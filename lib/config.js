/**
 * 插件配置（cordis.patch.yml 里那一行的 config）。
 *
 * 只放开奖夜时间与补抓节奏这几项：数据层和存档目录都随包走，不需要配置。
 */

import z from '@deepseek-ai/schemastery';

/** 默认值只写这一份：schema 默认值、工具说明、README 都从这取。 */
export const DEFAULTS = Object.freeze({
  /** 开奖夜首次检查时间（中国教育电视台 21:15 直播，官网一般 21:30 前后结算完成）。 */
  weeklyTime: '21:35',
  /** 开奖固定每周二、四、日；ISO 星期：周一 1 … 周日 7。 */
  weekdays: [2, 4, 7],
  timeZone: 'Asia/Shanghai',
  /** 首次未抓到时的补抓阶梯：距当次检查 +5、+15、+45 分钟（21:40 / 21:50 / 22:20）。 */
  retryOffsetsMinutes: [5, 15, 45],
  /** 当天始终没抓到，次日早上再补一次。 */
  nextMorningTime: '06:00',
});

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

export const Config = z.object({
  weeklyTime: z
    .string()
    .default(DEFAULTS.weeklyTime)
    .description('开奖夜首次检查时间（配置时区内的 HH:mm 或 HH:mm:ss）。'),
  weekdays: z
    .array(z.natural().min(1).max(7))
    .default([...DEFAULTS.weekdays])
    .description('开奖日，ISO 星期（周一 1 … 周日 7）。默认周二/四/日。'),
  timeZone: z
    .string()
    .default(DEFAULTS.timeZone)
    .description('开奖时间所用 IANA 时区。'),
  retryOffsetsMinutes: z
    .array(z.natural().min(1).max(120))
    .default([...DEFAULTS.retryOffsetsMinutes])
    .description('首次没抓到时的补抓阶梯（分钟，相对当次检查）。'),
  nextMorningTime: z
    .string()
    .default(DEFAULTS.nextMorningTime)
    .description('补抓阶梯用尽后的次日兜底时间（配置时区内的 HH:mm）。'),
});

/**
 * 整棵 schema 标成 volatile：设置面板会把下面所有字段投影成可热更新的表单，
 * 保存后 Loader 原地更新 config，下一次工具调用就生效（不用重启）。
 */
Config.meta.volatile = true;

/** Loader 传入的原始 config → 补齐默认值、做轻校验后的配置。 */
export function resolveConfig(raw) {
  const input = raw ?? {};
  const weeklyTime = normalizeTime(input.weeklyTime, DEFAULTS.weeklyTime);
  const weekdays = normalizeWeekdays(input.weekdays);
  const retryOffsetsMinutes = normalizeOffsets(input.retryOffsetsMinutes);
  return Object.freeze({
    weeklyTime,
    weekdays,
    timeZone: String(input.timeZone ?? '').trim() || DEFAULTS.timeZone,
    retryOffsetsMinutes,
    nextMorningTime: normalizeTime(input.nextMorningTime, DEFAULTS.nextMorningTime),
  });
}

/** 'HH:mm' / 'HH:mm:ss' → 'HH:mm:ss'；非法值退回默认值。 */
export function normalizeTime(value, fallback) {
  const text = String(value ?? '').trim();
  if (!TIME_PATTERN.test(text)) return fallback.length === 5 ? `${fallback}:00` : fallback;
  return text.length === 5 ? `${text}:00` : text;
}

function normalizeWeekdays(value) {
  const raw = Array.isArray(value) ? value : DEFAULTS.weekdays;
  const days = [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))];
  return days.length > 0 ? days.sort((a, b) => a - b) : [...DEFAULTS.weekdays];
}

function normalizeOffsets(value) {
  const raw = Array.isArray(value) ? value : DEFAULTS.retryOffsetsMinutes;
  const minutes = [...new Set(raw.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))];
  return minutes.length > 0 ? minutes.sort((a, b) => a - b) : [...DEFAULTS.retryOffsetsMinutes];
}
