/**
 * 把官网原始记录整理成稳定的、可序列化的结构。
 * 输出里 tiers 固定 6 项，缺失字段一律为 null（而不是 0），避免把「没数据」误当成「0 注」。
 */

export const TIER_NAMES = ['一等奖', '二等奖', '三等奖', '四等奖', '五等奖', '六等奖'];

/** 各奖级的中奖条件（现行规则）。 */
export const TIER_RULES = [
  '6 红 + 1 蓝',
  '6 红',
  '5 红 + 1 蓝',
  '5 红 或 4 红 + 1 蓝',
  '4 红 或 3 红 + 1 蓝',
  '2/1/0 红 + 1 蓝',
];

const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/**
 * 奖金字段可能带中文注解，例如：
 *   5250000（含加奖250000）
 *   5269907（含派奖999999）
 * 这里拆成「数值 + 注解」，数值取前导数字，注解原样保留，避免把整列解析成 null。
 */
export function splitMoney(v) {
  const s = String(v ?? '').trim();
  if (!s) return { value: null, note: null };
  const m = /^([\d.]+)\s*([\s\S]*)$/.exec(s);
  if (!m) return { value: null, note: s };
  const n = Number(m[1]);
  return { value: Number.isFinite(n) ? n : null, note: m[2].trim() || null };
}

/** '2026-11-19(四)' -> { date: '2026-11-19', weekday: '四' } */
export function parseDate(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})\s*(?:[(（]([^)）]+)[)）])?/.exec(s);
  return { date: m?.[1] ?? s, weekday: m?.[2] ?? '' };
}

export function normalizeDraw(raw) {
  const { date, weekday } = parseDate(raw?.date);
  const red = String(raw?.red ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const blue = String(raw?.blue ?? '').trim();

  const grades = Array.isArray(raw?.prizegrades) ? raw.prizegrades : [];
  const tiers = TIER_NAMES.map((name, i) => {
    const level = i + 1;
    const g = grades.find((x) => Number(x?.type) === level) ?? {};
    const money = splitMoney(g.typemoney);
    return {
      level,
      name,
      rule: TIER_RULES[i],
      winners: toInt(g.typenum),
      prize: money.value,
      /** 奖金注解，目前只有一等奖出现过（含加奖 / 含派奖），其余为 null */
      prizeNote: money.note,
    };
  });

  const notes = [raw?.prizeSpecialInfo, raw?.specialRuleInfo, raw?.compLimitInfo]
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join(' ');

  return {
    issue: String(raw?.code ?? ''),
    date,
    weekday,
    red,
    blue,
    /** 本期销售额（元） */
    sales: toInt(raw?.sales),
    /** 奖池滚存（元） */
    pool: toInt(raw?.poolmoney),
    /** 6 个奖级，顺序固定：一等奖 … 六等奖 */
    tiers,
    /** 一等奖中奖地区分布，如「山西1注，…，共17注。」 */
    firstPrizePlaces: String(raw?.content ?? '').trim() || null,
    /** 派奖 / 封顶等特殊说明 */
    notes: notes || null,
    /** 官网上该期的开奖公告页 */
    detailUrl: raw?.detailsLink
      ? new URL(raw.detailsLink, 'https://www.cwl.gov.cn').href
      : null,
    source: 'cwl.gov.cn',
  };
}

export function normalizeDraws(rawDraws) {
  return rawDraws.map(normalizeDraw);
}

/** 汇总统计：各奖级总注数、单期最大/最小、平均。 */
export function summarize(draws) {
  const tiers = TIER_NAMES.map((name, i) => {
    const nums = draws
      .map((d) => d.tiers[i]?.winners)
      .filter((n) => typeof n === 'number');
    const sum = nums.reduce((a, b) => a + b, 0);
    return {
      level: i + 1,
      name,
      drawsWithData: nums.length,
      totalWinners: sum,
      avgWinners: nums.length ? Number((sum / nums.length).toFixed(1)) : null,
      maxWinners: nums.length ? Math.max(...nums) : null,
      minWinners: nums.length ? Math.min(...nums) : null,
    };
  });

  const issues = draws.map((d) => d.issue).sort();
  return {
    draws: draws.length,
    firstIssue: issues[0] ?? null,
    lastIssue: issues.at(-1) ?? null,
    firstDate: draws.at(-1)?.date ?? null,
    lastDate: draws[0]?.date ?? null,
    totalSales: draws.reduce((a, d) => a + (d.sales ?? 0), 0),
    tiers,
  };
}
