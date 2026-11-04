# v6.1: popups no longer block the screen

- Popup style on the Alerts tab: **Small banner** (new default: a compact non-blocking card, phone: above the tab bar), **Full popup** (the previous full-screen one) or **No popup** (sound, notifications and the alert log still work). The banner has Dismiss, **Mute** (switch popups off in one tap) and "dismiss all"; the full popup has a "Smaller" button.
- Alerts are skipped (still listed under "Confirmed now") when the stop is wider than 5% of price (setting, 0 = never skip). Illiquid coins can give 15%+ stops that are rarely tradable.
- Settings are saved in this browser.

---

# v6: five tabs (Live Terminal, MACD, MA Ribbon, Trade Journal, Signals); MACD tab = "MACD Multi-Timeframe Confirmation Dashboard"

The tab bar is now exactly **Live Terminal | MACD | MA Ribbon | Trade Journal | Signals** (phone: bottom bar with 5 buttons). The Impulse, MTF, VIDYA, Reversal and MA Reversal tabs are no longer in the shell and their data is no longer fetched (less Binance load: the MACD route reads 5 timeframes for 50 pairs, about 650 request weight per 30 s refresh). Their source files are still in the project, unused; delete them if you do not want them.

## MACD tab (spec: MACD Multi-Timeframe Confirmation Dashboard)
Internal tabs: Dashboard, MACD Scanner, MACD Confirmation Alerts, Active Trades, MACD Performance, Backtesting, Settings.

Engine `lib/macdmtf.ts` (pure logic), route `/api/macd`, hook `use-macd`, alerts hook `use-macd-alerts`, live price hook `use-live-price` (Binance WebSocket, display only: signals never come from ticks).

### Rules (all must hold at the 5M candle close, closed candles only)
- MACD 12/26/9 on 1M, 3M, 5M, 15M, 30M: line above signal on ALL selected timeframes (BUY) or below on all (SELL), histogram supporting, MACD line moving the right way.
- The 5M MACD crossover in that direction is confirmed by a candle close. A cross up to 3 bars old (setting) is accepted so slower timeframes can finish agreeing; older crosses never fire.
- EMA 200 (5M): price above for BUY, below for SELL. Within 0.25 ATR of it -> WAIT.
- Supertrend 12,4 (5M) must point the same way. Stop = the Supertrend line; if it is not strictly on the correct side of the entry there is NO fallback stop and no trade.
- TP = entry +/- 2 x risk (strict 1:2). Fees + slippage (4 + 2 bps per side by default) are included in performance; a setup whose costs exceed 0.5R is rejected.
- Sideways / weak filter: EMA 200 crossed 3+ times in 30 bars, or MACD crossed 5+ times in 24 bars, or flat MACD line -> WAIT.
- One signal per crossover (the crossover time is part of the id). Any disagreement -> "WAIT / NO TRADE" with the disagreeing timeframes named.
- No repaint / look-ahead: other timeframes only contribute candles already closed at the 5M close (test proves prefix runs reproduce the full run).

### Alerts
Popup "MACD CONFIRMED BUY/SELL": coin, entry, SL, TP, 1:2, risk / reward %, all 5 timeframes, EMA 200 and Supertrend 12,4 confirmation, signal time, live price, countdown to the next 5M candle. Full screen on phones, corner card on desktop, one at a time ("+N more waiting"). Once per crossover, remembered in this browser. Sound toggle, browser / service-worker notification permission, "send test alert" (labelled test, not a signal), persisted alert log. The popup shows on any tab. Alerts only work while the page or installed app is open.

### Performance, back-test, settings
- MACD Performance: total BUY / SELL / confirmed, wins, losses, win rate, net P&L (R and price %), average profit / loss, profit factor, max drawdown, TP / SL hits, per-timeframe (each of 1M..30M tested as the trigger), daily / weekly / monthly, coin-wise. "Live replay" covers only the candles Binance returns for the page (about 16 h of 1M data); "Back-test" shows the last run.
- Backtesting: runs in YOUR browser on real Binance futures klines (public, CORS-enabled): up to 10 symbols, 7-30 days (+6 days warm-up), every trigger timeframe with and without the all-timeframe agreement. Nothing is stored. Same engine as live. CLI: `npx tsx scripts/backtest-macd.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 14 --csv trades.csv`.
- Settings: MACD lengths, Supertrend length / multiplier, which timeframes must agree, trigger timeframe, max crossover age, EMA 200 closeness, fees, slippage. RR fixed at 1:2. Saved in the browser.
- Dashboard shows connection state (CONNECTED / DELAYED / STALE / DISCONNECTED), WebSocket price status and the last candle update time. If Binance is unreachable the tab says so and shows no signals.

## Also changed
- `public/sw.js`: the service worker now ignores cross-origin requests (its comment already said Binance requests were never intercepted, but only /api/ was skipped).

## Checks run
- `npx tsx scripts/test-macd.ts`: 30+ checks on 18 synthetic markets (246 signals): agreement on all 5 timeframes, MACD side and histogram, cross age, EMA 200 side, Supertrend agreement, SL = Supertrend line, SL/TP geometry, reward = 2 x risk, unique ids, one signal per crossover, subset timeframes, other trigger timeframes, no repaint / look-ahead, config clamping, performance maths, back-test runner. All pass. The Impulse, MTF, MA reversal and reversal tests still pass. Indicators were earlier cross-checked against an independent Python implementation.
- Type-check clean. Pages rendered at 390 px and 1366 px (all 7 internal tabs, popup, back-test run against mocked klines, mocked WebSocket price): no horizontal overflow, no console errors.
- NOT done: Binance is not reachable from where this was built, so nothing has run on live data, no real-history back-test was run, and the WebSocket was only tested against a mock. `next build` was also not possible there (Google Fonts download). The performance numbers seen during testing came from synthetic candles and mean nothing. Run the back-test on the page or the CLI and judge the strategy on that.

## Files
New: `lib/macdmtf.ts`, `lib/macd-perf.ts`, `lib/macd-backtest.ts`, `app/api/macd/route.ts`, `hooks/use-macd.ts`, `hooks/use-macd-alerts.ts`, `hooks/use-live-price.ts`, `components/terminal/macd-ui.tsx`, `macd-panel.tsx`, `macd-alerts.tsx`, `macd-perf.tsx`, `macd-settings.tsx`, `scripts/test-macd.ts`, `scripts/backtest-macd.ts`. Changed: `components/terminal/terminal.tsx`, `public/sw.js`, `CHANGES.md`.

---

# MTF tab v5: Supertrend 1M/3M/5M/15M scanner + MACD early entry + EMA 200 (new FIRST tab, opens by default)

New "MTF" tab built from the second strategy brief. Engine: `lib/mtf.ts` (pure logic). Data: new route `/api/mtf` (top 60 USDT-M futures by volume; native Binance 1M (1000 bars), 3M, 5M, 15M (499 bars each); 30 s cache; the other routes are untouched). The earlier tabs stay as they were; this one is simply first and the default.

## Dashboard order (phone and desktop)
1. Supertrend 12,10 MTF scanner: pair, price, 24h, agreement headline ("MTF TREND AGREEMENT: 4/4 BULLISH"), status line, bullish / bearish timeframe counts, agreement %, overall direction, FULL / STRONG MAJORITY / MIXED / NO AGREEMENT, and a 1M-3M-5M-15M grid (Supertrend, MACD, EMA 200 side, overall) in green / red / yellow / grey. Conflicting timeframes are named.
2. MACD MTF: direction, cross age, line / signal / histogram, momentum, zero line for each timeframe.
3. EMA 200 entry filter (5M): price, EMA 200, slope, distance, BUY / SELL valid or blocked, EMA 20/50/100 + ribbon status, supplementary Impulse MACD 34/9 (extremes, momentum, direction change; never required).
4. MACD entry signal: waiting / crossover detected / EMA 200 invalid / conflict / CONFIRMED, with Entry, SL, TP, risk, reward, R:R.
5. Trade history, 6. Performance (signals, BUY/SELL, win rate, P&L, avg R, max drawdown, monthly). Pair list with search and filters (also a pair picker on phones).

## Rule
- Agreement is measured per timeframe: bullish = Supertrend BUY and MACD above its signal; bearish = both SELL. FULL = 4/4 (default). Optional STRONG = 3/4 with none opposed (the 5M Supertrend must still agree).
- Entry EVENT = 5M MACD crossing in the agreed direction. No signal just because MACD is already bullish; a Supertrend flip is never a trigger.
- Also required at the 5M close: MACD line moving the right way, histogram on the right side and growing, price on the right side of EMA 200 and not within 0.25 ATR of it.
- Wrong side of EMA 200 -> "MACD CROSS DETECTED — EMA 200 INVALID", no popup. Too close -> "EMA 200 CONFLICT — WAIT".
- One popup per setup. After a signal the setup is "used" and re-arms when the agreement is lost or the 5M MACD crosses back (setting "only when agreement is lost" available; in FULL mode both behave the same). Minimum 6 bars between same-side signals.
- Stop: 5M Supertrend by default; if it is on the wrong side, swing then ATR; no valid stop (or fees > 0.5R) rejects the setup. TP = entry +/- 2 x risk. Entry = 5M candle close (a signal price, not a fill).
- Look-ahead: other timeframes only contribute candles already closed at the 5M close.

## Checks run
- `npx tsx scripts/test-mtf.ts` (18 synthetic markets, FULL and STRONG): EMA 200 side, Supertrend / MACD agreement at the signal, 5M MACD side + histogram, SL/TP geometry and reward = 2 x risk, no duplicates, no repaint / look-ahead (prefix runs reproduce the full run), agreement maths. All pass. The previous Impulse, MA and reversal tests still pass.
- Type-check clean; page rendered at 390 px and 1366 px with no horizontal overflow and no console errors, using synthetic API data (Binance is not reachable from where this was built; `next build` was also not possible there because of the Google Fonts download).
- NOT done: no live Binance run, no real-history back-test. Run `npx tsx scripts/backtest-mtf.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 60` (FULL vs STRONG, re-arm modes, stop methods, R:R, fees and slippage included). Full 4-timeframe agreement is rare by design; whether it pays is unknown until that is run. Not a guarantee.
- Replay history on the page covers ~16 h (limited by the 1M candles), too short to judge anything.

## Files
New: `lib/mtf.ts`, `app/api/mtf/route.ts`, `hooks/use-mtf.ts`, `hooks/use-mtf-alerts.ts`, `components/terminal/mtf-panel.tsx`, `scripts/test-mtf.ts`, `scripts/backtest-mtf.ts`. Changed: `components/terminal/terminal.tsx` (MTF tab first + default, popups, 9-column phone bar), `lib/impulse5m.ts` (performance maths accepts any signal shape), `CHANGES.md`.

---

# 5M Impulse MACD tab v4: Impulse MACD exit + EMA 200 + MACD cross (new "Impulse" tab, 2nd tab)

New tab built from the strategy brief. Engine: `lib/impulse5m.ts` (pure logic). Data: new route `/api/impulse` (top 100 USDT-M futures by volume, 499 closed-candle 5M klines each, 30 s cache; the existing routes are untouched). Alerts run from the terminal shell, so a confirmed signal pops up on whichever tab is open.

## Rule (all of it is required, in this order)
1. Price on the right side of EMA 200 and EMA 200 not sloping against the trade (BUY: price > EMA 200, slope not falling; SELL: mirror).
2. LazyBear Impulse MACD (34 / 9) histogram enters a dynamic extreme zone: rolling percentile P10/P90 of the last 200 bars (or "recent extremes" mode). No fixed 70/30 levels.
3. Histogram turns and EXITS the zone (touching the zone alone never signals).
4. Regular MACD 12/26/9 crosses the same way ON or AFTER the exit bar and within 6 bars of it (an older cross is never reused), histogram strengthening.
5. The 5M candle closes with all of that intact and the market filter says SUITABLE -> CONFIRMED BUY / SELL. One alert per setup; the state resets after a signal or an invalidation (EMA 200 disagrees, no cross within 6 bars, no valid stop).

Supertrend 12,10 is never an entry trigger. It is the default stop reference; if it still points against the entry the signal stays valid and shows an "elevated reversal risk" warning.

## Stops, targets, filters
- Stop: Supertrend 12,10 by default, or swing high/low, or ATR x1.5 (Settings). If the chosen stop is on the wrong side of the entry, the next method is tried (supertrend -> swing -> ATR). No valid stop, or a stop so tight that fees + slippage exceed 0.5R, rejects the setup.
- Target: entry +/- risk x 2 (configurable). A pivot support/resistance before the target adds a warning; the target is never moved.
- NO TRADE / WAIT states: CHOPPY (EMA 200 crossed 3+ times in 30 bars, MACD crossed 5+ times in 24 bars, price within 0.25 ATR of EMA 200, flat EMA 200 with overlapping ribbon), LOW VOLATILITY (ATR < 0.10% of price or < half its 100-bar median), ABNORMAL VOLATILITY (ATR > 2.5x median, a candle > 4x ATR, or price > 20 ATR from EMA 200), POOR MARKET CONDITIONS (volume < 35% of its 100-bar average). Spread / order-book data is not available from the klines used, so nothing is said about it.
- Entry price is the signal candle's close (a signal price, not a fill). The popup and card also show the live price.

## UI
Pair dashboard (price, 24h, EMA 20/50/100/200 values, distance and slope of EMA 200, Impulse histogram / signal / active thresholds, MACD, Supertrend, market card, status line), scanner with search and filters, pair picker for phones, settings (all engine numbers, zone method, source, stop method, R:R), popup + sound + browser notification + vibration, signal history and performance (replayed over the fetched ~20 h window, fees and slippage included).

## Checks run
- `npx tsx scripts/test-impulse.ts`: 18 synthetic markets (up / down / choppy): no BUY below or SELL above EMA 200, SL/TP on the right side with reward = 2 x risk, fees <= 0.5R, MACD on the right side at the close, the setup really reached the zone, cross within the wait window, no duplicate alerts, and a no-repaint / no-look-ahead check (runs on prefixes of the data reproduce exactly the signals the full run shows).
- Impulse MACD, MACD and Supertrend values matched an independent Python implementation of the same formulas to 0.0 difference over 359-400 bars (that checks the code against the formulas as written, not against TradingView's output; compare a few bars on TradingView before relying on it).
- Type-check clean; page rendered on 390 px and 1366 px wide viewports with no horizontal overflow and no console errors (with synthetic API data, because Binance is not reachable from where this was built). `next build` could not be run there (Google Fonts download blocked); `next dev` rendered fine.
- NOT done: no run on live Binance candles and no real-history back-test. Use `npx tsx scripts/backtest-impulse.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 90` (compares lookbacks, zone methods, EMA 200 on/off, MACD cross on/off, impulse on/off, stop methods; fees and slippage included). The full rule is strict by design and fires rarely; whether it is profitable is unknown until that back-test is run. Nothing here is a guarantee.

## Files
New: `lib/impulse5m.ts`, `app/api/impulse/route.ts`, `hooks/use-impulse.ts`, `hooks/use-impulse-alerts.ts`, `components/terminal/impulse-panel.tsx`, `scripts/test-impulse.ts`, `scripts/backtest-impulse.ts`. Changed: `components/terminal/terminal.tsx` (tab, alerts, popup, 8-column phone bar), `CHANGES.md`.

---

# MA Reversal tab v3: EMA 9/21/50/200 + Volumatic VIDYA early reversals

New **MA Rev** tab (7th tab on phones). Catches early reversals from EMA 9/21 while EMA 50/200 are still pointing the OLD way. Engine: `lib/mareversal.ts`. The earlier "Reversal" tab (VIDYA flip ladder) is unchanged.

## Roles
EMA 9 = early trigger | EMA 21 = confirmation | EMA 50 / 200 = context only (never required, shown as OLD while they still point the old way) | VIDYA 14 / 9 / 1.5 = momentum filter | swing-point structure (higher lows / lower highs, swing-high/low break) = confirmation.

## Signals (per timeframe and overall)
- STRONG EARLY BUY/SELL: 9/21 crossed, price closed beyond BOTH 9 and 21, EMA 9 slope with the move, VIDYA fully aligned (price beyond the line, line sloping the right way, momentum aligned), and HL/LH structure.
- EARLY BUY/SELL: 9/21 crossed, price beyond the 21, EMA 9 slope with the move, VIDYA at least turning that way. 50/200 may still be the old trend.
- CONFIRMED BUY/SELL: stage 3 (above + EMA 50 flat or following) or stage 4 (9>21>50>200 / mirror) with VIDYA aligned and price not pulled back through the 21.
- WEAK REVERSAL: 9/21 crossed but VIDYA is not yet confirming. A bare crossover never produces EARLY/CONFIRMED.
- POSSIBLE FAKE REVERSAL: price closes back through both MAs within 10 candles of the cross, or the cross reverses within 8 candles, or VIDYA stays strongly opposite and price is not clear of 9/21.
- Stages: S0 old trend, S1 early, S2 confirming (+ structure, 21 not against), S3 trend confirmed (+ 50 flat/following), S4 full alignment.
- Every signal carries a plain-English reason ("9 crossed above 21 3 candles ago + 9 rising + price above 9/21 + 21 rising + VIDYA bullish - 50/200 = OLD TREND").

## Multi-timeframe (1M / 3M / 5M)
- Each timeframe is evaluated independently: 9/21/50/200 slope arrows, VIDYA state + momentum + volume delta, 9/21 cross age, structure, stage and signal.
- Overall headline relates every timeframe to the strongest FRESH signal: REVERSAL / CONFIRMED / WEAK / SUPPORT / COUNTER-TREND, plus a risk tag from the higher timeframes (e.g. "1M EARLY REVERSAL - HIGH RISK - 1M REVERSAL - 3M COUNTER-TREND - 5M COUNTER-TREND"). A 1M reversal is NOT rejected because 5M has not turned.
- An old, established trend on 3M/5M (full alignment with no recent cross) is flagged ESTABLISHED and ranked below any fresh reversal, so it cannot hide one.
- A CONFIRMED signal whose higher timeframes do not support it says so ("HIGHER TFs NOT CONFIRMING").

## Technical
- Closed candles only. EMA slope is measured in ATR(14) units per bar (9: 2 bars / 0.03, 21: 3 / 0.02, 50: 5 / 0.01, 200: 10 / 0.004) and VIDYA slope 2 bars / 0.02: these thresholds are the tuning knobs, at the top of `lib/mareversal.ts`.
- Swing pivots use 2 candles each side (confirmed 2 candles late); structure looks back 40 candles.
- VIDYA momentum = 9-bar CMO of closes + buy/sell volume balance of the last 9 candles (candle-direction volume, as in the rest of the project).
- `/api/reversal` now also returns `maRows`, computed from the SAME native 1m/3m/5m candles in the same pass, so there are no extra Binance requests. EMA 200 on 3M/5M uses 300 bars (small residual start-up bias).
- Tests: `npx tsx scripts/test-mareversal.ts` (bullish and bearish V-reversals with 50/200 still old, fake bounce, steady trend, and an invariant check that no early/confirmed signal exists without VIDYA, price and EMA 9 slope agreeing) and `npx tsx scripts/test-reversal.ts`.
- Validated on synthetic candles and a server render only; not yet on live Binance data. Signals are filters, not predictions: nothing here is guaranteed or risk-free.

---

# Reversal tab v2: fake-reversal filters

Three filters added to `lib/reversal.ts` (they reduce false signals, they cannot remove them, and each one delays or withholds some real signals):
- **Flip-back guard / FAILED tag:** if a timeframe flips and then flips straight back (1M within 15 candles, 3M within 8, 5M within 6), the attempt is dropped and the card shows "FAILED SELL/BUY REVERSAL" for 30 minutes. A flip-back also removes that timeframe from any running setup.
- **Volume check:** buy/sell volume since the 1M flip (close>open vs close<open candles) must lean the reversal's way by at least 5%, measured over at least 5 candles. Without it, SELL/BUY TRIGGER and STRONG are withheld (status stays EARLY, stage "EMA CROSSED - VOLUME NOT CONFIRMING YET"). A TRIGGER can drop back to EARLY if volume turns against it.
- **Chop filter:** 4 or more 1M VIDYA flips in 60 minutes marks the coin CHOPPY and suppresses EARLY/TRIGGER (3M/5M confirmations still work).
- UI: new CHK row on cards (and in the table) showing VOL %, CHOPPY and FAILED tags; failed setups get an amber banner.
- Tests: `npx tsx scripts/test-reversal.ts` now also covers whipsaw, low-volume and zig-zag markets (18 checks, all passing on synthetic data; not yet validated on live Binance candles).

---

# Reversal tab: 1M / 3M / 5M Volumatic VIDYA reversal tracker (mobile-first)

## What it does
- New **Reversal** tab (bottom bar on phones, top tab on desktop). Phones/tablets get vertical cards (no horizontal scroll, 44px+ touch targets); desktop (lg+) gets a table.
- Per coin and per timeframe (1M, 3M, 5M, each tracked independently, 5M is never assumed to be "the" higher trend): current VIDYA direction, previous direction, direction change, time since it changed, and a state: BULLISH / BEARISH / NEUTRAL / TURNING BULLISH / TURNING BEARISH.
- Main status: WAIT, EARLY BUY/SELL, BUY/SELL TRIGGER, 3M and 5M BUY/SELL CONFIRMED, STRONG BUY/SELL, plus a stage line ("3M REVERSAL DEVELOPING", "AWAITING 5M CONFIRMATION" ...).
- Sequence line shows the order the timeframes flipped (1M > 3M > 5M = lower-first, 5M > 3M > 1M = higher-first).
- Score (1M VIDYA +1, 1M EMA 9/21 cross +1, 3M +2, 5M +3, +1 for 2+ timeframes, +1 for all 3 = max 9) mapped to LOW / MEDIUM / HIGH / STRONG. STRONG is only possible for STRONG BUY/SELL.
- Search, filter (All / Buy / Sell / Early), sort (Strength / Newest / A-Z), "show more" paging.

## Rules (see lib/reversal.ts)
- Parameters: VIDYA length 14, momentum 9, band distance 1.5 (ATR(200) bands + SMA-15 smoothing kept from the existing VIDYA); EMA 9/21 on 1M.
- A reversal only counts if 1M, 3M and 5M were ALL on the opposite side just before its first flip, and that flip happened within the last 120 minutes. One timeframe flipping while the others disagree gives no signal.
- EARLY = 1M VIDYA flipped. TRIGGER = EARLY + 1M EMA 9 crossed EMA 21 the same way (cross may be up to 3 candles before the VIDYA flip). 3M / 5M CONFIRMED = that timeframe's VIDYA flipped as well. STRONG = all three flipped + the 1M EMA cross.
- TURNING = VIDYA direction still the old one, but price closed back through the VIDYA line and the line's slope reversed. It is a heads-up only and never scores.
- All readings use CLOSED candles only (the forming candle is dropped), so a status does not repaint inside a candle.
- A long-running trend with no fresh reversal shows WAIT ("TREND ALIGNED BEARISH - NO FRESH REVERSAL"), not a sell/buy signal.
- A direction adopted at the first evaluable bar (no flip seen in the loaded candles) is shown as "at least Xh", never as a fresh change.

## Files
- NEW `lib/reversal.ts` (pure engine), `app/api/reversal/route.ts`, `hooks/use-reversal.ts`, `components/terminal/reversal-panel.tsx`, `scripts/test-reversal.ts`.
- CHANGED `lib/indicators.ts` (added `vidyaTrendSeries()` and an opt-in `seed` option; default behaviour of every existing function is unchanged), `components/terminal/terminal.tsx` (new tab, 6-column bottom bar).
- Data: `/api/reversal` fetches native Binance 1m (400), 3m (300), 5m (300) klines for the top 100 USDT-M perpetuals by volume, cached 45s (the existing /api/market cache is 5 min, too slow for 1M). That is 300 requests per refresh (weight 2 each); lower MAX_COINS in the route if you hit rate limits.
- Test: `npx tsx scripts/test-reversal.ts` (synthetic candles: full SELL and BUY ladders, steady trend stays WAIT, epoch alignment, forming-candle drop).

Signals only, nothing here is guaranteed or risk-free.

---

# VIDYA BUY / SELL / NEUTRAL change tracking + mobile layout

## VIDYA signal changes
- `lib/indicators.ts`: `vidya()` split into a shared core (output verified identical to before). New `vidyaSignalSeries()` gives BUY/SELL/NEUTRAL for every candle in one pass, and `summarizeSignalHistory()` turns it into "current state + last 6 changes".
- The live per-timeframe signal now comes from the same series, so the grid and the history can never disagree (verified identical to the old `bucketSignal` on 270 random series).
- `CoinSignal` / `BtcTrend` gain `signalHistory` per timeframe (1m/3m/5m/15m/1h). History is rebuilt from real candles on each refresh, so changes appear immediately without leaving the page open.
- New **VIDYA** tab (`components/terminal/vidya-panel.tsx`): pick a timeframe, filter Buy / Sell / Neutral, "New only" (changed within the last 3 candles), search; most recent change on top; tap a row for every timeframe's last 6 changes and an "Open in Terminal" button.
- Timeframe cards in the terminal now show the last change (e.g. `NEUTRAL -> BUY`, `16m ago`).
- Note: the newest candle is still forming, so a change on "this candle" can still revert.

## Mobile
- Bottom tab bar on phones (Terminal / VIDYA / Ribbon / Journal / Signals); desktop keeps the top tabs.
- Terminal tab on phones switches between Coins / BTC / Bot instead of stacking everything.
- Compact B/S/N badges in tight rows, 2-column timeframe cards, shorter top bar, safe-area padding for iPhone notch + home bar.
- Trade Journal history scrolls sideways instead of squashing; MA Ribbon keeps the coin column pinned.
- `public/sw.js` (v2): page loads are now network-first, so an installed phone app picks up new deploys instead of showing the old cached shell.

---

# Supertrend replaced by Volumatic VIDYA + MA Cross (9/21/50/200)

- `lib/indicators.ts`: `supertrend()` removed. New `vidya()` (CMO-adaptive VIDYA 10/20, SMA-15 smoothing, ATR(200) x 2 flip bands, buy/sell volume + delta % per trend leg) and `maCross()` (EMA 9/21/50/200, state + candles-since-cross for 9/21, 21/50, 50/200).
- `lib/signals.ts`: bucket vote = VIDYA direction + at least 2 of 3 confirmations (RSI, MACD, MA cross alignment; `MIN_CONFIRMATIONS`). Score budget stays 100: VIDYA maturity 10 + MA cross alignment 5 (was Supertrend maturity 15).
- Types/UI: `supertrend` field replaced by `vidya` and `maCross` on CoinSignal/BtcTrend; sidebar shows VIDYA, MA Cross and VIDYA volume delta; coin header shows VIDYA and MA Cross chips.
- The 1H confluence gate (EMA200, EMA stack, SMA50/200, MACD, Ribbon) is unchanged.

---

# What was actually wrong, and what changed

## Root causes found
1. **Not using Binance at all.** `/api/market` was pulling from CoinGecko (spot market, top 100 by market cap), not Binance Futures.
2. **No real Supertrend.** The "Supertrend" was actually EMA+RSI+slope voting on fake mini price windows — never an ATR-based Supertrend. That's why it looked frozen: it wasn't a real indicator to begin with.
3. **Fake timeframes.** CoinGecko only gives 7-day hourly data, but the code sliced it into tiny windows and labeled them "1M/3M/5M" as if they were 1-minute candles. Completely mislabeled.
4. **Silent fake data fallback.** If CoinGecko failed or rate-limited, the app quietly generated randomized synthetic prices and displayed them as if real (`live:false` flag existed but wasn't obvious in the UI).
5. **Broken repo structure** (in the *other* repo you first sent me) — files were flat when imports expected `app/`, `lib/`, `components/` folders. That repo would fail to build from a fresh clone.
6. **No trade-freeze / auto SL-TP.** This specific repo (`new-project-my`) didn't have the auto-close-on-SL/TP feature yet — I ported it over from your other repo, where it did already work correctly.

## What's fixed now
- **Real Binance USDT-M Futures data**: `lib/binance.ts` pulls the full list of live PERPETUAL/USDT contracts (250-300+, exceeds your "100+" ask) plus real 1H candles.
- **Real ATR-based Supertrend**: `lib/indicators.ts` implements the actual algorithm (period 10, multiplier 3) with proper band-flip logic — verified with a runtime test that it correctly flips direction when price action actually reverses.
- **Honest timeframes**: relabeled to `4H / 12H / 1D / 2D`, built by resampling real 1H candles (not fake slices).
- **No more fake data**: if Binance is unreachable, the UI now says so explicitly ("DATA UNAVAILABLE") instead of quietly showing synthetic numbers.
- **Trade freeze + live PnL**: entry/stop/target lock the moment you log a trade; only price and P&L update live every 15s (unchanged behavior, now fed by real Binance prices).
- **Rate-limit safe**: signal/Supertrend recompute is cached for 3 minutes (klines are heavy); price ticks refresh every 15s via one cheap bulk endpoint.
- **PWA / mobile install**: added `manifest.json`, a minimal service worker, and app icons so you can "Add to Home Screen" on iOS/Android and it opens like a native app.

## Honest limitation
"Accurate signals only" isn't something any system can promise — I tightened the confluence logic (Supertrend + RSI + MACD must agree, and 3-of-4 timeframes must align) so it should throw fewer, higher-quality signals, but losses will still happen. Treat the score as a filter, not a guarantee.
