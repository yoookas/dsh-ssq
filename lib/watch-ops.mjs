/**
 * 开奖夜自动化的业务实现：检查、启用、停用、查看。
 *
 * 模型侧工具（ssq_check / ssq_watch_enable / ssq_watch_status / ssq_watch_disable）
 * 和人类侧的斜杠命令（/ssq-watch on|off|status）都调用这里的同一份逻辑，
 * 保证两条入口的行为完全一致。
 */

import { mutateArchive, readArchive, readState, writeState } from './archive.mjs';
import {
  OUR_TITLES,
  RETRY_TITLE,
  WEEKLY_TITLE,
  activeTasksFor,
  earliestScheduledAt,
  filterAlive,
  latestDrawDayAtOrBefore,
  nextIssueAfter,
  pendingNight,
  planLadder,
  pruneNights,
  retryPrompt,
  sessionState,
  weeklyPrompt,
} from './automation.mjs';
import { normalizeTime } from './config.js';
import { resolveRuntime } from './runtime.mjs';
import { formatInstant, zonedParts } from './time.mjs';

const nowIso = () => new Date().toISOString();
const fail = (message) => {
  throw new Error(message);
};

/** 一条 schedule 任务 → 工具/命令共用的稳定结构（全部字段可 JSON 序列化）。 */
export function scheduleEntry(entry) {
  return {
    id: String(entry.id),
    kind: String(entry.kind),
    title: String(entry.title),
    scheduled_at: entry.scheduledAt ?? null,
    state: entry.state ?? null,
    time: entry.time ?? null,
    weekdays: entry.weekdays ?? null,
    time_zone: entry.timeZone ?? null,
    at: entry.scheduledAt ?? null,
  };
}

/**
 * 删掉某一夜的补抓任务。
 *
 * 两份来源都要看：状态文件里记的 id（正常路径），以及 catalog 里 prompt 带着
 * `date="<开奖夜>"` 标记的一次性任务（状态文件被删/损坏时的兜底）。这样即使
 * watch-state.json 丢了，成功抓到之后也不会留下还在响的补抓提醒。
 */
export async function cancelNightRetries(schedule, sessionId, night, nightDate) {
  const marker = nightDate ? `date="${nightDate}"` : null;
  const ids = new Set((night.retryIds ?? []).map(String));

  if (marker) {
    try {
      const catalog = await schedule.catalog();
      for (const entry of activeTasksFor(catalog, sessionId)) {
        if (entry.kind === 'weekly') continue;
        if (String(entry.prompt ?? '').includes(marker)) ids.add(String(entry.id));
      }
    } catch {
      /* catalog 读不到就只按状态里的 id 删 */
    }
  }

  const removed = [];
  for (const id of ids) {
    try {
      const result = await schedule.edit({ id, action: 'delete' }, sessionId);
      if (result?.deleted === true) removed.push(id);
    } catch {
      /* 已经不存在的任务不用管 */
    }
  }
  night.retryIds = [];
  return removed;
}

/**
 * 开奖夜检查：已发布 → 落盘 + 清理补抓；未发布 → 排 +5/+15/+45 分钟与次日 06:00 的补抓阶梯。
 */
export async function checkDrawNight({ schedule, getConfig, sessionId, signal, date, force, dryRun }) {
  const { cfg, project, dataDir } = await resolveRuntime(getConfig);

  const nowMs = Date.now();
  const state = await readState(dataDir);
  const session = sessionState(state, sessionId);
  pruneNights(session);

  const weekdays =
    Array.isArray(session.weekdays) && session.weekdays.length > 0 ? session.weekdays : cfg.weekdays;
  const timeZone = session.timeZone || cfg.timeZone;
  const today = zonedParts(nowMs, timeZone).date;

  if (date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(date).trim())) {
    fail('date 必须是 YYYY-MM-DD。');
  }
  const explicitDate = date ? String(date).trim() : null;
  const latestDay = latestDrawDayAtOrBefore(today, weekdays);
  const archive = await readArchive(dataDir);

  // 0) 收尾：更早的开奖夜如果还挂着 pending，说明它的阶梯已经结束（多半是休市或任务被手动删了），
  //    先给它们结论，避免今晚的检查被旧状态带偏。
  const staleResolved = [];
  for (const [night, value] of Object.entries(session.nights ?? {})) {
    if (value?.status !== 'pending' || night >= latestDay) continue;
    const publishedBefore = Boolean(archive.latest && archive.latest.date >= night);
    if (!dryRun) await cancelNightRetries(schedule, sessionId, value, night);
    value.status = publishedBefore ? 'published' : 'gave-up';
    value.retryIds = [];
    value.checkedAt = nowIso();
    staleResolved.push(night);
  }

  const nightDate = explicitDate ?? pendingNight(session) ?? latestDay;
  const expectedIssue = nextIssueAfter(archive.latest?.issue, nightDate);
  const night = session.nights[nightDate] ?? {
    expectedIssue,
    status: 'pending',
    retryIds: [],
    checkedAt: null,
  };
  session.nights[nightDate] = night;
  if (!night.expectedIssue) night.expectedIssue = expectedIssue;

  // 1) 每次都拉一次完整快照（21 页 / 约 2091 期 / 约 2.7 秒），合并去重后整体重写存档。
  //    这样「发布晚了」「中间缺一期」「存档落后 N 期」都不需要单独处理：
  //    任何一次检查都会把存档对齐到官网的完整状态；
  //    而同一期号在合并时只会留一份（Map + 写队列），重复抓取是幂等的。
  let fresh = [];
  let fetchError = null;
  try {
    const all = await project.fetchAll({ pageSize: 100, concurrency: 2, delayMs: 120, signal });
    fresh = project.normalizeDraws(project.dedupeAndSort(all.result));
  } catch (error) {
    fetchError = error?.message ?? String(error);
  }

  let added = 0;
  if (fresh.length > 0 && !dryRun) {
    try {
      const written = await mutateArchive(project, dataDir, fresh);
      added = written.added;
    } catch (error) {
      fetchError = `存档写入失败：${error?.message ?? String(error)}`;
    }
  }

  // 合并后重新读一次：下面的 latest_* 字段必须是落盘后的真实状态。
  const current = dryRun ? archive : await readArchive(dataDir);
  let published = null;
  if (current.latest && current.latest.date >= nightDate) published = current.latest;
  else published = fresh.find((draw) => draw.date >= nightDate) ?? null;

  const notes = [];
  if (staleResolved.length > 0) notes.push(`已给更早的开奖夜收尾：${staleResolved.join('、')}`);
  if (added > 0) notes.push(`顺带补齐了 ${added} 期存档（含此前迟到/漏抓的期次）`);
  if (fetchError) notes.push(`官网查询失败、按未发布处理（${fetchError}）`);
  const noteText = notes.length > 0 ? ` ${notes.join('；')}。` : '';

  if (published) {
    const removed = dryRun ? [] : await cancelNightRetries(schedule, sessionId, night, nightDate);
    night.status = 'published';
    night.retryIds = [];
    night.checkedAt = nowIso();
    if (!dryRun) await writeState(dataDir, state);
    return {
      status: 'published',
      night: nightDate,
      expected_issue: night.expectedIssue ?? expectedIssue,
      latest_issue: published.issue,
      latest_date: published.date,
      added,
      retries: [],
      next_attempt: null,
      message: `第 ${published.issue} 期（${published.date} ${published.weekday}，红 ${published.red.join(' ')} 蓝 ${published.blue}）已入库${removed.length ? `，并清理了 ${removed.length} 个补抓任务` : ''}。存档目录 ${dataDir}。${noteText}`,
    };
  }

  // 2) 未发布：先看这一夜有没有还在排队的补抓任务。
  //    除了状态文件里记的 id，还按 prompt 里的 date 标记把「孤儿任务」认领回来：
  //    状态文件被删/换机器后，不会重复排一轮阶梯。
  const catalog = await schedule.catalog();
  const active = activeTasksFor(catalog, sessionId);
  const marker = `date="${nightDate}"`;
  for (const entry of active) {
    if (entry.kind === 'weekly' || entry.title !== RETRY_TITLE) continue;
    if (!String(entry.prompt ?? '').includes(marker)) continue;
    if (!night.retryIds.includes(entry.id)) night.retryIds.push(entry.id);
  }
  const alive = filterAlive(active, night.retryIds);

  if (alive.length > 0) {
    const next = earliestScheduledAt(alive);
    return {
      status: 'pending',
      night: nightDate,
      expected_issue: night.expectedIssue ?? expectedIssue,
      latest_issue: current.latest?.issue ?? null,
      latest_date: current.latest?.date ?? null,
      added,
      retries: alive.map((entry) => scheduleEntry(entry)),
      next_attempt: next,
      message: `第 ${night.expectedIssue ?? expectedIssue} 期还没发布（官网最新仍是 ${current.latest?.issue ?? '未知'}），本期还有 ${alive.length} 个补抓任务${next ? `，下一次 ${formatInstant(Date.parse(next), timeZone)}` : ''}。${noteText}`,
    };
  }

  if (night.retryIds.length > 0 && night.status === 'pending' && force !== true) {
    night.status = 'gave-up';
    night.checkedAt = nowIso();
    if (!dryRun) await writeState(dataDir, state);
    return {
      status: 'gave-up',
      night: nightDate,
      expected_issue: night.expectedIssue ?? expectedIssue,
      latest_issue: current.latest?.issue ?? null,
      latest_date: current.latest?.date ?? null,
      added,
      retries: [],
      next_attempt: null,
      message: `第 ${night.expectedIssue ?? expectedIssue} 期的补抓阶梯已全部用尽，官网仍未发布。可能是休市/停开；需要继续重试请带 force=true 再排一轮。${noteText}`,
    };
  }

  // 3) 排新一轮补抓阶梯。
  const steps = planLadder({ nowMs, nightDate, config: cfg, timeZone });
  if (steps.length === 0) {
    night.status = 'gave-up';
    night.checkedAt = nowIso();
    if (!dryRun) await writeState(dataDir, state);
    return {
      status: 'gave-up',
      night: nightDate,
      expected_issue: night.expectedIssue ?? expectedIssue,
      latest_issue: current.latest?.issue ?? null,
      latest_date: current.latest?.date ?? null,
      added,
      retries: [],
      next_attempt: null,
      message: `当前时间已过所有补抓时间点，没有可排的任务。${noteText}`,
    };
  }

  const retries = [];
  const failures = [];
  for (const step of steps) {
    const at = new Date(step.ts).toISOString();
    if (dryRun) {
      retries.push({ label: step.label, at, id: null, created: false, title: RETRY_TITLE });
      continue;
    }
    try {
      const record = await schedule.create(
        {
          title: RETRY_TITLE,
          prompt: retryPrompt(nightDate, step.label),
          timing: { kind: 'at', at },
          target: { kind: 'session', sessionId },
        },
        sessionId,
        signal,
      );
      night.retryIds.push(record.id);
      retries.push({ label: step.label, at: record.scheduledAt, id: record.id, created: true, title: RETRY_TITLE });
    } catch (error) {
      failures.push(`${step.label}: ${error?.message ?? String(error)}`);
    }
  }

  night.status = retries.some((item) => item.created) || dryRun ? 'pending' : 'gave-up';
  night.checkedAt = nowIso();
  if (!dryRun) await writeState(dataDir, state);

  const next = retries[0]?.at ?? null;
  const failureText = failures.length ? `（${failures.length} 个补抓任务创建失败：${failures.join('；')}）` : '';
  return {
    status: night.status === 'pending' ? 'pending' : 'gave-up',
    night: nightDate,
    expected_issue: night.expectedIssue ?? expectedIssue,
    latest_issue: archive.latest?.issue ?? null,
    latest_date: archive.latest?.date ?? null,
    added,
    retries,
    next_attempt: next,
    message: dryRun
      ? `第 ${night.expectedIssue ?? expectedIssue} 期尚未发布；按阶梯将排 ${retries.length} 个补抓任务（dry_run，未真正创建）。${noteText}`
      : `第 ${night.expectedIssue ?? expectedIssue} 期尚未发布，已排定 ${retries.filter((item) => item.created).length} 个补抓任务${next ? `，最早 ${formatInstant(Date.parse(next), timeZone)}` : ''}${failureText}。${noteText}`,
  };
}

/** 在当前会话启用开奖夜周期任务（同一个会话重复调用不会建第二个）。 */
export async function enableWatch({
  schedule,
  getConfig,
  sessionId,
  signal,
  time,
  weekdays,
  timeZone,
  replace,
}) {
  const { cfg, dataDir } = await resolveRuntime(getConfig);

  const days = normalizeWeekdays(weekdays) ?? cfg.weekdays;
  const at = normalizeTime(time ?? cfg.weeklyTime, cfg.weeklyTime);
  const zone = String(timeZone ?? '').trim() || cfg.timeZone;

  const state = await readState(dataDir);
  const session = sessionState(state, sessionId);
  const catalog = await schedule.catalog();
  const active = activeTasksFor(catalog, sessionId);
  const existing =
    // 优先按「标题 + weekly」找：状态文件丢了也能认领回已有任务，不会建出第二个周期任务。
    active.find((entry) => entry.kind === 'weekly' && entry.title === WEEKLY_TITLE) ??
    filterAlive(active, [session.weeklyId]).find((entry) => entry.kind === 'weekly') ??
    null;

  if (existing && replace !== true) {
    session.weeklyId = existing.id;
    session.weekdays = Array.isArray(existing.weekdays) ? existing.weekdays : days;
    session.timeZone = existing.timeZone ?? zone;
    await writeState(dataDir, state);
    return {
      enabled: true,
      created: false,
      id: existing.id,
      kind: existing.kind,
      title: existing.title,
      time: existing.time ?? at,
      weekdays: existing.weekdays ?? days,
      time_zone: existing.timeZone ?? zone,
      scheduled_at: existing.scheduledAt ?? null,
      message: '周期任务已经存在，没有重复创建。要换时间/星期请带 replace=true。',
    };
  }

  if (existing && replace === true) {
    await schedule.edit({ id: existing.id, action: 'delete' }, sessionId);
  }

  const record = await schedule.create(
    {
      title: WEEKLY_TITLE,
      prompt: weeklyPrompt(cfg),
      timing: { kind: 'weekly', weekly: { time: at, time_zone: zone, weekdays: days } },
      target: { kind: 'session', sessionId },
    },
    sessionId,
    signal,
  );

  session.weeklyId = record.id;
  session.weekdays = days;
  session.timeZone = zone;
  await writeState(dataDir, state);

  return {
    enabled: true,
    created: true,
    id: record.id,
    kind: record.kind,
    title: record.title,
    time: record.time ?? at,
    weekdays: record.weekdays ?? days,
    time_zone: record.timeZone ?? zone,
    scheduled_at: record.scheduledAt ?? null,
    message: `已创建周期任务。到点后会在本会话提示执行 ssq_check；如果当时还没开奖，会按 ${cfg.retryOffsetsMinutes.join('/')} 分钟与次日 ${cfg.nextMorningTime.slice(0, 5)} 的阶梯自动补抓，结果写回本会话。`,
  };
}

/** 当前会话的自动化状态：周期任务、待补抓、最近几期结论。 */
export async function statusWatch({ schedule, getConfig, sessionId }) {
  const { cfg, dataDir } = await resolveRuntime(getConfig);
  const state = await readState(dataDir);
  const session = sessionState(state, sessionId);
  const catalog = await schedule.catalog();
  const ours = activeTasksFor(catalog, sessionId).filter((entry) => OUR_TITLES.includes(entry.title));

  const weekly = ours.find((entry) => entry.kind === 'weekly') ?? null;
  const retries = ours
    .filter((entry) => entry.kind !== 'weekly')
    .sort((a, b) => String(a.scheduledAt).localeCompare(String(b.scheduledAt)))
    .map((entry) => scheduleEntry(entry));

  const nights = Object.entries(session.nights ?? {})
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, 8)
    .map(([night, value]) => ({
      night,
      expected_issue: value.expectedIssue ?? null,
      status: value.status ?? 'unknown',
      checked_at: value.checkedAt ?? null,
    }));

  return {
    session_id: String(sessionId),
    weekly: weekly ? scheduleEntry(weekly) : null,
    retries,
    nights,
    time_zone: cfg.timeZone,
    message: weekly
      ? `周期任务在运行；当前有 ${retries.length} 个待执行的补抓任务，抓到的数据会写回本会话（${sessionId}）。`
      : '当前会话没有开奖夜周期任务。需要的话调用 ssq_watch_enable（或 /ssq-watch on）创建。',
  };
}

/** 停用本会话的全部双色球定时任务。 */
export async function disableWatch({ schedule, getConfig, sessionId }) {
  const { dataDir } = await resolveRuntime(getConfig);
  const catalog = await schedule.catalog();
  const ours = activeTasksFor(catalog, sessionId).filter((entry) => OUR_TITLES.includes(entry.title));

  const deleted = [];
  for (const entry of ours) {
    try {
      const result = await schedule.edit({ id: entry.id, action: 'delete' }, sessionId);
      if (result.deleted) {
        deleted.push({
          id: entry.id,
          title: entry.title,
          kind: entry.kind,
          scheduled_at: entry.scheduledAt ?? null,
        });
      }
    } catch {
      /* 单个任务删除失败不影响其它任务 */
    }
  }

  const state = await readState(dataDir);
  const session = sessionState(state, sessionId);
  session.weeklyId = null;
  for (const night of Object.values(session.nights ?? {})) {
    if (Array.isArray(night.retryIds)) night.retryIds = [];
    if (night.status === 'pending') night.status = 'cancelled';
  }
  await writeState(dataDir, state);

  return {
    deleted,
    remaining: 0,
    message: deleted.length
      ? '已删除本会话的全部双色球定时任务；已发出的提醒不会撤回。'
      : '本会话没有本插件创建的定时任务。',
  };
}

function normalizeWeekdays(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const days = [...new Set(value.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))];
  return days.length ? days.sort((a, b) => a - b) : null;
}
