#!/usr/bin/env node
/**
 * 双色球开奖数据 CLI（数据源：中国福利彩票官网，2013-01-01 至今）。
 *
 *   node bin/ssq.mjs info
 *   node bin/ssq.mjs latest --count 5
 *   node bin/ssq.mjs fetch            # 全量落盘到 data/
 *   node bin/ssq.mjs check            # 校验已落盘数据
 */

import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

import {
  SOURCE_INFO,
  CwlError,
  buildUrl,
  fetchAll,
  fetchPage,
  fetchRecent,
} from '../src/cwl.mjs';
import { normalizeDraws, summarize } from '../src/normalize.mjs';
import { toCsv, toJsonl } from '../src/csv.mjs';

const USAGE = `用法: ssq <command> [options]

命令:
  info                      查看数据源信息与当前期数
  latest [-n N] [--json]    查看最近 N 期（默认 5，最多 100）
  fetch                     抓取全量并写入 out 目录（CSV + JSONL + summary）
  check [--file <path>]     校验数据文件（缺奖级 / 重复 / 排序 / 日期）
  watch                     开奖夜轮询，测「第几秒能查到新一期」

fetch 选项:
  --out <dir>          输出目录，默认 ./data
  --page-size <n>      每页条数，默认 100（接口上限）
  --concurrency <n>    并发数，默认 2
  --delay <ms>         请求间隔，默认 120
  --pages <n>          只抓前 n 页（调试用）
  --no-cache           忽略本地分页缓存

watch 选项（用来实测发布延迟，开奖夜跑）:
  --interval <s>       轮询间隔秒数，默认 60
  --max-wait <min>     最长等待分钟数，默认 180
  --baseline <issue>   基准期号，默认取当前最新一期
  --out <dir>          观测日志写入 <dir>/watch-log.jsonl`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'data' },
    count: { type: 'string', short: 'n', default: '5' },
    'page-size': { type: 'string', default: '100' },
    concurrency: { type: 'string', default: '2' },
    delay: { type: 'string', default: '120' },
    pages: { type: 'string' },
    cache: { type: 'boolean', default: true },
    'no-cache': { type: 'boolean', default: false },
    file: { type: 'string' },
    interval: { type: 'string', default: '60' },
    'max-wait': { type: 'string', default: '180' },
    baseline: { type: 'string' },
    json: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const cmd = positionals[0] ?? 'help';
const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const fmt = new Intl.NumberFormat('zh-CN');

async function writeAtomic(file, content) {
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}

/** 分页缓存：让 fetch 可断点续跑，也避免重复打接口。 */
function cacher(dir, pageSize, enabled) {
  return {
    async get(pageNo) {
      if (!enabled) return null;
      try {
        return JSON.parse(await readFile(path.join(dir, `page-${pageSize}-${pageNo}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
    async put(pageNo, payload) {
      if (!enabled) return;
      await mkdir(dir, { recursive: true });
      await writeAtomic(path.join(dir, `page-${pageSize}-${pageNo}.json`), JSON.stringify(payload));
    },
  };
}

async function cmdInfo() {
  const page = await fetchPage({ pageNo: 1, pageSize: 1 });
  console.log(`数据源   ${SOURCE_INFO.name}`);
  console.log(`接口     ${SOURCE_INFO.endpoint}`);
  console.log(`覆盖     ${SOURCE_INFO.coverage}（最早第 ${SOURCE_INFO.earliestIssue} 期）`);
  console.log(`奖级     ${SOURCE_INFO.tierCount} 个，每期含中奖注数 + 单注奖金`);
  console.log(`总期数   共 ${page.total} 期`);
  const latest = await fetchRecent(1);
  const d = latest[0];
  console.log(
    `最新一期 ${d.code}  ${d.date}  红 ${d.red}  蓝 ${d.blue}` +
      `  一等奖 ${d.prizegrades[0]?.typenum} 注 × ${d.prizegrades[0]?.typemoney} 元`,
  );
  console.log(`示例URL  ${buildUrl({ pageNo: 1, pageSize: 5 })}`);
}

async function cmdLatest() {
  const count = Math.max(1, Math.min(num(values.count, 5), SOURCE_INFO.maxPageSize));
  const draws = normalizeDraws(await fetchRecent(count));
  if (values.json) {
    console.log(JSON.stringify(draws, null, 2));
    return;
  }
  console.log(`最近 ${draws.length} 期（${SOURCE_INFO.name}）\n`);
  for (const d of draws) {
    console.log(`${d.issue}  ${d.date}(${d.weekday})  红 ${d.red.join(' ')}  蓝 ${d.blue}`);
    console.log(
      `  销售额 ${fmt.format(d.sales ?? 0)} 元   奖池 ${fmt.format(d.pool ?? 0)} 元`,
    );
    for (const t of d.tiers) {
      console.log(
        `  ${t.name}  ${String(t.winners ?? '-').padStart(9)} 注 × ${String(t.prize ?? '-').padStart(8)} 元`,
      );
    }
    if (d.firstPrizePlaces) console.log(`  一等奖分布: ${d.firstPrizePlaces}`);
    console.log();
  }
}

async function cmdFetch() {
  const out = path.resolve(values.out);
  const pageSize = Math.min(num(values['page-size'], 100), SOURCE_INFO.maxPageSize);
  const concurrency = Math.max(1, num(values.concurrency, 2));
  const delayMs = Math.max(0, num(values.delay, 120));
  const maxPages = values.pages ? Math.max(1, num(values.pages, 1)) : Infinity;
  const cacheDir = path.join(out, '.cache');
  const cache = cacher(cacheDir, pageSize, values.cache && !values['no-cache']);

  const t0 = Date.now();
  const collected = [];
  let meta = { total: 0, pages: 0 };

  const spin = (msg) => {
    if (!values.quiet) process.stderr.write(`\r${msg}\x1b[K`);
  };

  const first = (await cache.get(1)) ?? (await fetchPage({ pageNo: 1, pageSize }));
  await cache.put(1, first);
  meta.total = first.total;
  const pages = Math.min(Math.ceil(first.total / pageSize) || 1, maxPages);
  meta.pages = pages;
  collected.push(...first.result);
  spin(`[1/${pages}] 已获取 ${collected.length}/${first.total} 期`);

  let next = 2;
  const worker = async () => {
    for (;;) {
      const pageNo = next;
      next += 1;
      if (pageNo > pages) return;
      let payload = await cache.get(pageNo);
      if (!payload) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        payload = await fetchPage({ pageNo, pageSize, onRetry: ({ attempt, wait }) => spin(`第 ${pageNo} 页重试 ${attempt}，${wait}ms 后再试`) });
        await cache.put(pageNo, payload);
      }
      collected.push(...payload.result);
      spin(`[${pageNo}/${pages}] 已获取 ${collected.length}/${first.total} 期`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(pages - 1, 0)) }, worker));

  const draws = normalizeDraws(collected).sort((a, b) => b.issue.localeCompare(a.issue));
  const deduped = [...new Map(draws.map((d) => [d.issue, d])).values()];
  const summary = summarize(deduped);

  await mkdir(out, { recursive: true });
  await writeAtomic(path.join(out, 'ssq_draws.csv'), toCsv(deduped));
  await writeAtomic(path.join(out, 'ssq_draws.jsonl'), toJsonl(deduped));
  await writeAtomic(
    path.join(out, 'latest.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE_INFO, data: deduped.slice(0, 10) }, null, 2),
  );
  await writeAtomic(
    path.join(out, 'summary.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), source: SOURCE_INFO, ...summary }, null, 2),
  );

  if (!values.quiet) process.stderr.write('\r\x1b[K');
  console.log(`已写入 ${out}`);
  console.log(`  期数 ${summary.draws}  ${summary.firstIssue}（${summary.firstDate}）→ ${summary.lastIssue}（${summary.lastDate}）`);
  console.log(`  耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const t of summary.tiers) {
    console.log(
      `  ${t.name} 合计 ${String(fmt.format(t.totalWinners)).padStart(12)} 注` +
        `   单期均值 ${String(t.avgWinners).padStart(9)}   最高 ${String(t.maxWinners).padStart(9)}`,
    );
  }
}

/**
 * 轮询到「出现比基准更新的期号」为止，记录检出时刻，并换算成距开奖（当天 21:15 +08:00）的分钟数。
 * 只有当 watch 在开奖当晚启动时，这个数字才有意义；白天启动会测到「已经发布很久」，脚本会自行标注。
 */
async function cmdWatch() {
  const out = path.resolve(values.out);
  const intervalMs = Math.max(10, num(values.interval, 60)) * 1000;
  const maxWaitMs = Math.max(1, num(values['max-wait'], 180)) * 60000;
  const first = normalizeDraws(await fetchRecent(1))[0];
  const baseline = values.baseline ? String(values.baseline) : first.issue;
  const startedAt = Date.now();

  console.log(`基准期号 ${baseline}（${first.date}）；每 ${intervalMs / 1000}s 查一次，最长等 ${maxWaitMs / 60000} 分钟`);
  console.log('Ctrl-C 可随时退出；检出后写入 data/watch-log.jsonl\n');

  for (;;) {
    let latest;
    try {
      latest = normalizeDraws(await fetchRecent(1))[0];
    } catch (err) {
      console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] 查询失败：${err.message}`);
      latest = null;
    }

    if (latest && latest.issue !== baseline) {
      const detectedAt = Date.now();
      const scheduled = Date.parse(`${latest.date}T21:15:00+08:00`);
      const lagMinutes = Number(((detectedAt - scheduled) / 60000).toFixed(1));
      const record = {
        issue: latest.issue,
        date: latest.date,
        baseline,
        scheduledAt: new Date(scheduled).toISOString(),
        detectedAt: new Date(detectedAt).toISOString(),
        lagMinutes,
        firstPrizeWinners: latest.tiers[0].winners,
        firstPrize: latest.tiers[0].prize,
        sales: latest.sales,
      };
      await mkdir(out, { recursive: true });
      await appendFile(path.join(out, 'watch-log.jsonl'), `${JSON.stringify(record)}\n`, 'utf8');

      console.log(`检出第 ${latest.issue} 期  于 ${new Date(detectedAt).toLocaleString('zh-CN', { hour12: false })}`);
      console.log(`距开奖（${latest.date} 21:15）${lagMinutes} 分钟`);
      if (lagMinutes > 180) {
        console.log('注意：这个数字只是「启动时数据早就在了」，不代表首发延迟。要测准请在开奖当晚 21:10 前启动。');
      }
      console.log(`已记录到 ${path.join(out, 'watch-log.jsonl')}`);
      return;
    }

    if (Date.now() - startedAt > maxWaitMs) {
      console.log(`等待 ${maxWaitMs / 60000} 分钟仍未出现新一期，退出`);
      process.exitCode = 2;
      return;
    }

    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const waited = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`[${stamp}] 仍是最新 ${baseline}，已等 ${waited} 分钟`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

async function cmdCheck() {
  const file = path.resolve(values.file ?? path.join(values.out, 'ssq_draws.jsonl'));
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    console.error(`找不到 ${file}，请先运行: node bin/ssq.mjs fetch`);
    process.exitCode = 1;
    return;
  }
  const draws = text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const problems = [];
  const seen = new Set();
  for (const d of draws) {
    if (seen.has(d.issue)) problems.push(`重复期号 ${d.issue}`);
    seen.add(d.issue);
    if (!/^\d{7}$/.test(d.issue)) problems.push(`期号格式异常 ${d.issue}`);
    if (!Array.isArray(d.red) || d.red.length !== 6) problems.push(`${d.issue} 红球数不是 6`);
    if (!d.blue) problems.push(`${d.issue} 缺蓝球`);
    if (!Array.isArray(d.tiers) || d.tiers.length !== 6) problems.push(`${d.issue} 奖级数不是 6`);
    const missing = d.tiers.filter((t) => typeof t.winners !== 'number').map((t) => t.name);
    if (missing.length) problems.push(`${d.issue} 缺中奖注数: ${missing.join('/')}`);
    const missingPrize = d.tiers.filter((t) => typeof t.prize !== 'number').map((t) => t.name);
    if (missingPrize.length) problems.push(`${d.issue} 缺单注奖金: ${missingPrize.join('/')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) problems.push(`${d.issue} 日期异常 ${d.date}`);
  }
  const sorted = draws.every((d, i) => i === 0 || draws[i - 1].issue > d.issue);

  console.log(`文件 ${file}`);
  console.log(`期数 ${draws.length}，按行序${sorted ? '严格倒序' : '【未严格倒序】'}`);
  console.log(`问题 ${problems.length} 条`);
  for (const p of problems.slice(0, 20)) console.log(`  - ${p}`);
  if (problems.length > 20) console.log(`  ... 其余 ${problems.length - 20} 条省略`);

  const s = summarize(draws);
  console.log(`范围 ${s.firstIssue}（${s.firstDate}）→ ${s.lastIssue}（${s.lastDate}）`);
  for (const t of s.tiers) {
    console.log(`  ${t.name} 覆盖 ${t.drawsWithData}/${s.draws} 期，中奖 ${fmt.format(t.totalWinners)} 注`);
  }
}

try {
  if (values.help || cmd === 'help') {
    console.log(USAGE);
  } else if (cmd === 'info') {
    await cmdInfo();
  } else if (cmd === 'latest') {
    await cmdLatest();
  } else if (cmd === 'fetch') {
    await cmdFetch();
  } else if (cmd === 'watch') {
    await cmdWatch();
  } else if (cmd === 'check') {
    await cmdCheck();
  } else {
    console.error(`未知命令: ${cmd}\n`);
    console.log(USAGE);
    process.exitCode = 1;
  }
} catch (err) {
  process.stderr.write('\r\x1b[K');
  if (err instanceof CwlError) {
    console.error(`请求失败: ${err.message}`);
    if (err.body) console.error(`响应片段: ${err.body}`);
  } else {
    console.error(err?.stack ?? String(err));
  }
  process.exitCode = 1;
}
