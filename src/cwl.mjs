/**
 * 中国福利彩票官网「双色球」开奖公告接口客户端。
 *
 * 接口：GET https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice
 * 参数：name=ssq & issueCount=<上限> & pageNo=<从1开始> & pageSize=<每页条数, 实测上限100> & systemType=PC
 * 范围：官网接口固定从 2013-01-01（第 2013001 期）开始，更早的期次不在该接口内。
 * 字段：result[].prizegrades[] 给出 1~6 等奖的 typenum（中奖注数）与 typemoney（单注奖金）。
 *
 * 本模块只依赖 Node 18+ 自带的全局 fetch，无第三方依赖，可被 CLI 或 dsh 插件直接 import。
 */

export const API_BASE =
  'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice';

/** 数据源元信息，便于上层（CLI / 插件 / UI）自描述。 */
export const SOURCE_INFO = Object.freeze({
  id: 'cwl-ssq',
  name: '中国福利彩票官网 · 双色球开奖公告',
  endpoint: API_BASE,
  coverage: '2013-01-01 至今',
  earliestIssue: '2013001',
  maxPageSize: 100,
  tierCount: 6,
  fields: [
    'code 期号',
    'date 开奖日期',
    'red 红球（6 个）',
    'blue 蓝球',
    'sales 本期销售额（元）',
    'poolmoney 奖池滚存（元）',
    'prizegrades[].typenum 各奖级中奖注数',
    'prizegrades[].typemoney 各奖级单注奖金（元）',
    'content 一等奖中奖地区分布',
  ],
});

/** 接口/网络层错误。status 为 0 表示没拿到 HTTP 响应。 */
export class CwlError extends Error {
  constructor(message, { status = 0, url = '', body = '' } = {}) {
    super(message);
    this.name = 'CwlError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

const DEFAULT_HEADERS = {
  // 官网对 UA/Referer 不敏感（实测均可省略），但保持礼貌的默认值。
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  Accept: 'application/json, text/javascript, */*; q=0.01',
  Referer: 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 极简 Cookie Jar。
 *
 * 官网的 CDN 在请求偏快时会返回 302 到同一地址并下发 `C3VK` 挑战 cookie（Max-Age=300），
 * 带上它再请求就恢复正常。Node 的 fetch 不保存 Cookie，所以这里自己存一份：
 * 按 host 记录，命中就带上；过期后（Max-Age=0 / expires 1970）删掉。
 */
const cookieJar = new Map();

function absorbCookies(url, response) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    return;
  }
  const header = response?.headers;
  if (!header) return;
  const list =
    typeof header.getSetCookie === 'function'
      ? header.getSetCookie()
      : [header.get('set-cookie')].filter(Boolean);
  if (!Array.isArray(list) || list.length === 0) return;

  let jar = cookieJar.get(host);
  if (!jar) {
    jar = new Map();
    cookieJar.set(host, jar);
  }
  for (const raw of list) {
    const first = String(raw).split(';')[0].trim();
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    const lower = String(raw).toLowerCase();
    if (!name) continue;
    if (/max-age=0(?:$|;)/.test(lower) || lower.includes('expires=thu, 01 jan 1970')) jar.delete(name);
    else jar.set(name, value);
  }
}

function cookieHeaderFor(url) {
  try {
    const jar = cookieJar.get(new URL(url).host);
    if (!jar || jar.size === 0) return null;
    return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  } catch {
    return null;
  }
}

function headersFor(url, extra) {
  const cookie = cookieHeaderFor(url);
  return cookie ? { ...DEFAULT_HEADERS, ...extra, Cookie: cookie } : { ...DEFAULT_HEADERS, ...extra };
}

function isRedirect(status) {
  return status >= 300 && status < 400;
}

/** 构造请求 URL，便于调试与日志。 */
export function buildUrl({ pageNo = 1, pageSize = 100, issueCount = 30000 } = {}) {
  const url = new URL(API_BASE);
  url.searchParams.set('name', 'ssq');
  url.searchParams.set('issueCount', String(issueCount));
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('systemType', 'PC');
  return url.toString();
}

function combineSignals(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

async function requestOnce(url, { timeoutMs = 20000, signal, fetchImpl = fetch } = {}) {
  const requestSignal = combineSignals(signal, timeoutMs);
  const send = async (target) => {
    const res = await fetchImpl(target, {
      headers: headersFor(target),
      redirect: 'manual',
      signal: requestSignal,
    });
    absorbCookies(target, res);
    return res;
  };

  let res;
  try {
    res = await send(url);
    // CDN 挑战：302 到同一地址并下发 cookie。带上它再打一次，最多跟一跳。
    if (isRedirect(res.status)) {
      const location = res.headers.get('location');
      if (location) {
        // 跟一跳（挑战页通常 302 回同一地址），send() 会带上刚拿到的 cookie。
        res = await send(new URL(location, url).href);
      }
    }
  } catch (err) {
    const reason = err?.name === 'TimeoutError' ? `请求超时（>${timeoutMs}ms）` : err?.message || String(err);
    throw new CwlError(`网络请求失败：${reason}`, { status: 0, url });
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new CwlError(`HTTP ${res.status} ${res.statusText}`, {
      status: res.status,
      url,
      body: text.slice(0, 500),
    });
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CwlError('响应不是合法 JSON（可能被风控页拦截）', {
      status: res.status,
      url,
      body: text.slice(0, 500),
    });
  }

  if (json?.state !== 0) {
    throw new CwlError(`接口返回失败：state=${json?.state} message=${json?.message ?? ''}`, {
      status: res.status,
      url,
      body: text.slice(0, 500),
    });
  }
  if (!Array.isArray(json.result)) {
    throw new CwlError('响应缺少 result 数组', { status: res.status, url, body: text.slice(0, 500) });
  }
  return json;
}

/**
 * 带指数退避的请求。仅对网络错误 / 5xx / 429 / 解析失败重试；4xx 直接抛出。
 */
export async function requestWithRetry(url, { retries = 4, baseDelayMs = 600, onRetry, ...rest } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestOnce(url, rest);
    } catch (err) {
      lastErr = err;
      const retryable =
        !(err instanceof CwlError) ||
        err.status === 0 ||
        err.status === 429 ||
        err.status >= 500 ||
        // 3xx 只在 CDN 挑战没跟上时出现；带上刚拿到的 cookie 重试一次通常就过了
        (err.status >= 300 && err.status < 400);
      if (attempt === retries || !retryable) break;
      const wait = Math.round(baseDelayMs * 2 ** attempt * (0.7 + Math.random() * 0.6));
      onRetry?.({ attempt: attempt + 1, wait, error: err });
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * 抓取一页原始开奖公告。
 * @returns {Promise<{total:number,pageNo:number,pageSize:number,result:object[]}>}
 */
export async function fetchPage({
  pageNo = 1,
  pageSize = 100,
  issueCount = 30000,
  timeoutMs = 20000,
  retries = 4,
  signal,
  fetchImpl = fetch,
  onRetry,
} = {}) {
  const url = buildUrl({ pageNo, pageSize, issueCount });
  const json = await requestWithRetry(url, { retries, timeoutMs, signal, fetchImpl, onRetry });
  return {
    total: Number(json.total) || 0,
    pageNo: Number(json.pageNo) || pageNo,
    pageSize: Number(json.pageSize) || pageSize,
    result: json.result,
  };
}

/**
 * 取最近 n 期（一次请求即可，pageSize 上限 100）。
 */
export async function fetchRecent(count = 10, opts = {}) {
  const pageSize = Math.min(Math.max(count, 1), SourceMaxPageSize());
  const page = await fetchPage({ ...opts, pageNo: 1, pageSize });
  return page.result.slice(0, count);
}

function SourceMaxPageSize() {
  return SOURCE_INFO.maxPageSize;
}

/**
 * 抓全量（并发 + 间隔，默认 2 并发 / 120ms）。
 * @returns {Promise<{total:number,pages:number,result:object[]}>}
 */
export async function fetchAll({
  pageSize = 100,
  concurrency = 2,
  delayMs = 120,
  onProgress,
  onRetry,
  signal,
} = {}) {
  const first = await fetchPage({ pageNo: 1, pageSize, onRetry, signal });
  const total = first.total;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const result = [...first.result];
  onProgress?.({ pageNo: 1, pages, fetched: result.length, total });

  let nextPage = 2;
  const worker = async () => {
    for (;;) {
      const pageNo = nextPage;
      nextPage += 1;
      if (pageNo > pages) return;
      if (delayMs > 0) await sleep(delayMs);
      const page = await fetchPage({ pageNo, pageSize, onRetry, signal });
      result.push(...page.result);
      onProgress?.({ pageNo, pages, fetched: result.length, total });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(pages - 1, 0)) }, worker),
  );
  return { total, pages, result };
}

/** 按期号去重并按「期号倒序」（最新在前）排序。 */
export function dedupeAndSort(rawDraws) {
  const byIssue = new Map();
  for (const d of rawDraws) {
    if (d?.code) byIssue.set(String(d.code), d);
  }
  return [...byIssue.values()].sort((a, b) => String(b.code).localeCompare(String(a.code)));
}
