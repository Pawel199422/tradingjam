// Skaner rynku – uruchamiany co godzinę przez GitHub Actions (albo ręcznie: node scanner/scanner.js)
// Wynik: out/results.json, który aplikacja pobiera przy starcie.

const fs = require('fs');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const CONF = {
  BINANCE_TOP: +(process.env.BINANCE_TOP || 200),  // ile najpłynniejszych coinów z Binance
  BINGX_TOP: +(process.env.BINGX_TOP || 200),      // ile coinów z BingX, których NIE MA na Binance (lowcapy)
  OKX_TOP: +(process.env.OKX_TOP || 50),           // ile coinów z OKX, których nie ma na Binance ani BingX
  MIN_QV_OKX: 3e5,
  MIN_QV_BINANCE: 1e6,                             // min. wolumen 24h w USDT
  MIN_QV_BINGX: 3e5,
  THREADS: Math.max(1, Math.min(+(process.env.THREADS || 4), os.cpus().length)), // równoległe wątki (obliczenia)
  CONCURRENCY: 2,                                  // równoległe coiny w jednym wątku
  TIME_LIMIT_MIN: +(process.env.TIME_LIMIT_MIN || 38), // zapas przed limitem joba
  OUT: process.env.OUT || path.join(__dirname, '..', 'out', 'results.json'),
  HISTORY_IN: process.env.HISTORY_IN || null,     // lokalny plik historii (testy); domyślnie pobierana z gałęzi data
  HISTORY_MAX_CLOSED: 3000,
};

// Kategorie z CoinGecko (darmowe API). Kolejność = priorytet przy konflikcie.
const CG_CATS = [
  ['stock', ['tokenized-stock'], 1],
  ['meme', ['meme-token'], 4],
  ['ai', ['artificial-intelligence', 'ai-agents'], 3],
  ['gaming', ['gaming'], 2],
  ['rwa', ['real-world-assets-rwa'], 2],
  ['depin', ['depin'], 2],
  ['l2', ['layer-2'], 1],
  ['l1', ['layer-1'], 1],
  ['exchange', ['exchange-based-tokens'], 1],
  ['defi', ['decentralized-finance-defi'], 3],
];
async function coingeckoCats(errors) {
  const map = {}; let ok = 0;
  if (process.env.NO_COINGECKO) return map;
  for (const [key, ids, pages] of CG_CATS) for (const id of ids) for (let pg = 1; pg <= pages; pg++) {
    const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=${id}&per_page=250&page=${pg}`;
    let rows = null;
    for (let t = 0; t < 3; t++) {
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        if (r.status === 429) { await X.sleep(30000); continue; }
        if (r.ok) rows = await r.json();
        break;
      } catch (e) { await X.sleep(5000); }
    }
    await X.sleep(7000); // limit darmowego API
    if (!Array.isArray(rows)) break;
    ok++;
    for (const c of rows) { const sym = String(c.symbol || '').toUpperCase(); if (sym && !map[sym]) map[sym] = key; }
    if (rows.length < 250) break;
  }
  console.log(`CoinGecko: ${ok} zapytań OK, ${Object.keys(map).length} symboli z kategorią`);
  if (!ok) errors.push('CoinGecko: brak danych o kategoriach (użyto listy wbudowanej)');
  return map;
}

async function main() {
  const t0 = Date.now(); const errors = [];
  let bn = [], bx = [];
  try { bn = await X.binanceTickers(); } catch (e) { errors.push('Binance tickery: ' + e.message); }
  try { bx = await X.bingxTickers(); } catch (e) { errors.push('BingX tickery: ' + e.message); }
  let ok = [];
  try { ok = await X.okxTickers(); console.log(`OKX: ${ok.length} par USDT`); } catch (e) { errors.push('OKX tickery: ' + e.message); }

  const cg = await coingeckoCats(errors);
  let funding = {};
  try { funding = await X.bingxFunding(); console.log(`Funding BingX: ${Object.keys(funding).length} kontraktów`); } catch (e) { errors.push('Funding BingX: ' + e.message); }
  const onBingxAll = new Set(bx.map(t => E.cleanBase(t.base)));
  const notStock = t => E.catOf(t.base, cg) !== 'stock' && !X.stockLike(t.base, E.catOf(t.base, cg), onBingxAll.has(E.cleanBase(t.base)));
  bn = bn.filter(notStock); bx = bx.filter(notStock); ok = ok.filter(notStock);

  const binance = bn.filter(t => t.qv >= CONF.MIN_QV_BINANCE).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINANCE_TOP);
  const onBinance = new Set(bn.map(t => E.cleanBase(t.base)));
  const onBingx = new Set(bx.map(t => E.cleanBase(t.base)));
  const bingx = bx.filter(t => t.qv >= CONF.MIN_QV_BINGX && !onBinance.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINGX_TOP);
  const onOkx = new Set(ok.map(t => E.cleanBase(t.base)));
  const okx = ok.filter(t => t.qv >= CONF.MIN_QV_OKX && !onBinance.has(E.cleanBase(t.base)) && !onBingx.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, CONF.OKX_TOP);
  // Na zmianę Binance/BingX – przy limicie czasu odpadają najmniej płynne z obu list, a nie cały BingX
  const universe = [];
  for (let i = 0; i < Math.max(binance.length, bingx.length, okx.length); i++) { if (binance[i]) universe.push(binance[i]); if (bingx[i]) universe.push(bingx[i]); if (okx[i]) universe.push(okx[i]); }
  console.log(`Do analizy: ${binance.length} z Binance + ${bingx.length} z BingX + ${okx.length} z OKX`);

  // ---------- Historia wyników: wczytanie poprzedniej ----------
  let history = [];
  try {
    if (CONF.HISTORY_IN) history = fs.existsSync(CONF.HISTORY_IN) ? JSON.parse(fs.readFileSync(CONF.HISTORY_IN, 'utf8')) : [];
    else if (process.env.GITHUB_REPOSITORY) {
      const r = await fetch(`https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/data/history.json?t=${Date.now()}`);
      if (r.ok) history = await r.json();
    }
    if (!Array.isArray(history)) history = [];
  } catch (e) { errors.push('Historia: ' + e.message); history = []; }
  const pathKeys = new Set(history.filter(p => p.status === 'open').map(p => p.ex + p.sym));
  const paths = new Map();
  console.log(`Historia: ${history.length} wpisów, otwartych ${pathKeys.size} coinów`);

  // Wątki: każdy liczy swoją część listy (obliczenia modelu są ciężkie, więc dzielimy je na rdzenie)
  const coins = []; let done = 0, timedOut = false;
  const shards = Array.from({ length: CONF.THREADS }, () => []);
  universe.forEach((t, i) => shards[i % CONF.THREADS].push(t));
  await Promise.all(shards.map(list => new Promise(resolve => {
    const w = new Worker(__filename, { workerData: { pathKeys: [...pathKeys], list, cg, funding, onBinance: [...onBinance], onBingx: [...onBingx], onOkx: [...onOkx], t0, limit: CONF.TIME_LIMIT_MIN, conc: CONF.CONCURRENCY } });
    w.on('message', m => {
      if (m.coin) { if (m.coin._path) { paths.set(m.coin.ex + m.coin.sym, m.coin._path); delete m.coin._path; } coins.push(m.coin); }
      if (m.error) errors.push(m.error);
      if (m.timedOut) timedOut = true;
      if (m.tick) { done++; if (done % 25 === 0) console.log(`  ${done}/${universe.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`); }
    });
    w.on('error', e => { errors.push('Wątek: ' + e.message); resolve(); });
    w.on('exit', resolve);
  })));
  if (timedOut) errors.push(`Limit czasu – przeanalizowano ${done}/${universe.length}`);

  // ---------- Historia wyników: rozliczenie otwartych i dopisanie nowych ----------
  const now = Date.now();
  for (const key of pathKeys) {
    if (paths.has(key)) continue; // coin wypadł z listy – pobieramy świece osobno
    const pk = history.find(p => p.status === 'open' && p.ex + p.sym === key);
    try { const k = await X.getKlines(pk.ex, pk.sym, '1h', 800); paths.set(key, { t: k.t, h: k.h, l: k.l, c: k.c }); } catch (e) { }
  }
  history = history.map(p => (p.status === 'open' ? E.resolvePick(p, paths.get(p.ex + p.sym), now) : p));
  // Zbyt stare otwarte (brak danych > 3 dni po końcu) – zamykamy bez wyniku
  history = history.map(p => (p.status === 'open' && now > p.end + 3 * 864e5 ? { ...p, status: 'expired', closedAt: p.end, r: 0, noData: true } : p));
  let added = 0;
  const btcCoin = coins.find(c => c.ex === 'binance' && c.base === 'BTC');
  for (const iv of ['1h', '4h', '1d', '30d']) {
    const btcA = btcCoin && btcCoin.res[iv] && !btcCoin.res[iv].error ? btcCoin.res[iv] : null;
    for (const r of E.rankTop(coins, iv, 'all', 10, 'big')) {
      if (r.tier !== 0) continue; // tylko wiarygodne i powyżej progu
      if (history.some(p => p.status === 'open' && p.ex === r.coin.ex && p.sym === r.coin.sym && p.iv === iv && p.dir === r.d.dir)) continue;
      history.push({
        id: `${now}-${iv}-${r.coin.ex}-${r.coin.sym}-${r.d.dir}`, t: now, end: now + E.HORIZON_MS[iv], iv, mode: 'big',
        ex: r.coin.ex, sym: r.coin.sym, base: r.coin.base, dir: r.d.dir, p: +r.d.p.toFixed(3), hist: r.d.hist !== null ? +r.d.hist.toFixed(3) : null,
        price: r.coin.res[iv].price, target: r.d.target, stop: r.d.stop, status: 'open',
        // do późniejszej analizy, co działa najlepiej
        lift: +r.lift.toFixed(3), skill: r.d.skill !== null ? +r.d.skill.toFixed(4) : null, qv: Math.round(r.coin.qv || 0),
        cat: r.coin.cat || null, btcTrend: btcA && btcA.raw ? +btcA.raw.trend.toFixed(2) : null,
      });
      added++;
    }
  }
  const openH = history.filter(p => p.status === 'open');
  const closedH = history.filter(p => p.status !== 'open').sort((a, b) => b.closedAt - a.closedAt).slice(0, CONF.HISTORY_MAX_CLOSED);
  history = [...openH, ...closedH];
  console.log(`Historia: +${added} nowych, otwartych ${openH.length}, zamkniętych ${closedH.length}`);

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMin: +((Date.now() - t0) / 60000).toFixed(1),
    counts: { binance: coins.filter(c => c.ex === 'binance').length, bingx: coins.filter(c => c.ex === 'bingx').length, okx: coins.filter(c => c.ex === 'okx').length },
    errors: errors.slice(0, 50),
    coins,
  };
  fs.mkdirSync(path.dirname(CONF.OUT), { recursive: true });
  fs.writeFileSync(CONF.OUT, JSON.stringify(out));
  fs.writeFileSync(path.join(path.dirname(CONF.OUT), 'history.json'), JSON.stringify(history));
  console.log(`Zapisano ${coins.length} coinów → ${CONF.OUT} (${(fs.statSync(CONF.OUT).size / 1024).toFixed(0)} KB, ${out.durationMin} min)`);
  if (errors.length) console.log('Ostrzeżenia:\n  ' + errors.slice(0, 10).join('\n  '));
  const catCount = {}; for (const c of coins) catCount[c.cat] = (catCount[c.cat] || 0) + 1;
  console.log('Kategorie:', JSON.stringify(catCount));
  for (const iv of ['1h', '4h', '1d', '30d']) {
    console.log(`TOP 5 ${iv}: ` + E.rankTop(coins, iv, 'all', 5, 'big').map(r => `${r.coin.base} ${r.d.dir} ${(r.d.p * 100).toFixed(0)}%${r.d.weak ? '(brak przewagi)' : ''}`).join(', '));
  }
  if (!coins.length) process.exit(1); // nie nadpisuj danych pustym wynikiem
}

// Kod wątku roboczego
async function workerMain() {
  const { list, cg, funding, t0, limit, conc } = workerData;
  const pathKeys = new Set(workerData.pathKeys || []);
  const onBinance = new Set(workerData.onBinance), onBingx = new Set(workerData.onBingx), onOkx = new Set(workerData.onOkx || []);
  let next = 0;
  async function loop() {
    while (next < list.length) {
      if ((Date.now() - t0) / 60000 > limit) { parentPort.postMessage({ timedOut: true }); return; }
      const t = list[next++];
      try {
        const c = await X.analyzeCoin(E, t, null, { path: pathKeys.has(t.ex + t.sym) });
        c.cat = E.catOf(t.base, cg);
        { const f = funding[t.base] !== undefined ? funding[t.base] : funding[E.cleanBase(t.base)]; if (f !== undefined) c.funding = +f.toPrecision(4); }
        c.exs = [t.ex, onBinance.has(E.cleanBase(t.base)) && 'binance', onBingx.has(E.cleanBase(t.base)) && 'bingx', onOkx.has(E.cleanBase(t.base)) && 'okx'].filter((x, i, arr) => x && arr.indexOf(x) === i);
        if (Object.values(c.res).some(a => !a.error)) parentPort.postMessage({ coin: c });
      } catch (e) { parentPort.postMessage({ error: `${t.ex} ${t.sym}: ${e.message}` }); }
      parentPort.postMessage({ tick: true });
    }
  }
  await Promise.all(Array.from({ length: conc }, loop));
}

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else workerMain().catch(e => { parentPort.postMessage({ error: 'Wątek: ' + e.message }); });
