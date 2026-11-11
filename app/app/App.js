// TradingJam – Expo / React Native
// Ekran TOP 10: najbardziej prawdopodobne scenariusze LONG/SHORT z Binance i BingX.
// Wyniki liczy co godzinę skaner na GitHubie; bez serwera apka robi mniejszy skan sama.
// To narzędzie analityczne, nie porada inwestycyjna.

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, ScrollView, TouchableOpacity, TextInput,
  ActivityIndicator, StyleSheet, RefreshControl, StatusBar, Platform,
} from 'react-native';

const E = require('./engine');
const X = require('./exchanges');

// ⬇⬇⬇ Wpisz swój login GitHub (instrukcja w README) ⬇⬇⬇
const RESULTS_URL = 'https://raw.githubusercontent.com/TWOJ_LOGIN/tradingjam/data/results.json';
const SERVER_ON = !RESULTS_URL.includes('TWOJ_LOGIN');
const LOCAL_BINANCE = 12, LOCAL_BINGX = 6; // skan na telefonie, gdy brak serwera

const HORIZONS = [['1h', '24 godz.'], ['4h', '3 dni'], ['1d', '14 dni']];
const HORIZON_INFO = {
  '1h': 'Prognoza na najbliższe 24 godziny · liczona ze świec 1-godzinnych · krótki trading',
  '4h': 'Prognoza na najbliższe 3 dni · liczona ze świec 4-godzinnych · swing kilkudniowy',
  '1d': 'Prognoza na najbliższe 14 dni · liczona ze świec dziennych · pozycja na ok. 2 tygodnie',
};
const catKey = c => c.cat || E.catOf(c.base);

// ---------- Formatowanie ----------
const pct0 = x => `${Math.round(x * 100)}%`;
const pct1 = x => `${(x * 100).toFixed(1)}%`;
const sgn = x => (x >= 0 ? '+' : '') + x.toFixed(1) + '%';
function fmtPrice(p) {
  if (!isFinite(p)) return '–';
  if (p >= 1000) return p.toLocaleString('pl-PL', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (p >= 1) return p.toFixed(3);
  return p.toPrecision(4);
}
function fmtVol(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' mld $';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + ' mln $';
  return (v / 1e3).toFixed(0) + ' tys. $';
}
function fmtTime(iso) {
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const C = {
  bg: '#0b0f17', card: '#131a26', card2: '#1a2333', line: '#243045', text: '#e6edf7', mute: '#8a97ab',
  up: '#22c55e', down: '#ef4444', side: '#94a3b8', accent: '#60a5fa', warn: '#f59e0b',
  binance: '#f0b90b', bingx: '#2a7cf6',
};
const dirColor = d => (d === 'LONG' ? C.up : C.down);

// ---------- Małe komponenty ----------
function Sparkline({ data, h = 32 }) {
  if (!data || data.length < 2) return <View style={{ height: h }} />;
  const mn = Math.min(...data), mx = Math.max(...data); const rng = mx - mn || 1;
  const col = data[data.length - 1] >= data[0] ? C.up : C.down;
  return (
    <View style={{ height: h, flexDirection: 'row', alignItems: 'flex-end', gap: 1 }}>
      {data.map((v, i) => (
        <View key={i} style={{ flex: 1, height: 3 + ((v - mn) / rng) * (h - 3), backgroundColor: col, opacity: 0.3 + 0.7 * (i / data.length), borderRadius: 1 }} />
      ))}
    </View>
  );
}

const CatBadge = ({ coin }) => {
  const k = catKey(coin); const c = E.CATS[k] || E.CATS.other;
  return (
    <View style={[s.badge, { borderColor: c.color, backgroundColor: c.color + '22' }]}>
      <Text style={{ color: c.color, fontSize: 10, fontWeight: '700' }}>{c.label}</Text>
    </View>
  );
};

function Legend() {
  const [open, setOpen] = useState(false);
  const items = [
    ['LONG 53%', 'szansa 53%, że cena najpierw WZROŚNIE do celu, zanim spadnie o tyle samo. SHORT – odwrotnie: najpierw spadek.'],
    ['50% = rzut monetą', 'każdy punkt powyżej 50% to przewaga. Na rynku krypto realne przewagi to zwykle 52–58%.'],
    ['Cel +2,5%', 'poziom ceny, do którego liczony jest ruch – 2× typowa zmienność danego coina (ATR).'],
    ['24 godz. / 3 dni / 14 dni', 'w jakim czasie ma się wydarzyć scenariusz. Krótszy horyzont = szybszy, ale bardziej losowy ruch.'],
    ['trafność 61%', 'jak często model trafiał kierunek, gdy dawał mocny sygnał – sprawdzone na historii tego coina.'],
    ['słaby model', 'na historii tego coina model nie był lepszy od zgadywania średniej. Procent jest wtedy tylko orientacyjny.'],
    ['Kategoria', 'typ projektu: Memecoin, AI, Layer 1/2 (blockchainy), DeFi (finanse), Gaming, RWA (realne aktywa), DePIN (infrastruktura), Token giełdy.'],
    ['BingX', 'giełda z mniejszymi projektami (lowcapy). Wyższe ryzyko, presja kupna szacowana z kształtu świec.'],
  ];
  return (
    <View style={[s.card, { paddingVertical: 10 }]}>
      <TouchableOpacity onPress={() => setOpen(!open)}>
        <Text style={{ color: C.accent, fontWeight: '700' }}>{open ? '▾' : 'ⓘ'} Jak czytać wyniki?</Text>
      </TouchableOpacity>
      {open ? items.map(([k, t]) => (
        <Text key={k} style={[s.li, { marginTop: 6 }]}><Text style={{ fontWeight: '800' }}>{k}</Text> – {t}</Text>
      )) : null}
    </View>
  );
}

const ExBadge = ({ ex }) => (
  <View style={[s.badge, { borderColor: ex === 'bingx' ? C.bingx : C.binance }]}>
    <Text style={{ color: ex === 'bingx' ? C.bingx : C.binance, fontSize: 10, fontWeight: '700' }}>{ex === 'bingx' ? 'BingX' : 'Binance'}</Text>
  </View>
);

function Chips({ items, value, onChange }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingVertical: 4 }}>
      {items.map(([k, t]) => (
        <TouchableOpacity key={k} onPress={() => onChange(k)} style={[s.chip, value === k && s.chipOn]}>
          <Text style={{ color: value === k ? C.bg : C.text, fontSize: 13, fontWeight: '600' }}>{t}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

function ProbBar({ label, p, color, sub }) {
  return (
    <View style={{ marginBottom: 12 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
        <Text style={{ color: C.text, fontWeight: '600' }}>{label}</Text>
        <Text style={{ color, fontWeight: '800', fontSize: 16 }}>{pct1(p)}</Text>
      </View>
      <View style={{ height: 8, backgroundColor: C.line, borderRadius: 4, overflow: 'hidden' }}>
        <View style={{ width: `${Math.max(2, p * 100)}%`, height: 8, backgroundColor: color }} />
      </View>
      {sub ? <Text style={s.small}>{sub}</Text> : null}
    </View>
  );
}

// ---------- Wiersz TOP 10 ----------
function TopRow({ rank, row, horizonTxt, onPress }) {
  const { coin, a, d } = row;
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={s.card}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={s.rank}>{rank}</Text>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={s.sym}>{coin.base}</Text><CatBadge coin={coin} /><ExBadge ex={coin.ex} />
          </View>
          <Text style={s.small}>{fmtPrice(coin.price)} $ · 24h <Text style={{ color: coin.chg >= 0 ? C.up : C.down }}>{sgn(coin.chg)}</Text></Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          <View style={[s.dirPill, { backgroundColor: dirColor(d.dir) }]}><Text style={s.dirPillT}>{d.dir}</Text></View>
          <Text style={[s.bigPct, { color: dirColor(d.dir) }]}>{pct0(d.p)}</Text>
        </View>
      </View>
      <View style={{ marginTop: 8 }}><Sparkline data={coin.spark} h={24} /></View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
        <Text style={s.meta}>Cel {sgn(d.movePct)} → {fmtPrice(d.target)} w {horizonTxt}</Text>
        {a.weak
          ? <Text style={[s.meta, { color: C.warn }]}>słaby model</Text>
          : <Text style={s.meta}>{a.dirHit !== null ? `trafność ${pct0(a.dirHit)}` : `przewaga +${(a.skill * 100).toFixed(1)}%`}</Text>}
      </View>
    </TouchableOpacity>
  );
}

// ---------- Szczegóły coina ----------
function Detail({ coin, iv0, onBack }) {
  const [iv, setIv] = useState(iv0);
  const a = coin.res[iv]; const d = E.dirOf(a);
  return (
    <ScrollView contentContainerStyle={s.page}>
      <TouchableOpacity onPress={onBack} style={{ marginBottom: 10 }}><Text style={{ color: C.accent, fontSize: 16 }}>‹ Wróć</Text></TouchableOpacity>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text style={s.title}>{coin.base}</Text><CatBadge coin={coin} /><ExBadge ex={coin.ex} />
      </View>
      <Text style={s.small}>{fmtPrice(coin.price)} $ · 24h <Text style={{ color: coin.chg >= 0 ? C.up : C.down }}>{sgn(coin.chg)}</Text> · wol. {fmtVol(coin.qv)}</Text>
      <View style={{ marginVertical: 12 }}><Sparkline data={coin.spark} h={48} /></View>
      <Chips items={HORIZONS} value={iv} onChange={setIv} />
      <Text style={s.small}>{HORIZON_INFO[iv]}</Text>

      {!a || a.error ? <Text style={[s.small, { marginTop: 12 }]}>{a ? a.error : 'Brak danych'}</Text> : (
        <View>
          <View style={[s.card, { borderColor: dirColor(d.dir), marginTop: 10 }]}>
            <Text style={s.small}>Najbardziej prawdopodobny scenariusz na {a.horizonTxt}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
              <Text style={{ color: dirColor(d.dir), fontSize: 28, fontWeight: '900' }}>{d.dir}</Text>
              <Text style={{ color: dirColor(d.dir), fontSize: 28, fontWeight: '900' }}>{pct1(d.p)}</Text>
            </View>
            <Text style={s.li}>Cel: {fmtPrice(d.target)} ({sgn(d.movePct)}) · unieważnienie: {fmtPrice(d.stop)}</Text>
            <Text style={s.small}>Normalnie taki ruch u {coin.base} zdarza się w {pct0(d.hist)} przypadków – teraz {d.p >= d.hist ? 'częściej' : 'rzadziej'} o {Math.abs((d.p - d.hist) * 100).toFixed(1)} pkt proc.</Text>
            {a.weak ? <Text style={[s.small, { color: C.warn, marginTop: 6 }]}>Uwaga: na historii tego coina model nie był lepszy od średniej – wynik orientacyjny.</Text> : null}
          </View>

          <Text style={s.h3}>Wszystkie scenariusze ({a.horizonTxt}, ruch ±{a.m}× ATR)</Text>
          <ProbBar label="Wzrost (LONG)" p={a.probs.up} color={C.up} sub={`cel ≈ ${fmtPrice(a.levels.up)} · historycznie ${pct0(a.prior.up)}`} />
          <ProbBar label="Spadek (SHORT)" p={a.probs.down} color={C.down} sub={`poziom ≈ ${fmtPrice(a.levels.down)} · historycznie ${pct0(a.prior.down)}`} />
          <ProbBar label="Konsolidacja" p={a.probs.side} color={C.side} sub={`żaden poziom nie zostanie osiągnięty · historycznie ${pct0(a.prior.side)}`} />

          <Text style={s.h3}>Jak wygląda wykres ({a.label})</Text>
          {E.reasons(a.raw, coin.est).map((t, i) => <Text key={i} style={s.li}>• {t}</Text>)}
          {coin.est ? <Text style={s.small}>BingX nie udostępnia wolumenu kupujących – presja jest szacowana z położenia zamknięcia w świecy.</Text> : null}

          <Text style={s.h3}>Wiarygodność dla {coin.base}</Text>
          {a.skill === null ? <Text style={s.li}>• Za krótka historia, żeby przetestować model.</Text> : (
            <View>
              <Text style={[s.li, { color: a.skill > 0.02 ? C.up : a.skill > 0 ? C.warn : C.down }]}>
                • Lepszy od „zgadywania średnią” o {(a.skill * 100).toFixed(1)}%{a.skill <= 0 ? ' – brak przewagi' : ''}
              </Text>
              {a.dirHit !== null
                ? <Text style={s.li}>• Gdy był mocny sygnał, kierunek trafiony w {pct1(a.dirHit)} ({a.dirN} sygnałów w ostatnich {a.nVal} świecach)</Text>
                : <Text style={s.li}>• W okresie testu nie było mocnych sygnałów</Text>}
            </View>
          )}
          <Text style={s.small}>Model wytrenowany na {a.nTrain} świecach {coin.base} ({a.label}), osobno dla każdego coina i interwału.</Text>
        </View>
      )}
      <Text style={[s.small, { marginTop: 20 }]}>Procent = szansa, że cena w podanym czasie najpierw dojdzie do celu, a nie do poziomu w przeciwną stronę. Liczone z tego, jak kończyły się podobne układy wykresu w historii coina. Nie jest to porada inwestycyjna.</Text>
    </ScrollView>
  );
}

// ---------- Aplikacja ----------
export default function App() {
  const [data, setData] = useState(null);        // { generatedAt, coins, source }
  const [extra, setExtra] = useState([]);        // coiny przeanalizowane na żądanie
  const [status, setStatus] = useState('');      // komunikat ładowania
  const [err, setErr] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState('top');
  const [iv, setIv] = useState('1h');
  const [dir, setDir] = useState('all');
  const [sel, setSel] = useState(null);
  // filtry listy
  const [q, setQ] = useState('');
  const [exF, setExF] = useState('all');
  const [minP, setMinP] = useState('0');
  const [sortBy, setSortBy] = useState('p');
  const [busy, setBusy] = useState(false);
  const [catF, setCatF] = useState('all');
  const scanning = useRef(false);

  const localScan = useCallback(async () => {
    if (scanning.current) return; scanning.current = true;
    setErr(null); setStatus('Pobieram listę coinów…');
    try {
      let bn = [], bx = [];
      try { bn = await X.binanceTickers(); } catch (e) { }
      try { bx = await X.bingxTickers(); } catch (e) { }
      if (!bn.length && !bx.length) throw new Error('Brak połączenia z giełdami');
      const onBn = new Set(bn.map(t => t.base));
      const list = [
        ...bn.sort((a, b) => b.qv - a.qv).slice(0, LOCAL_BINANCE),
        ...bx.filter(t => !onBn.has(t.base) && t.qv > 5e5).sort((a, b) => b.qv - a.qv).slice(0, LOCAL_BINGX),
      ];
      const coins = [];
      for (let i = 0; i < list.length; i++) {
        setStatus(`Analiza ${list[i].base} (${i + 1}/${list.length})…`);
        const c = await X.analyzeCoin(E, list[i]);
        coins.push(c);
        setData({ generatedAt: new Date().toISOString(), coins: [...coins], source: 'local' });
      }
      setStatus('');
    } catch (e) { setErr(e.message); setStatus(''); }
    scanning.current = false;
  }, []);

  const load = useCallback(async () => {
    if (!SERVER_ON) return localScan();
    setErr(null); setStatus('Wczytuję wyniki skanu…');
    try {
      const r = await fetch(RESULTS_URL + '?t=' + Date.now());
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      setData({ ...j, source: 'server' }); setStatus('');
    } catch (e) { setStatus(''); setErr('Nie udało się pobrać wyników z serwera (' + e.message + ').'); }
  }, [localScan]);

  useEffect(() => { load(); }, []);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const coins = useMemo(() => {
    const base = data ? data.coins : [];
    const seen = new Set(base.map(c => c.ex + c.sym));
    return [...base, ...extra.filter(c => !seen.has(c.ex + c.sym))];
  }, [data, extra]);

  const catItems = useMemo(() => {
    const n = {}; for (const c of coins) { const k = catKey(c); n[k] = (n[k] || 0) + 1; }
    return [['all', 'Wszystkie kategorie'], ...Object.keys(E.CATS).filter(k => n[k]).map(k => [k, `${E.CATS[k].label} (${n[k]})`])];
  }, [coins]);
  const coinsCat = useMemo(() => (catF === 'all' ? coins : coins.filter(c => catKey(c) === catF)), [coins, catF]);
  const top = useMemo(() => E.rankTop(coinsCat, iv, dir, 10), [coinsCat, iv, dir]);
  const horizonTxt = E.CFG[iv].horizonTxt;

  const filtered = useMemo(() => {
    const Q = q.trim().toUpperCase();
    let rows = coinsCat.map(c => ({ c, d: E.dirOf(c.res[iv]), a: c.res[iv] }))
      .filter(r => (!Q || r.c.base.includes(Q)) && (exF === 'all' || r.c.ex === exF))
      .filter(r => minP === '0' || (r.d && r.d.p >= +minP))
      .filter(r => dir === 'all' || (r.d && r.d.dir === (dir === 'long' ? 'LONG' : 'SHORT')));
    const key = { p: r => (r.d ? r.d.p : -1), v: r => r.c.qv, c: r => r.c.chg }[sortBy];
    return rows.sort((x, y) => key(y) - key(x));
  }, [coinsCat, iv, q, exF, minP, sortBy, dir]);

  const analyzeOnDemand = async () => {
    const base = q.trim().toUpperCase().replace(/[\s\/\-_]|USDT$/g, ''); if (!base) return;
    setBusy(true); setErr(null);
    try {
      let t;
      try { t = await X.binanceTicker(base + 'USDT'); } catch (e) { t = await X.bingxTicker(base + '-USDT'); }
      const c = await X.analyzeCoin(E, t);
      setExtra(x => [...x, c]); setSel(c);
    } catch (e) { setErr(`Nie znalazłem ${base} na Binance ani BingX.`); }
    setBusy(false);
  };

  const age = data && data.generatedAt ? (Date.now() - new Date(data.generatedAt)) / 36e5 : 0;

  if (sel) {
    return (
      <SafeAreaView style={s.root}><StatusBar barStyle="light-content" />
        <Detail coin={sel} iv0={iv} onBack={() => setSel(null)} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={s.page} keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={C.accent} />}
      >
        <Text style={s.title}>TradingJam</Text>
        <Text style={s.small}>
          {data ? `${data.source === 'local' ? 'Skan z telefonu' : 'Skan'}: ${fmtTime(data.generatedAt)} · ${data.coins.length} coinów · Binance + BingX` : 'Binance + BingX'}
        </Text>
        {age > 3 && data && data.source === 'server' ? <Text style={[s.small, { color: C.warn }]}>Wyniki mają ponad {Math.floor(age)} godz. – sprawdź, czy skaner na GitHubie działa.</Text> : null}
        {status ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}><ActivityIndicator color={C.accent} /><Text style={s.small}>{status}</Text></View> : null}
        {err ? (
          <View style={[s.card, { borderColor: C.down }]}>
            <Text style={{ color: C.down }}>{err}</Text>
            <TouchableOpacity onPress={localScan} style={{ marginTop: 8 }}><Text style={{ color: C.accent }}>Zrób skan na telefonie ({LOCAL_BINANCE + LOCAL_BINGX} coinów)</Text></TouchableOpacity>
          </View>
        ) : null}

        <View style={{ marginTop: 12 }}>
          <Text style={s.label}>Horyzont prognozy</Text>
          <Chips items={HORIZONS} value={iv} onChange={setIv} />
          <Text style={s.small}>{HORIZON_INFO[iv]}</Text>
          <Text style={s.label}>Kierunek</Text>
          <Chips items={[['all', 'Long i Short'], ['long', '▲ Tylko LONG (wzrost)'], ['short', '▼ Tylko SHORT (spadek)']]} value={dir} onChange={setDir} />
          <Text style={s.label}>Kategoria</Text>
          <Chips items={catItems} value={catF} onChange={setCatF} />
        </View>
        <Legend />

        {tab === 'top' ? (
          <View>
            <Text style={s.h2}>TOP 10 scenariuszy na {horizonTxt}{catF !== 'all' ? ` · ${E.CATS[catF].label}` : ''}</Text>
            {top.length === 0 && !status ? <Text style={s.small}>Brak wyników.</Text> : null}
            {top.map((row, i) => (
              <TopRow key={row.coin.ex + row.coin.sym} rank={i + 1} row={row} horizonTxt={horizonTxt} onPress={() => setSel(row.coin)} />
            ))}
            <Text style={[s.small, { marginTop: 14 }]}>
              Procent = szansa, że cena w ciągu {horizonTxt} najpierw dojdzie do celu (±2× ATR), a nie do poziomu w przeciwną stronę. Liczone osobno z historii każdego coina. Coiny, dla których model nie wykazał przewagi na historii, są na końcu listy. Nie jest to porada inwestycyjna.
            </Text>
          </View>
        ) : (
          <View>
            <TextInput value={q} onChangeText={setQ} placeholder="Szukaj coina, np. PEPE" placeholderTextColor={C.mute}
              autoCapitalize="characters" autoCorrect={false} style={s.input} />
            <Chips items={[['all', 'Wszystkie giełdy'], ['binance', 'Binance'], ['bingx', 'BingX (lowcapy)']]} value={exF} onChange={setExF} />
            <Chips items={[['0', 'Każde %'], ['0.5', '≥ 50%'], ['0.6', '≥ 60%'], ['0.7', '≥ 70%']]} value={minP} onChange={setMinP} />
            <Chips items={[['p', 'Sortuj: prawdop.'], ['v', 'Wolumen'], ['c', 'Zmiana 24h']]} value={sortBy} onChange={setSortBy} />
            <Text style={[s.small, { marginVertical: 6 }]}>{filtered.length} coinów</Text>
            {filtered.slice(0, 150).map(({ c, d, a }) => (
              <TouchableOpacity key={c.ex + c.sym} onPress={() => setSel(c)} style={s.row}>
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={{ color: C.text, fontWeight: '700', fontSize: 15 }}>{c.base}</Text><CatBadge coin={c} /><ExBadge ex={c.ex} />
                  </View>
                  <Text style={s.small}>{fmtPrice(c.price)} $ · <Text style={{ color: c.chg >= 0 ? C.up : C.down }}>{sgn(c.chg)}</Text> · {fmtVol(c.qv)}</Text>
                </View>
                {d ? (
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: a.weak ? C.mute : dirColor(d.dir), fontWeight: '800', fontSize: 16 }}>{d.dir} {pct0(d.p)}</Text>
                    <Text style={s.small}>{a.weak ? 'słaby model' : `cel ${sgn(d.movePct)}`}</Text>
                  </View>
                ) : <Text style={s.small}>brak danych</Text>}
              </TouchableOpacity>
            ))}
            {q.trim() && filtered.length === 0 ? (
              <TouchableOpacity onPress={analyzeOnDemand} disabled={busy} style={[s.btn, { marginTop: 12 }]}>
                {busy ? <ActivityIndicator color={C.bg} /> : <Text style={s.btnT}>Przeanalizuj {q.trim().toUpperCase()} teraz</Text>}
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </ScrollView>

      <View style={s.tabbar}>
        {[['top', 'TOP 10'], ['all', 'Wszystkie coiny']].map(([k, t]) => (
          <TouchableOpacity key={k} onPress={() => setTab(k)} style={s.tabBtn}>
            <Text style={{ color: tab === k ? C.accent : C.mute, fontWeight: '700' }}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  page: { padding: 16, paddingTop: Platform.OS === 'android' ? 40 : 16, paddingBottom: 40 },
  title: { color: C.text, fontSize: 26, fontWeight: '800' },
  label: { color: C.mute, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 10 },
  h2: { color: C.text, fontSize: 18, fontWeight: '800', marginTop: 12, marginBottom: 2 },
  h3: { color: C.text, fontWeight: '700', fontSize: 14, marginTop: 16, marginBottom: 8 },
  small: { color: C.mute, fontSize: 12, marginTop: 3, lineHeight: 17 },
  meta: { color: C.mute, fontSize: 12 },
  li: { color: C.text, fontSize: 13, marginBottom: 5, lineHeight: 18 },
  card: { backgroundColor: C.card, borderRadius: 14, padding: 14, marginTop: 10, borderWidth: 1, borderColor: C.line },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  rank: { color: C.mute, fontSize: 18, fontWeight: '800', width: 30 },
  sym: { color: C.text, fontSize: 18, fontWeight: '800' },
  bigPct: { fontSize: 26, fontWeight: '900', marginTop: 2 },
  dirPill: { borderRadius: 6, paddingHorizontal: 8, paddingVertical: 2 },
  dirPillT: { color: C.bg, fontWeight: '900', fontSize: 12 },
  badge: { borderWidth: 1, borderRadius: 5, paddingHorizontal: 5, paddingVertical: 1 },
  chip: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: 18, backgroundColor: C.card2, borderWidth: 1, borderColor: C.line },
  chipOn: { backgroundColor: C.accent, borderColor: C.accent },
  input: { backgroundColor: C.card, color: C.text, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: C.line, marginTop: 12, marginBottom: 4 },
  btn: { backgroundColor: C.accent, borderRadius: 10, padding: 14, alignItems: 'center' },
  btnT: { color: C.bg, fontWeight: '800' },
  tabbar: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line, backgroundColor: C.card },
  tabBtn: { flex: 1, alignItems: 'center', paddingVertical: 14 },
});
