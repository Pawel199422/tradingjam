// Backtest „TOP 10”: jak skuteczne byłyby scenariusze wybierane do TOP 10 w przeszłości,
// przy różnych modelach i zasadach wyboru. Wszystko liczone walk-forward (model zna tylko przeszłość).
// Tryb 2:1 (cel 2×ATR, stop 1×ATR). Wynik: trafione cele, średni wynik w R na scenariusz.
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');
const I = E._internal;

const IV = process.env.IV || '1h';
const STEP = { '1h': 36e5, '4h': 4 * 36e5, '1d': 864e5 }[IV];
const N_BINANCE = +(process.env.N_BINANCE || 70), N_BINGX = +(process.env.N_BINGX || 50);
const VALID_N = 1000, REFIT = 200, BE = 1 / 3;

// ---------- Wątek: dane i predykcje per coin ----------
function features(k, ctx, k4) {
  const { F, raw } = I.buildFeatures(k, ctx);
  if (k4) { // kilka interwałów naraz: dla świecy 1h dokładamy trend i RSI z ostatniej zamkniętej świecy 4h
    const f4 = I.buildFeatures(k4).raw; const t4 = k4.t; let j = 0;
    for (let i = 0; i < F.length; i++) {
      if (!F[i]) continue;
      while (j + 1 < t4.length && t4[j + 1] + 4 * 36e5 <= k.t[i] + 36e5) j++;
      const r4 = t4[j] + 4 * 36e5 <= k.t[i] + 36e5 ? f4[j] : null;
      if (!r4) { F[i] = null; continue; }
      F[i] = [...F[i], r4.trend, r4.rsi / 100, r4.slope];
    }
  }
  return { Z: I.zscore(F), raw };
}
function labels(k, raw, H) {
  const tg = E.BIG.target, st = E.BIG.stop;
  return { L: I.outcomes(k, raw, H, tg, st), S: I.outcomes(k, raw, H, st, tg).map(y => (y === null ? null : -y)) };
}
// walk-forward per coin: zwraca dla punktów testu p, prior (z przeszłości) i wynik
function walk(Z, Y, lab, H, l2) {
  const out = []; if (lab.length < 500) return out;
  const vs = lab.slice(Math.max(300 + H, lab.length - VALID_N));
  let model = null, fittedAt = -Infinity, bm = 0, bb = 0, n = 0;
  for (const t of vs) {
    if (t - fittedAt >= REFIT) { model = I.fitModel(Z, Y, lab.filter(i => i <= t - H), model && model.W, l2); fittedAt = t; }
    const p = I.predictP(model, Z[t]);
    const rskill = n >= 100 && bb > 0 ? 1 - bm / bb : null;
    out.push({ i: t, p: p[0], prior: model.prior[0], y: Y[t], rskill });
    // skill liczony tylko z wcześniejszych punktów testu (bez zaglądania w przyszłość)
    if (t + H <= vs[vs.length - 1]) { bm += I.brier(p, Y[t]); bb += I.brier(model.prior, Y[t]); n++; }
  }
  return out;
}
async function worker() {
  const H = E.CFG[IV].H; const btcCtx = E.btcContext(workerData.btc);
  for (const t of workerData.list) {
    try {
      const k = await X.getKlines(t.ex, t.sym, IV, E.HISTORY);
      if (k.c.length < 900) continue;
      const k4 = IV === '1h' ? await X.getKlines(t.ex, t.sym, '4h', 1200) : null;
      const recs = {};
      const run = (name, Z, raw, l2) => {
        const Y = labels(k, raw, H); const lab = Y => { const a = []; for (let i = 0; i < k.c.length - 1 - H; i++) if (Z[i] && Y[i] !== null) a.push(i); return a; };
        const lL = lab(Y.L), lS = lab(Y.S);
        recs[name] = { L: walk(Z, Y.L, lL, H, l2).map(r => ({ ...r, t: k.t[r.i] })), S: walk(Z, Y.S, lS, H, l2).map(r => ({ ...r, t: k.t[r.i] })) };
        return { Y, lL, lS };
      };
      const base = features(k); const b = run('base', base.Z, base.raw, 0.3);
      run('l2strong', base.Z, base.raw, 1.0);
      const fb = features(k, btcCtx); run('btc', fb.Z, fb.raw, 0.3);
      if (k4) { const fm = features(k, null, k4); run('mtf', fm.Z, fm.raw, 0.3); }
      // dane do modelu wspólnego (wszystkie coiny razem)
      const pool = { t: [], Z: [], L: [], S: [] };
      for (let i = 0; i < k.c.length - 1 - H; i++) if (base.Z[i] && b.Y.L[i] !== null && b.Y.S[i] !== null) { pool.t.push(k.t[i]); pool.Z.push(base.Z[i]); pool.L.push(b.Y.L[i]); pool.S.push(b.Y.S[i]); }
      parentPort.postMessage({ coin: t.ex + ':' + t.base, recs, pool });
    } catch (e) { }
  }
}

// ---------- Główny wątek ----------
function pooledPreds(coins, H) {
  // model wspólny: co 200 świec douczany na danych WSZYSTKICH coinów sprzed chwili t−H
  const all = []; coins.forEach((c, ci) => c.pool.t.forEach((t, j) => all.push({ ci, t, z: c.pool.Z[j], L: c.pool.L[j], S: c.pool.S[j] })));
  all.sort((a, b) => a.t - b.t);
  const tMax = all[all.length - 1].t; const tStart = tMax - VALID_N * STEP;
  const res = coins.map(() => ({ L: [], S: [] }));
  for (const side of ['L', 'S']) {
    let model = null; const rng = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
    for (let T = tStart; T <= tMax; T += REFIT * STEP) {
      let train = all.filter(r => r.t <= T - H * STEP);
      if (train.length > 40000) train = train.filter(() => rng() < 40000 / train.length);
      const Z = train.map(r => r.z), Y = train.map(r => r[side]);
      model = I.fitModel(Z, Y, Z.map((_, i) => i), model && model.W, 0.3);
      for (const r of all) if (r.t >= T && r.t < T + REFIT * STEP) {
        const p = I.predictP(model, r.z);
        res[r.ci][side].push({ t: r.t, p: p[0], y: r[side] });
      }
    }
  }
  // prior coina: częstość z jego przeszłości; skill per coin – narastająco z wcześniejszych predykcji
  coins.forEach((c, ci) => {
    for (const side of ['L', 'S']) {
      const lab = c.pool.t.map((t, j) => ({ t, y: c.pool[side][j] })).sort((x, y) => x.t - y.t);
      let bm = 0, bb = 0, n = 0, ptr = 0, cw = 0, cnt = 0;
      res[ci][side] = res[ci][side].sort((a, b) => a.t - b.t).map(r => {
        while (ptr < lab.length && lab[ptr].t <= r.t - H * STEP) { cnt++; if (lab[ptr].y === 1) cw++; ptr++; }
        const prior = cnt ? cw / cnt : 0.33;
        const rskill = n >= 100 && bb > 0 ? 1 - bm / bb : null;
        bm += (r.p - (r.y === 1 ? 1 : 0)) ** 2; bb += (prior - (r.y === 1 ? 1 : 0)) ** 2; n++;
        return { ...r, prior, rskill };
      });
    }
  });
  return res;
}

function simulate(coinRecs, rule, H) {
  // coinRecs: [{ coin, L:[{t,p,prior,y,rskill}], S:[...] }]
  const byT = new Map();
  for (const c of coinRecs) for (const side of ['L', 'S']) for (const r of c[side]) {
    if (!byT.has(r.t)) byT.set(r.t, new Map());
    const m = byT.get(r.t); const prev = m.get(c.coin);
    const cand = { coin: c.coin, side, ...r, lift: r.p - r.prior };
    const ok = x => x.rskill !== null && x.rskill > 0;
    // jak w aplikacji: mocniejszy scenariusz coina, sprawdzony ma pierwszeństwo
    if (!prev || (ok(cand) && !ok(prev)) || (ok(cand) === ok(prev) && cand.p > prev.p)) m.set(c.coin, cand);
  }
  const times = [...byT.keys()].sort((a, b) => a - b);
  const blocked = new Map(); let win = 0, loss = 0, none = 0;
  for (const t of times) {
    let cands = [...byT.get(t).values()].filter(x => rule.filter(x));
    cands.sort(rule.sort);
    let taken = 0;
    for (const x of cands) {
      if (taken >= rule.top) break;
      const key = x.coin + x.side; if ((blocked.get(key) || 0) > t) continue;
      blocked.set(key, t + H * STEP); taken++;
      if (x.y === 1) win++; else if (x.y === -1) loss++; else none++;
    }
  }
  const n = win + loss + none;
  return { n, hit: win + loss ? win / (win + loss) : 0, avgR: n ? (2 * win - loss) / n : 0 };
}

async function main() {
  const t0 = Date.now(); const H = E.CFG[IV].H;
  const bn = (await X.binanceTickers()).filter(t => t.qv >= 3e6).sort((a, b) => b.qv - a.qv).slice(0, N_BINANCE);
  const onB = new Set(bn.map(t => E.cleanBase(t.base)));
  let bx = [];
  try { bx = (await X.bingxTickers()).filter(t => t.qv >= 5e5 && !onB.has(E.cleanBase(t.base))).sort((a, b) => b.qv - a.qv).slice(0, N_BINGX); } catch (e) { }
  const list = [...bn, ...bx];
  const btc = await X.binanceKlines('BTCUSDT', IV, E.HISTORY);
  console.log(`Horyzont ${IV} (H=${H}) · coinów: ${list.length}`);
  const T = Math.max(1, Math.min(4, os.cpus().length));
  const shards = Array.from({ length: T }, () => []); list.forEach((t, i) => shards[i % T].push(t));
  const coins = [];
  await Promise.all(shards.map(sh => new Promise(res => {
    const w = new Worker(__filename, { workerData: { list: sh, btc } });
    w.on('message', m => coins.push(m)); w.on('exit', res); w.on('error', e => { console.log('wątek:', e.message); res(); });
  })));
  console.log(`Policzone coiny: ${coins.length} (${((Date.now() - t0) / 60000).toFixed(1)} min)`);

  const variants = {};
  for (const name of ['base', 'l2strong', 'btc', 'mtf']) {
    const cr = coins.filter(c => c.recs[name]).map(c => ({ coin: c.coin, L: c.recs[name].L, S: c.recs[name].S }));
    if (cr.length) variants[name] = cr;
  }
  try {
    const pp = pooledPreds(coins, H);
    variants.pooled = coins.map((c, i) => ({ coin: c.coin, L: pp[i].L, S: pp[i].S }));
  } catch (e) { console.log('model wspólny: ' + e.message); }

  const byLift = (a, b) => b.lift - a.lift || b.p - a.p;
  const byP = (a, b) => b.p - a.p;
  const passed = x => x.rskill !== null && x.rskill > 0;
  const rules = {
    'APLIKACJA (test zdany, p>próg, wg przewagi)': { filter: x => passed(x) && x.p > BE + 0.02, sort: byLift, top: 10 },
    'jw. ale wg procentu': { filter: x => passed(x) && x.p > BE + 0.02, sort: byP, top: 10 },
    'jw. + przewaga ≥5 pkt': { filter: x => passed(x) && x.p > BE + 0.02 && x.lift >= 0.05, sort: byLift, top: 10 },
    'jw. + przewaga ≥8 pkt': { filter: x => passed(x) && x.p > BE + 0.02 && x.lift >= 0.08, sort: byLift, top: 10 },
    'test mocniej zdany (skill ≥1%)': { filter: x => x.rskill !== null && x.rskill >= 0.01 && x.p > BE + 0.02, sort: byLift, top: 10 },
    'bez testu (tylko p>próg)': { filter: x => x.p > BE + 0.02, sort: byLift, top: 10 },
    'TOP 5 zamiast 10': { filter: x => passed(x) && x.p > BE + 0.02, sort: byLift, top: 5 },
    'p ≥ 45%': { filter: x => passed(x) && x.p >= 0.45, sort: byLift, top: 10 },
  };
  console.log('\nTryb 2:1 · próg opłacalności 33% · wynik R: cel +2, stop −1, brak rozstrzygnięcia 0');
  for (const [vn, cr] of Object.entries(variants)) {
    console.log(`\n=== MODEL: ${vn} ===`);
    for (const [rn, rule] of Object.entries(rules)) {
      if (vn !== 'base' && !/^APLIKACJA|≥5 pkt|≥1%/.test(rn)) continue;
      const r = simulate(cr, rule, H);
      console.log(`${rn.padEnd(46)} scenariuszy ${String(r.n).padStart(5)} | trafione ${(r.hit * 100).toFixed(1)}% | średnio ${r.avgR >= 0 ? '+' : ''}${r.avgR.toFixed(3)}R`);
    }
  }
  console.log(`\nCzas: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

if (isMainThread) main().catch(e => { console.error(e); process.exit(1); });
else worker();
