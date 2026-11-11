// Silnik analizy – wspólny dla aplikacji (telefon) i skanera (serwer GitHub).
// Dla każdego coina i interwału osobno trenuje model na historii tego coina
// i liczy prawdopodobieństwo 3 scenariuszy: wzrost / spadek / konsolidacja.

// Interwał -> horyzont scenariusza (H świec) i wielkość ruchu (m × ATR)
const CFG = {
  '1h': { label: '1h', H: 24, m: 2, horizonTxt: '24 godz.' },
  '4h': { label: '4h', H: 18, m: 2, horizonTxt: '3 dni' },
  '1d': { label: '1D', H: 14, m: 2, horizonTxt: '14 dni' },
};
const VALID_N = 1000;    // ile ostatnich sytuacji do testu skuteczności
const REFIT_EVERY = 200; // co ile świec model jest douczany w teście
// Tryb „Bezpieczny cel”: bliższy cel (1× ATR), dalszy stop (2× ATR) – wyższa szansa trafienia, gorszy stosunek zysku do ryzyka
const SAFE = { target: 1, stop: 2, thr: 0.65 };
const BREAK_EVEN = SAFE.stop / (SAFE.target + SAFE.stop); // 66,7% – próg opłacalności przy celu 1:2
const HISTORY = 3000;    // ile świec historii pobierać na interwał
const WARMUP = 60;       // świece na rozgrzanie wskaźników
const EDGE_MIN = 0.15;   // próg przewagi P(wzrost) - P(spadek) dla sygnału

function parseKlines(raw) {
  const t = [], o = [], h = [], l = [], c = [], v = [], tb = [];
  for (const r of raw) {
    t.push(r[0]); o.push(+r[1]); h.push(+r[2]); l.push(+r[3]);
    c.push(+r[4]); v.push(+r[5]); tb.push(+r[9]); // r[9] = wolumen kupujących (taker buy)
  }
  return { t, o, h, l, c, v, tb };
}

function ema(a, n) {
  const k = 2 / (n + 1); const out = new Array(a.length); let e = a[0];
  for (let i = 0; i < a.length; i++) { e = i === 0 ? a[0] : a[i] * k + e * (1 - k); out[i] = e; }
  return out;
}
function smaArr(a, n) {
  const out = new Array(a.length).fill(NaN); let s = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) out[i] = s / n; }
  return out;
}
function rsiArr(c, n = 14) {
  const out = new Array(c.length).fill(NaN); let g = 0, lo = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
    if (i <= n) { g += up; lo += dn; if (i === n) { g /= n; lo /= n; out[i] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo); } }
    else { g = (g * (n - 1) + up) / n; lo = (lo * (n - 1) + dn) / n; out[i] = lo === 0 ? 100 : 100 - 100 / (1 + g / lo); }
  }
  return out;
}
function atrArr(h, l, c, n = 14) {
  const out = new Array(c.length).fill(NaN); let a = 0;
  for (let i = 1; i < c.length; i++) {
    const tr = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    if (i <= n) { a += tr; if (i === n) { a /= n; out[i] = a; } }
    else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}

// Cechy opisujące "jak wygląda wykres" w danej świecy
function buildFeatures(k) {
  const { h, l, c, v, tb } = k; const n = c.length;
  const e20 = ema(c, 20), e50 = ema(c, 50), atr = atrArr(h, l, c, 14), rsi = rsiArr(c, 14), vs = smaArr(v, 20);
  const F = new Array(n).fill(null); const raw = new Array(n).fill(null);
  for (let i = WARMUP; i < n; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    let sv6 = 0, st6 = 0, sv12 = 0, sd12 = 0;
    for (let j = i - 5; j <= i; j++) { sv6 += v[j]; st6 += tb[j]; }
    for (let j = i - 11; j <= i; j++) { sv12 += v[j]; sd12 += 2 * tb[j] - v[j]; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - 19; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    const v3 = (v[i] + v[i - 1] + v[i - 2]) / 3;
    const r = {
      trend: (c[i] - e50[i]) / a,              // odległość od EMA50 w ATR
      slope: (e20[i] - e20[i - 5]) / a,        // nachylenie EMA20
      rsi: rsi[i],
      volRatio: vs[i] > 0 ? v3 / vs[i] : 1,    // wolumen vs średnia
      buy: sv6 > 0 ? st6 / sv6 : 0.5,          // udział kupujących (taker buy)
      cvd: sv12 > 0 ? sd12 / sv12 : 0,         // delta wolumenu kupno-sprzedaż
      range: hi > lo ? (c[i] - lo) / (hi - lo) : 0.5, // pozycja w zakresie 20 świec
      atr: a,
    };
    raw[i] = r;
    F[i] = [r.trend, r.slope, r.rsi / 100, Math.log(Math.max(r.volRatio, 1e-3)), r.buy - 0.5, r.cvd, r.range];
  }
  return { F, raw };
}

// Co się wydarzyło po każdej świecy: 1 = najpierw +mUp·ATR, -1 = najpierw -mDn·ATR, 0 = ani to, ani to
function outcomes(k, raw, H, m, mDn) {
  if (mDn === undefined) mDn = m;
  const { h, l, c } = k; const n = c.length; const Y = new Array(n).fill(null);
  for (let i = 0; i < n - H; i++) {
    const r = raw[i]; if (!r) continue;
    const up = c[i] + m * r.atr, dn = c[i] - mDn * r.atr; let y = 0;
    for (let j = i + 1; j <= i + H; j++) {
      const hu = h[j] >= up, hd = l[j] <= dn;
      if (hu && hd) { y = 0; break; }
      if (hu) { y = 1; break; }
      if (hd) { y = -1; break; }
    }
    Y[i] = y;
  }
  return Y;
}

function zscore(F) {
  const rows = F.filter(Boolean); const d = rows[0].length;
  const mu = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const r of rows) for (let q = 0; q < d; q++) mu[q] += r[q] / rows.length;
  for (const r of rows) for (let q = 0; q < d; q++) sd[q] += (r[q] - mu[q]) ** 2 / rows.length;
  for (let q = 0; q < d; q++) sd[q] = Math.sqrt(sd[q]) || 1;
  return F.map(r => (r ? r.map((x, q) => (x - mu[q]) / sd[q]) : null));
}

function baseRates(Y, idx) {
  let u = 0, dn = 0, nn = 0;
  for (const i of idx) { if (Y[i] === 1) u++; else if (Y[i] === -1) dn++; else nn++; }
  const t = idx.length || 1; return [u / t, dn / t, nn / t];
}

// Model dobrany do coina: regresja logistyczna (3 scenariusze) trenowana na historii TEGO coina
const L2 = 0.3, ITERS = 200, LR = 0.5;
function fitModel(Z, Y, idx, init) {
  const d = Z[idx[0]].length; const n = idx.length; const prior = baseRates(Y, idx);
  const W = init ? init.map(r => r.slice()) : [0, 1, 2].map(c => {
    const r = new Array(d + 1).fill(0); r[d] = Math.log(Math.max(prior[c], 0.02)); return r;
  });
  const G = [0, 1, 2].map(() => new Array(d + 1).fill(0)); const z = [0, 0, 0];
  for (let it = 0; it < ITERS; it++) {
    for (const g of G) g.fill(0);
    for (const i of idx) {
      const x = Z[i]; const y = Y[i] === 1 ? 0 : Y[i] === -1 ? 1 : 2;
      for (let c = 0; c < 3; c++) { let s = W[c][d]; for (let q = 0; q < d; q++) s += W[c][q] * x[q]; z[c] = s; }
      const mx = Math.max(z[0], z[1], z[2]); const e0 = Math.exp(z[0] - mx), e1 = Math.exp(z[1] - mx), e2 = Math.exp(z[2] - mx);
      const S = e0 + e1 + e2; const p = [e0 / S, e1 / S, e2 / S];
      for (let c = 0; c < 3; c++) { const gc = p[c] - (c === y ? 1 : 0); const Gc = G[c]; for (let q = 0; q < d; q++) Gc[q] += gc * x[q]; Gc[d] += gc; }
    }
    for (let c = 0; c < 3; c++) for (let q = 0; q <= d; q++) W[c][q] -= LR * (G[c][q] / n + (q < d ? L2 * W[c][q] : 0));
  }
  return { W, prior };
}
function predictP(model, x) {
  const { W } = model; const d = x.length; const z = [0, 1, 2].map(c => { let s = W[c][d]; for (let q = 0; q < d; q++) s += W[c][q] * x[q]; return s; });
  const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const S = e[0] + e[1] + e[2];
  return e.map(v => v / S);
}

function brier(p, y) {
  const t = [y === 1 ? 1 : 0, y === -1 ? 1 : 0, y === 0 ? 1 : 0];
  return (p[0] - t[0]) ** 2 + (p[1] - t[1]) ** 2 + (p[2] - t[2]) ** 2;
}

// Model kierunkowy dla trybu „Bezpieczny cel”. Y: 1 = cel pierwszy, -1 = stop pierwszy, 0 = nic
function dirModel(Z, Y, labelled, cur, H) {
  let skill = null, hiHit = null, hiN = 0, nVal = 0;
  if (labelled.length >= 500) {
    const vs = labelled.slice(Math.max(300 + H, labelled.length - VALID_N));
    let bm = 0, bb = 0, hits = 0, cnt = 0, model = null, fittedAt = -Infinity;
    for (const t of vs) {
      if (t - fittedAt >= REFIT_EVERY) { model = fitModel(Z, Y, labelled.filter(i => i <= t - H), model && model.W); fittedAt = t; }
      const p = predictP(model, Z[t]);
      bm += brier(p, Y[t]); bb += brier(model.prior, Y[t]);
      if (p[0] >= SAFE.thr) { cnt++; if (Y[t] === 1) hits++; }
    }
    skill = bb > 0 ? 1 - bm / bb : 0; hiN = cnt; hiHit = cnt ? hits / cnt : null; nVal = vs.length;
  }
  const model = fitModel(Z, Y, labelled); const p = predictP(model, Z[cur]);
  return { p: p[0], prior: model.prior[0], skill, hiHit, hiN, nVal, weak: skill === null || skill <= 0 };
}

function analyze(k, iv) {
  const { H, m, horizonTxt, label } = CFG[iv];
  const n = k.c.length; const cur = n - 2; // ostatnia ZAMKNIĘTA świeca
  const { F, raw } = buildFeatures(k);
  if (!F[cur]) return { error: 'Za mało danych' };
  const Z = zscore(F);
  const Y = outcomes(k, raw, H, m);
  const labelled = [];
  for (let i = 0; i <= cur - H; i++) if (Z[i] && Y[i] !== null) labelled.push(i);
  if (labelled.length < 120) return { error: 'Za krótka historia coina' };

  // Test skuteczności (walk-forward): model uczy się tylko na przeszłości i przewiduje kolejne sytuacje
  let skill = null, dirHit = null, dirN = 0, nVal = 0;
  if (labelled.length >= 500) {
    const vs = labelled.slice(Math.max(300 + H, labelled.length - VALID_N)); // min. 300 świec nauki przed testem
    let bm = 0, bb = 0, hits = 0, cnt = 0;
    let model = null, fittedAt = -Infinity;
    for (const t of vs) {
      if (t - fittedAt >= REFIT_EVERY) {
        const train = labelled.filter(i => i <= t - H);
        model = fitModel(Z, Y, train, model && model.W); fittedAt = t;
      }
      const p = predictP(model, Z[t]);
      bm += brier(p, Y[t]); bb += brier(model.prior, Y[t]);
      const e = p[0] - p[1];
      if (Math.abs(e) >= EDGE_MIN) { cnt++; if ((e > 0 && Y[t] === 1) || (e < 0 && Y[t] === -1)) hits++; }
    }
    skill = bb > 0 ? 1 - bm / bb : 0; dirN = cnt; dirHit = cnt > 0 ? hits / cnt : null; nVal = vs.length;
  }

  const model = fitModel(Z, Y, labelled);
  const p = predictP(model, Z[cur]); const prior = model.prior;
  const edge = p[0] - p[1];
  const signal = edge >= EDGE_MIN ? 'KUPNO' : edge <= -EDGE_MIN ? 'SPRZEDAŻ' : 'NEUTRALNY';
  const weak = skill === null || skill <= 0; // test na historii nie wykazał przewagi
  const r = raw[cur]; const price = k.c[cur];
  // Tryb „Bezpieczny cel”: osobne modele dla LONG i SHORT
  const lab = YY => labelled.filter(i => YY[i] !== null);
  const YL = outcomes(k, raw, H, SAFE.target, SAFE.stop);
  const YS = outcomes(k, raw, H, SAFE.stop, SAFE.target).map(y => (y === null ? null : -y));
  const safe = {
    long: dirModel(Z, YL, lab(YL), cur, H),
    short: dirModel(Z, YS, lab(YS), cur, H),
    levels: { longT: price + SAFE.target * r.atr, longS: price - SAFE.stop * r.atr, shortT: price - SAFE.target * r.atr, shortS: price + SAFE.stop * r.atr },
  };
  return {
    safe,
    iv, label, horizonTxt, H, m, price,
    probs: { up: p[0], down: p[1], side: p[2] }, prior: { up: prior[0], down: prior[1], side: prior[2] },
    edge, signal, weak, skill, dirHit, dirN, nVal, nTrain: labelled.length,
    levels: { up: price + m * r.atr, down: price - m * r.atr }, raw: r, reasons: reasons(r),
  };
}

function reasons(r, est) {
  const out = [];
  out.push(r.trend > 0.5 ? `Cena ${r.trend.toFixed(1)} ATR nad EMA50 – trend wzrostowy`
    : r.trend < -0.5 ? `Cena ${Math.abs(r.trend).toFixed(1)} ATR pod EMA50 – trend spadkowy`
      : 'Cena blisko EMA50 – brak wyraźnego trendu');
  out.push(r.rsi > 70 ? `RSI ${r.rsi.toFixed(0)} – rynek wykupiony`
    : r.rsi < 30 ? `RSI ${r.rsi.toFixed(0)} – rynek wyprzedany` : `RSI ${r.rsi.toFixed(0)} – neutralnie`);
  out.push(`Wolumen ${r.volRatio.toFixed(1)}× średniej z 20 świec`
    + (r.volRatio > 1.5 ? ' – wzmożona aktywność' : r.volRatio < 0.7 ? ' – mała aktywność' : ''));
  const bp = r.buy * 100;
  out.push(`Kupujący${est ? ' (szac.)' : ''}: ${bp.toFixed(0)}% wolumenu (6 świec) – `
    + (bp > 53 ? 'przewaga presji kupna' : bp < 47 ? 'przewaga presji sprzedaży' : 'równowaga'));
  out.push(`Delta wolumenu${est ? ' (szac.)' : ''} (CVD, 12 świec): ${(r.cvd * 100).toFixed(0)}% – `
    + (r.cvd > 0.05 ? 'agresywni kupujący' : r.cvd < -0.05 ? 'agresywni sprzedający' : 'bez przewagi'));
  out.push(`Pozycja w zakresie 20 świec: ${(r.range * 100).toFixed(0)}%`
    + (r.range > 0.85 ? ' – przy szczycie' : r.range < 0.15 ? ' – przy dołku' : ''));
  return out;
}

// ---------- Wynik w zwartej postaci (do JSON i do UI) ----------
const r4 = x => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const sig = x => (x === null || !isFinite(x) ? null : +x.toPrecision(6));
const cDir = d => ({ p: r4(d.p), prior: r4(d.prior), skill: r4(d.skill), hiHit: r4(d.hiHit), hiN: d.hiN, nVal: d.nVal, weak: d.weak });
function compact(a) {
  if (!a || a.error) return { error: a ? a.error : 'Brak danych' };
  const R = a.raw;
  return {
    label: a.label, horizonTxt: a.horizonTxt, m: a.m, price: sig(a.price),
    probs: { up: r4(a.probs.up), down: r4(a.probs.down), side: r4(a.probs.side) },
    prior: { up: r4(a.prior.up), down: r4(a.prior.down), side: r4(a.prior.side) },
    edge: r4(a.edge), signal: a.signal, weak: a.weak, skill: r4(a.skill),
    dirHit: r4(a.dirHit), dirN: a.dirN, nVal: a.nVal, nTrain: a.nTrain,
    levels: { up: sig(a.levels.up), down: sig(a.levels.down) },
    safe: a.safe ? {
      long: cDir(a.safe.long), short: cDir(a.safe.short),
      levels: { longT: sig(a.safe.levels.longT), longS: sig(a.safe.levels.longS), shortT: sig(a.safe.levels.shortT), shortS: sig(a.safe.levels.shortS) },
    } : null,
    raw: { trend: r4(R.trend), slope: r4(R.slope), rsi: r4(R.rsi), volRatio: r4(R.volRatio), buy: r4(R.buy), cvd: r4(R.cvd), range: r4(R.range), atr: sig(R.atr) },
  };
}

// Scenariusz dla trybu: 'safe' (cel 1 ATR / stop 2 ATR) lub 'equal' (±2 ATR).
// side: 'long' | 'short' wymusza kierunek; bez niego wybierany jest mocniejszy.
function dirOf(a, mode = 'equal', side = null) {
  if (!a || a.error) return null;
  const mk = (dir, p, hist, target, stop, weak, skill, hiHit, hiN, nVal, md) => ({
    dir, p, hist, target, stop, weak, skill, hiHit, hiN, nVal, mode: md,
    movePct: (target / a.price - 1) * 100, stopPct: (stop / a.price - 1) * 100,
  });
  if (mode === 'safe' && a.safe) {
    const S = a.safe, L = S.long, Sh = S.short;
    const lo = mk('LONG', L.p, L.prior, S.levels.longT, S.levels.longS, L.weak, L.skill, L.hiHit, L.hiN, L.nVal, 'safe');
    const sh = mk('SHORT', Sh.p, Sh.prior, S.levels.shortT, S.levels.shortS, Sh.weak, Sh.skill, Sh.hiHit, Sh.hiN, Sh.nVal, 'safe');
    if (side === 'long') return lo;
    if (side === 'short') return sh;
    if (lo.weak !== sh.weak) return lo.weak ? sh : lo;
    return lo.p >= sh.p ? lo : sh;
  }
  const long = side ? side === 'long' : a.probs.up >= a.probs.down;
  return mk(long ? 'LONG' : 'SHORT', long ? a.probs.up : a.probs.down, long ? a.prior.up : a.prior.down,
    long ? a.levels.up : a.levels.down, long ? a.levels.down : a.levels.up,
    a.weak, a.skill, a.dirHit, a.dirN, a.nVal, 'equal');
}

// TOP N: najwyższe prawdopodobieństwo; scenariusze bez potwierdzonej przewagi idą na koniec
function rankTop(coins, iv, dir = 'all', n = 10, mode = 'equal') {
  const rows = [];
  for (const c of coins) {
    const a = c.res && c.res[iv];
    const d = dirOf(a, mode, dir === 'all' ? null : dir); if (!d || d.p === null) continue;
    rows.push({ coin: c, a, d });
  }
  rows.sort((x, y) => (x.d.weak - y.d.weak) || (y.d.p - x.d.p));
  return rows.slice(0, n);
}

// ---------- Kategorie coinów ----------
const CATS = {
  meme: { label: 'Memecoin', color: '#f472b6' },
  ai: { label: 'AI', color: '#a78bfa' },
  l1: { label: 'Layer 1', color: '#60a5fa' },
  l2: { label: 'Layer 2', color: '#38bdf8' },
  defi: { label: 'DeFi', color: '#34d399' },
  gaming: { label: 'Gaming', color: '#fbbf24' },
  rwa: { label: 'RWA', color: '#f59e0b' },
  depin: { label: 'DePIN', color: '#2dd4bf' },
  exchange: { label: 'Token giełdy', color: '#fb923c' },
  other: { label: 'Inne', color: '#8a97ab' },
};
// Pewne przypisania dla znanych coinów (mają pierwszeństwo przed danymi z CoinGecko)
const STATIC_CATS = {
  l1: 'BTC ETH SOL XRP ADA AVAX DOT TRX TON SUI APT NEAR SEI ATOM HBAR ALGO XLM LTC BCH ETC KAS TIA EGLD XTZ ICP VET FTM S BERA MOVE',
  l2: 'ARB OP POL MATIC STRK MNT ZK METIS MANTA BLAST LINEA SCR',
  meme: 'DOGE SHIB PEPE WIF BONK FLOKI TRUMP PENGU FARTCOIN POPCAT MOG BRETT NEIRO TURBO MEW BOME DOGS PNUT GOAT MOODENG SPX BABYDOGE MEME PEOPLE',
  ai: 'FET RENDER TAO VIRTUAL AI16Z WLD ARKM GRT AIXBT IO AKT OLAS NMR AGIX OCEAN',
  defi: 'UNI AAVE LINK MKR SKY LDO CRV PENDLE JUP RAY CAKE ENA HYPE INJ DYDX GMX COMP SNX SUSHI 1INCH JTO ETHFI EIGEN',
  rwa: 'ONDO OM PLUME CFG POLYX',
  depin: 'FIL AR HNT IOTX THETA STORJ GLM',
  gaming: 'AXS SAND MANA GALA BEAM RON IMX ILV YGG PIXEL',
  exchange: 'BNB OKB CRO BGB LEO KCS GT',
};
const STATIC_MAP = {};
for (const [k, list] of Object.entries(STATIC_CATS)) for (const sym of list.split(' ')) STATIC_MAP[sym] = k;
const cleanBase = b => String(b).toUpperCase().replace(/^(1000000|1000|1M)(?=[A-Z])/, '');
// cg: opcjonalna mapa symbol -> kategoria z CoinGecko (dostarcza skaner)
function catOf(base, cg) {
  const b = cleanBase(base);
  return STATIC_MAP[b] || (cg && cg[b]) || 'other';
}

module.exports = { SAFE, BREAK_EVEN, CATS, catOf, cleanBase, CFG, HISTORY, VALID_N, EDGE_MIN, parseKlines, analyze, reasons, compact, dirOf, rankTop };
