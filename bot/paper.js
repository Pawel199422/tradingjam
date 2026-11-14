// Bot „na sucho” (paper trading) – handluje WIRTUALNYM kontem na cenach z BingX.
// Co godzinę, po skanie: zamyka pozycje, które doszły do celu / stopu / końca czasu,
// i otwiera nowe z zielonych scenariuszy TOP 10 (24 godz. i 3 dni, układ 2:1).
// Liczy opłaty i poślizg, żeby wynik był jak najbliższy prawdziwemu handlowi.
const fs = require('fs');
const path = require('path');
const E = require('../app/engine.js');
const X = require('../app/exchanges.js');

const CFG = {
  mode: 'paper',            // na razie tylko „na sucho”
  startBalance: 1000,       // wirtualne USDT
  riskPct: 0.01,            // ryzyko na pozycję: 1% salda (strata przy stopie)
  maxOpen: 5,               // maks. otwartych pozycji naraz
  maxLeverage: 3,           // łączna wartość pozycji ≤ 3× saldo
  feePct: 0.0005,           // opłata BingX (taker) za stronę: 0,05%
  slipPct: 0.0005,          // poślizg za stronę: 0,05%
  dailyLossPct: 0.03,       // po stracie 3% w ciągu dnia (UTC) – brak nowych wejść do końca dnia
  horizons: ['1h', '4h'],   // 24 godz. i 3 dni – potwierdzone w backteście
  minQv: 3e5,               // min. obrót z 24h na BingX
};
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'out');
const H_MS = { '1h': 24 * 36e5, '4h': 72 * 36e5 };

async function loadState() {
  try {
    if (process.env.BOT_IN) return fs.existsSync(process.env.BOT_IN) ? JSON.parse(fs.readFileSync(process.env.BOT_IN, 'utf8')) : null;
    if (process.env.GITHUB_REPOSITORY) {
      const r = await fetch(`https://raw.githubusercontent.com/${process.env.GITHUB_REPOSITORY}/data/bot.json?t=${Date.now()}`);
      if (r.ok) return await r.json();
    }
  } catch (e) { }
  return null;
}
const fresh = () => ({ cfg: CFG, startedAt: Date.now(), balance: CFG.startBalance, positions: [], closed: [], equity: [], day: null, log: [] });

// cena wykonania z poślizgiem (zawsze na naszą niekorzyść)
const fill = (px, side, opening) => {
  const worse = (side === 'LONG') === opening ? 1 + CFG.slipPct : 1 - CFG.slipPct;
  return px * worse;
};
const pnl = (p, exitPx) => (p.side === 'LONG' ? exitPx - p.entry : p.entry - exitPx) * p.qty;

function closePos(st, p, exitRaw, reason, t) {
  const exit = fill(exitRaw, p.side, false);
  const gross = pnl(p, exit);
  const fees = (p.entry * p.qty + exit * p.qty) * CFG.feePct;
  const net = gross - fees;
  st.balance += net;
  st.closed.unshift({ ...p, exit, closedAt: t, reason, net: +net.toFixed(4), fees: +fees.toFixed(4), r: +(net / p.risk).toFixed(2) });
  st.log.unshift(`${new Date(t).toISOString().slice(0, 16)} zamknięto ${p.base} ${p.side} (${reason}) ${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT`);
}

async function main() {
  const now = Date.now();
  const res = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));
  let st = await loadState();
  if (!st || !st.cfg) st = fresh();
  st.cfg = CFG;

  // aktualne ceny z BingX (bot handluje tylko tam)
  const tick = await X.bingxTickers();
  const byBase = new Map(tick.map(t => [E.cleanBase(t.base), t]));

  // ---------- 1. zamykanie pozycji ----------
  for (const p of [...st.positions]) {
    let k = null;
    try { k = await X.bingxKlines(p.sym, '1h', 200); } catch (e) { }
    let done = null;
    if (k) {
      for (let i = 0; i < k.t.length && !done; i++) {
        if (k.t[i] < p.openedAt || k.t[i] < (p.checkedTo || 0)) continue;
        if (k.t[i] >= p.end) break;
        const hitS = p.side === 'LONG' ? k.l[i] <= p.stop : k.h[i] >= p.stop;
        const hitT = p.side === 'LONG' ? k.h[i] >= p.target : k.l[i] <= p.target;
        if (hitS) done = [p.stop, 'stop', k.t[i] + 36e5];      // oba w jednej świecy → liczymy stop (ostrożnie)
        else if (hitT) done = [p.target, 'cel', k.t[i] + 36e5];
      }
      if (!done && k.t.length) p.checkedTo = k.t[k.t.length - 1]; // ostatnia (niezamknięta) świeca – sprawdzimy ponownie
    }
    const live = byBase.get(E.cleanBase(p.base));
    if (!done && live) {
      if (p.side === 'LONG' ? live.price <= p.stop : live.price >= p.stop) done = [p.stop, 'stop', now];
      else if (p.side === 'LONG' ? live.price >= p.target : live.price <= p.target) done = [p.target, 'cel', now];
    }
    if (!done && now >= p.end) done = [live ? live.price : p.entry, 'czas minął', now];
    if (done) { closePos(st, p, done[0], done[1], done[2]); st.positions = st.positions.filter(x => x !== p); }
  }

  // ---------- 2. bezpiecznik dzienny ----------
  const today = new Date(now).toISOString().slice(0, 10);
  if (!st.day || st.day.date !== today) st.day = { date: today, startBalance: st.balance };
  const dayLoss = (st.day.startBalance - st.balance) / st.day.startBalance;
  const halted = dayLoss >= CFG.dailyLossPct;
  if (halted) st.log.unshift(`${new Date(now).toISOString().slice(0, 16)} dzienny limit straty – brak nowych wejść do końca dnia`);

  // ---------- 3. nowe wejścia ----------
  let opened = 0;
  if (!halted) {
    const cands = [];
    for (const iv of CFG.horizons) {
      for (const r of E.rankTop(res.coins, iv, 'all', 10, 'big')) {
        if (r.tier !== 0) continue;
        const live = byBase.get(E.cleanBase(r.coin.base));
        if (!live || live.qv < CFG.minQv) continue;
        cands.push({ r, iv, live });
      }
    }
    cands.sort((a, b) => b.r.lift - a.r.lift);
    for (const { r, iv, live } of cands) {
      if (st.positions.length >= CFG.maxOpen) break;
      if (st.positions.some(p => E.cleanBase(p.base) === E.cleanBase(r.coin.base))) continue;
      const side = r.d.dir;
      const entry = fill(live.price, side, true);
      // odległości celu i stopu jak w aplikacji (w %), liczone od ceny wejścia
      const tgtPct = Math.abs(r.d.movePct) / 100, stopPct = Math.abs(r.d.stopPct) / 100;
      if (!(stopPct > 0.001 && stopPct < 0.5)) continue;
      const risk = st.balance * CFG.riskPct;
      let qty = risk / (entry * stopPct);
      const used = st.positions.reduce((a, p) => a + p.entry * p.qty, 0);
      const room = st.balance * CFG.maxLeverage - used;
      if (room <= st.balance * 0.05) break;
      if (qty * entry > room) qty = room / entry;
      const target = side === 'LONG' ? entry * (1 + tgtPct) : entry * (1 - tgtPct);
      const stop = side === 'LONG' ? entry * (1 - stopPct) : entry * (1 + stopPct);
      st.positions.push({
        id: `${now}-${live.sym}`, base: r.coin.base, sym: live.sym, side, iv, openedAt: now, end: now + H_MS[iv],
        entry, qty, target, stop, risk: qty * entry * stopPct, p: +r.d.p.toFixed(3), lift: +r.lift.toFixed(3),
      });
      st.log.unshift(`${new Date(now).toISOString().slice(0, 16)} otwarto ${r.coin.base} ${side} (${iv === '1h' ? '24 godz.' : '3 dni'}) po ${entry.toPrecision(5)}`);
      opened++;
    }
  }

  // ---------- 4. saldo z niezrealizowanym wynikiem ----------
  const unreal = st.positions.reduce((a, p) => { const l = byBase.get(E.cleanBase(p.base)); return a + (l ? pnl(p, l.price) : 0); }, 0);
  st.equity.push([now, +st.balance.toFixed(2), +(st.balance + unreal).toFixed(2)]);
  st.equity = st.equity.slice(-24 * 90);
  st.closed = st.closed.slice(0, 1000); st.log = st.log.slice(0, 200);
  st.updatedAt = now;
  fs.writeFileSync(path.join(OUT_DIR, 'bot.json'), JSON.stringify(st));
  console.log(`Bot (na sucho): saldo ${st.balance.toFixed(2)} USDT, otwarte ${st.positions.length}, nowe ${opened}, zamknięte łącznie ${st.closed.length}${halted ? ' · dzienny limit' : ''}`);
}

main().catch(e => { console.error('Bot:', e.message); process.exit(0); });
