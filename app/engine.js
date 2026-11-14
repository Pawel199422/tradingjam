// Silnik analizy – wspólny dla aplikacji (telefon) i skanera (serwer GitHub).
// Dla każdego coina i interwału osobno trenuje model na historii tego coina
// i liczy prawdopodobieństwo 3 scenariuszy: wzrost / spadek / konsolidacja.

// Interwał -> horyzont scenariusza (H świec) i wielkość ruchu (m × ATR)
const CFG = {
  '1h': { label: '1h', H: 24, m: 2, horizonTxt: '24 godz.' },
  '4h': { label: '4h', H: 18, m: 2, horizonTxt: '3 dni' },
  '1d': { label: '1D', H: 14, m: 2, horizonTxt: '14 dni' },
  // 30 dni ze świec dziennych: cel/stop skalowane √(30/14) ≈ 1,46 – ruch realny na miesiąc
  '30d': { label: '1D', H: 30, m: 2 * 1.46, horizonTxt: '30 dni', scale: 1.46, bars: '1d' },
};
// 14 dni ze świec 4h – dla coinów z krótką historią dzienną. 84 świece = 14 dni,
// zmienność 4h × √6 ≈ zmienność dzienna, więc ruch skalujemy o 2,45.
const ALT_CFG = {
  '1d4h': { label: '4h', H: 84, m: 2 * 2.45, horizonTxt: '14 dni', scale: 2.45 },
  // 3 dni dla młodego coina: 72 świece 1h, cel/stop skalowane √4 = 2 (ATR 1h → ATR 4h)
  '4h1h': { label: '1h', H: 72, m: 2 * 2, horizonTxt: '3 dni', scale: 2 },
  '30d4h': { label: '4h', H: 180, m: 2 * 2.45 * 1.46, horizonTxt: '30 dni', scale: 2.45 * 1.46 },
};
const MIN_DAILY = 200; // min. liczba świec dziennych dla zwykłej prognozy 14 dni
const VALID_N = 1000;    // ile ostatnich sytuacji do testu skuteczności
const REFIT_EVERY = 200; // co ile świec model jest douczany w teście
// Tryb „Bezpieczny cel”: bliższy cel (1× ATR), dalszy stop (2× ATR) – wyższa szansa trafienia, gorszy stosunek zysku do ryzyka
const SAFE = { target: 1, stop: 2, thr: 0.65 };
// Tryb „Duży cel” (2:1): cel 2× ATR, stop 1× ATR – rzadziej trafia, ale wygrana jest 2× większa od straty
const BIG = { target: 2, stop: 1, thr: 0.40 };
const BREAK_EVEN = SAFE.stop / (SAFE.target + SAFE.stop); // 66,7% – próg opłacalności przy celu 1:2
// Próg opłacalności = stop / (cel + stop)
const MODE_BE = { safe: BREAK_EVEN, big: BIG.stop / (BIG.target + BIG.stop), equal: 0.5 };
const MODE_RR = { safe: '1:2', big: '2:1', equal: '1:1' };
const HISTORY = 3000;    // ile świec historii pobierać na interwał
const WARMUP = 60;
const REGIME_X = 4;
const TREND_MIN = 0.5;     // min. odległość od EMA50 (w ATR), żeby mówić o wyraźnym trendzie        // historia: min. 4× wzrost (lub spadek do 1/4) = „jeden trend”       // świece na rozgrzanie wskaźników
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
// Kontekst rynku (BTC) w tej samej świecy: trend BTC (odległość od EMA50 w ATR) i ruch z ostatnich 6 świec
function btcContext(kb) {
  if (!kb || !kb.c || kb.c.length < 60) return null;
  const e50 = ema(kb.c, 50), atr = atrArr(kb.h, kb.l, kb.c, 14); const t = [], v = [];
  for (let i = 6; i < kb.c.length; i++) {
    const a = atr[i]; if (!(a > 0)) continue;
    t.push(kb.t[i]); v.push([(kb.c[i] - e50[i]) / a, (kb.c[i] - kb.c[i - 6]) / a]);
  }
  return { t, v };
}
// ctx: kontekst BTC ({t, v} – bierzemy ostatnią świecę BTC nie późniejszą niż świeca coina)
// k4: świece 4h tego samego coina – dla modelu 1h dokładamy trend, RSI i nachylenie z ostatniej ZAMKNIĘTEJ świecy 4h
function buildFeatures(k, ctx, k4) {
  const f4 = k4 ? buildFeatures(k4).raw : null; let j4 = 0, jb = 0;
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
    if (k4) {
      while (j4 + 1 < k4.t.length && k4.t[j4 + 1] + 4 * 36e5 <= k.t[i] + 36e5) j4++;
      const r4 = k4.t[j4] + 4 * 36e5 <= k.t[i] + 36e5 ? f4[j4] : null;
      if (!r4) { F[i] = null; raw[i] = null; continue; }
      F[i].push(r4.trend, r4.rsi / 100, r4.slope);
    }
    if (ctx) {
      while (jb + 1 < ctx.t.length && ctx.t[jb + 1] <= k.t[i]) jb++;
      if (!ctx.t.length || ctx.t[jb] > k.t[i]) { F[i] = null; raw[i] = null; continue; }
      const b = ctx.v[jb]; F[i].push(b[0], b[1]); r.btcTrend = b[0];
    }
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
function fitModel(Z, Y, idx, init, l2 = L2) {
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
    for (let c = 0; c < 3; c++) for (let q = 0; q <= d; q++) W[c][q] -= LR * (G[c][q] / n + (q < d ? l2 * W[c][q] : 0));
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
function dirModel(Z, Y, labelled, cur, H, thr) {
  let skill = null, hiHit = null, hiN = 0, nVal = 0;
  if (labelled.length >= 500) {
    const vs = labelled.slice(Math.max(300 + H, labelled.length - VALID_N));
    let bm = 0, bb = 0, hits = 0, cnt = 0, model = null, fittedAt = -Infinity;
    for (const t of vs) {
      if (t - fittedAt >= REFIT_EVERY) { model = fitModel(Z, Y, labelled.filter(i => i <= t - H), model && model.W); fittedAt = t; }
      const p = predictP(model, Z[t]);
      bm += brier(p, Y[t]); bb += brier(model.prior, Y[t]);
      if (p[0] >= thr) { cnt++; if (Y[t] === 1) hits++; }
    }
    skill = bb > 0 ? 1 - bm / bb : 0; hiN = cnt; hiHit = cnt ? hits / cnt : null; nVal = vs.length;
  }
  const model = fitModel(Z, Y, labelled); const p = predictP(model, Z[cur]);
  return { p: p[0], prior: model.prior[0], skill, hiHit, hiN, nVal, weak: skill === null || skill <= 0 };
}

function analyze(k, iv, ctx, k4) {
  const cfg = CFG[iv] || ALT_CFG[iv];
  const { H, m, horizonTxt, label } = cfg; const scale = cfg.scale || 1;
  const n = k.c.length; const cur = n - 2; // ostatnia ZAMKNIĘTA świeca
  const { F, raw } = buildFeatures(k, ctx, k4);
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
  const tg = SAFE.target * scale, st = SAFE.stop * scale;
  const YL = outcomes(k, raw, H, tg, st);
  const YS = outcomes(k, raw, H, st, tg).map(y => (y === null ? null : -y));
  const safe = {
    long: dirModel(Z, YL, lab(YL), cur, H, SAFE.thr),
    short: dirModel(Z, YS, lab(YS), cur, H, SAFE.thr),
    levels: { longT: price + tg * r.atr, longS: price - st * r.atr, shortT: price - tg * r.atr, shortS: price + st * r.atr },
  };
  // Tryb „Duży cel” (2:1)
  const tgB = BIG.target * scale, stB = BIG.stop * scale;
  const YLb = outcomes(k, raw, H, tgB, stB);
  const YSb = outcomes(k, raw, H, stB, tgB).map(y => (y === null ? null : -y));
  const big = {
    long: dirModel(Z, YLb, lab(YLb), cur, H, BIG.thr),
    short: dirModel(Z, YSb, lab(YSb), cur, H, BIG.thr),
    levels: { longT: price + tgB * r.atr, longS: price - stB * r.atr, shortT: price - tgB * r.atr, shortS: price + stB * r.atr },
  };
  // Zmiana trendu: czy w ciągu H świec cena zamknie się po drugiej stronie średniej EMA50
  let brk = { side: null };
  if (Math.abs(r.trend) >= TREND_MIN) {
    const side = r.trend > 0 ? 1 : -1;
    const YB = new Array(n).fill(null);
    for (let i = 0; i <= cur - H; i++) {
      const ri = raw[i]; if (!ri || Math.sign(ri.trend) !== side || Math.abs(ri.trend) < TREND_MIN) continue;
      let y = 0;
      for (let j = i + 1; j <= i + H; j++) { const rj = raw[j]; if (rj && Math.sign(rj.trend) === -side) { y = 1; break; } }
      YB[i] = y;
    }
    const labB = labelled.filter(i => YB[i] !== null);
    const e50 = price - r.trend * r.atr;
    if (labB.length >= 60) {
      const m = dirModel(Z, YB, labB, cur, H, 0.5);
      brk = { side: side > 0 ? 'up' : 'down', level: e50, ...m, nHist: labB.length };
    } else brk = { side: side > 0 ? 'up' : 'down', level: e50, p: null, nHist: labB.length };
  }
  // Historia z jednego trendu: coin w całej historii głównie rósł (albo spadał), a teraz idzie w drugą stronę
  let hiC = -Infinity, loC = Infinity;
  for (let i = WARMUP; i <= cur; i++) { if (k.c[i] > hiC) hiC = k.c[i]; if (k.c[i] < loC) loC = k.c[i]; }
  const c0 = k.c[WARMUP];
  let regime = null;
  if (hiC / c0 >= REGIME_X && r.trend < -0.5 && price < hiC * 0.7) regime = { dir: 'up', x: hiC / c0, fromTop: price / hiC - 1 };
  else if (loC / c0 <= 1 / REGIME_X && r.trend > 0.5 && price > loC * 1.4) regime = { dir: 'down', x: loC / c0, fromTop: price / loC - 1 };
  // Średnie kroczące do pokazania (te same co na giełdach: MA5/10/30) + EMA używane przez model
  const sma = nn => { let t = 0; for (let i = cur - nn + 1; i <= cur; i++) t += k.c[i]; return t / nn; };
  const ma = cur >= 50 ? { ma5: sma(5), ma10: sma(10), ma30: sma(30), ema20: ema(k.c, 20)[cur], ema50: ema(k.c, 50)[cur] } : null;
  return {
    ma,
    brk,
    regime,
    src: ALT_CFG[iv] ? ALT_CFG[iv].label : null,
    safe, big,
    iv, label, horizonTxt, H, m, price,
    probs: { up: p[0], down: p[1], side: p[2] }, prior: { up: prior[0], down: prior[1], side: prior[2] },
    edge, signal, weak, skill, dirHit, dirN, nVal, nTrain: labelled.length,
    levels: { up: price + m * r.atr, down: price - m * r.atr }, raw: r, reasons: reasons(r),
  };
}

// Opis wykresu prostym językiem (dla początkujących)
function reasons(r, est) {
  const out = [];
  out.push(r.trend > 0.5 ? `Trend wzrostowy – cena jest wyraźnie powyżej swojej średniej z ostatnich 50 świec`
    : r.trend < -0.5 ? `Trend spadkowy – cena jest wyraźnie poniżej swojej średniej z ostatnich 50 świec`
      : 'Brak wyraźnego trendu – cena kręci się wokół swojej średniej');
  out.push(r.rsi > 70 ? `Rynek „przegrzany” (RSI ${r.rsi.toFixed(0)}) – po mocnych wzrostach często przychodzi korekta`
    : r.rsi < 30 ? `Rynek „wyprzedany” (RSI ${r.rsi.toFixed(0)}) – po mocnych spadkach często przychodzi odbicie`
      : `Siła ruchu neutralna (RSI ${r.rsi.toFixed(0)}) – ani przegrzany, ani wyprzedany`);
  out.push(r.volRatio > 1.5 ? `Duże zainteresowanie – obroty ${r.volRatio.toFixed(1)}× wyższe niż zwykle`
    : r.volRatio < 0.7 ? `Małe zainteresowanie – obroty tylko ${r.volRatio.toFixed(1)}× zwykłych`
      : `Normalne obroty (${r.volRatio.toFixed(1)}× średniej)`);
  const bp = r.buy * 100;
  out.push((bp > 53 ? `Przewagę mają kupujący` : bp < 47 ? `Przewagę mają sprzedający` : `Kupujący i sprzedający w równowadze`)
    + ` – ${bp.toFixed(0)}% ostatnich transakcji to zakupy${est ? ' (szacunek)' : ''}`);
  out.push(r.range > 0.85 ? `Cena przy szczycie z ostatnich 20 świec`
    : r.range < 0.15 ? `Cena przy dołku z ostatnich 20 świec`
      : `Cena w środku zakresu z ostatnich 20 świec (${(r.range * 100).toFixed(0)}% drogi od dołka do szczytu)`);
  return out;
}

// Czynniki, z których korzysta model (do opisu w aplikacji)
const FACTORS = [
  ['Średnia krocząca (EMA 50)', 'jak daleko cena jest od swojej średniej – trend'],
  ['Nachylenie średniej (EMA 20)', 'czy krótki trend przyspiesza, czy hamuje'],
  ['RSI 14', 'czy rynek jest przegrzany albo wyprzedany'],
  ['Wolumen', 'czy obroty są większe czy mniejsze niż zwykle'],
  ['Presja kupujących', 'jaka część ostatnich transakcji to zakupy'],
  ['Delta wolumenu (CVD)', 'czy przez ostatnie 12 świec przeważało kupowanie czy sprzedawanie'],
  ['Pozycja w zakresie', 'czy cena jest przy szczycie czy przy dołku z ostatnich 20 świec'],
  ['Trend Bitcoina (24 godz. i 3 dni)', 'czy cały rynek, czyli BTC, rośnie czy spada'],
  ['Trend z wyższego interwału (24 godz.)', 'trend, RSI i nachylenie średniej ze świec 4h'],
];

// ---------- Wynik w zwartej postaci (do JSON i do UI) ----------
const r4 = x => (x === null || x === undefined || !isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const sig = x => (x === null || !isFinite(x) ? null : +x.toPrecision(6));
const cDir = d => ({ p: r4(d.p), prior: r4(d.prior), skill: r4(d.skill), hiHit: r4(d.hiHit), hiN: d.hiN, nVal: d.nVal, weak: d.weak });
const cMode = m => (m ? {
  long: cDir(m.long), short: cDir(m.short),
  levels: { longT: sig(m.levels.longT), longS: sig(m.levels.longS), shortT: sig(m.levels.shortT), shortS: sig(m.levels.shortS) },
} : null);
function compact(a) {
  if (!a || a.error) return { error: a ? a.error : 'Brak danych' };
  const R = a.raw;
  return {
    label: a.label, horizonTxt: a.horizonTxt, m: r4(a.m), price: sig(a.price), src: a.src || null,
    brk: a.brk ? (a.brk.side ? { side: a.brk.side, level: sig(a.brk.level), p: r4(a.brk.p), prior: r4(a.brk.prior), skill: r4(a.brk.skill), hiHit: r4(a.brk.hiHit), hiN: a.brk.hiN || 0, weak: a.brk.p === null || a.brk.p === undefined ? true : a.brk.weak, nHist: a.brk.nHist } : { side: null }) : null,
    ma: a.ma ? { ma5: sig(a.ma.ma5), ma10: sig(a.ma.ma10), ma30: sig(a.ma.ma30), ema20: sig(a.ma.ema20), ema50: sig(a.ma.ema50) } : null,
    regime: a.regime ? { dir: a.regime.dir, x: r4(a.regime.x), fromTop: r4(a.regime.fromTop) } : null,
    probs: { up: r4(a.probs.up), down: r4(a.probs.down), side: r4(a.probs.side) },
    prior: { up: r4(a.prior.up), down: r4(a.prior.down), side: r4(a.prior.side) },
    edge: r4(a.edge), signal: a.signal, weak: a.weak, skill: r4(a.skill),
    dirHit: r4(a.dirHit), dirN: a.dirN, nVal: a.nVal, nTrain: a.nTrain,
    levels: { up: sig(a.levels.up), down: sig(a.levels.down) },
    safe: cMode(a.safe), big: cMode(a.big),
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
    // cel lub stop poniżej 10% ceny (np. stop −141%) – ruchy zbyt duże na ten horyzont
    tooWide: !(Math.min(target, stop) > a.price * 0.1),
  });
  if (mode === 'safe' || mode === 'big') {
    const S = a[mode]; if (!S) return null;
    const L = S.long, Sh = S.short;
    const lo = mk('LONG', L.p, L.prior, S.levels.longT, S.levels.longS, L.weak, L.skill, L.hiHit, L.hiN, L.nVal, mode);
    const sh = mk('SHORT', Sh.p, Sh.prior, S.levels.shortT, S.levels.shortS, Sh.weak, Sh.skill, Sh.hiHit, Sh.hiN, Sh.nVal, mode);
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
// Ekstremalny ruch w 24h – historia coina słabo opisuje taką sytuację
const EXTREME_PCT = 40;
const isExtreme = c => Math.abs(c.chg || 0) >= EXTREME_PCT;
// Niska płynność: mały obrót z 24h – pojedyncze knoty łatwo wybijają stop
const LOW_QV = 2e5;
const isIlliquid = c => c && c.qv > 0 && c.qv < LOW_QV;
// Powód braku zaufania: 'short' = za krótka historia do testu, 'noedge' = test nie wykazał przewagi
const weakWhy = d => (!d || !d.weak ? null : d.skill === null || d.skill === undefined ? 'short' : 'noedge');

// Opis statystyczny (neutralny – bez poleceń kupna/sprzedaży): { level, text }
function verdict(d, coin, a) {
  if (d && d.tooWide) return { level: 'avoid', text: `Za duże ruchy na ten horyzont – ${coin.base} zmienia się tak gwałtownie, że cel i stop wypadłyby poza sensowny zakres (stop poniżej zera). Tej statystyki nie da się tu uczciwie pokazać – sprawdź krótszy horyzont.` };
  if (!d) return { level: 'none', text: 'Brak danych.' };
  const be = MODE_BE[d.mode] || 0.5;
  const pc = Math.round(d.p * 100), bc = Math.round(be * 100);
  if (isExtreme(coin)) return { level: 'avoid', text: 'Ekstremalna zmienność – cena zmieniła się o 40% lub więcej w 24h. Historia coina nie opisuje takiej sytuacji, statystyka jest tu niewiarygodna.' };
  if (a && a.regime) return { level: 'avoid', text: `Historia z jednego trendu – dane ${coin.base} pochodzą głównie z okresu silnych ${a.regime.dir === 'up' ? 'wzrostów' : 'spadków'}, a teraz cena idzie w drugą stronę. Statystyka (${d.dir} ${pc}%) może być mocno skrzywiona.` };
  if (weakWhy(d) === 'short') return { level: 'none', text: 'Za młody coin – nie da się sprawdzić, czy ten procent coś znaczy.' };
  if (weakWhy(d) === 'noedge') return { level: 'none', text: 'Wykres nic tu nie mówi – ten procent nie jest lepszy od zwykłej średniej.' };
  if (d.p > be + 0.02) return { level: 'go', text: `Statystycznie: przewaga scenariusza ${d.dir} – ${pc}% przy progu opłacalności ${bc}%.` };
  if (d.p >= be - 0.005) return { level: 'weak', text: `Statystycznie: ${d.dir} ${pc}% – na granicy progu opłacalności ${bc}% (za mały zapas, by mówić o przewadze).` };
  return { level: 'weak', text: `Żaden scenariusz nie przekracza progu opłacalności ${bc}% (najwyżej ${d.dir} ${pc}%). Statystyka nie podpowiada ani longa, ani shorta.` };
}

function rankTop(coins, iv, dir = 'all', n = 10, mode = 'equal') {
  const rows = [];
  for (const c of coins) {
    const a = c.res && c.res[iv];
    const d = dirOf(a, mode, dir === 'all' ? null : dir); if (!d || d.p === null) continue;
    rows.push({ coin: c, a, d });
  }
  // Kolejność: 0 = wiarygodny i powyżej progu, 1 = wiarygodny pod progiem, 2 = z ostrzeżeniem.
  // W grupie: największa przewaga nad normą („teraz − normalnie”), potem wyższy procent.
  for (const r of rows) { r.tier = rankTier(r); r.lift = liftOf(r.d); }
  rows.sort((x, y) => (x.tier - y.tier) || (y.lift - x.lift) || (y.d.p - x.d.p));
  return rows.slice(0, n);
}
const TOP_SKILL = 0.01, TOP_LIFT = 0.05;
const liftOf = d => (d && d.p !== null && d.hist !== null && d.hist !== undefined ? d.p - d.hist : 0);
function rankTier(r) {
  if (r.d.weak || r.d.tooWide || isExtreme(r.coin) || isIlliquid(r.coin) || (r.a && r.a.regime)) return 2;
  // TOP: test wyraźnie zdany (skill ≥ 1%) i przewaga nad normą ≥ 5 pkt – w backteście najlepsza zasada wyboru
  return r.d.p > (MODE_BE[r.d.mode] || 0.5) + 0.02 && (r.d.skill || 0) >= TOP_SKILL && liftOf(r.d) >= TOP_LIFT ? 0 : 1;
}
// Krótki powód miejsca w TOP 10 (do wyświetlenia przy coinie)
function rankReason(r) {
  const lift = Math.round(liftOf(r.d) * 100);
  const liftTxt = lift > 0 ? `+${lift} pkt ponad normę` : lift < 0 ? `${lift} pkt poniżej normy` : 'na poziomie normy';
  if (r.tier === 2) {
    const why = r.d.tooWide ? '⚠ za duże ruchy na ten horyzont' : isExtreme(r.coin) ? '⚡ ekstremalny ruch' : r.a && r.a.regime ? '⚠ historia z jednego trendu' : isIlliquid(r.coin) ? '💧 mały obrót' : weakWhy(r.d) === 'short' ? '⚠ za młody coin' : '⚠ wykres nic tu nie mówi';
    return { good: false, text: `Na końcu listy: ${why}` };
  }
  if (r.tier === 0) return { good: true, text: `Dlaczego tu: ${liftTxt} · powyżej progu · test na historii zdany ✓` };
  const why = !(r.d.p > (MODE_BE[r.d.mode] || 0.5) + 0.02) ? 'pod progiem opłacalności' : liftOf(r.d) < TOP_LIFT ? 'przewaga poniżej +5 pkt' : 'test zdany tylko na granicy';
  return { good: false, text: `Niżej na liście: ${liftTxt} · ${why}` };
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

// ---------- Historia wyników: rozliczanie zapisanych scenariuszy ----------
const HORIZON_MS = { '1h': 24 * 36e5, '4h': 72 * 36e5, '1d': 14 * 864e5, '30d': 30 * 864e5 };
// path: świece 1h { t, h, l, c } (t = czas otwarcia). Pierwsze dotknięcie celu albo stopu;
// gdy w jednej świecy padają oba – liczymy stop (ostrożnie). Po czasie bez rozstrzygnięcia – „expired”.
function resolvePick(pk, path, now = Date.now()) {
  if (!pk || pk.status !== 'open' || !path || !path.t) return pk;
  const long = pk.dir === 'LONG';
  let last = null;
  for (let i = 0; i < path.t.length; i++) {
    const t = path.t[i];
    if (t < pk.t) continue;
    if (t >= pk.end) break;
    last = i;
    const hitS = long ? path.l[i] <= pk.stop : path.h[i] >= pk.stop;
    const hitT = long ? path.h[i] >= pk.target : path.l[i] <= pk.target;
    if (hitS) return { ...pk, status: 'loss', closedAt: t + 36e5, r: -1 };
    if (hitT) return { ...pk, status: 'win', closedAt: t + 36e5, r: +(Math.abs(pk.target - pk.price) / Math.abs(pk.price - pk.stop)).toFixed(2) };
  }
  const lastT = path.t.length ? path.t[path.t.length - 1] : 0;
  if (now >= pk.end && lastT + 36e5 >= pk.end) {
    const exit = last !== null ? path.c[last] : pk.price;
    const r = ((long ? exit - pk.price : pk.price - exit) / Math.abs(pk.price - pk.stop));
    return { ...pk, status: 'expired', closedAt: pk.end, r: +r.toFixed(2) };
  }
  return pk;
}
// Podsumowanie: liczba trafień i wynik w „jednostkach ryzyka” (R): cel 2:1 = +2R, stop = −1R
function historyStats(list, iv) {
  const cl = list.filter(p => p.iv === iv && p.status !== 'open' && !p.noData);
  const win = cl.filter(p => p.status === 'win').length, loss = cl.filter(p => p.status === 'loss').length;
  const exp = cl.length - win - loss;
  const sumR = cl.reduce((a, p) => a + (p.r || 0), 0);
  return { n: cl.length, win, loss, exp, open: list.filter(p => p.iv === iv && p.status === 'open').length, hit: win + loss ? win / (win + loss) : null, sumR };
}

// Rozbicie wyników na grupy (przewaga, kierunek, zgodność z BTC, giełda)
function historyBreakdown(list, iv) {
  const cl = list.filter(p => p.iv === iv && p.status !== 'open' && !p.noData);
  const grp = (label, f) => { const g = cl.filter(f); const w = g.filter(p => p.status === 'win').length, l = g.filter(p => p.status === 'loss').length; return { label, n: g.length, hit: w + l ? w / (w + l) : null, sumR: g.reduce((a, p) => a + (p.r || 0), 0) }; };
  const withBtc = p => p.btcTrend !== null && p.btcTrend !== undefined;
  const sameBtc = p => withBtc(p) && ((p.dir === 'LONG' && p.btcTrend > 0.5) || (p.dir === 'SHORT' && p.btcTrend < -0.5));
  const againstBtc = p => withBtc(p) && ((p.dir === 'LONG' && p.btcTrend < -0.5) || (p.dir === 'SHORT' && p.btcTrend > 0.5));
  return [
    { title: 'Przewaga nad normą', rows: [grp('+5 pkt i więcej', p => p.lift !== undefined && p.lift >= 0.05), grp('poniżej +5 pkt', p => p.lift !== undefined && p.lift < 0.05)] },
    { title: 'Kierunek', rows: [grp('LONG', p => p.dir === 'LONG'), grp('SHORT', p => p.dir === 'SHORT')] },
    { title: 'Względem trendu BTC', rows: [grp('zgodnie z BTC', sameBtc), grp('pod prąd BTC', againstBtc), grp('BTC bez trendu', p => withBtc(p) && !sameBtc(p) && !againstBtc(p))] },
    { title: 'Giełda', rows: [grp('Binance', p => p.ex === 'binance'), grp('BingX', p => p.ex === 'bingx'), grp('OKX', p => p.ex === 'okx')] },
  ].map(s => ({ ...s, rows: s.rows.filter(r => r.n > 0) })).filter(s => s.rows.length);
}

// Wnętrze modelu – do eksperymentów (scripts/backtest-top.js)
const _internal = { buildFeatures, zscore, outcomes, fitModel, predictP, brier, baseRates };

module.exports = { _internal, historyBreakdown, btcContext, HORIZON_MS, resolvePick, historyStats, rankReason, liftOf, LOW_QV, isIlliquid, REGIME_X, FACTORS, BIG, MODE_BE, MODE_RR, verdict, ALT_CFG, MIN_DAILY, EXTREME_PCT, isExtreme, weakWhy, SAFE, BREAK_EVEN, CATS, catOf, cleanBase, CFG, HISTORY, VALID_N, EDGE_MIN, parseKlines, analyze, reasons, compact, dirOf, rankTop };
