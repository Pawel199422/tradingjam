// Pobieranie danych z giełd – działa w aplikacji (React Native) i w Node 20+ (skaner).
// Binance: spot, publiczny mirror danych (działa też z serwerów w USA, np. GitHub).
// BingX: kontrakty perpetual USDT (dużo mniejszych, lowcapowych projektów).

const BINANCE_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com'];
const BINGX = 'https://open-api.bingx.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function http(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status === 429 || r.status >= 500) { last = new Error('HTTP ' + r.status); await sleep(1500 * (i + 1)); continue; }
      if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) {
      last = e;
      if (e.status) throw e;            // błąd 4xx – ponawianie nic nie da
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

// ---------- Binance ----------
async function binanceGet(path) {
  let last;
  for (const h of BINANCE_HOSTS) {
    try { return await http(h + path); } catch (e) { last = e; if (e.status === 400) throw new Error('Nie ma takiej pary na Binance'); }
  }
  throw last;
}

const STABLE = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'EUR', 'USDE', 'USD1', 'PYUSD', 'XUSD', 'RLUSD', 'AEUR', 'EURI', 'USDS', 'GBP', 'BFUSD', 'USTC', 'PAXG', 'WBTC', 'WBETH', 'BNSOL']);
const isJunk = base => STABLE.has(base) || (/(BULL|BEAR)$/.test(base) && base.length > 4);

async function binanceTickers() {
  const all = await binanceGet('/api/v3/ticker/24hr');
  return all
    .filter(t => t.symbol.endsWith('USDT') && +t.quoteVolume > 0 && +t.count > 0)
    .map(t => ({ ex: 'binance', sym: t.symbol, base: t.symbol.slice(0, -4), price: +t.lastPrice, chg: +t.priceChangePercent, qv: +t.quoteVolume }))
    .filter(t => !isJunk(t.base));
}

async function binanceKlines(sym, iv, total) {
  let all = []; let end = null;
  while (all.length < total) {
    const r = await binanceGet(`/api/v3/klines?symbol=${sym}&interval=${iv}&limit=1000` + (end ? `&endTime=${end}` : ''));
    if (!r.length) break;
    all = r.concat(all); end = r[0][0] - 1;
    if (r.length < 1000) break;
  }
  const k = { t: [], o: [], h: [], l: [], c: [], v: [], tb: [] };
  for (const x of all) { k.t.push(+x[0]); k.o.push(+x[1]); k.h.push(+x[2]); k.l.push(+x[3]); k.c.push(+x[4]); k.v.push(+x[5]); k.tb.push(+x[9]); }
  return k;
}

async function binanceTicker(sym) {
  const t = await binanceGet(`/api/v3/ticker/24hr?symbol=${sym}`);
  return { ex: 'binance', sym, base: sym.replace(/USDT$/, ''), price: +t.lastPrice, chg: +t.priceChangePercent, qv: +t.quoteVolume };
}

// ---------- BingX ----------
async function bingxGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const j = await http(BINGX + path + sep + 'timestamp=' + Date.now());
  if (j && j.code !== undefined && j.code !== 0) throw new Error('BingX: ' + (j.msg || j.code));
  return j.data;
}

const num = x => parseFloat(String(x).replace('%', ''));

function bingxTickerRow(t) {
  const base = t.symbol.replace(/-USDT$/, '');
  const price = num(t.lastPrice);
  const qv = t.quoteVolume !== undefined ? num(t.quoteVolume) : num(t.volume) * price;
  return { ex: 'bingx', sym: t.symbol, base, price, chg: num(t.priceChangePercent), qv };
}

async function bingxTickers() {
  const all = await bingxGet('/openApi/swap/v2/quote/ticker');
  return (Array.isArray(all) ? all : [])
    .filter(t => /^[A-Z0-9]{2,20}-USDT$/.test(t.symbol))
    .map(bingxTickerRow)
    // pomijamy kontrakty na akcje/forex/surowce (NCSK…, NCFX…, NCCO…, NCSI…) i stablecoiny
    .filter(t => !/^NC(SK|FX|CO|SI)/.test(t.base) && !isJunk(t.base) && t.qv > 0 && isFinite(t.price));
}

async function bingxTicker(sym) {
  const d = await bingxGet(`/openApi/swap/v2/quote/ticker?symbol=${sym}`);
  const t = Array.isArray(d) ? d[0] : d;
  if (!t) throw new Error('Nie ma takiej pary na BingX');
  return bingxTickerRow(t);
}

async function bingxKlines(sym, iv, total) {
  const map = new Map(); let end = null;
  while (map.size < total) {
    const d = await bingxGet(`/openApi/swap/v3/quote/klines?symbol=${sym}&interval=${iv}&limit=1000` + (end ? `&endTime=${end}` : ''));
    const rows = (Array.isArray(d) ? d : []).map(x => Array.isArray(x)
      ? [+x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]
      : [+x.time, +x.open, +x.high, +x.low, +x.close, +x.volume]);
    if (!rows.length) break;
    const before = map.size; let minT = Infinity;
    for (const r of rows) { map.set(r[0], r); if (r[0] < minT) minT = r[0]; }
    if (map.size === before || rows.length < 1000) break;
    end = minT - 1;
  }
  const all = [...map.values()].sort((a, b) => a[0] - b[0]); // BingX zwraca od najnowszych
  const k = { t: [], o: [], h: [], l: [], c: [], v: [], tb: [] };
  for (const [t, o, h, l, c, v] of all) {
    k.t.push(t); k.o.push(o); k.h.push(h); k.l.push(l); k.c.push(c); k.v.push(v);
    // BingX nie podaje wolumenu kupujących – szacujemy go z położenia zamknięcia w świecy
    k.tb.push(h > l ? v * (c - l) / (h - l) : v * 0.5);
  }
  return k;
}

// ---------- Wspólne ----------
const getKlines = (ex, sym, iv, total) => (ex === 'bingx' ? bingxKlines(sym, iv, total) : binanceKlines(sym, iv, total));

// Pełna analiza jednego coina na wszystkich interwałach (używa silnika E)
async function analyzeCoin(E, ticker, onProgress) {
  const res = {}; let spark = [];
  for (const iv of Object.keys(E.CFG)) {
    try {
      const k = await getKlines(ticker.ex, ticker.sym, iv, E.HISTORY);
      if (iv === '1h') spark = k.c.slice(-48).map(x => +x.toPrecision(6));
      await sleep(0);
      res[iv] = k.c.length < 200 ? { error: 'Za krótka historia coina' } : E.compact(E.analyze(k, iv));
    } catch (e) { res[iv] = { error: e.message || 'Błąd pobierania' }; }
    if (onProgress) onProgress(iv);
  }
  return { ...ticker, est: ticker.ex === 'bingx', spark, res };
}

module.exports = { binanceTickers, binanceTicker, binanceKlines, bingxTickers, bingxTicker, bingxKlines, getKlines, analyzeCoin, sleep };
