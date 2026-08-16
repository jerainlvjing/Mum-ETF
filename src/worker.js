// ETF 份额每日记录服务 - Cloudflare Workers + D1 版
// 数据源：上交所/深交所场内份额 + 东财 fundselector 流通市值(DEC_NAV)
// 定时任务：每个交易日 23:30（北京时间）自动抓取；首次部署回填 90 个交易日历史

import * as XLSX from 'xlsx';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// 默认 14 只宽基 ETF（代码 + 完整名称）
const ETF_LIST = [
  ['510050', '上证50ETF'],
  ['510180', '上证180ETF'],
  ['510300', '沪深300ETF华泰柏瑞'],
  ['510310', '沪深300ETF易方达'],
  ['510330', '沪深300ETF华夏'],
  ['510500', '中证500ETF南方'],
  ['512100', '中证1000ETF南方'],
  ['512500', '中证500ETF华夏'],
  ['560010', '中证1000ETF广发'],
  ['588000', '科创50ETF华夏'],
  ['588080', '科创50ETF易方达'],
  ['159845', '中证1000ETF华夏'],
  ['159915', '创业板ETF易方达'],
  ['159919', '沪深300ETF嘉实'],
];
const NAME_MAP = Object.fromEntries(ETF_LIST);
const DEFAULT_CODES = ETF_LIST.map((x) => x[0]).join(',');

const isSSE = (c) => c.startsWith('5');   // 510/512/560/588 沪市
const isSZSE = (c) => c.startsWith('15'); // 159 深市

// ---------------- 日期工具（北京时间） ----------------
function shiftDays(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + delta * 86400 * 1000).toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=周日 1-5=工作日
}
function bjToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
// 从 endDate 往前找 days 个工作日（不含 endDate 本身），从近到远
function generateWorkdays(days, endDateStr) {
  const dates = [];
  let d = shiftDays(endDateStr, -1);
  while (dates.length < days) {
    const wd = weekdayOf(d);
    if (wd >= 1 && wd <= 5) dates.push(d);
    d = shiftDays(d, -1);
  }
  return dates;
}

// ---------------- 数据源 ----------------
async function fetchSSE(date, sseCodes) {
  const url = 'https://query.sse.com.cn/commonQuery.do?' + new URLSearchParams({
    isPagination: 'true', 'pageHelp.pageSize': '10000', 'pageHelp.pageNo': '1',
    'pageHelp.beginPage': '1', 'pageHelp.cacheSize': '1', 'pageHelp.endPage': '1',
    sqlId: 'COMMON_SSE_ZQPZ_ETFZL_XXPL_ETFGM_SEARCH_L', STAT_DATE: date,
  });
  const res = await fetch(url, { headers: { Referer: 'https://www.sse.com.cn/', 'User-Agent': UA } });
  const js = await res.json();
  const result = {};
  for (const x of (js.result || [])) {
    const code = x.SEC_CODE;
    if (sseCodes.includes(code)) {
      result[code] = { name: NAME_MAP[code] || x.SEC_NAME, share: (parseFloat(x.TOT_VOL) || 0) * 10000 };
    }
  }
  return result;
}

async function fetchSZSE(start, end, szseCodes) {
  const url = 'https://www.szse.cn/api/report/ShowReport?' + new URLSearchParams({
    SHOWTYPE: 'xlsx', CATALOGID: 'scsj_fund_jjgm', TABKEY: 'tab1',
    txtStart: start, txtEnd: end, jjlb: 'ETF', random: String(Math.random()),
  });
  const res = await fetch(url, { headers: { Referer: 'https://www.szse.cn/market/fund/volume/etf/index.html', 'User-Agent': UA } });
  const buf = await res.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const result = {};
  for (const row of rows.slice(1)) {
    if (!row || row.length < 4) continue;
    const date = String(row[0]).slice(0, 10);
    const code = String(row[1]).trim();
    if (!szseCodes.includes(code)) continue;
    const share = parseFloat(String(row[3]).replace(/,/g, '')) || 0;
    (result[date] = result[date] || {})[code] = { name: NAME_MAP[code] || row[2], share };
  }
  return result;
}

async function fetchMarketValues(codes) {
  const url = 'https://datacenter.eastmoney.com/stock/fundselector/api/data/get?' + new URLSearchParams({
    type: 'RPTA_APP_FUNDSELECT',
    sty: 'SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,DEC_TOTALSHARE,DEC_NAV',
    extraCols: '', source: 'FUND_SELECTOR', client: 'APP',
    sr: '-1,-1,1', st: 'DEC_TOTALSHARE,SECURITY_CODE,SECURITY_CODE',
    filter: '(ETF_TYPE_CODE="ALL")', p: '1', ps: '2000', isIndexFilter: '0',
  });
  const res = await fetch(url, { headers: { Referer: 'https://data.eastmoney.com/', 'User-Agent': UA } });
  const js = await res.json();
  const result = {};
  for (const d of (js.result && js.result.data) || []) {
    const code = d.SECURITY_CODE;
    if (codes.includes(code) && d.DEC_NAV != null && d.DEC_NAV !== '') {
      result[code] = parseFloat(d.DEC_NAV) * 1e8; // 亿元 -> 元
    }
  }
  return result;
}

async function fetchLatestTradeDate() {
  try {
    const url = 'https://api.fund.eastmoney.com/f10/lsjz?' + new URLSearchParams({ fundCode: '510300', pageIndex: '1', pageSize: '1' });
    const res = await fetch(url, { headers: { Referer: 'https://fundf10.eastmoney.com/', 'User-Agent': UA } });
    const js = await res.json();
    return js.Data.LSJZList[0].FSRQ;
  } catch (e) {
    console.error('拿交易日失败，回退周末判断', e);
    const wd = weekdayOf(bjToday());
    if (wd === 6) return shiftDays(bjToday(), -1);
    if (wd === 0) return shiftDays(bjToday(), -2);
    return bjToday();
  }
}

// ---------------- D1 存储 ----------------
async function store(env, date, items) {
  if (!items.length) return 0;
  const stmt = env.DB.prepare(`
    INSERT INTO etf_shares (code, name, date, total_share, market_value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(code, date) DO UPDATE SET
      name = excluded.name,
      total_share = excluded.total_share,
      market_value = COALESCE(excluded.market_value, etf_shares.market_value)
  `);
  for (const [code, name, share, mv] of items) {
    await stmt.bind(code, name, date, share, mv).run();
  }
  return items.length;
}

async function queryAll(env) {
  const { results } = await env.DB.prepare('SELECT code, name, date, total_share, market_value FROM etf_shares ORDER BY date ASC, code ASC').all();
  return results || [];
}

async function queryLatest(env) {
  const { results } = await env.DB.prepare('SELECT code, name, date, total_share, market_value FROM etf_shares WHERE date = (SELECT MAX(date) FROM etf_shares) ORDER BY code').all();
  return results || [];
}

// ---------------- 抓取与回填 ----------------
async function collectToday(env) {
  const codes = (env.ETF_CODES || DEFAULT_CODES).split(',').map((s) => s.trim()).filter(Boolean);
  const sseCodes = codes.filter(isSSE);
  const szseCodes = codes.filter(isSZSE);

  const date = await fetchLatestTradeDate();
  const mvs = await fetchMarketValues(codes);

  const items = [];
  const sse = await fetchSSE(date, sseCodes);
  for (const [code, v] of Object.entries(sse)) items.push([code, v.name, v.share, mvs[code] ?? null]);
  const szse = await fetchSZSE(date, date, szseCodes);
  for (const m of Object.values(szse)) {
    for (const [code, v] of Object.entries(m)) items.push([code, v.name, v.share, mvs[code] ?? null]);
  }

  const n = await store(env, date, items);
  return { date, count: n };
}

// 回填历史：每次从数据库最早日期往前回填 45 个工作日（单次请求上交所 45 次 fetch < 50 子请求上限）
async function backfill(env) {
  const codes = (env.ETF_CODES || DEFAULT_CODES).split(',').map((s) => s.trim()).filter(Boolean);
  const sseCodes = codes.filter(isSSE);
  const szseCodes = codes.filter(isSZSE);
  const target = parseInt(env.BACKFILL_DAYS || '90', 10);

  const row = await env.DB.prepare('SELECT MIN(date) as minDate, COUNT(DISTINCT date) as cnt FROM etf_shares').first();
  const existing = row && row.cnt ? row.cnt : 0;
  if (existing >= target) {
    return { done: true, days: existing, wrote: 0, message: '已有 ' + existing + ' 个交易日，无需回填' };
  }

  const chunk = 45;
  const endDate = (row && row.minDate) || bjToday();
  const dates = generateWorkdays(chunk, endDate);
  if (!dates.length) return { done: true, days: existing, wrote: 0 };

  let wrote = 0;
  // 深交所一次范围查询
  try {
    const szse = await fetchSZSE(dates[dates.length - 1], dates[0], szseCodes);
    for (const [date, m] of Object.entries(szse)) {
      wrote += await store(env, date, Object.entries(m).map(([c, v]) => [c, v.name, v.share, null]));
    }
  } catch (e) {
    console.error('深交所回填失败', e);
  }
  // 上交所逐日
  for (const date of dates) {
    try {
      const sse = await fetchSSE(date, sseCodes);
      wrote += await store(env, date, Object.entries(sse).map(([c, v]) => [c, v.name, v.share, null]));
    } catch (e) {
      console.error('上交所回填失败', date, e);
    }
  }

  const after = await env.DB.prepare('SELECT COUNT(DISTINCT date) as cnt FROM etf_shares').first();
  const totalDays = (after && after.cnt) || 0;
  return { done: totalDays >= target, wrote, days: totalDays, range: dates[dates.length - 1] + ' ~ ' + dates[0] };
}

// ---------------- 工具 ----------------
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  if (request.method === 'OPTIONS') return jsonResponse({ ok: true });

  if (path === '/api/shares') {
    return jsonResponse(await queryAll(env));
  }
  if (path === '/api/shares/latest') {
    return jsonResponse(await queryLatest(env));
  }
  if (path === '/api/collect' && request.method === 'POST') {
    try {
      const r = await collectToday(env);
      return jsonResponse({ ok: true, ...r });
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
  if (path === '/api/backfill' && request.method === 'POST') {
    try {
      const r = await backfill(env);
      return jsonResponse({ ok: true, ...r });
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e && e.message || e) }, 500);
    }
  }
  return jsonResponse({ ok: false, error: 'Not Found' }, 404);
}

// ---------------- 入口 ----------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env, url);
    }
    // 静态资源（index.html 等）
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env) {
    try {
      const r = await collectToday(env);
      console.log('[cron] 当日抓取完成', JSON.stringify(r));
    } catch (e) {
      console.error('[cron] 抓取失败', e);
    }
  },
};
