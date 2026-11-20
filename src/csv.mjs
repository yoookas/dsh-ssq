/**
 * 把规范化后的开奖记录导出为 CSV / JSONL。
 * CSV 为宽表：每期一行，6 个奖级的注数与单注奖金各自成列，方便直接丢进 Excel / SQLite / pandas。
 */

import { TIER_NAMES } from './normalize.mjs';

export const CSV_COLUMNS = [
  'issue',
  'date',
  'weekday',
  'red1',
  'red2',
  'red3',
  'red4',
  'red5',
  'red6',
  'blue',
  'sales',
  'pool',
  ...TIER_NAMES.flatMap((_, i) =>
    i === 0
      ? ['t1_winners', 't1_prize', 't1_prize_note']
      : [`t${i + 1}_winners`, `t${i + 1}_prize`],
  ),
  'first_prize_places',
  'detail_url',
];

const escape = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function drawToRow(d) {
  return [
    d.issue,
    d.date,
    d.weekday,
    ...Array.from({ length: 6 }, (_, i) => d.red[i] ?? ''),
    d.blue,
    d.sales,
    d.pool,
    ...d.tiers.flatMap((t, i) =>
      i === 0 ? [t.winners, t.prize, t.prizeNote] : [t.winners, t.prize],
    ),
    d.firstPrizePlaces,
    d.detailUrl,
  ];
}

export function toCsv(draws) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const d of draws) lines.push(drawToRow(d).map(escape).join(','));
  return `${lines.join('\n')}\n`;
}

export function toJsonl(draws) {
  return draws.map((d) => JSON.stringify(d)).join('\n') + (draws.length ? '\n' : '');
}
