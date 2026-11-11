# t. TradingJam

Aplikacja, która na ekranie głównym pokazuje **TOP 10 najbardziej prawdopodobnych scenariuszy LONG/SHORT** z Binance i BingX. W zakładce „Wszystkie coiny” można filtrować resztę.

- **Android**: plik APK do pobrania z linku
- **iPhone**: wersja webowa w Safari → „Do ekranu początkowego” (ikona jak zwykła apka)
- Wszystko na darmowym koncie GitHub: skan rynku co godzinę, automatyczne budowanie aplikacji

## Jak to działa

```
GitHub (co godzinę)                 Twoje linki
scanner/scanner.js ─► results.json ─► APK (Android) + strona (iPhone)
  • Binance: 100 najpłynniejszych par USDT
  • BingX: 100 coinów, których NIE MA na Binance (lowcapy)
  • 3000 świec × 1h / 4h / 1D, osobny model dla każdego coina
```

**Co oznacza procent:** szansa, że w podanym czasie (24 godz. / 3 dni / 14 dni) cena **najpierw** dojdzie do celu (±2× ATR), a nie do poziomu w przeciwną stronę. Model uczy się na historii danego coina (trend, RSI, wolumen, presja kupujących/sprzedających, CVD, pozycja w zakresie). Następnie sprawdza się na ostatnich ~1000 świecach, których „nie widział”. Jeśli nie był tam lepszy od średniej, coin dostaje etykietę „słaby model” i trafia na koniec rankingu.

**BingX** nie podaje wolumenu kupujących, więc presja jest tam **szacowana** z kształtu świec (oznaczenie „szac.”).

---

## Konfiguracja (jednorazowo, ok. 20 min)

### 1. Repozytorium
1. Na github.com kliknij **New repository** → nazwa **`tradingjam`** → **Public** → *Create repository*.
2. Kliknij **uploading an existing file** i przeciągnij z rozpakowanej paczki foldery `app`, `scanner`, `scripts` oraz plik `README.md` → *Commit changes*.
3. Folder `.github` jest ukryty, więc oba pliki workflow dodaj ręcznie przez **Add file → Create new file**:
   - nazwa `.github/workflows/scan.yml` → wklej zawartość `scan.yml` → *Commit changes*
   - nazwa `.github/workflows/build-app.yml` → wklej zawartość `build-app.yml` → *Commit changes*
4. **Settings → Actions → General → Workflow permissions** → zaznacz **Read and write permissions** → *Save*.

### 2. Pierwszy skan rynku
**Actions → Skan rynku → Run workflow**. Trwa ok. 10–20 min. Potem uruchamia się sam co godzinę.

### 3. Budowanie aplikacji
**Actions → Budowanie aplikacji → Run workflow**. Pierwsze budowanie trwa ok. 20–30 min. Później uruchamia się samo po każdej zmianie w folderze `app`.

### 4. Włączenie strony dla iPhone'a
**Settings → Pages → Source: Deploy from a branch → Branch: `gh-pages` / `(root)` → Save**. Po 1–2 minutach strona działa.

## Twoje linki (zamień LOGIN na swój login GitHub)

| Co | Link |
|---|---|
| APK na Androida | `https://github.com/LOGIN/tradingjam/releases/latest/download/tradingjam.apk` |
| Wersja na iPhone / przeglądarkę | `https://LOGIN.github.io/tradingjam/` |

**Instalacja na Androidzie:** otwórz link na telefonie → pobierz → otwórz plik → zezwól na instalację z tego źródła → *Zainstaluj*. Google Play Protect może pokazać ostrzeżenie, bo aplikacja nie jest ze sklepu. Wybierz „Zainstaluj mimo to”.

**Na iPhonie:** otwórz link w **Safari** → przycisk *Udostępnij* → **Do ekranu początkowego**.

Nowe wersje APK instalują się na starą (dane zostają).

---

## Szybki test bez GitHuba (Expo Go)
1. Zainstaluj **Expo Go** na telefonie i otwórz **snack.expo.dev** na komputerze.
2. Wklej `app/App.js` do `App.js`. Dodaj pliki `engine.js` i `exchanges.js` (ikonka „+”).
3. Kliknij **My Device** i zeskanuj QR.
Bez serwera aplikacja sama przeskanuje 18 coinów (ok. 1–2 min).

## Ustawienia skanera (scanner/scanner.js)

| Ustawienie | Domyślnie | Co robi |
|---|---|---|
| `BINANCE_TOP` | 100 | ile coinów z Binance |
| `BINGX_TOP` | 100 | ile lowcapów z BingX |
| `MIN_QV_BINANCE` | 3 mln $ | min. wolumen 24h |
| `MIN_QV_BINGX` | 0,5 mln $ | min. wolumen 24h |

> Jeśli skan pokaże błąd BingX (np. blokada serwerów z USA), wyniki z Binance i tak się zapiszą.
> GitHub może wyłączyć harmonogram po 60 dniach bez aktywności. Wtedy w Actions kliknij „Enable workflow”.

---

To narzędzie analityczne, nie porada inwestycyjna. Prawdopodobieństwa opisują, jak historycznie kończyły się podobne układy wykresu. Rynek nie musi się powtórzyć, a przy lowcapach ryzyko jest szczególnie wysokie.
