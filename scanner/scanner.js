// Skaner rynku – uruchamiany co godzinę przez GitHub Actions (albo ręcznie: node scanner/scanner.js)
// Wynik: out/results.json, który aplikacja pobiera przy starcie.

const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const CONF = {
  BINANCE_TOP: +(process.env.BINANCE_TOP || 100),  // ile najpłynniejszych coinów z Binance
  BINGX_TOP: +(process.env.BINGX_TOP || 100),      // ile coinów z BingX, których NIE MA na Binance (lowcapy)
  MIN_QV_BINANCE: 3e6,                             // min. wolumen 24h w USDT
  MIN_QV_BINGX: 5e5,
  CONCURRENCY: 4,
  TIME_LIMIT_MIN: +(process.env.TIME_LIMIT_MIN || 38), // zapas przed limitem joba
  OUT: process.env.OUT || path.join(__dirname, '..', 'out', 'results.json'),
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

  const cg = await coingeckoCats(errors);
  let funding = {};
  try { funding = await X.bingxFunding(); console.log(`Funding BingX: ${Object.keys(funding).length} kontraktów`); } catch (e) { errors.push('Funding BingX: ' + e.message); }
  const notStock = t => E.catOf(t.base, cg) !== 'stock';
  bn = bn.filter(notStock); bx = bx.filter(notStock);

  const binance = bn.filter(t => t.qv >= CONF.MIN_QV_BINANCE).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINANCE_TOP);
  const onBinance = new Set(bn.map(t => E.cleanBase(t.base)));
  const onBingx = new Set(bx.map(t => E.cleanBase(t.base)));
  const bingx = bx.filter(t => t.qv >= CONF.MIN_QV_BINGX && !onBinance.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINGX_TOP);
  const universe = [...binance, ...bingx];
  console.log(`Do analizy: ${binance.length} z Binance + ${bingx.length} z BingX`);

  const coins = []; let next = 0, done = 0, timedOut = false;
  async function worker() {
    while (next < universe.length) {
      if ((Date.now() - t0) / 60000 > CONF.TIME_LIMIT_MIN) { timedOut = true; return; }
      const t = universe[next++];
      try {
        const c = await X.analyzeCoin(E, t);
        c.cat = E.catOf(t.base, cg);
        { const f = funding[t.base] !== undefined ? funding[t.base] : funding[E.cleanBase(t.base)]; if (f !== undefined) c.funding = +f.toPrecision(4); }
        c.exs = [onBinance.has(E.cleanBase(t.base)) && 'binance', onBingx.has(E.cleanBase(t.base)) && 'bingx'].filter(Boolean);
        if (Object.values(c.res).some(a => !a.error)) coins.push(c);
      } catch (e) { errors.push(`${t.ex} ${t.sym}: ${e.message}`); }
      done++;
      if (done % 20 === 0) console.log(`  ${done}/${universe.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);
    }
  }
  await Promise.all(Array.from({ length: CONF.CONCURRENCY }, worker));
  if (timedOut) errors.push(`Limit czasu – przeanalizowano ${done}/${universe.length}`);

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMin: +((Date.now() - t0) / 60000).toFixed(1),
    counts: { binance: coins.filter(c => c.ex === 'binance').length, bingx: coins.filter(c => c.ex === 'bingx').length },
    errors: errors.slice(0, 50),
    coins,
  };
  fs.mkdirSync(path.dirname(CONF.OUT), { recursive: true });
  fs.writeFileSync(CONF.OUT, JSON.stringify(out));
  console.log(`Zapisano ${coins.length} coinów → ${CONF.OUT} (${(fs.statSync(CONF.OUT).size / 1024).toFixed(0)} KB, ${out.durationMin} min)`);
  if (errors.length) console.log('Ostrzeżenia:\n  ' + errors.slice(0, 10).join('\n  '));
  const catCount = {}; for (const c of coins) catCount[c.cat] = (catCount[c.cat] || 0) + 1;
  console.log('Kategorie:', JSON.stringify(catCount));
  for (const iv of ['1h', '4h', '1d']) {
    console.log(`TOP 5 ${iv}: ` + E.rankTop(coins, iv, 'all', 5, 'big').map(r => `${r.coin.base} ${r.d.dir} ${(r.d.p * 100).toFixed(0)}%${r.d.weak ? '(brak przewagi)' : ''}`).join(', '));
  }
  if (!coins.length) process.exit(1); // nie nadpisuj danych pustym wynikiem
}

main().catch(e => { console.error(e); process.exit(1); });
