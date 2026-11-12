// TradingJam – Expo / React Native
// Ekran TOP 10: najbardziej prawdopodobne scenariusze LONG/SHORT z Binance i BingX.
// Wyniki liczy co godzinę skaner na GitHubie; bez serwera apka robi mniejszy skan sama.
// To narzędzie analityczne, nie porada inwestycyjna.

import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  SafeAreaView, View, Text, ScrollView, TouchableOpacity, TextInput, Image,
  ActivityIndicator, StyleSheet, RefreshControl, StatusBar, Platform,
} from 'react-native';

const E = require('./engine');
const X = require('./exchanges');

// ⬇⬇⬇ Wpisz swój login GitHub (instrukcja w README) ⬇⬇⬇
const RESULTS_URL = 'https://raw.githubusercontent.com/TWOJ_LOGIN/tradingjam/data/results.json';
const SERVER_ON = !RESULTS_URL.includes('TWOJ_LOGIN');
// Dobrowolne wsparcie projektu
const DONATE_ADDRESS = '0x3f0817931418f7B4678758c71b57ED7E2b5ce9e8';
const DONATE_NETWORK = 'BNB Smart Chain (BEP-20)';
const DONATE_TOKEN = 'USDT';
const LOCAL_BINANCE = 12, LOCAL_BINGX = 6; // skan na telefonie, gdy brak serwera

const HORIZONS = [['1h', '24 godz.'], ['4h', '3 dni'], ['1d', '14 dni'], ['30d', '30 dni']];
const HORIZON_INFO = {
  '1h': 'Prognoza na najbliższe 24 godziny · liczona ze świec 1-godzinnych · krótki trading',
  '4h': 'Prognoza na najbliższe 3 dni · liczona ze świec 4-godzinnych · swing kilkudniowy',
  '1d': 'Prognoza na najbliższe 14 dni · liczona ze świec dziennych · pozycja na ok. 2 tygodnie',
  '30d': 'Prognoza na najbliższe 30 dni · liczona ze świec dziennych · pozycja na ok. miesiąc, cel i stop dalej niż przy 14 dniach',
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

// ---------- Plakietki ----------
const EX = { binance: ['Binance', '#f0b90b'], bingx: ['BingX', '#2a7cf6'], okx: ['OKX', '#e6edf7'], bybit: ['Bybit', '#f7a600'] };
const ExBadge = ({ ex, dim }) => {
  const [label, color] = EX[ex] || [ex, C.mute];
  return (
    <View style={[s.badge, { borderColor: color, opacity: dim ? 0.55 : 1 }]}>
      <Text style={{ color, fontSize: 10, fontWeight: '700' }}>{label}</Text>
    </View>
  );
};
// Giełdy, na których jest coin (pierwsza = z niej liczona analiza)
const ExBadges = ({ coin }) => {
  const list = [coin.ex, ...(coin.exs || []).filter(e => e !== coin.ex)];
  return <>{list.map((e, i) => <ExBadge key={e} ex={e} dim={i > 0} />)}</>;
};

const MODES = [['big', '2:1 · duży zysk'], ['equal', '1:1 · po równo'], ['safe', '1:2 · mały zysk']];
const MODE_INFO = {
  big: 'Ryzykujesz 10 $, możesz zarobić 20 $. Cel jest daleko, więc trafia rzadziej (zwykle 30–45%), ale wystarczy wygrać 1 raz na 3, żeby wyjść na zero (próg 33%).',
  equal: 'Ryzykujesz 10 $, możesz zarobić 10 $. Żeby wyjść na plus, trzeba wygrywać częściej niż co drugi raz (próg 50%).',
  safe: 'Ryzykujesz 10 $, możesz zarobić tylko 5 $. Cel jest blisko, więc trafia często (zwykle 60–80%), ale trzeba wygrać 2 razy na 3, żeby wyjść na zero (próg 67%).',
};
const breakEven = d => E.MODE_BE[d.mode] || 0.5;
const aboveBE = d => !d.weak && d.p > breakEven(d) + 0.02;

// Ostrzeżenia: 'short' = za krótka historia do testu, 'noedge' = test nie wykazał przewagi
const WHY = {
  short: {
    title: '⚠ Za młody coin – procent niesprawdzony',
    text: (c) => `${c.base} jest na giełdzie za krótko, żeby sprawdzić, czy procenty z aplikacji w ogóle się u niego sprawdzają. Traktuj ten procent jak zgadywanie.`,
  },
  noedge: {
    title: '⚠ Wykres nic tu nie mówi',
    text: (c, d) => `Sprawdziliśmy to na historii ${c.base}: procenty z aplikacji trafiały nie lepiej, niż gdyby po prostu zawsze mówić „${d && d.hist != null ? pct0(d.hist) : 'średnio tyle samo'}” (tak często ${c.base} robi ten ruch zwykle). Analiza wykresu nic tu nie dodaje – nie sugeruj się tym procentem.`,
  },
};
const weakShort = why => (why === 'short' ? '⚠ za młody coin' : '⚠ wykres nic tu nie mówi');
function WeakNote({ coin, why, sides, d }) {
  if (!why) return null;
  const w = WHY[why];
  return (
    <View style={[s.box, { borderColor: C.warn, marginTop: 8 }]}>
      <Text style={{ color: C.warn, fontWeight: '800' }}>{w.title}{sides ? ` (${sides})` : ''}</Text>
      <Text style={[s.li, { marginTop: 4 }]}>{w.text(coin, d)}</Text>
    </View>
  );
}
const ExtremeBadge = ({ coin }) => (E.isExtreme(coin) ? (
  <View style={[s.badge, { borderColor: C.warn, backgroundColor: C.warn + '22' }]}>
    <Text style={{ color: C.warn, fontSize: 10, fontWeight: '800' }}>⚡ {sgn(coin.chg)} / 24h</Text>
  </View>
) : null);

const RegimeBadge = ({ a }) => (a && a.regime ? (
  <View style={[s.badge, { borderColor: C.warn, backgroundColor: C.warn + '22' }]}>
    <Text style={{ color: C.warn, fontSize: 10, fontWeight: '800' }}>⚠ 1 trend</Text>
  </View>
) : null);
function RegimeNote({ coin, a }) {
  const [open, setOpen] = useState(false);
  if (!a || !a.regime) return null;
  const up = a.regime.dir === 'up';
  const x = up ? `urósł ok. ${Math.round(a.regime.x)}×` : `spadł do ok. ${Math.round(a.regime.x * 100)}% ceny`;
  return (
    <View style={[s.box, { borderColor: C.warn, marginTop: 8 }]}>
      <Text style={{ color: C.warn, fontWeight: '800' }}>⚠ Historia z jednego trendu</Text>
      <Text style={[s.li, { marginTop: 4 }]}>Dane {coin.base} pochodzą głównie z okresu silnych {up ? 'wzrostów' : 'spadków'}. Obecny trend {up ? 'spadkowy' : 'wzrostowy'} jest w nich słabo reprezentowany, więc statystyka może być skrzywiona.</Text>
      {open ? <Text style={[s.li, { marginTop: 4 }]}>W analizowanej historii {coin.base} {x}. Model uczy się wyłącznie na przeszłości coina, więc „nauczył się”, że {up ? 'cena zwykle rośnie – LONG wychodzi wysoko, SHORT nisko' : 'cena zwykle spada – SHORT wychodzi wysoko, LONG nisko'}. Teraz cena jest {up ? 'wyraźnie poniżej' : 'wyraźnie powyżej'} średniej, a takich sytuacji w danych prawie nie ma. Statystyka patrzy w lusterko wsteczne i może jeszcze nie widzieć zmiany. Taki coin jest przesunięty na koniec TOP 10.</Text> : null}
      <TouchableOpacity onPress={() => setOpen(!open)}><Text style={{ color: C.accent, marginTop: 4, fontSize: 12 }}>{open ? 'Zwiń' : 'Dlaczego?'}</Text></TouchableOpacity>
    </View>
  );
}
// Na czym opiera się procent – czynniki modelu
function FactorsBox() {
  const [open, setOpen] = useState(false);
  return (
    <View style={[s.box, { marginTop: 10 }]}>
      <TouchableOpacity onPress={() => setOpen(!open)}>
        <Text style={{ color: C.accent, fontWeight: '700' }}>{open ? '▾' : 'ⓘ'} Na czym opiera się ten procent?</Text>
      </TouchableOpacity>
      {open ? (
        <View style={{ marginTop: 6 }}>
          <Text style={s.li}>Aplikacja nie kieruje się jednym wskaźnikiem. Średnia krocząca to tylko 1 z 7 czynników, które model bierze pod uwagę naraz:</Text>
          {E.FACTORS.map(([k, t]) => <Text key={k} style={s.li}>• <Text style={{ fontWeight: '700' }}>{k}</Text> – {t}</Text>)}
          <Text style={[s.li, { marginTop: 4 }]}>Model szuka w historii tego coina momentów, w których te czynniki układały się podobnie jak teraz, i liczy, jak często cena doszła najpierw do celu, a nie do stopu. Sam z siebie nie zakłada, że „cena pod średnią = spadki” – wagę każdego czynnika ustala historia danego coina. Dlatego przy coinie, który w przeszłości prawie tylko rósł, wynik może się kłócić z tym, co widać na wykresie.</Text>
        </View>
      ) : null}
    </View>
  );
}

const LiquidityBadge = ({ coin }) => (E.isIlliquid(coin) ? (
  <View style={[s.badge, { borderColor: C.warn, backgroundColor: C.warn + '22' }]}>
    <Text style={{ color: C.warn, fontSize: 10, fontWeight: '800' }}>💧 mały obrót</Text>
  </View>
) : null);

// „Na wykresie trend wzrostowy, a LONG tylko 15%?” – wyjaśnienie pokazywane, gdy procent kłóci się z trendem
function MismatchNote({ coin, a, mode }) {
  const [open, setOpen] = useState(false);
  if (!a || !a.raw) return null;
  const t = a.raw.trend;
  if (Math.abs(t) < 1) return null; // tylko wyraźny, widoczny na wykresie trend
  const up = t > 0;
  const d = E.dirOf(a, mode, up ? 'long' : 'short');
  if (!d || d.p === null) return null;
  const be = E.MODE_BE[d.mode] || 0.5;
  if (!d.weak && d.p > be + 0.02 && !a.regime) return null; // procent zgadza się z trendem – nie ma czego tłumaczyć
  const dir = up ? 'LONG' : 'SHORT';
  const pts = [];
  pts.push(`Procent nie odpowiada na pytanie „czy cena ${up ? 'wzrośnie' : 'spadnie'}?”, tylko: czy w ciągu ${a.horizonTxt} dojdzie do celu ${sgn(d.movePct)}, ZANIM dotknie stopu ${sgn(d.stopPct)}. Trend może trwać, a cena i tak po drodze wybije stop.`);
  if (d.mode === 'big') pts.push(`W układzie 2:1 cel jest daleko, więc trafia rzadko – wynik 30–40% to normalna wartość. Liczy się, czy procent przekracza próg ${pct0(be)}.`);
  if (d.mode === 'safe') pts.push(`W układzie 1:2 stop jest 2× dalej niż cel, więc potrzeba aż ${pct0(be)} trafień, żeby wyjść na zero.`);
  if (d.hist !== null && d.hist !== undefined) pts.push(`W historii ${coin.base} taki ruch zdarzał się w ${pct0(d.hist)} przypadków. Teraz statystyka daje ${pct0(d.p)} – ${d.p >= d.hist ? 'trochę więcej' : 'mniej'} niż zwykle, czyli obecny układ wykresu ${d.p >= d.hist ? 'lekko sprzyja' : 'nie sprzyja'} temu scenariuszowi.`);
  if (a.regime) pts.push(`Historia ${coin.base} to głównie silne ${a.regime.dir === 'up' ? 'wzrosty' : 'spadki'}. Obecny trend ${up ? 'wzrostowy' : 'spadkowy'} jest w danych rzadki, więc statystyka „nie zna” takiej sytuacji.`);
  if (d.weak) pts.push(E.weakWhy(d) === 'short' ? `${coin.base} jest za młody, żeby sprawdzić, czy procenty się u niego sprawdzają.` : `Sprawdziliśmy na historii ${coin.base}: wykres nie pomagał tu przewidywać, więc procent jest mało wiarygodny.`);
  if (E.isIlliquid(coin)) pts.push(`Mały obrót (${fmtVol(coin.qv)} $ na dobę) – przy tak płytkim rynku pojedyncze knoty łatwo wybijają stop.`);
  return (
    <View style={[s.box, { borderColor: C.accent, marginTop: 8 }]}>
      <Text style={{ color: C.accent, fontWeight: '800' }}>{up ? '📈' : '📉'} Na wykresie trend {up ? 'wzrostowy' : 'spadkowy'}, a {dir} tylko {pct0(d.p)}?</Text>
      <Text style={[s.li, { marginTop: 4 }]}>{pts[0]}</Text>
      {open ? pts.slice(1).map((x, i) => <Text key={i} style={[s.li, { marginTop: 4 }]}>• {x}</Text>) : null}
      {pts.length > 1 ? <TouchableOpacity onPress={() => setOpen(!open)}><Text style={{ color: C.accent, marginTop: 4, fontSize: 12 }}>{open ? 'Zwiń' : `Więcej powodów (${pts.length - 1})`}</Text></TouchableOpacity> : null}
    </View>
  );
}

function Legend() {
  const [open, setOpen] = useState(false);
  const items = [
    ['LONG 45%', 'w podobnych sytuacjach w historii cena w 45 przypadkach na 100 najpierw doszła do celu w górę, zanim doszła do stopu. SHORT – odwrotnie.'],
    ['2:1 · duży zysk', 'ryzykujesz 10 $, możesz zarobić 20 $. Procenty niższe (30–45%), ale próg opłacalności to tylko 33%.'],
    ['1:1 · po równo', 'ryzykujesz 10 $, możesz zarobić 10 $. Próg opłacalności 50%.'],
    ['1:2 · mały zysk', 'ryzykujesz 10 $, możesz zarobić 5 $. Procenty wysokie (60–80%), ale próg opłacalności aż 67%.'],
    ['✓ powyżej progu', 'statystyka historyczna przekracza próg opłacalności dla wybranego rodzaju celu. Porównuj procent z progiem, a nie między trybami.'],
    ['Dlaczego tu: +13 pkt ponad normę', 'o ile punktów procentowych szansa jest teraz wyższa niż zwykle dla tego coina. Im więcej, tym bardziej obecny wykres zmienia sytuację – według tego układana jest kolejność TOP 10.'],
    ['normalnie 64%', 'jak często ten coin robi taki ruch bez względu na wykres. Liczy się różnica między tym a prognozą.'],
    ['trafność 71%', 'w teście na historii coina: gdy model dawał wysoką szansę, tyle razy faktycznie trafił.'],
    ['⚠ wykres nic tu nie mówi', 'sprawdziliśmy na historii coina: procent z aplikacji trafiał nie lepiej niż zwykła średnia. Nie sugeruj się nim. Takie coiny są wyszarzone i na końcu listy.'],
    ['⚠ za młody coin', 'coin jest za krótko na giełdzie, żeby sprawdzić, czy procenty się u niego sprawdzają. Traktuj procent jak zgadywanie.'],
    ['🔄 Zmiana trendu', 'szansa, że w podanym czasie cena przetnie swoją średnią (EMA 50) w drugą stronę – czyli obecny trend zostanie przełamany. Pionowa kreska na pasku = jak często zdarza się to normalnie.'],
    ['💧 mały obrót', 'obrót z 24h poniżej 200 tys. $. Przy tak płytkim rynku pojedyncze knoty łatwo wybijają stop – statystyka jest mniej pewna. Coin jest na końcu listy.'],
    ['⚠ 1 trend', 'historia coina to głównie jeden silny trend (np. wielokrotny wzrost), a teraz cena idzie w drugą stronę. Statystyka może być skrzywiona – coin jest na końcu listy.'],
    ['⚡ ekstremalny ruch', 'cena zmieniła się o 40% lub więcej w 24h (pump/dump). Historia słabo opisuje takie sytuacje – ryzyko jest bardzo wysokie.'],
    ['Funding', 'opłata między longami i shortami na kontraktach. Dodatni = więcej chętnych na long (longi płacą), ujemny = przewaga shortów.'],
    ['24 godz. / 3 dni / 14 dni', 'w jakim czasie ma się wydarzyć scenariusz.'],
    ['Kategoria', 'typ projektu: Memecoin, AI, Layer 1/2, DeFi, Gaming, RWA, DePIN, Token giełdy.'],
    ['Giełdy', 'pierwsza plakietka = giełda, z której liczona jest analiza; wyblakłe = coin jest też tam.'],
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

// ---------- Werdykt, kalkulator, poradnik ----------
const VCOL = { go: C.up, weak: C.warn, none: C.mute, avoid: C.down };
const VICON = { go: '▲▼', weak: '·', none: '·', avoid: '⚡' };
function VerdictBox({ d, coin, a, compact }) {
  const v = E.verdict(d, coin, a);
  if (compact) return <Text style={[s.meta, { color: VCOL[v.level], marginTop: 4 }]}>{v.text}</Text>;
  return (
    <View style={[s.box, { borderColor: VCOL[v.level], marginTop: 10 }]}>
      <Text style={{ color: C.mute, fontSize: 11, fontWeight: '700' }}>PODSUMOWANIE STATYSTYKI</Text>
      <Text style={{ color: VCOL[v.level], fontWeight: '800', fontSize: 15, marginTop: 4 }}>{v.text}</Text>
      <Text style={[s.small, { marginTop: 4 }]}>Opis statystyczny, nie rekomendacja. Decyzja i ryzyko należą wyłącznie do Ciebie.</Text>
    </View>
  );
}

// Przykład edukacyjny zarządzania ryzykiem – stałe liczby, bez danych użytkownika
function RiskExample({ d }) {
  const c = 1000, r = 1;
  const stop = Math.abs(d.stopPct) / 100, move = Math.abs(d.movePct) / 100;
  const loss = c * r / 100, size = stop > 0 ? loss / stop : 0, gain = size * move;
  return (
    <View style={s.card}>
      <Text style={s.h3}>📚 Przykład edukacyjny: jak działa zarządzanie ryzykiem</Text>
      <Text style={s.li}>Załóżmy przykładowy kapitał <Text style={{ fontWeight: '800' }}>1000 USDT</Text> i zasadę ryzykowania <Text style={{ fontWeight: '800' }}>1%</Text> kapitału na jedną transakcję. Przy odległości stopu {Math.abs(d.stopPct).toFixed(1)}%:</Text>
      <Text style={s.li}>• wielkość pozycji w tym przykładzie: {size.toFixed(0)} USDT</Text>
      <Text style={s.li}>• strata przy stopie: <Text style={{ color: C.down }}>−{loss.toFixed(2)} USDT</Text> (1% kapitału)</Text>
      <Text style={s.li}>• zysk przy celu: <Text style={{ color: C.up }}>+{gain.toFixed(2)} USDT</Text></Text>
      <Text style={s.small}>To ilustracja zasady liczenia ryzyka, a nie propozycja transakcji ani wielkości pozycji dla Ciebie.</Text>
    </View>
  );
}

const GUIDE = [
  ['Co robi TradingJam?', 'To narzędzie statystyczne i edukacyjne. Co godzinę analizuje wykresy ok. 450 kryptowalut z Binance, BingX i OKX i pokazuje, jak w przeszłości kończyły się podobne sytuacje na wykresie – czyli jak często cena szła w górę (LONG) albo w dół (SHORT). Te same wyniki widzi każdy użytkownik; nie są dopasowane do niczyjej sytuacji.'],
  ['LONG i SHORT', 'LONG = zarabiasz, gdy cena rośnie. SHORT = zarabiasz, gdy cena spada (dostępne na kontraktach, np. na BingX czy Binance Futures).'],
  ['Co znaczy „LONG 45%”?', 'Że w podobnych sytuacjach w przeszłości cena w 45 przypadkach na 100 najpierw doszła do celu, a dopiero potem (albo wcale) do stopu. To nie jest gwarancja. Czy 45% to dużo, zależy od rodzaju celu: przy układzie 2:1 to wynik powyżej progu opłacalności (33%), przy 1:1 – poniżej (50%).'],
  ['Cel i stop', 'Cel (take profit) – poziom ceny zamknięcia z zyskiem. Stop (stop loss) – poziom zamknięcia ze stratą, który ogranicza dalsze straty. W statystyce aplikacji oba poziomy są liczone automatycznie ze zmienności coina, żeby porównywać scenariusze w jednakowy sposób.'],
  ['Ile możesz zarobić, a ile stracić (2:1, 1:1, 1:2)?', 'To stosunek zysku do ryzyka (risk/reward). 2:1 · duży zysk (ryzykujesz 10 $, możesz zarobić 20 $) – możliwy zysk jest 2× większy od możliwej straty; trafia rzadziej (zwykle 30–45%), ale opłaca się już powyżej 33%. 1:1 · po równo (10 $ na 10 $) – zysk = strata, opłaca się powyżej 50%. 1:2 · mały zysk (ryzykujesz 10 $, możesz zarobić 5 $) – zysk jest 2× mniejszy od straty; trafia często (60–80%), ale opłaca się dopiero powyżej 67%. Szansa i stosunek zysku do ryzyka zawsze idą w przeciwne strony – to matematyka. Liczy się nie sam procent, tylko to, o ile przekracza próg opłacalności.'],
  ['Próg opłacalności', 'Matematyczny punkt, przy którym wygrane i przegrane się równoważą (33% dla układu 2:1, 50% dla 1:1, 67% dla 1:2). „Powyżej progu” znaczy, że historyczna statystyka scenariusza była wyższa od tego punktu. Wyniki historyczne nie gwarantują wyników w przyszłości.'],
  ['„Wykres nic tu nie mówi” i „Za młody coin”', 'Każdy procent sprawdzamy na historii danego coina: czy w przeszłości trafiał lepiej niż zwykła średnia (np. „ten coin robi taki ruch w 37% przypadków”).\n\n⚠ Wykres nic tu nie mówi – sprawdziliśmy i procent z aplikacji nie był lepszy od średniej. Nie sugeruj się nim.\n\n⚠ Za młody coin – coin jest za krótko na giełdzie, żeby to sprawdzić. Procent to zgadywanie.\n\nTakie coiny są wyszarzone i na końcu TOP 10.'],
  ['Jak powstaje TOP 10?', 'Dla każdego coina bierzemy mocniejszy scenariusz (LONG albo SHORT) na wybranym horyzoncie i rodzaju celu. Potem układamy listę w trzech grupach: 1) scenariusze, które przeszły test na historii coina i są powyżej progu opłacalności, 2) te, które przeszły test, ale są pod progiem, 3) coiny z ostrzeżeniem (wykres nic nie mówi, za młody coin, ekstremalny ruch, historia z jednego trendu, mały obrót). W każdej grupie decyduje przewaga nad normą: o ile punktów procentowych szansa jest teraz wyższa niż zwykle dla tego coina. Np. coin, który normalnie trafia w 27%, a teraz w 40% (+13 pkt), będzie wyżej niż coin z 38% przy normie 36% (+2 pkt) – bo tu obecny wykres naprawdę coś zmienia. Pod każdym coinem w TOP 10 jest linijka „Dlaczego tu”.'],
  ['Widzę trend wzrostowy, a LONG ma tylko 15–30%. Dlaczego?', 'Bo procent nie odpowiada na pytanie „czy cena wzrośnie?”, tylko: czy cena dojdzie do konkretnego celu, ZANIM dotknie stopu, w podanym czasie. Trend może trwać, a cena po drodze i tak wybije stop. Do tego w układzie 2:1 cel jest daleko, więc trafia rzadko – 30–40% to normalny wynik, a liczy się próg 33%. Wreszcie statystyka pochodzi z historii danego coina: jeśli w podobnych układach cena częściej wracała, niż szła dalej, procent będzie niski mimo trendu. W szczegółach coina, gdy procent „kłóci się” z trendem, aplikacja pokazuje ramkę z wyjaśnieniem dla tego konkretnego coina.'],
  ['Czy aplikacja kieruje się średnią kroczącą?', 'Częściowo. Średnia krocząca (EMA 50 i nachylenie EMA 20) to 2 z 7 czynników. Pozostałe to RSI, wolumen, presja kupujących, delta wolumenu (CVD) i pozycja ceny w zakresie 20 świec. Model nie ma sztywnej reguły typu „cena pod średnią = sprzedawaj” – sprawdza, jak w historii danego coina kończyły się podobne układy wszystkich czynników razem. To oznacza, że wynik zależy od przeszłości coina, a nie od samego wykresu z ostatnich dni.'],
  ['🔄 Zmiana trendu – co to jest?', 'Średnia krocząca (EMA 50) działa jak „linia trendu”: cena nad nią = trend wzrostowy, pod nią = spadkowy. Przełamanie trendu to zamknięcie świecy po drugiej stronie tej linii. Karta w szczegółach coina pokazuje, jak często w historii tego coina – w podobnym układzie wykresu – dochodziło do przełamania w podanym czasie, oraz na jakim poziomie ceny leży średnia. Im dalej cena od średniej (np. zaraz po dużym pumpie), tym zwykle mniejsza szansa na przełamanie w krótkim czasie. Przełamanie nie oznacza, że cena pójdzie dalej w nową stronę – to sygnał, że dotychczasowy trend słabnie.'],
  ['⚠ Historia z jednego trendu', 'Gdy coin w całej swojej historii np. kilkukrotnie urósł, model „nauczył się”, że zwykle rośnie. Jeśli teraz cena wyraźnie spada, takich sytuacji w danych prawie nie ma – statystyka patrzy w lusterko wsteczne i może się kłócić z tym, co widać na wykresie. Dlatego pokazujemy wtedy ostrzeżenie i przesuwamy coin na koniec TOP 10. To samo działa w drugą stronę (coin, który głównie spadał, a teraz rośnie).'],
  ['⚡ Ekstremalny ruch', 'Coin zmienił cenę o 40% lub więcej w 24h (gwałtowny wzrost lub spadek). W takich sytuacjach historia słabo opisuje to, co się dzieje, więc statystyka jest niewiarygodna, a zmienność i ryzyko – wyjątkowo wysokie.'],
  ['Horyzonty', '24 godz. – krótki trading, szybkie ruchy, więcej przypadkowości. 3 dni – swing, dobry kompromis. 14 dni – dłuższe pozycje, większe ruchy w procentach. 30 dni – pozycja na ok. miesiąc: cel i stop są dalej (ok. 1,5× dalej niż przy 14 dniach), bo w miesiąc cena przechodzi większą drogę. Procent nie musi być wyższy niż przy krótszych horyzontach – dłuższy czas to też większy ruch potrzebny do celu.'],
  ['Kategorie', 'Memecoin – coiny „dla zabawy”, bardzo zmienne. AI – projekty sztucznej inteligencji. Layer 1/2 – blockchainy (np. ETH, SOL). DeFi – finanse zdecentralizowane. Gaming, RWA (realne aktywa), DePIN (infrastruktura), Token giełdy.'],
  ['Funding', 'Opłata na kontraktach między graczami. Dodatni = dużo osób gra na wzrost (tłok na longach), ujemny = przewaga shortów. Bardzo wysoki funding bywa sygnałem, że rynek jest przegrzany.'],
  ['Zarządzanie ryzykiem – podstawy (edukacyjnie)', 'Powszechnie opisywane w literaturze zasady: ograniczanie straty na jednej transakcji do niewielkiego procentu kapitału (często podaje się 1–2%), stosowanie zleceń stop loss, ostrożność z dźwignią (zwielokrotnia zarówno zyski, jak i straty) oraz świadomość, że każda strategia ma serie strat. To wiedza ogólna, a nie zalecenie dla Ciebie.'],
  ['Czego aplikacja NIE robi', 'Nie zna przyszłości i nie gwarantuje zysku. Nie uwzględnia wiadomości, ogłoszeń ani manipulacji. Nie zna Twojej sytuacji finansowej, celów ani doświadczenia i nie wskazuje, co powinieneś kupić lub sprzedać. Pokazuje statystykę z przeszłości – decyzja i ryzyko są zawsze po Twojej stronie.'],
  ['Zastrzeżenia prawne', 'Treści w aplikacji mają charakter wyłącznie informacyjny i edukacyjny. Nie stanowią porady inwestycyjnej, doradztwa w zakresie kryptoaktywów, rekomendacji inwestycyjnej ani oferty w rozumieniu przepisów prawa, w tym rozporządzeń MiCA i MAR. Nie są spersonalizowane. Wyniki historyczne nie gwarantują przyszłych wyników. Handel kryptoaktywami, zwłaszcza z dźwignią, wiąże się z wysokim ryzykiem utraty całości zainwestowanych środków. Przed podjęciem decyzji rozważ skorzystanie z porady licencjonowanego doradcy.'],
];
function Support() {
  const [copied, setCopied] = useState('');
  const copy = async () => {
    try { await navigator.clipboard.writeText(DONATE_ADDRESS); setCopied('Skopiowano adres ✓'); }
    catch (e) { setCopied('Przytrzymaj adres palcem, żeby go zaznaczyć i skopiować.'); }
  };
  return (
    <View>
      <Text style={s.h2}>☕ Wesprzyj TradingJam</Text>
      <Text style={s.li}>Aplikacja jest <Text style={{ fontWeight: '800' }}>darmowa dla wszystkich</Text>. Jeśli pomaga Ci lepiej rozumieć rynek, możesz dobrowolnie wesprzeć jej rozwój – na przykład kwotą 5 {DONATE_TOKEN}.</Text>
      <View style={[s.card, { alignItems: 'center' }]}>
        <View style={{ backgroundColor: '#fff', padding: 8, borderRadius: 10 }}>
          <Image source={require('./assets/donate-qr.png')} style={{ width: 200, height: 200 }} />
        </View>
        <Text style={[s.small, { marginTop: 10 }]}>Adres ({DONATE_TOKEN} · {DONATE_NETWORK}):</Text>
        <Text selectable style={{ color: C.text, fontWeight: '700', fontSize: 13, textAlign: 'center', marginTop: 4 }}>{DONATE_ADDRESS}</Text>
        <TouchableOpacity onPress={copy} style={[s.btn, { marginTop: 10, paddingHorizontal: 24 }]}><Text style={s.btnT}>Kopiuj adres</Text></TouchableOpacity>
        {copied ? <Text style={[s.small, { color: C.up }]}>{copied}</Text> : null}
      </View>
      <View style={[s.box, { borderColor: C.warn, marginTop: 10 }]}>
        <Text style={{ color: C.warn, fontWeight: '800' }}>⚠ Ważne przed wysłaniem</Text>
        <Text style={s.li}>• Wysyłaj wyłącznie <Text style={{ fontWeight: '800' }}>{DONATE_TOKEN}</Text> w sieci <Text style={{ fontWeight: '800' }}>{DONATE_NETWORK}</Text>.</Text>
        <Text style={s.li}>• Inny token lub inna sieć (np. Ethereum, Tron) = ryzyko bezpowrotnej utraty środków.</Text>
        <Text style={s.li}>• Do opłaty za przelew potrzebujesz odrobiny BNB w portfelu (zwykle kilka groszy).</Text>
      </View>
      <Text style={[s.small, { marginTop: 10 }]}>Wsparcie jest całkowicie dobrowolne. Nie daje dodatkowych funkcji ani usług i nie jest zapłatą za porady – wszystkie treści pozostają darmowe dla każdego.</Text>
    </View>
  );
}

function Guide() {
  const [open, setOpen] = useState(0);
  return (
    <View>
      <Text style={s.h2}>📘 Poradnik – zacznij tutaj</Text>
      <Text style={s.small}>Wszystko, co musisz wiedzieć, w 2 minuty. Kliknij temat, żeby go rozwinąć.</Text>
      {GUIDE.map(([t, body], i) => (
        <TouchableOpacity key={t} onPress={() => setOpen(open === i ? -1 : i)} style={s.card}>
          <Text style={{ color: C.text, fontWeight: '800' }}>{open === i ? '▾' : '▸'} {t}</Text>
          {open === i ? <Text style={[s.li, { marginTop: 6 }]}>{body}</Text> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
}

// ---------- Wiersz TOP 10 ----------
function TopRow({ rank, row, horizonTxt, onPress }) {
  const { coin, d } = row;
  const dim = d.weak || E.isExtreme(coin) || E.isIlliquid(coin) || !!(row.a && row.a.regime);
  const col = dim ? C.mute : dirColor(d.dir);
  return (
    <TouchableOpacity activeOpacity={0.85} onPress={onPress} style={[s.card, dim && { opacity: 0.75 }]}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={s.rank}>{rank}</Text>
        <View style={{ flex: 1, minWidth: 0, marginRight: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 4 }}>
            <Text style={s.sym}>{coin.base}</Text><CatBadge coin={coin} /><ExBadges coin={coin} /><ExtremeBadge coin={coin} /><LiquidityBadge coin={coin} /><RegimeBadge a={row.a} />
          </View>
          <Text style={s.small}>{fmtPrice(coin.price)} $ · 24h <Text style={{ color: coin.chg >= 0 ? C.up : C.down }}>{sgn(coin.chg)}</Text></Text>
        </View>
        <View style={{ alignItems: 'flex-end', flexShrink: 0 }}>
          <View style={[s.dirPill, { backgroundColor: col }]}><Text style={s.dirPillT}>{d.dir}</Text></View>
          <Text style={[s.bigPct, { color: col }]}>{pct0(d.p)}</Text>
        </View>
      </View>
      <View style={{ marginTop: 8 }}><Sparkline data={coin.spark} h={24} /></View>
      <Text style={[s.meta, { marginTop: 8 }]}>Cel {sgn(d.movePct)} ({fmtPrice(d.target)}) · Stop {sgn(d.stopPct)} · w {horizonTxt}</Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={s.meta}>normalnie {pct0(d.hist)}{d.hiHit !== null && d.hiN >= 20 ? ` · trafność ${pct0(d.hiHit)}` : ''}</Text>
        {d.weak
          ? <Text style={[s.meta, { color: C.warn }]}>{weakShort(E.weakWhy(d))}</Text>
          : aboveBE(d) ? <Text style={[s.meta, { color: C.up }]}>✓ powyżej progu {pct0(breakEven(d))}</Text>
            : <Text style={s.meta}>{d.p >= breakEven(d) - 0.005 ? 'na granicy progu' : 'poniżej progu'} {pct0(breakEven(d))}</Text>}
      </View>
      <VerdictBox d={d} coin={coin} a={row.a} compact />
      {row.tier !== undefined ? (() => { const rr = E.rankReason(row); return <Text style={[s.meta, { marginTop: 4, color: rr.good ? C.accent : C.mute, fontWeight: '600' }]}>{rr.text}</Text>; })() : null}
    </TouchableOpacity>
  );
}

// Karta jednego scenariusza w szczegółach
function ScenarioCard({ coin, d, horizonTxt }) {
  const col = d.weak ? C.mute : dirColor(d.dir);
  return (
    <View style={[s.card, { borderColor: col }]}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10 }}>
        <Text style={{ color: col, fontSize: 24, fontWeight: '900' }}>{d.dir}</Text>
        <Text style={{ color: col, fontSize: 24, fontWeight: '900' }}>{pct1(d.p)}</Text>
        {aboveBE(d) ? <Text style={{ color: C.up, fontWeight: '700' }}>✓ powyżej progu</Text> : null}
      </View>
      <Text style={s.li}>Cel: {fmtPrice(d.target)} ({sgn(d.movePct)}) · Stop: {fmtPrice(d.stop)} ({sgn(d.stopPct)}) · w {horizonTxt}</Text>
      <Text style={s.small}>Przykład na każde 100 $ pozycji: cel <Text style={{ color: C.up }}>+{Math.abs(d.movePct).toFixed(2)} $</Text> · stop <Text style={{ color: C.down }}>−{Math.abs(d.stopPct).toFixed(2)} $</Text> (układ {E.MODE_RR[d.mode]})</Text>
      <Text style={s.small}>Normalnie {coin.base} robi taki ruch w {pct0(d.hist)} przypadków – teraz {d.p >= d.hist ? 'częściej' : 'rzadziej'} o {Math.abs((d.p - d.hist) * 100).toFixed(1)} pkt proc. Próg opłacalności: {pct0(breakEven(d))}.</Text>
      {!d.weak && d.hiHit !== null && d.hiN >= 20
        ? <Text style={s.small}>Test na historii: gdy model dawał {d.mode === 'safe' ? '≥65%' : d.mode === 'big' ? '≥40%' : 'mocny sygnał'}, trafiał w {pct1(d.hiHit)} przypadków ({d.hiN} razy w ostatnich {d.nVal} świecach).</Text>
        : null}
      {d.weak ? <Text style={[s.small, { color: C.warn }]}>{weakShort(E.weakWhy(d))}</Text> : null}
    </View>
  );
}

// Karta „Zmiana trendu” – szansa, że cena przetnie średnią EMA50 w drugą stronę
const VIOLET = '#a78bfa';
function TrendCard({ a, coin }) {
  const [open, setOpen] = useState(false);
  const b = a.brk; if (!b) return null;
  const help = open ? (
    <Text style={[s.small, { color: C.text, marginTop: 6 }]}>
      Średnia krocząca (EMA 50) działa jak „linia trendu”: cena nad nią = trend wzrostowy, pod nią = spadkowy. Przełamanie trendu to zamknięcie świecy po drugiej stronie tej linii. Średnia nie stoi w miejscu – co świecę przesuwa się w stronę ceny. Po mocnym wzroście, gdy cena zaczyna stać w miejscu, średnia szybko ją dogania i przełamanie następuje bez dużego spadku. Dlatego wysoka szansa na przełamanie NIE oznacza wysokiej szansy na SHORT – częściej oznacza po prostu, że trend słabnie i cena przestaje uciekać od średniej.{'\n\n'}
      Procent pokazuje, jak często w historii {coin.base} – w podobnym układzie wykresu – dochodziło do takiego przełamania w podanym czasie. „Normalnie” to średnia dla wszystkich sytuacji z tym samym trendem.{'\n\n'}
      Przełamanie nie znaczy, że cena potem pójdzie dalej w nową stronę – to sygnał, że dotychczasowy trend słabnie. Często po nim cena wraca do średniej i „testuje” ją jeszcze raz.
    </Text>
  ) : null;
  const toggle = <TouchableOpacity onPress={() => setOpen(!open)}><Text style={{ color: C.accent, fontSize: 12 }}>{open ? 'Zwiń' : 'Co to znaczy?'}</Text></TouchableOpacity>;
  if (!b.side) return (
    <View style={[s.card, { borderColor: C.line }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
        <Text style={{ color: C.text, fontWeight: '800' }}>🔄 Zmiana trendu</Text>{toggle}
      </View>
      <Text style={s.small}>Brak wyraźnego trendu – cena jest blisko swojej średniej, więc nie ma czego przełamywać.</Text>
      {help}
    </View>
  );
  const up = b.side === 'up';
  const dist = (b.level / a.price - 1) * 100;
  const why = b.p === null ? null : E.weakWhy(b);
  const col = b.p === null || b.weak ? C.mute : VIOLET;
  return (
    <View style={[s.card, { borderColor: col }]}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text style={{ color: C.text, fontWeight: '800', fontSize: 15 }}>🔄 Zmiana trendu</Text>
        <Text style={{ color: col, fontWeight: '900', fontSize: 22 }}>{b.p === null ? '–' : pct0(b.p)}</Text>
      </View>
      <Text style={[s.li, { marginTop: 2 }]}>Trend teraz: <Text style={{ color: up ? C.up : C.down, fontWeight: '700' }}>{up ? '↗ wzrostowy' : '↘ spadkowy'}</Text></Text>
      {b.p !== null ? (
        <View style={{ height: 8, backgroundColor: C.line, borderRadius: 4, marginVertical: 8 }}>
          <View style={{ width: `${Math.max(2, b.p * 100)}%`, height: 8, borderRadius: 4, backgroundColor: col }} />
          {b.prior !== null ? <View style={{ position: 'absolute', left: `${b.prior * 100}%`, top: -3, width: 2, height: 14, backgroundColor: C.text, opacity: 0.7 }} /> : null}
        </View>
      ) : null}
      <Text style={s.small}>
        {b.p === null ? 'Za mało podobnych sytuacji w historii coina, żeby policzyć szansę. ' : 'Szansa, że '}
        {b.p === null ? '' : <>w ciągu {a.horizonTxt} cena zamknie się <Text style={{ color: C.text, fontWeight: '700' }}>{up ? 'pod' : 'nad'} swoją średnią</Text> – czyli trend {up ? 'wzrostowy' : 'spadkowy'} zostanie przełamany. Średnia jest teraz na {fmtPrice(b.level)} ({sgn(dist)}), ale <Text style={{ color: C.text, fontWeight: '700' }}>przesuwa się za ceną</Text>{Math.abs(dist) > 5 ? ` – gdy cena ${up ? 'przestaje rosnąć' : 'przestaje spadać'}, średnia ją dogania, więc do przełamania nie jest potrzebny ruch o ${Math.abs(dist).toFixed(0)}%` : ''}.</>}
      </Text>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <Text style={[s.small, why ? { color: C.warn } : null]}>
          {b.p !== null && b.prior !== null ? `normalnie ${pct0(b.prior)} = kreska na pasku` : ''}{why ? ` · ${why === 'short' ? '⚠ za młody coin' : '⚠ wykres nic tu nie mówi'}` : ''}
        </Text>
        {toggle}
      </View>
      {help}
    </View>
  );
}

// ---------- Szczegóły coina ----------
// Czytelny opis błędu pobierania (np. chińskie komunikaty BingX)
const errText = e => (/^Za młody/.test(e) ? e : /[\u4e00-\u9fff]|limit|frequen|later|ograniczył/i.test(e)
  ? 'Giełda chwilowo nie oddała danych dla tego horyzontu (limit zapytań). Dane pojawią się po kolejnym skanie – zwykle w ciągu godziny. Sprawdź też inne horyzonty.'
  : e);
function Detail({ coin, iv0, mode0, onBack }) {
  const [iv, setIv] = useState(iv0);
  const [mode, setMode] = useState(mode0);
  const a = coin.res[iv];
  const ok = a && !a.error && (mode === 'equal' || a[mode]);
  return (
    <ScrollView contentContainerStyle={s.page}>
      <TouchableOpacity onPress={onBack} style={{ marginBottom: 10 }}><Text style={{ color: C.accent, fontSize: 16 }}>‹ Wróć</Text></TouchableOpacity>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={s.title}>{coin.base}</Text><CatBadge coin={coin} /><ExBadges coin={coin} /><ExtremeBadge coin={coin} /><LiquidityBadge coin={coin} /><RegimeBadge a={a && !a.error ? a : null} />
      </View>
      <Text style={s.small}>{fmtPrice(coin.price)} $ · 24h <Text style={{ color: coin.chg >= 0 ? C.up : C.down }}>{sgn(coin.chg)}</Text> · wol. {fmtVol(coin.qv)}</Text>
      {coin.funding !== undefined && coin.funding !== null ? (
        <Text style={s.small}>Funding (BingX): {(coin.funding * 100).toFixed(4)}% – {coin.funding > 0.0001 ? 'przewaga longów (longi płacą shortom)' : coin.funding < -0.0001 ? 'przewaga shortów (shorty płacą longom)' : 'równowaga'}</Text>
      ) : null}
      {E.isExtreme(coin) ? (
        <View style={[s.box, { borderColor: C.warn, marginTop: 8 }]}>
          <Text style={{ color: C.warn, fontWeight: '800' }}>⚡ Ekstremalny ruch: {sgn(coin.chg)} w 24h</Text>
          <Text style={[s.small, { color: C.text }]}>Przy takim pumpie/dumpie historia coina słabo opisuje sytuację. Procenty poniżej traktuj bardzo ostrożnie – ryzyko jest wyjątkowo wysokie.</Text>
        </View>
      ) : null}
      {(coin.exs || []).length > 1 ? <Text style={s.small}>Dostępny na: {coin.exs.map(e => (EX[e] || [e])[0]).join(', ')} · analiza z {(EX[coin.ex] || [coin.ex])[0]}</Text> : null}
      <View style={{ marginVertical: 12 }}><Sparkline data={coin.spark} h={48} /></View>
      <Text style={s.label}>Horyzont</Text>
      <Chips items={HORIZONS} value={iv} onChange={setIv} />
      <Text style={s.small}>{HORIZON_INFO[iv]}</Text>
      <Text style={s.label}>Ile możesz zarobić, a ile stracić</Text>
      <Chips items={MODES} value={mode} onChange={setMode} />
      <Text style={s.small}>{MODE_INFO[mode]}</Text>

      {!ok ? <Text style={[s.small, { marginTop: 12 }]}>{a && a.error ? errText(a.error) : 'Brak danych dla tego trybu – poczekaj na kolejny skan.'}</Text> : (
        <View>
          <Text style={s.h3}>Scenariusze na {a.horizonTxt}</Text>
          {a.src ? <Text style={s.small}>{coin.base} jest młodym coinem (za mało dłuższych świec), więc prognoza {a.horizonTxt} jest liczona ze świec {a.src === '1h' ? '1-godzinnych' : '4-godzinnych'}.</Text> : null}
          <VerdictBox d={E.dirOf(a, mode)} coin={coin} a={a} />
          <MismatchNote coin={coin} a={a} mode={mode} />
          <RegimeNote coin={coin} a={a} />
          {(() => {
            const L = E.dirOf(a, mode, 'long'), S = E.dirOf(a, mode, 'short');
            const wl = E.weakWhy(L), ws = E.weakWhy(S);
            return wl && wl === ws && wl === 'short' ? <WeakNote coin={coin} why={wl} />
              : <>{wl ? <WeakNote coin={coin} why={wl} sides="LONG" d={L} /> : null}{ws ? <WeakNote coin={coin} why={ws} sides="SHORT" d={S} /> : null}</>;
          })()}
          {(() => {
            const L = E.dirOf(a, mode, 'long'), S = E.dirOf(a, mode, 'short');
            const first = L.weak === S.weak ? (L.p >= S.p ? 'L' : 'S') : (L.weak ? 'S' : 'L');
            const cards = [<ScenarioCard key="L" coin={coin} d={L} horizonTxt={a.horizonTxt} />, <ScenarioCard key="S" coin={coin} d={S} horizonTxt={a.horizonTxt} />];
            return first === 'L' ? cards : cards.reverse();
          })()}
          <TrendCard a={a} coin={coin} />
          {mode === 'equal' ? (
            <ProbBar label="Konsolidacja (żaden poziom)" p={a.probs.side} color={C.side} sub={`historycznie ${pct0(a.prior.side)}`} />
          ) : null}

          <RiskExample d={E.dirOf(a, mode)} />

          <Text style={s.h3}>Jak wygląda wykres ({a.label})</Text>
          {E.reasons(a.raw, coin.est).map((t, i) => <Text key={i} style={s.li}>• {t}</Text>)}
          <FactorsBox />
          {coin.est ? <Text style={s.small}>Ta giełda nie udostępnia wolumenu kupujących – presja jest szacowana z położenia zamknięcia w świecy.</Text> : null}
          <Text style={s.small}>Model wytrenowany na {a.nTrain} świecach {coin.base} ({a.label}), osobno dla każdego coina, interwału i kierunku.</Text>
        </View>
      )}
      <Text style={[s.small, { marginTop: 20 }]}>Procent = szansa, że cena w podanym czasie najpierw dojdzie do celu, a nie do stopu. Liczone z tego, jak kończyły się podobne układy wykresu w historii coina. Treść informacyjna i edukacyjna – nie stanowi porady inwestycyjnej, rekomendacji ani oferty. Wyniki historyczne nie gwarantują przyszłych wyników.</Text>
    </ScrollView>
  );
}

// ---------- Aplikacja ----------
function Consent({ onAccept }) {
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.page}>
        <Text style={s.title}>Zanim zaczniesz</Text>
        <Text style={[s.li, { marginTop: 12 }]}>TradingJam to narzędzie <Text style={{ fontWeight: '800' }}>statystyczne i edukacyjne</Text>. Pokazuje, jak w przeszłości kończyły się podobne układy wykresów kryptowalut.</Text>
        <Text style={s.li}>• To <Text style={{ fontWeight: '800' }}>nie jest</Text> porada inwestycyjna, doradztwo ani rekomendacja kupna czy sprzedaży.</Text>
        <Text style={s.li}>• Wyniki są takie same dla wszystkich i nie uwzględniają Twojej sytuacji finansowej.</Text>
        <Text style={s.li}>• Wyniki historyczne nie gwarantują przyszłych wyników.</Text>
        <Text style={s.li}>• Handel kryptoaktywami wiąże się z wysokim ryzykiem utraty całości środków.</Text>
        <Text style={s.li}>• Wszystkie decyzje podejmujesz samodzielnie i na własną odpowiedzialność.</Text>
        <TouchableOpacity onPress={onAccept} style={[s.btn, { marginTop: 20 }]}>
          <Text style={s.btnT}>Rozumiem i akceptuję</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}
const CONSENT_KEY = 'tj_consent_v1';
const readConsent = () => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(CONSENT_KEY) === '1'; } catch (e) { return false; } };
const saveConsent = () => { try { if (typeof localStorage !== 'undefined') localStorage.setItem(CONSENT_KEY, '1'); } catch (e) { } };

export default function App() {
  const [consent, setConsent] = useState(readConsent());
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
  const [shown, setShown] = useState(100);
  const [sortBy, setSortBy] = useState('p');
  const [busy, setBusy] = useState(false);
  const [catF, setCatF] = useState('all');
  const [mode, setMode] = useState('big');
  const [bybitSet, setBybitSet] = useState(null);
  const scanning = useRef(false);

  const localScan = useCallback(async () => {
    if (scanning.current) return; scanning.current = true;
    setErr(null); setStatus('Pobieram listę coinów…');
    try {
      let bn = [], bx = [];
      try { bn = await X.binanceTickers(); } catch (e) { }
      try { bx = await X.bingxTickers(); } catch (e) { }
      if (!bn.length && !bx.length) throw new Error('Brak połączenia z giełdami');
      const onBn = new Set(bn.map(t => E.cleanBase(t.base)));
      const list = [
        ...bn.sort((a, b) => b.qv - a.qv).slice(0, LOCAL_BINANCE),
        ...bx.filter(t => !onBn.has(E.cleanBase(t.base)) && t.qv > 5e5).sort((a, b) => b.qv - a.qv).slice(0, LOCAL_BINGX),
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
  // Bybit blokuje serwery skanera, więc listę coinów z Bybit pobiera urządzenie użytkownika
  useEffect(() => { X.bybitBases().then(set => { if (set && set.size) setBybitSet(set); }).catch(() => { }); }, []);
  // Ceny na żywo: co minutę telefon pobiera aktualne ceny z giełd (statystyka zmienia się raz na godzinę ze skanem)
  const [live, setLive] = useState(null);
  const [liveAt, setLiveAt] = useState(null);
  useEffect(() => {
    let alive = true, n = 0;
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return; // karta w tle – nie pobieramy
      const m = new Map();
      try { for (const t of await X.binanceTickers()) m.set('binance' + t.sym, t); } catch (e) { }
      try { for (const t of await X.bingxTickers()) m.set('bingx' + t.sym, t); } catch (e) { }
      try { for (const t of await X.okxTickers()) m.set('okx' + t.sym, t); } catch (e) { }
      if (alive && m.size) { setLive(m); setLiveAt(new Date()); }
      // co 5 minut sprawdzamy, czy jest nowy skan – wtedy wczytuje się sam, bez odświeżania
      if (SERVER_ON && ++n % 5 === 0) {
        try {
          const r = await fetch(RESULTS_URL + '?t=' + Date.now()); const j = await r.json();
          if (alive && j && j.generatedAt) setData(d => (!d || d.generatedAt !== j.generatedAt ? { ...j, source: 'server' } : d));
        } catch (e) { }
      }
    };
    const first = setTimeout(tick, 4000);
    const id = setInterval(tick, 60000);
    return () => { alive = false; clearTimeout(first); clearInterval(id); };
  }, []);
  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const coins = useMemo(() => {
    const base = data ? data.coins : [];
    const seen = new Set(base.map(c => c.ex + c.sym));
    let all = [...base, ...extra.filter(c => !seen.has(c.ex + c.sym))];
    if (live) all = all.map(c => { const t = live.get(c.ex + c.sym); return t ? { ...c, price: t.price, chg: t.chg, qv: t.qv, live: true } : c; });
    if (!bybitSet) return all;
    return all.map(c => (bybitSet.has(E.cleanBase(c.base)) && !(c.exs || []).includes('bybit')
      ? { ...c, exs: [...(c.exs || [c.ex]), 'bybit'] } : c));
  }, [data, extra, bybitSet, live]);

  const catItems = useMemo(() => {
    const n = {}; for (const c of coins) { const k = catKey(c); n[k] = (n[k] || 0) + 1; }
    return [['all', 'Wszystkie kategorie'], ...Object.keys(E.CATS).filter(k => n[k]).map(k => [k, `${E.CATS[k].label} (${n[k]})`])];
  }, [coins]);
  const coinsCat = useMemo(() => (catF === 'all' ? coins : coins.filter(c => catKey(c) === catF)), [coins, catF]);
  const top = useMemo(() => E.rankTop(coinsCat, iv, dir, 10, mode), [coinsCat, iv, dir, mode]);
  const horizonTxt = E.CFG[iv].horizonTxt;

  const filtered = useMemo(() => {
    const Q = q.trim().toUpperCase();
    let rows = coinsCat.map(c => ({ c, d: E.dirOf(c.res[iv], mode, dir === 'all' ? null : dir), a: c.res[iv] }))
      .filter(r => (!Q || r.c.base.includes(Q)) && (exF === 'all' || r.c.ex === exF || (r.c.exs || []).includes(exF)))
      .filter(r => minP === '0' || (r.d && r.d.p >= +minP));
    const key = { p: r => (r.d ? r.d.p : -1), v: r => r.c.qv, c: r => r.c.chg }[sortBy];
    return rows.sort((x, y) => key(y) - key(x));
  }, [coinsCat, iv, q, exF, minP, sortBy, dir, mode]);

  const analyzeOnDemand = async () => {
    const base = q.trim().toUpperCase().replace(/[\s\/\-_]|USDT$/g, ''); if (!base) return;
    setBusy(true); setErr(null);
    try {
      let t;
      try { t = await X.binanceTicker(base + 'USDT'); } catch (e) {
        try { t = await X.bingxTicker(base + '-USDT'); } catch (e2) { t = await X.bybitTicker(base + 'USDT'); }
      }
      const c = await X.analyzeCoin(E, t);
      setExtra(x => [...x, c]); setSel(c);
    } catch (e) { setErr(`Nie znalazłem ${base} na Binance, BingX ani Bybit (albo giełda blokuje połączenie z przeglądarki).`); }
    setBusy(false);
  };

  const age = data && data.generatedAt ? (Date.now() - new Date(data.generatedAt)) / 36e5 : 0;

  if (!consent) return <Consent onAccept={() => { saveConsent(); setConsent(true); }} />;

  if (sel) {
    return (
      <SafeAreaView style={s.root}><StatusBar barStyle="light-content" />
        <Detail coin={(sel && coins.find(c => c.ex + c.sym === sel.ex + sel.sym)) || sel} iv0={iv} mode0={mode} onBack={() => setSel(null)} />
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
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Image source={require('./assets/icon.png')} style={{ width: 34, height: 34, borderRadius: 9, borderWidth: 1, borderColor: C.line }} />
          <Text style={[s.title, { letterSpacing: -0.5 }]}>tradingjam</Text>
        </View>
        <Text style={s.small}>
          {data ? `${data.source === 'local' ? 'Skan z telefonu' : 'Statystyka'}: ${fmtTime(data.generatedAt)} · ${data.coins.length} coinów · Binance + BingX + OKX${bybitSet ? ' · oznaczone też na Bybit' : ''}` : 'Binance + BingX'}
        </Text>
        {liveAt ? <Text style={s.small}><Text style={{ color: C.up }}>●</Text> Ceny na żywo · {liveAt.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })} · statystyka odświeża się co godzinę</Text> : null}
        {age > 3 && data && data.source === 'server' ? <Text style={[s.small, { color: C.warn }]}>Wyniki mają ponad {Math.floor(age)} godz. – sprawdź, czy skaner na GitHubie działa.</Text> : null}
        {status ? <View style={{ flexDirection: 'row', gap: 8, marginTop: 10, alignItems: 'center' }}><ActivityIndicator color={C.accent} /><Text style={s.small}>{status}</Text></View> : null}
        {err ? (
          <View style={[s.card, { borderColor: C.down }]}>
            <Text style={{ color: C.down }}>{err}</Text>
            <TouchableOpacity onPress={localScan} style={{ marginTop: 8 }}><Text style={{ color: C.accent }}>Zrób skan na telefonie ({LOCAL_BINANCE + LOCAL_BINGX} coinów)</Text></TouchableOpacity>
          </View>
        ) : null}

        {tab !== 'guide' && tab !== 'support' ? (
          <TouchableOpacity onPress={() => setTab('guide')} style={[s.box, { borderColor: C.accent, marginTop: 10 }]}>
            <Text style={{ color: C.accent, fontWeight: '800' }}>📘 Pierwszy raz? Przeczytaj Poradnik (2 min)</Text>
            <Text style={s.small}>Dowiesz się, co znaczą procenty, cel, stop i próg opłacalności oraz jak czytać wyniki.</Text>
          </TouchableOpacity>
        ) : null}
        {tab === 'guide' ? <Guide /> : tab === 'support' ? <Support /> : <>
        <View style={{ marginTop: 12 }}>
          <Text style={s.label}>Horyzont prognozy</Text>
          <Chips items={HORIZONS} value={iv} onChange={setIv} />
          <Text style={s.small}>{HORIZON_INFO[iv]}</Text>
          <Text style={s.label}>Ile możesz zarobić, a ile stracić</Text>
          <Chips items={MODES} value={mode} onChange={setMode} />
          <Text style={s.small}>{MODE_INFO[mode]}</Text>
          <Text style={s.label}>Kierunek</Text>
          <Chips items={[['all', 'Long i Short'], ['long', '▲ Tylko LONG (wzrost)'], ['short', '▼ Tylko SHORT (spadek)']]} value={dir} onChange={setDir} />
          <Text style={s.label}>Kategoria</Text>
          <Chips items={catItems} value={catF} onChange={setCatF} />
        </View>
        <Legend />

        {tab === 'top' ? (
          <View>
            <Text style={s.h2}>TOP 10 scenariuszy na {horizonTxt}{catF !== 'all' ? ` · ${E.CATS[catF].label}` : ''}</Text>
            <Text style={[s.small, { marginBottom: 6 }]}>Kolejność: najpierw scenariusze, które przeszły test na historii i są powyżej progu – od największej przewagi nad normą (jak bardzo obecny wykres zwiększa szansę w porównaniu ze zwykłym zachowaniem coina). Coiny z ostrzeżeniami są na końcu.</Text>
            {top.length === 0 && !status ? <Text style={s.small}>{coins.length ? 'Dane dla tego rodzaju celu pojawią się po najbliższym skanie (co godzinę).' : 'Brak wyników.'}</Text> : null}
            {top.map((row, i) => (
              <TopRow key={row.coin.ex + row.coin.sym} rank={i + 1} row={row} horizonTxt={horizonTxt} onPress={() => setSel(row.coin)} />
            ))}
            <Text style={[s.small, { marginTop: 14 }]}>
              Procent = szansa, że cena w ciągu {horizonTxt} najpierw dojdzie do celu, a nie do stopu. Liczone osobno z historii każdego coina. „✓ powyżej progu” = szansa wyższa niż próg opłacalności dla danego rodzaju celu. Coiny bez potwierdzonej przewagi, z za krótką historią albo po ekstremalnym ruchu (⚡) są wyszarzone i na końcu listy. Treści mają charakter wyłącznie informacyjny i edukacyjny – nie stanowią porady inwestycyjnej ani rekomendacji. Wyniki historyczne nie gwarantują przyszłych wyników.
            </Text>
          </View>
        ) : (
          <View>
            <TextInput value={q} onChangeText={setQ} placeholder="Szukaj coina, np. PEPE" placeholderTextColor={C.mute}
              autoCapitalize="characters" autoCorrect={false} style={s.input} />
            <Chips items={[['all', 'Wszystkie giełdy'], ['binance', 'Binance'], ['bingx', 'BingX (lowcapy)'], ['okx', 'OKX'], ...(bybitSet ? [['bybit', 'Też na Bybit']] : [])]} value={exF} onChange={setExF} />
            {exF === 'bybit' ? <Text style={s.small}>Coiny dostępne także na Bybit. Statystyka jest liczona z danych Binance lub BingX – ceny na Bybit są zwykle bardzo zbliżone.</Text> : null}
            <Chips items={[['0', 'Każde %'], ['0.5', '≥ 50%'], ['0.6', '≥ 60%'], ['0.7', '≥ 70%']]} value={minP} onChange={setMinP} />
            <Chips items={[['p', 'Sortuj: prawdop.'], ['v', 'Wolumen'], ['c', 'Zmiana 24h']]} value={sortBy} onChange={setSortBy} />
            <Text style={[s.small, { marginVertical: 6 }]}>{filtered.length} coinów</Text>
            {filtered.slice(0, shown).map(({ c, d, a }) => (
              <TouchableOpacity key={c.ex + c.sym} onPress={() => setSel(c)} style={s.row}>
                <View style={{ flex: 1, minWidth: 0, marginRight: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', rowGap: 4 }}>
                    <Text style={{ color: C.text, fontWeight: '700', fontSize: 15 }}>{c.base}</Text><CatBadge coin={c} /><ExBadges coin={c} /><ExtremeBadge coin={c} /><LiquidityBadge coin={c} /><RegimeBadge a={a} />
                  </View>
                  <Text style={s.small}>{fmtPrice(c.price)} $ · <Text style={{ color: c.chg >= 0 ? C.up : C.down }}>{sgn(c.chg)}</Text> · {fmtVol(c.qv)}</Text>
                </View>
                {d ? (
                  <View style={{ alignItems: 'flex-end', flexShrink: 0, maxWidth: '45%' }}>
                    <Text style={{ color: d.weak ? C.mute : dirColor(d.dir), fontWeight: '800', fontSize: 16 }}>{d.dir} {pct0(d.p)}</Text>
                    <Text style={[s.small, d.weak ? { color: C.warn } : aboveBE(d) ? { color: C.up } : null]}>{d.weak ? weakShort(E.weakWhy(d)) : `${aboveBE(d) ? '✓ ' : ''}cel ${sgn(d.movePct)} · stop ${sgn(d.stopPct)}`}</Text>
                  </View>
                ) : <Text style={s.small}>brak danych</Text>}
              </TouchableOpacity>
            ))}
            {filtered.length > shown ? (
              <TouchableOpacity onPress={() => setShown(shown + 100)} style={[s.btn, { marginTop: 12 }]}>
                <Text style={s.btnT}>Pokaż więcej ({filtered.length - shown})</Text>
              </TouchableOpacity>
            ) : null}
            {q.trim() && filtered.length === 0 ? (
              <TouchableOpacity onPress={analyzeOnDemand} disabled={busy} style={[s.btn, { marginTop: 12 }]}>
                {busy ? <ActivityIndicator color={C.bg} /> : <Text style={s.btnT}>Przeanalizuj {q.trim().toUpperCase()} teraz</Text>}
              </TouchableOpacity>
            ) : null}
          </View>
        )}
        </>}
      </ScrollView>

      <View style={s.tabbar}>
        {[['top', 'TOP 10'], ['all', 'Wszystkie'], ['guide', 'Poradnik'], ['support', '☕ Wesprzyj']].map(([k, t]) => (
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
  box: { borderWidth: 1, borderRadius: 10, padding: 10, backgroundColor: C.card2 },
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
