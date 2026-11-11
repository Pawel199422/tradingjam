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

async function main() {
  const t0 = Date.now(); const errors = [];
  let bn = [], bx = [];
  try { bn = await X.binanceTickers(); } catch (e) { errors.push('Binance tickery: ' + e.message); }
  try { bx = await X.bingxTickers(); } catch (e) { errors.push('BingX tickery: ' + e.message); }

  const binance = bn.filter(t => t.qv >= CONF.MIN_QV_BINANCE).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINANCE_TOP);
  const onBinance = new Set(bn.map(t => t.base));
  const bingx = bx.filter(t => t.qv >= CONF.MIN_QV_BINGX && !onBinance.has(t.base)).sort((a, b) => b.qv - a.qv).slice(0, CONF.BINGX_TOP);
  const universe = [...binance, ...bingx];
  console.log(`Do analizy: ${binance.length} z Binance + ${bingx.length} z BingX`);

  const coins = []; let next = 0, done = 0, timedOut = false;
  async function worker() {
    while (next < universe.length) {
      if ((Date.now() - t0) / 60000 > CONF.TIME_LIMIT_MIN) { timedOut = true; return; }
      const t = universe[next++];
      try {
        const c = await X.analyzeCoin(E, t);
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
  for (const iv of ['1h', '4h', '1d']) {
    console.log(`TOP 5 ${iv}: ` + E.rankTop(coins, iv, 'all', 5).map(r => `${r.coin.base} ${r.d.dir} ${(r.d.p * 100).toFixed(0)}%`).join(', '));
  }
  if (!coins.length) process.exit(1); // nie nadpisuj danych pustym wynikiem
}

main().catch(e => { console.error(e); process.exit(1); });
