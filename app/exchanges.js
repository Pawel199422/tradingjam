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
// tokenizowane akcje/ETF (np. TQQQB, SKHYB, KORUB, NVDAX) – to nie są kryptowaluty
const STOCK_LIST = 'TQQQ SQQQ SOXL SOXS SPY QQQ NVDA TSLA AAPL MSFT AMZN GOOGL GOOG META INTC SKHY COIN MSTR AMD NFLX HOOD CRCL PLTR ORCL AVGO TSM BABA GME AMC SPCX IWM TLT GLD SLV USO '
  + 'KORU INTW SNXX TSLL NVDL NVDU CONL MSTU MSTX MSTZ BITX BITU ETHU SBIT UPRO SPXL SPXS SPXU TNA TZA LABU LABD YINN YANG FNGU FNGD TECL TECS UDOW SDOW TMF TMV '
  + 'SOXX SMH ARKK XLK XLF XLE KWEB FXI EWY EWJ EWZ MCHI URA BOTZ IBIT FBTC ETHA GBTC BITO UVXY VXX SVIX PYPL SHOP UBER ABNB NKE JPM BAC WMT MCD '
  + 'ARM SMCI ASML QCOM TXN ADBE CRM SNOW PANW CRWD RDDT RBLX DJT CRWV CIRCLE SBET BMNR GLXY IREN CLSK MARA RIOT HUT CORZ BTDR WULF CIFR';
const STOCK = new RegExp('^(' + STOCK_LIST.trim().split(/\s+/).join('|') + ')[BX]?$');
// Heurystyka dla nowych tokenów-akcji Binance: 4 litery + „B”, tylko na Binance, bez kategorii krypto
// (np. KORUB, INTWB, SNXXB). Znane krypto z końcówką B (BNB, ARB…) mają inne długości lub kategorię.
const stockLike = (base, cat, onBingx) => base.length === 5 && /^[A-Z]{4}B$/.test(base) && !onBingx && (cat === 'rwa' || cat === 'other' || cat === 'stock');
const isJunk = base => STABLE.has(base) || STOCK.test(base) || (/(BULL|BEAR)$/.test(base) && base.length > 4);

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

// ---------- Bybit (tylko analiza na telefonie – Bybit blokuje serwery w USA) ----------
const BYBIT = 'https://api.bybit.com';
const BYBIT_IV = { '1h': '60', '4h': '240', '1d': 'D' };
async function bybitGet(path) {
  const j = await http(BYBIT + path);
  if (j && j.retCode !== 0) throw new Error('Bybit: ' + (j.retMsg || j.retCode));
  return j.result;
}
async function bybitTicker(sym) {
  const r = await bybitGet(`/v5/market/tickers?category=linear&symbol=${sym}`);
  const t = r && r.list && r.list[0];
  if (!t) throw new Error('Nie ma takiej pary na Bybit');
  return { ex: 'bybit', sym, base: sym.replace(/USDT$/, ''), price: +t.lastPrice, chg: +t.price24hPcnt * 100, qv: +t.turnover24h };
}
// Lista coinów dostępnych na Bybit (kontrakty USDT) – pobierana na urządzeniu użytkownika
async function bybitBases() {
  const r = await bybitGet('/v5/market/tickers?category=linear');
  const out = new Set();
  for (const t of (r && r.list) || []) if (/USDT$/.test(t.symbol) && +t.turnover24h > 0) out.add(t.symbol.replace(/USDT$/, '').replace(/^(1000000|1000|1M)(?=[A-Z])/, ''));
  return out;
}
async function bybitKlines(sym, iv, total) {
  const map = new Map(); let end = null;
  while (map.size < total) {
    const r = await bybitGet(`/v5/market/kline?category=linear&symbol=${sym}&interval=${BYBIT_IV[iv]}&limit=1000` + (end ? `&end=${end}` : ''));
    const rows = (r && r.list ? r.list : []).map(x => [+x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]);
    if (!rows.length) break;
    const before = map.size; let minT = Infinity;
    for (const row of rows) { map.set(row[0], row); if (row[0] < minT) minT = row[0]; }
    if (map.size === before || rows.length < 1000) break;
    end = minT - 1;
  }
  const all = [...map.values()].sort((a, b) => a[0] - b[0]);
  const k = { t: [], o: [], h: [], l: [], c: [], v: [], tb: [] };
  for (const [t, o, h, l, c, v] of all) {
    k.t.push(t); k.o.push(o); k.h.push(h); k.l.push(l); k.c.push(c); k.v.push(v);
    k.tb.push(h > l ? v * (c - l) / (h - l) : v * 0.5); // szacunek presji kupna
  }
  return k;
}

// Funding (BingX perpetual) – wszystkie kontrakty jednym zapytaniem
async function bingxFunding() {
  const d = await bingxGet('/openApi/swap/v2/quote/premiumIndex');
  const out = {};
  for (const t of Array.isArray(d) ? d : []) {
    const f = num(t.lastFundingRate);
    if (t.symbol && isFinite(f)) out[t.symbol.replace(/-USDT$/, '')] = f;
  }
  return out;
}

// ---------- Wspólne ----------
const getKlines = (ex, sym, iv, total) => (ex === 'bingx' ? bingxKlines(sym, iv, total) : ex === 'bybit' ? bybitKlines(sym, iv, total) : binanceKlines(sym, iv, total));

// Pełna analiza jednego coina na wszystkich interwałach (używa silnika E)
async function analyzeCoin(E, ticker, onProgress) {
  const res = {}; let spark = []; let k4h = null;
  for (const iv of Object.keys(E.CFG)) {
    try {
      const k = await getKlines(ticker.ex, ticker.sym, iv, E.HISTORY);
      if (iv === '1h') spark = k.c.slice(-48).map(x => +x.toPrecision(6));
      if (iv === '4h') k4h = k;
      await sleep(0);
      if (iv === '1d' && k.c.length < E.MIN_DAILY && k4h && k4h.c.length >= 300) {
        // młody coin: prognoza 14 dni liczona ze świec 4h
        res[iv] = E.compact(E.analyze(k4h, '1d4h'));
      } else {
        res[iv] = k.c.length < 200 ? { error: `Za krótka historia coina (${k.c.length} świec, potrzeba min. 200)` } : E.compact(E.analyze(k, iv));
      }
    } catch (e) { res[iv] = { error: e.message || 'Błąd pobierania' }; }
    if (onProgress) onProgress(iv);
  }
  return { ...ticker, cat: E.catOf(ticker.base), est: ticker.ex !== 'binance', exs: [ticker.ex], spark, res };
}

module.exports = { stockLike, STOCK, bybitBases, bingxFunding, bybitTicker, bybitKlines, isJunk, binanceTickers, binanceTicker, binanceKlines, bingxTickers, bingxTicker, bingxKlines, getKlines, analyzeCoin, sleep };
