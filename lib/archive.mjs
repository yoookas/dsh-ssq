/**
 * 本地存档：与 CLI 共用 data/ssq_draws.jsonl（每行一条规范化记录）。
 *
 * 读：按 mtime+size 缓存，避免每次工具调用都重解析 2000 多行。
 * 写：沿用项目里的 toJsonl / toCsv / summarize，保证插件落盘和 `node bin/ssq.mjs fetch`
 *    写出来的东西完全一致；写文件走 tmp + rename，不会留下半个文件。
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const archiveCache = new Map();

export function archiveFiles(dataDir) {
  return {
    dir: dataDir,
    jsonl: path.join(dataDir, 'ssq_draws.jsonl'),
    csv: path.join(dataDir, 'ssq_draws.csv'),
    summary: path.join(dataDir, 'summary.json'),
    latest: path.join(dataDir, 'latest.json'),
    state: path.join(dataDir, 'watch-state.json'),
  };
}

const byIssueDesc = (a, b) => String(b.issue).localeCompare(String(a.issue));

/** 读存档；文件不存在时返回空存档（不抛错）。 */
export async function readArchive(dataDir) {
  const files = archiveFiles(dataDir);
  let info;
  try {
    info = await stat(files.jsonl);
  } catch {
    return { drawCount: 0, latest: null, draws: [], exists: false };
  }
  const cached = archiveCache.get(files.jsonl);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;

  const text = await readFile(files.jsonl, 'utf8');
  // 按期号去重：同一期以「后出现的行」为准。正常写入不会产生重复，
  // 但如果文件被别的工具/旧版本写脏过，这里保证读出的一定是唯一期号。
  const byIssue = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const draw = JSON.parse(trimmed);
      if (draw?.issue) byIssue.set(String(draw.issue), draw);
    } catch {
      /* 坏行跳过：存档里偶尔出现半行不影响其它期 */
    }
  }
  const draws = [...byIssue.values()].sort(byIssueDesc);
  const value = { drawCount: draws.length, latest: draws[0] ?? null, draws, exists: true };
  archiveCache.set(files.jsonl, { mtimeMs: info.mtimeMs, size: info.size, value });
  return value;
}

/** 合并：同一期号以新抓到的为准，按「期号倒序」返回。 */
export function mergeDraws(existing, incoming) {
  const map = new Map();
  for (const draw of existing) map.set(draw.issue, draw);
  for (const draw of incoming) map.set(draw.issue, draw);
  return [...map.values()].sort(byIssueDesc);
}

/** 落盘：JSONL + CSV + summary + latest，四件套与 CLI 同构。 */
export async function writeArchive(project, dataDir, draws) {
  const files = archiveFiles(dataDir);
  await mkdir(dataDir, { recursive: true });
  const { toJsonl, toCsv, summarize, SOURCE_INFO } = project;

  await writeAtomic(files.jsonl, toJsonl(draws));
  await writeAtomic(files.csv, toCsv(draws));
  await writeAtomic(
    files.summary,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE_INFO, ...summarize(draws) }, null, 2)}\n`,
  );
  await writeAtomic(
    files.latest,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE_INFO, data: draws.slice(0, 10) }, null, 2)}\n`,
  );
  archiveCache.delete(files.jsonl);
  return files;
}

/* -------------------------- 写入串行化 -------------------------- */

/**
 * 每个存档目录一条写队列。
 *
 * 读-改-写必须在同一条队列里完成：否则「全量同步」和「开奖夜增量合并」并发时，
 * 后写的那个会用它读到的旧快照覆盖前者刚补进去的期数（丢数据）。
 * 队列放在模块级，同一进程内跨工具调用、跨会话共享。
 */
const writeQueues = new Map();

function withArchiveLock(dataDir, task) {
  const key = path.join(dataDir, 'ssq_draws.jsonl');
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  // 队列本身不因单次失败而中断；调用方仍然收到这一次的真实结果。
  writeQueues.set(
    key,
    run.catch(() => {}),
  );
  return run;
}

/**
 * 合并并落盘（串行、幂等）。
 *
 * 同一期号重复合并只会保留一份（后到的覆盖先到的），所以重复抓取、补抓重跑、
 * 甚至两个会话同时抓，都不会在存档里留下重复期次。
 *
 * @returns {Promise<{added:number,total:number,latest:object|null,files:object}>}
 *   added 是「真正新增的期数」（按去重后的差额算）。
 */
export async function mutateArchive(project, dataDir, incoming) {
  return withArchiveLock(dataDir, async () => {
    // 队列内重新读盘：拿到的是上一个写操作提交后的最新状态。
    const archive = await readArchive(dataDir);
    const merged = mergeDraws(archive.draws, incoming);
    const added = merged.length - archive.draws.length;
    const files = await writeArchive(project, dataDir, merged);
    return { added, total: merged.length, latest: merged[0] ?? null, files };
  });
}

/** 读插件自己的状态（周期任务 id、补抓任务 id、每期结论）。 */
export async function readState(dataDir) {
  const files = archiveFiles(dataDir);
  try {
    const parsed = JSON.parse(await readFile(files.state, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.sessions && typeof parsed.sessions === 'object') {
      return { version: 1, sessions: parsed.sessions };
    }
  } catch {
    /* 没有状态文件或内容损坏：当成全新状态，下一次写入会重建 */
  }
  return { version: 1, sessions: {} };
}

export async function writeState(dataDir, state) {
  const files = archiveFiles(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeAtomic(files.state, `${JSON.stringify(state, null, 2)}\n`);
}

async function writeAtomic(file, content) {
  // 随机后缀：同一进程同一毫秒内的两次写不会撞到同一个临时文件名。
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/**
 * 往期数据筛选 + 分页。
 * @param {object[]} draws 按倒序排好的规范化记录
 */
export function queryDraws(draws, { fromIssue, toIssue, year, fromDate, toDate, page = 1, pageSize = 20 }) {
  const filtered = draws.filter((draw) => {
    if (fromIssue && String(draw.issue) < String(fromIssue)) return false;
    if (toIssue && String(draw.issue) > String(toIssue)) return false;
    if (year && !String(draw.issue).startsWith(String(year))) return false;
    if (fromDate && draw.date < fromDate) return false;
    if (toDate && draw.date > toDate) return false;
    return true;
  });
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), pages);
  const start = (safePage - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize);
  return {
    total,
    page: safePage,
    pages,
    pageSize,
    rows,
    first: filtered[0] ?? null,
    last: filtered.at(-1) ?? null,
  };
}
