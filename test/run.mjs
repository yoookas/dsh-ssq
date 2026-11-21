/**
 * 双色球插件的本地冒烟测试（不装进 profile，直接在 Node 里跑）。
 *
 * 覆盖：
 *   · 插件入口 apply() 的注册路径（数据工具 + schedule 注入后的自动化工具）
 *   · 每个工具返回值的 output.schema 校验（与 Host 同一套 validateJsonSchemaValue）
 *   · 开奖夜补抓阶梯：未发布 → 排 4 个任务；重复调用不重复排；已发布 → 清理任务
 *   · 周期任务的创建 / 去重 / 删除
 *   · 纯函数：时区换算、期号递推、阶梯计算、往期查询分页
 */

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';

/** 包根目录（test/ 的上一级）；数据层就在包内 src/。 */
const PLUGIN = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const PROJECT = PLUGIN;

const results = [];
function check(name, fn) {
  try {
    const value = fn();
    results.push({ name, ok: true, note: value ?? '' });
  } catch (error) {
    results.push({ name, ok: false, note: error?.message ?? String(error) });
  }
}
async function checkAsync(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true, note: value ?? '' });
  } catch (error) {
    results.push({ name, ok: false, note: error?.stack ?? String(error) });
  }
}

/* ----------------------------- 纯函数 ----------------------------- */

const time = await import(`${PLUGIN}/lib/time.mjs`);
const automation = await import(`${PLUGIN}/lib/automation.mjs`);
const archive = await import(`${PLUGIN}/lib/archive.mjs`);
const config = await import(`${PLUGIN}/lib/config.js`);

check('时区：Asia/Shanghai 21:35 换算成 UTC', () => {
  const ts = time.zonedToUtc('2026-11-22', '21:35:00', 'Asia/Shanghai');
  assert.equal(new Date(ts).toISOString(), '2026-11-22T13:35:00.000Z');
});

check('时区：06:00 次日与 ISO 星期', () => {
  assert.equal(new Date(time.zonedToUtc('2026-11-23', '06:00:00', 'Asia/Shanghai')).toISOString(), '2026-11-22T22:00:00.000Z');
  assert.equal(time.isoWeekday('2026-11-22'), 7);
  assert.equal(time.isoWeekday('2026-11-19'), 4);
});

check('期号递推：同年 +1，跨年回到 001', () => {
  assert.equal(automation.nextIssueAfter('2026133', '2026-11-22'), '2026134');
  assert.equal(automation.nextIssueAfter('2026153', '2027-01-03'), '2027001');
});

check('补抓阶梯：+5/+15/+45 分钟 + 次日 06:00（21:40 / 21:50 / 22:20 / 06:00）', () => {
  const nowMs = time.zonedToUtc('2026-11-22', '21:35:00', 'Asia/Shanghai');
  const cfg = config.resolveConfig({}, PROJECT);
  const steps = automation.planLadder({
    nowMs,
    nightDate: '2026-11-22',
    config: cfg,
    timeZone: 'Asia/Shanghai',
  });
  assert.equal(steps.length, 4);
  assert.deepEqual(
    steps.map((step) => new Date(step.ts).toISOString()),
    ['2026-11-22T13:40:00.000Z', '2026-11-22T13:50:00.000Z', '2026-11-22T14:20:00.000Z', '2026-11-22T22:00:00.000Z'],
  );
});

check('配置默认值', () => {
  const cfg = config.resolveConfig({}, '/tmp');
  assert.equal(cfg.weeklyTime, '21:35:00');
  assert.deepEqual(cfg.weekdays, [2, 4, 7]);
  assert.deepEqual(cfg.retryOffsetsMinutes, [5, 15, 45]);
  assert.equal(cfg.nextMorningTime, '06:00:00');
  assert.equal(cfg.timeZone, 'Asia/Shanghai');
});

check('往期查询：期号区间 + 分页', () => {
  const draws = [
    { issue: '2026133', date: '2026-11-19' },
    { issue: '2026132', date: '2026-11-17' },
    { issue: '2026131', date: '2026-11-15' },
  ];
  const page = archive.queryDraws(draws, { fromIssue: '2026131', toIssue: '2026132', page: 1, pageSize: 1 });
  assert.equal(page.total, 2);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].issue, '2026132');
  assert.equal(page.pages, 2);
});

/* --------------------------- 插件注册 --------------------------- */

const plugin = await import(pathToFileURL(`${PLUGIN}/index.js`).href);

const toolDefs = new Map();
const commandDefs = new Map();
const injections = [];

const fakeTools = {
  register(definition) {
    toolDefs.set(definition.name, definition);
    return () => toolDefs.delete(definition.name);
  },
};

const fakeCommands = {
  register(definition) {
    commandDefs.set(definition.name, definition);
    return () => commandDefs.delete(definition.name);
  },
  list: () => [...commandDefs.values()].map(({ handler, ...rest }) => rest),
  find: (_agent, name) => commandDefs.get(name),
};

const baseCtx = {
  tools: fakeTools,
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  inject(dependencies, callback) {
    injections.push({ dependencies, callback });
  },
};

const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'ssq-plugin-data-'));
// 存档目录随包走，测试用环境变量把它指到临时目录，避免写进仓库 data/。
process.env.SSQ_DATA_DIR = DATA_DIR;
plugin.apply(baseCtx, {});

check('插件入口：名称与依赖', () => {
  assert.equal(plugin.name, 'ssq-draws');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.ok(plugin.Config);
});

check('插件入口：注册了 3 个数据工具，等待 2 个带服务的注入', () => {
  assert.deepEqual([...toolDefs.keys()].sort(), ['ssq_history', 'ssq_latest', 'ssq_sync']);
  assert.deepEqual(
    injections.map(({ dependencies }) => dependencies).sort(),
    [['schedule'], ['schedule', 'commands']].sort(),
  );
});

/* --------------------------- 假 schedule --------------------------- */

class FakeSchedule {
  constructor() {
    this.tasks = new Map();
    this.seq = 0;
  }

  /** dsh 0.2.2 API：create(request, actorSessionId) —— timing 带类型，target 指定投递目的地。 */
  async create(request, actorSessionId) {
    const id = `sched-${++this.seq}`;
    const timing = request.timing ?? {};
    const record = {
      id,
      title: request.title,
      prompt: request.prompt,
      target: request.target ?? { kind: 'session', sessionId: actorSessionId },
      involvedSessionIds: actorSessionId ? [actorSessionId] : [],
      status: 'active',
    };

    if (timing.kind === 'weekly') {
      record.kind = 'weekly';
      record.time = timing.weekly.time;
      record.timeZone = timing.weekly.time_zone;
      record.weekdays = [...timing.weekly.weekdays];
      record.scheduledAt = new Date(Date.now() + 3600_000).toISOString();
    } else if (timing.kind === 'at') {
      const at = Date.parse(String(timing.at));
      if (!(at > Date.now())) throw new Error('not_future');
      record.kind = 'at';
      record.scheduledAt = new Date(at).toISOString();
    } else {
      throw new Error('invalid_selector');
    }

    this.tasks.set(id, record);
    return { ...record };
  }

  async catalog() {
    return [...this.tasks.values()].map((task) => ({ ...task }));
  }

  /** dsh 0.2.2 API：edit({ id, action: 'delete' }, actorSessionId)。 */
  async edit(request, actorSessionId) {
    if (request.action !== 'delete') throw new Error(`unsupported edit: ${request.action}`);
    const record = this.tasks.get(request.id);
    if (!record) return { id: request.id, deleted: false, code: 'schedule_not_found' };
    const owner = record.target?.kind === 'session' ? record.target.sessionId : undefined;
    if (actorSessionId !== undefined && owner !== actorSessionId && !record.involvedSessionIds.includes(actorSessionId)) {
      return { id: request.id, deleted: false, code: 'schedule_not_found' };
    }
    this.tasks.delete(request.id);
    return { id: request.id, deleted: true };
  }
}

const schedule = new FakeSchedule();
const scopedCtx = { ...baseCtx, schedule, commands: fakeCommands };
for (const { callback } of injections) callback(scopedCtx);

check('schedule 注入后：7 个工具齐全', () => {
  assert.deepEqual([...toolDefs.keys()].sort(), [
    'ssq_check',
    'ssq_history',
    'ssq_latest',
    'ssq_sync',
    'ssq_watch_disable',
    'ssq_watch_enable',
    'ssq_watch_status',
  ]);
});

const agent = { id: 'session-test', session: { id: 'session-test' } };
const signal = new AbortController().signal;

async function call(name, args = {}, withAgent = true) {
  const definition = toolDefs.get(name);
  assert.ok(definition, `工具 ${name} 未注册`);
  const value = await definition.execute(args, {
    callId: 'call-1',
    rootCallId: 'call-1',
    name,
    arguments: args,
    agent: withAgent ? agent : undefined,
    signal,
  });
  const violations = validateJsonSchemaValue(definition.output.schema, value);
  assert.deepEqual(violations, [], `${name} 输出不符合 schema：${violations.join('; ')}`);
  const rendered = definition.output.render(args, value);
  assert.ok(Array.isArray(rendered) && rendered.length > 0, `${name} render 返回空`);
  assert.equal(rendered[0].type, 'text');
  return { value, text: rendered[0].text };
}

/* ----------------------------- 工具实测 ----------------------------- */

await checkAsync('ssq_latest：实时接口取最近 2 期', async () => {
  const { value } = await call('ssq_latest', { count: 2 });
  assert.equal(value.draws.length, 2);
  assert.match(value.draws[0].issue, /^\d{7}$/);
  assert.equal(value.draws[0].red.length, 6);
  assert.equal(value.draws[0].tiers.length, 6);
});

await checkAsync('ssq_sync：全量同步落盘', async () => {
  const { value, text } = await call('ssq_sync', {}, false);
  assert.ok(value.archive_total > 2000, `存档期数异常：${value.archive_total}`);
  assert.equal(value.mode, 'full');
  assert.ok(!text.includes('undefined'));
  const firstLine = readFileSync(path.join(DATA_DIR, 'ssq_draws.jsonl'), 'utf8').split('\n')[0];
  assert.ok(JSON.parse(firstLine).issue);
});

await checkAsync('ssq_history：按年份筛选 + 分页', async () => {
  const { value, text } = await call('ssq_history', { year: 2019, page: 2, page_size: 5 });
  assert.equal(value.returned, 5);
  assert.equal(value.page, 2);
  assert.ok(value.total > 100, `2019 年期数异常：${value.total}`);
  assert.ok(value.draws.every((draw) => draw.issue.startsWith('2019')));
  assert.ok(!text.includes('undefined'));
});

await checkAsync('ssq_history：期号区间 + 关闭奖级明细', async () => {
  const { value } = await call('ssq_history', { from_issue: '2026130', to_issue: '2026133', with_tiers: false });
  assert.equal(value.total, 4);
  assert.ok(value.draws.every((draw) => draw.tiers === undefined));
});

await checkAsync('ssq_check：已发布的最近一期直接判定 published', async () => {
  const { value } = await call('ssq_check', {});
  assert.equal(value.status, 'published');
  assert.equal(value.added, 0);
  assert.match(value.latest_issue, /^\d{7}$/);
});

await checkAsync('ssq_check：未来开奖日 → 排 4 个补抓任务', async () => {
  const { value } = await call('ssq_check', { date: '2026-11-22' });
  assert.equal(value.status, 'pending');
  assert.equal(value.retries.length, 4);
  assert.equal(value.retries.filter((item) => item.created).length, 4);
  assert.equal(schedule.tasks.size, 4);
  assert.ok(value.next_attempt);
});

await checkAsync('ssq_check：同日再调不重复排任务', async () => {
  const before = schedule.tasks.size;
  const { value } = await call('ssq_check', { date: '2026-11-22' });
  assert.equal(value.status, 'pending');
  assert.equal(schedule.tasks.size, before);
});

await checkAsync('ssq_watch_enable：创建周期任务', async () => {
  const { value } = await call('ssq_watch_enable', {});
  assert.equal(value.enabled, true);
  assert.equal(value.created, true);
  assert.equal(value.kind, 'weekly');
  assert.deepEqual(value.weekdays, [2, 4, 7]);
  assert.equal(value.time, '21:35:00');
  assert.equal(value.time_zone, 'Asia/Shanghai');
});

await checkAsync('ssq_watch_enable：重复调用不重复创建', async () => {
  const before = schedule.tasks.size;
  const { value } = await call('ssq_watch_enable', {});
  assert.equal(value.created, false);
  assert.equal(schedule.tasks.size, before);
});

await checkAsync('ssq_watch_enable：状态文件丢失后仍能认领已有任务', async () => {
  writeFileSync(path.join(DATA_DIR, 'watch-state.json'), '{"version":1,"sessions":{}}\n', 'utf8');
  const before = schedule.tasks.size;
  const { value } = await call('ssq_watch_enable', {});
  assert.equal(value.created, false);
  assert.equal(schedule.tasks.size, before);
});

await checkAsync('ssq_check：更早的开奖夜会被自动收尾', async () => {
  const today = time.zonedParts(Date.now(), 'Asia/Shanghai').date;
  const latestDay = automation.latestDrawDayAtOrBefore(today, [2, 4, 7]);
  const staleNight = time.addDays(latestDay, -7);

  // 造两条「属于更早开奖夜」的一次性任务，并把那一夜写成 pending
  const first = await schedule.create(
    {
      title: '双色球开奖数据补抓',
      prompt: automation.retryPrompt(staleNight, '+5 分钟'),
      timing: { kind: 'at', at: new Date(Date.now() + 300_000).toISOString() },
      target: { kind: 'session', sessionId: 'session-test' },
    },
    'session-test',
  );
  const second = await schedule.create(
    {
      title: '双色球开奖数据补抓',
      prompt: automation.retryPrompt(staleNight, '+10 分钟'),
      timing: { kind: 'at', at: new Date(Date.now() + 600_000).toISOString() },
      target: { kind: 'session', sessionId: 'session-test' },
    },
    'session-test',
  );

  const statePath = path.join(DATA_DIR, 'watch-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.sessions['session-test'] ??= { weeklyId: null, weekdays: null, timeZone: null, nights: {} };
  state.sessions['session-test'].nights ??= {};
  state.sessions['session-test'].nights[staleNight] = {
    expectedIssue: '2026001',
    status: 'pending',
    retryIds: [first.id, second.id],
    checkedAt: null,
  };
  writeFileSync(statePath, JSON.stringify(state), 'utf8');

  const before = schedule.tasks.size;
  const { value } = await call('ssq_check', {});
  assert.equal(value.night, latestDay);
  assert.equal(value.status, 'published');
  assert.ok(schedule.tasks.size < before, '更早开奖夜的补抓任务没有被清掉');
  assert.match(value.message, /收尾/);

  const alive = await schedule.catalog();
  assert.ok(!alive.some((entry) => entry.id === first.id || entry.id === second.id));
});

await checkAsync('ssq_watch_status：周期任务 + 4 个补抓', async () => {
  const { value } = await call('ssq_watch_status', {});
  assert.ok(value.weekly);
  assert.equal(value.retries.length, 4);
  assert.ok(value.nights.length >= 1);
});

await checkAsync('ssq_check：数据到达后清理补抓任务', async () => {
  // 造一个「2026-11-22 已开奖」的存档：写一条期号更大的记录进去
  const file = path.join(DATA_DIR, 'ssq_draws.jsonl');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const sample = JSON.parse(lines[0]);
  const seeded = {
    ...sample,
    issue: '2026134',
    date: '2026-11-22',
    weekday: '日',
  };
  writeFileSync(file, `${JSON.stringify(seeded)}\n${lines.join('\n')}\n`, 'utf8');

  const before = schedule.tasks.size;
  const { value } = await call('ssq_check', { date: '2026-11-22' });
  assert.equal(value.status, 'published');
  assert.equal(value.latest_issue, '2026134');
  assert.ok(schedule.tasks.size < before, '补抓任务没有被清理');
});

await checkAsync('ssq_watch_disable：删掉本会话全部任务', async () => {
  const { value } = await call('ssq_watch_disable', {});
  assert.ok(value.deleted.length >= 1);
  const left = await schedule.catalog();
  assert.equal(left.filter((entry) => entry.target?.sessionId === 'session-test').length, 0);
});

await checkAsync('没有 Agent 时自动化工具给出明确错误', async () => {
  await assert.rejects(() => call('ssq_watch_status', {}, false), /需要一个会话/);
});

/* ------------------------- 重复 / 迟到数据 ------------------------- */

/** 用同一个插件、另一个存档目录再起一份实例（独立的工具表 / 会话 / 任务）。 */
const LATE_DIR = DATA_DIR;

const readJsonl = (dir) =>
  readFileSync(path.join(dir, 'ssq_draws.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const FUTURE_NIGHT = time.addDays(time.zonedParts(Date.now(), 'Asia/Shanghai').date, 5);

await checkAsync('迟到数据：开奖日后两天才发布，也会被下一次检查补回', async () => {
  const before = readJsonl(LATE_DIR);
  // 挑 3 期「官网确实有」的当期（避开上一条用例写入的造数据期号）
  const victims = new Set(before.filter((draw) => draw.issue <= '2026130').slice(0, 3).map((draw) => draw.issue));
  assert.equal(victims.size, 3);
  writeFileSync(
    path.join(LATE_DIR, 'ssq_draws.jsonl'),
    `${before.filter((draw) => !victims.has(draw.issue)).map((draw) => JSON.stringify(draw)).join('\n')}\n`,
    'utf8',
  );

  // 用一个「未来开奖日」触发检查：本期必然未发布（hit 为空），
  // 数据仍然要被补回去 —— 证明写入不依赖「本期已发布」。
  const { value } = await call('ssq_check', { date: FUTURE_NIGHT });
  assert.equal(value.status, 'pending');
  assert.ok(value.added >= 3, `迟到期次没有补回：added=${value.added}`);

  const after = readJsonl(LATE_DIR);
  for (const issue of victims) {
    assert.ok(after.some((draw) => draw.issue === issue), `第 ${issue} 期没有被补回`);
  }
  assert.equal(after.length, before.length, '补回后期数应与原来一致');
});

await checkAsync('重复抓取：同一期合并多次也只留一份', async () => {
  const before = readJsonl(LATE_DIR);
  await call('ssq_sync', {});
  await call('ssq_sync', {});
  const after = readJsonl(LATE_DIR);
  const issues = after.map((draw) => draw.issue);
  assert.equal(new Set(issues).size, issues.length, '存档里出现了重复期号');
  assert.equal(after.length, before.length, '重复同步不应改变期数');
});

await checkAsync('重复检查：同一次 check 跑两遍，added 归零且期数不变', async () => {
  const { value: first } = await call('ssq_check', { date: FUTURE_NIGHT, dry_run: true });
  const before = readJsonl(LATE_DIR).length;
  await call('ssq_check', { date: FUTURE_NIGHT });
  const after = readJsonl(LATE_DIR).length;
  const { value: second } = await call('ssq_check', { date: FUTURE_NIGHT });
  assert.equal(first.added, 0);
  assert.equal(second.added, 0);
  assert.equal(after, before);
});

await checkAsync('并发写入：两次合并同时进行也不会丢期次', async () => {
  const archiveLib = await import(`${PLUGIN}/lib/archive.mjs`);
  const sourceLib = await import(`${PLUGIN}/lib/source.mjs`);
  const loaded = await sourceLib.loadSsq();
  const dir = mkdtempSync(path.join(tmpdir(), 'ssq-plugin-race-'));
  copyFileSync(path.join(PROJECT, 'data', 'ssq_draws.jsonl'), path.join(dir, 'ssq_draws.jsonl'));

  const sample = JSON.parse(readFileSync(path.join(PROJECT, 'data', 'ssq_draws.jsonl'), 'utf8').split('\n')[0]);
  const a = { ...sample, issue: '2097001', date: '2097-01-01' };
  const b = { ...sample, issue: '2097002', date: '2097-01-02' };
  await Promise.all([
    archiveLib.mutateArchive(loaded, dir, [a]),
    archiveLib.mutateArchive(loaded, dir, [b]),
  ]);
  const issues = readFileSync(path.join(dir, 'ssq_draws.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).issue);
  assert.ok(issues.includes('2097001') && issues.includes('2097002'), '并发写入丢了其中一期');
  assert.equal(new Set(issues).size, issues.length);
});

await checkAsync('状态文件丢了也不会重复排补抓阶梯（按 prompt 标记认领）', async () => {
  const night = time.addDays(time.zonedParts(Date.now(), 'Asia/Shanghai').date, 12);
  await call('ssq_check', { date: night });
  const mine = (await schedule.catalog()).filter((entry) => entry.target?.sessionId === 'session-test');
  const before = mine.length;
  assert.ok(before > 0);

  writeFileSync(path.join(LATE_DIR, 'watch-state.json'), '{"version":1,"sessions":{}}\n', 'utf8');
  const { value } = await call('ssq_check', { date: night });
  const after = (await schedule.catalog()).filter((entry) => entry.target?.sessionId === 'session-test');

  assert.equal(value.status, 'pending');
  assert.equal(after.length, before, '状态丢失后重复创建了补抓任务');
  await call('ssq_watch_disable', {});
});

/* --------------------------- 缺口与快照 --------------------------- */

await checkAsync('任意缺口（最新 3 期 + 中间 1 期）：一次检查就补齐', async () => {
  const before = readJsonl(LATE_DIR);
  // 同样避开上一条用例写入的造数据期号，只删官网确实有的期次
  const tail = before.filter((draw) => draw.issue <= '2026130').slice(0, 3);
  const middle = before[500];             // 历史中间某期
  const victims = new Set([...tail.map((d) => d.issue), middle.issue]);
  writeFileSync(
    path.join(LATE_DIR, 'ssq_draws.jsonl'),
    `${before.filter((draw) => !victims.has(draw.issue)).map((draw) => JSON.stringify(draw)).join('\n')}\n`,
    'utf8',
  );
  assert.equal(readJsonl(LATE_DIR).length, before.length - 4);

  // 用一个「未来开奖日」触发检查：本期必然未发布，但存档仍应被对齐到完整状态。
  const { value } = await call('ssq_check', { date: FUTURE_NIGHT });
  assert.equal(value.status, 'pending');

  const after = readJsonl(LATE_DIR);
  assert.equal(after.length, before.length, '缺口没有被完全补齐');
  for (const issue of victims) {
    assert.ok(after.some((draw) => draw.issue === issue), `第 ${issue} 期没有补回`);
  }
  const issues = after.map((draw) => draw.issue);
  assert.equal(new Set(issues).size, issues.length, '补回后出现重复期号');
});

await checkAsync('全量快照不依赖旧存档：删掉整个存档后也能重建', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ssq-plugin-empty-'));
  const previous = process.env.SSQ_DATA_DIR;
  process.env.SSQ_DATA_DIR = dir;
  try {
    const { value } = await call('ssq_check', { date: FUTURE_NIGHT });
    assert.equal(value.status, 'pending');
    const draws = readJsonl(dir);
    assert.ok(draws.length > 2000, `空存档没有被重建：${draws.length} 期`);
    await call('ssq_watch_disable', {});
  } finally {
    process.env.SSQ_DATA_DIR = previous;
  }
});

/* ----------------------------- 斜杠命令 ----------------------------- */

async function runCommand(rawInput) {
  const definition = commandDefs.get('ssq-watch');
  assert.ok(definition, '命令 /ssq-watch 未注册');
  return definition.handler({ commandId: 'cmd-1', agent, rawInput, attachments: [], signal });
}

check('命令注册：/ssq-watch 带说明与输入提示', () => {
  const definition = commandDefs.get('ssq-watch');
  assert.ok(definition);
  assert.match(definition.description, /双色球/);
  assert.equal(definition.input?.hint, 'on | off | status');
});

await checkAsync('/ssq-watch on：启用并绑定当前会话', async () => {
  const result = await runCommand(' on');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已启用|已经在运行/);
  const left = (await schedule.catalog()).filter((entry) => entry.target?.sessionId === 'session-test');
  assert.ok(left.some((entry) => entry.kind === 'weekly'));
});

await checkAsync('/ssq-watch status：输出周期任务与补抓', async () => {
  const result = await runCommand(' status');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /周期任务/);
  assert.match(result.text, /待补抓/);
});

await checkAsync('/ssq-watch off：删除本会话全部任务', async () => {
  const result = await runCommand(' off');
  assert.equal(result.kind, 'success');
  const left = (await schedule.catalog()).filter((entry) => entry.target?.sessionId === 'session-test');
  assert.equal(left.length, 0);
});

await checkAsync('/ssq-watch 未知参数：返回用法错误', async () => {
  const result = await runCommand(' foo');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法/);
});

/* ----------------------------- 结果 ----------------------------- */

const failed = results.filter((item) => !item.ok);
for (const item of results) {
  console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}${item.note && !item.ok ? `\n      ${item.note}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
console.log(`测试存档目录：${DATA_DIR}`);
process.exitCode = failed.length === 0 ? 0 : 1;
