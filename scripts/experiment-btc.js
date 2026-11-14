// Eksperyment: czy kontekst rynku (BTC) poprawia trafność modelu?
// Dla każdego coina i horyzontu liczymy test walk-forward dwa razy – bez i z cechami BTC –
// i porównujemy „skill” (o ile model jest lepszy od zwykłej średniej). Wynik tylko w logu.
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const IVS = ['1h', '4h', '1d'];
const N_BINANCE = +(process.env.N_BINANCE || 60), N_BINGX = +(process.env.N_BINGX || 40);

const pick = a => ({
  equal: a.skill,
  bigL: a.big && a.big.long.skill, bigS: a.big && a.big.short.skill,
  safeL: a.safe && a.safe.long.skill, safeS: a.safe && a.safe.short.skill,
});

async function main() {
  const t0 = Date.now();
  const bn = (await X.binanceTickers()).filter(t => t.qv >= 3e6).sort((a, b) => b.qv - a.qv).slice(0, N_BINANCE);
  const onB = new Set(bn.map(t => E.cleanBase(t.base)));
  let bx = [];
  try { bx = (await X.bingxTickers()).filter(t => t.qv >= 5e5 && !onB.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, N_BINGX); } catch (e) { }
  const list = [...bn, ...bx].filter(t => t.base !== 'BTC');
  const btc = {};
  for (const iv of IVS) btc[iv] = await X.binanceKlines('BTCUSDT', iv, E.HISTORY);
  console.log(`Coinów: ${list.length} (Binance ${bn.length}, BingX ${bx.length})`);

  const T = Math.max(1, Math.min(4, os.cpus().length));
  const shards = Array.from({ length: T }, () => []); list.forEach((t, i) => shards[i % T].push(t));
  const rows = [];
  await Promise.all(shards.map(sh => new Promise(res => {
    const w = new Worker(__filename, { workerData: { list: sh, btc } });
    w.on('message', m => rows.push(m)); w.on('exit', res); w.on('error', e => { console.log('wątek:', e.message); res(); });
  })));

  for (const iv of IVS) {
    console.log(`\n=== ${iv} ===`);
    for (const key of ['equal', 'bigL', 'bigS', 'safeL', 'safeS']) {
      const pairs = rows.filter(r => r.iv === iv && r.a0 && r.a1 && r.a0[key] != null && r.a1[key] != null).map(r => [r.a0[key], r.a1[key]]);
      if (!pairs.length) continue;
      const m0 = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, m1 = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
      const pos0 = pairs.filter(p => p[0] > 0).length, pos1 = pairs.filter(p => p[1] > 0).length;
      const better = pairs.filter(p => p[1] > p[0]).length;
      console.log(`${key.padEnd(6)} n=${String(pairs.length).padStart(3)} | skill bez BTC ${(m0 * 100).toFixed(2)}% → z BTC ${(m1 * 100).toFixed(2)}% | zdany test: ${pos0} → ${pos1} | lepiej z BTC: ${better}/${pairs.length}`);
    }
  }
  console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

async function worker() {
  const btcCtx = {}; for (const iv of IVS) btcCtx[iv] = E.btcContext(workerData.btc[iv]);
  for (const t of workerData.list) {
    for (const iv of IVS) {
      try {
        const k = await X.getKlines(t.ex, t.sym, iv, E.HISTORY);
        if (k.c.length < 600) continue;
        const a0 = E.analyze(k, iv), a1 = E.analyze(k, iv, btcCtx[iv]);
        parentPort.postMessage({ base: t.base, iv, a0: a0.error ? null : pick(a0), a1: a1.error ? null : pick(a1) });
      } catch (e) { }
    }
  }
}

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else worker();
