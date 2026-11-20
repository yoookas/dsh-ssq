/**
 * 开奖夜自动化：哪些天开奖、下一次开奖是哪天、补抓阶梯怎么排。
 *
 * 这里只做纯计算 + 少量 schedule 服务调用封装，不碰网络、不碰存档。
 */

import { addDays, isoWeekday, zonedToUtc } from './time.mjs';

/** 周期任务标题（同时充当「这些任务是我建的」的识别依据）。 */
export const WEEKLY_TITLE = '双色球开奖数据抓取';
/** 一次性补抓任务标题。 */
export const RETRY_TITLE = '双色球开奖数据补抓';
export const OUR_TITLES = Object.freeze([WEEKLY_TITLE, RETRY_TITLE]);

/** 是否开奖日。 */
export function isDrawDay(date, weekdays) {
  return weekdays.includes(isoWeekday(date));
}

/** 从 date 往回找最近一个开奖日（最多回看 7 天）。 */
export function latestDrawDayAtOrBefore(date, weekdays) {
  let cursor = date;
  for (let i = 0; i < 8; i += 1) {
    if (isDrawDay(cursor, weekdays)) return cursor;
    cursor = addDays(cursor, -1);
  }
  return date;
}

/**
 * 下一个期号：'2026133' → '2026134'；跨年时用开奖日所在年份 + '001'。
 */
export function nextIssueAfter(issue, nightDate) {
  if (!issue) return null;
  const text = String(issue);
  const year = text.slice(0, 4);
  const seq = Number(text.slice(4));
  const nightYear = String(nightDate).slice(0, 4);
  if (nightYear > year) return `${nightYear}001`;
  if (!Number.isFinite(seq)) return null;
  return `${year}${String(seq + 1).padStart(3, '0')}`;
}

/**
 * 补抓阶梯：相对「本次检查时刻」的 retryOffsetsMinutes（默认 +5/+15/+45 分钟），再加次日早上 06:00。
 * 已经过去的时间点直接丢掉（schedule 的 at 只接受未来时刻）。
 */
export function planLadder({ nowMs, nightDate, config, timeZone }) {
  const steps = config.retryOffsetsMinutes.map((minutes) => ({
    label: `+${minutes} 分钟`,
    offsetMinutes: minutes,
    ts: nowMs + minutes * 60_000,
  }));

  const morningDate = addDays(nightDate, 1);
  const morningTs = zonedToUtc(morningDate, config.nextMorningTime, timeZone);
  if (morningTs > nowMs) {
    steps.push({
      label: `次日 ${config.nextMorningTime.slice(0, 5)}`,
      offsetMinutes: null,
      ts: morningTs,
    });
  }

  const seen = new Set();
  return steps
    .filter((step) => step.ts > nowMs + 1_000)
    .filter((step) => {
      if (seen.has(step.ts)) return false;
      seen.add(step.ts);
      return true;
    })
    .sort((a, b) => a.ts - b.ts);
}

/** 取（或建）某个会话的状态。 */
export function sessionState(state, sessionId) {
  const key = String(sessionId);
  if (!state.sessions[key]) state.sessions[key] = { weeklyId: null, weekdays: null, timeZone: null, nights: {} };
  const session = state.sessions[key];
  if (!session.nights) session.nights = {};
  return session;
}

/** 找当前还没结论的开奖夜（有挂着的补抓任务）。 */
export function pendingNight(session) {
  const nights = Object.entries(session.nights ?? {})
    .filter(([, value]) => value?.status === 'pending')
    .sort(([a], [b]) => b.localeCompare(a));
  return nights[0]?.[0] ?? null;
}

/** 只保留最近若干期结论，避免状态文件无限长。 */
export function pruneNights(session, keep = 40) {
  const entries = Object.entries(session.nights ?? {}).sort(([a], [b]) => b.localeCompare(a));
  if (entries.length <= keep) return;
  session.nights = Object.fromEntries(entries.slice(0, keep));
}

/** 本会话在 catalog 里的活跃任务（catalog 不区分会话时按 sessionId 过滤）。 */
export function activeTasksFor(scheduleCatalog, sessionId) {
  return scheduleCatalog.filter(
    (entry) => entry.sessionId === sessionId && entry.status === 'active',
  );
}

/** 按 id 从一批任务里挑出仍然活跃的那些。 */
export function filterAlive(entries, ids) {
  const wanted = new Set((ids ?? []).map(String));
  return entries.filter((entry) => wanted.has(String(entry.id)));
}

/** 下一次触发时间（ISO），没有则 null。 */
export function earliestScheduledAt(entries) {
  let best = null;
  for (const entry of entries) {
    if (!entry.scheduledAt) continue;
    if (best === null || Date.parse(entry.scheduledAt) < Date.parse(best)) best = entry.scheduledAt;
  }
  return best;
}

/** 周期任务的提醒文案：到点让模型调用 ssq_check。 */
export function weeklyPrompt(config) {
  return [
    '【双色球开奖夜】请调用 ssq_check 工具检查今天的开奖数据是否已发布。',
    '· 已发布：工具会把数据写入本地存档，并自动清理本期的补抓任务。',
    `· 未发布：工具会自动排定 ${config.retryOffsetsMinutes.join(' / ')} 分钟后以及次日 ${config.nextMorningTime.slice(0, 5)} 的补抓提醒，不要另建任务。`,
    '只做这一件事，完成后用一两句话汇报当期号码与一等奖注数。',
  ].join('\n');
}

/** 补抓任务的提醒文案：带上开奖夜，避免次日 06:00 时把「今天」算错。 */
export function retryPrompt(nightDate, label) {
  return [
    `【双色球开奖补抓 · ${label}】请调用 ssq_check（date="${nightDate}"）检查 ${nightDate} 那期开奖是否已发布。`,
    '· 已发布：工具会落盘并清理剩余的补抓任务。',
    '· 未发布：这是既有阶梯中的一次尝试，工具不会再新建任务，等下一次提醒即可。',
  ].join('\n');
}
