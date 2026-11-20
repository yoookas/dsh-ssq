/**
 * 时区与日期工具。
 *
 * 「开奖日」「21:35」「次日 06:00」都按配置时区（默认 Asia/Shanghai）计算，
 * 但 dsh 的 schedule 服务只认 UTC 时刻，所以这里做本地墙钟 ↔ UTC 的换算。
 * 只用 Node 自带的 Intl，不引入日期库。
 */

const formatterCache = new Map();

function formatter(timeZone) {
  let f = formatterCache.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

/** 某一时刻在指定时区的墙钟字段。 */
export function zonedParts(ts, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(ts));
  const out = {};
  for (const part of parts) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return {
    date: `${out.year}-${out.month}-${out.day}`,
    time: `${out.hour}:${out.minute}:${out.second}`,
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
  };
}

/** 指定时刻在该时区相对 UTC 的偏移（毫秒，东八区为 +28800000）。 */
export function zoneOffsetMs(ts, timeZone) {
  const parts = zonedParts(ts, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - (ts - (ts % 1000));
}

/** 时区里的某天某个时刻 → UTC 毫秒。'2026-11-22' + '06:00:00' + Asia/Shanghai。 */
export function zonedToUtc(date, time, timeZone) {
  const [year, month, day] = String(date).split('-').map(Number);
  const [hour, minute, second = 0] = String(time).split(':').map(Number);
  const local = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = local - zoneOffsetMs(local, timeZone);
  const settled = zoneOffsetMs(ts, timeZone);
  if (settled !== local - ts) ts = local - settled;
  return ts;
}

/** ISO 星期：周一 1 … 周日 7。 */
export function isoWeekday(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 日历减法（与时区无关，按 Y-M-D 计）。 */
export function addDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const WEEKDAY_NAMES = ['一', '二', '三', '四', '五', '六', '日'];

export function weekdayName(date) {
  return WEEKDAY_NAMES[isoWeekday(date) - 1];
}

/** 人类可读的「2026-11-22 21:35 (周日)」。 */
export function formatInstant(ts, timeZone) {
  const parts = zonedParts(ts, timeZone);
  return `${parts.date} ${parts.time.slice(0, 5)} (周${weekdayName(parts.date)})`;
}

export function formatDateZoned(ts, timeZone) {
  return zonedParts(ts, timeZone).date;
}
