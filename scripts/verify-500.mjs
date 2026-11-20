// 临时校验脚本：拿 500.com 的独立历史数据核对官网接口的期号/号码/一二等奖注数。
// 用完即弃，不属于交付物。
import { readFile } from 'node:fs/promises';

const rows = (await readFile(new URL('../data/ssq_draws.jsonl', import.meta.url), 'utf8'))
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byIssue = new Map(rows.map((d) => [d.issue, d]));

const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();

async function fetch500(start, end) {
  const url = `https://datachart.500.com/ssq/history/newinc/history.php?start=${start}&end=${end}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      Referer: 'https://datachart.500.com/ssq/history/history.shtml',
    },
  });
  // 500.com 的行首有一堆 HTML 注释节点（<!--<td>2</td>-->），先剥掉再解析，否则列会整体错位。
  const html = (await res.text()).replace(/<!--[\s\S]*?-->/g, '');
  const out = [];
  for (const m of html.matchAll(/<tr class="t_tr1">([\s\S]*?)<\/tr>/g)) {
    const tds = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    if (tds.length < 16) continue;
    out.push({
      issue: `20${tds[0].slice(0, 2)}${tds[0].slice(2)}`,
      red: tds.slice(1, 7),
      blue: tds[7],
      t1: Number(tds[10]),
      t2: Number(tds[12]),
      date: tds[15],
    });
  }
  return out;
}

const ranges = [
  ['13001', '13100'],
  ['15001', '15100'],
  ['18001', '18100'],
  ['21001', '21100'],
  ['24001', '24100'],
];

let checked = 0;
let mismatch = 0;
for (const [start, end] of ranges) {
  const list = await fetch500(start, end);
  let bad = 0;
  for (const r of list) {
    const mine = byIssue.get(r.issue);
    if (!mine) {
      console.log(`缺失 ${r.issue}`);
      bad += 1;
      continue;
    }
    checked += 1;
    const same =
      mine.red.join(',') === r.red.join(',') &&
      mine.blue === r.blue &&
      mine.tiers[0].winners === r.t1 &&
      mine.tiers[1].winners === r.t2 &&
      mine.date === r.date;
    if (!same) {
      bad += 1;
      mismatch += 1;
      console.log(
        `不一致 ${r.issue}`,
        `官网 ${mine.date} ${mine.red.join(',')}|${mine.blue} T1=${mine.tiers[0].winners} T2=${mine.tiers[1].winners}`,
        `| 500 ${r.date} ${r.red.join(',')}|${r.blue} T1=${r.t1} T2=${r.t2}`,
      );
    }
  }
  console.log(`${start}-${end}: ${list.length} 期，问题 ${bad}`);
  await new Promise((r) => setTimeout(r, 400));
}
console.log(`\n合计核对 ${checked} 期，不一致 ${mismatch} 期`);
