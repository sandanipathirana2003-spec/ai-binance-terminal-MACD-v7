// Run: npx tsx scripts/test-impulse.ts            (add --dump out.json to export indicator series for an independent cross-check)
import type { Candle } from '../lib/binance'
import { analyzeImpulse, impulseMacd, regularMacd, supertrend, summarizePerformance, IMPULSE_TF_MS, DEFAULT_IMPULSE, normalizeConfig } from '../lib/impulse5m'
import { writeFileSync } from 'node:fs'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
/** Synthetic 5M market: slow drift + pullback waves + noise. */
function make(n: number, seed: number, drift: number, wave = 0.006, period = 70, noise = 0.0012): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  const t0 = Date.UTC(2026, 9, 1)
  for (let i = 0; i < n; i++) {
    const o = p
    p = Math.max(1, p * (1 + drift + (wave * Math.cos((2 * Math.PI * i) / period) * (2 * Math.PI)) / period + (r() - 0.5) * noise))
    out.push({ openTime: t0 + i * IMPULSE_TF_MS, open: o, high: Math.max(o, p) * (1 + r() * 0.0006), low: Math.min(o, p) * (1 - r() * 0.0006), close: p, volume: 100 + r() * 80 })
  }
  return out
}

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const markets: Array<[string, Candle[]]> = []
for (const seed of [11, 12, 13, 14, 15, 16]) {
  markets.push([`uptrend s${seed}`, make(1500, seed, 0.0001, 0.01, 60, 0.003)])
  markets.push([`downtrend s${seed}`, make(1500, seed + 100, -0.0001, 0.01, 60, 0.003)])
  markets.push([`choppy s${seed}`, make(1500, seed + 200, 0, 0.006, 25, 0.004)])
}
const all = []
for (const [name, c] of markets) {
  const a = analyzeImpulse('T', c)!
  const sigs = a.signals
  all.push(...sigs)
  console.log(`== ${name}: ${sigs.length} signals (${sigs.filter((s) => s.side === 'BUY').length} BUY / ${sigs.filter((s) => s.side === 'SELL').length} SELL) status=${a.row.status} market=${a.row.market.label}`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.ema200Pos === 'ABOVE' && s.entry > s.ema.e200 : s.ema200Pos === 'BELOW' && s.entry < s.ema.e200)), `${name}: no BUY below / SELL above EMA 200`)
  ok(sigs.every((s) => s.plan.costR <= 0.5 && s.plan.risk > 0), `${name}: every signal has a valid stop and fees <= 0.5R`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.plan.sl < s.entry && s.plan.tp > s.entry : s.plan.sl > s.entry && s.plan.tp < s.entry)), `${name}: SL/TP on the correct side of entry`)
  ok(sigs.every((s) => Math.abs(s.plan.reward / s.plan.risk - DEFAULT_IMPULSE.rr) < 1e-9), `${name}: reward = risk x ${DEFAULT_IMPULSE.rr}`)
  ok(sigs.every((s) => s.macd.hist !== 0 && (s.side === 'BUY' ? s.macd.line > s.macd.signal : s.macd.line < s.macd.signal)), `${name}: MACD on the right side of its signal at the close`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.impulse.extreme <= s.impulse.threshold : s.impulse.extreme >= s.impulse.threshold)), `${name}: setup really reached the extreme zone`)
  ok(sigs.every((s) => s.crossLagBars >= 0 && s.crossLagBars <= DEFAULT_IMPULSE.maxCrossWait), `${name}: MACD cross within ${DEFAULT_IMPULSE.maxCrossWait} bars after the impulse exit`)
  // one alert per setup: same side signals never on consecutive bars
  const byTime = [...sigs].sort((x, y) => x.time - y.time)
  ok(byTime.every((s, i) => i === 0 || s.side !== byTime[i - 1].side || s.time - byTime[i - 1].time >= 2 * IMPULSE_TF_MS), `${name}: no duplicate alerts on consecutive candles`)
}
ok(all.length >= 5 && all.some((s) => s.side === 'BUY') && all.some((s) => s.side === 'SELL'), `engine produces BUY and SELL signals on synthetic data (${all.length} total)`)

// Causality / no-repaint: running on a prefix must give exactly the signals the full run shows up to that bar.
{
  const c = markets[0][1]
  const full = analyzeImpulse('T', c)!.signals
  let mismatches = 0, checked = 0
  for (const cut of [600, 777, 900, 1100, 1300, 1450, 1500]) {
    const pre = analyzeImpulse('T', c.slice(0, cut))!.signals
    const lastT = c[cut - 1].openTime + IMPULSE_TF_MS
    const expect = full.filter((s) => s.time <= lastT)
    checked += expect.length
    const key = (s: { id: string; entry: number; plan: { sl: number } }) => `${s.id}|${s.entry.toFixed(8)}|${s.plan.sl.toFixed(8)}`
    const a = new Set(pre.map(key)), b = new Set(expect.map(key))
    if (a.size !== b.size || [...a].some((k) => !b.has(k))) mismatches++
  }
  ok(mismatches === 0, `no repaint / no look-ahead: prefix runs match the full run (${checked} signals compared)`)
}

// Config normalisation clamps junk input
{
  const n = normalizeConfig({ length: -5, lookback: 99999, rr: 'abc', slMethod: 'nope', upperPct: 50 })
  ok(n.length === 5 && n.lookback === 300 && n.rr === 2 && n.slMethod === 'supertrend' && n.upperPct === 70, 'config input is clamped to safe ranges')
}

// Ablation switches change behaviour
{
  const c = markets[0][1]
  const base = analyzeImpulse('T', c)!.signals.length
  const noEma = analyzeImpulse('T', c, { requireEma200: false })!.signals.length
  const noImp = analyzeImpulse('T', c, { requireImpulse: false })!.signals.length
  console.log(`   ablation on uptrend: full=${base} noEMA200=${noEma} noImpulse=${noImp}`)
  ok(noEma >= base, 'dropping the EMA 200 filter never removes signals')
}

// Performance maths on a hand-made list
{
  const mk = (r: number, res: 'WIN' | 'LOSS', t: number) => ({ side: 'BUY', time: t, outcome: { result: res, r, pnlPct: r, closedAt: t } }) as never
  const p = summarizePerformance([mk(1.9, 'WIN', 1), mk(-1.1, 'LOSS', 2), mk(-1.1, 'LOSS', 3), mk(1.9, 'WIN', 4)])
  ok(p.wins === 2 && p.losses === 2 && Math.abs(p.winRate - 50) < 1e-9 && Math.abs(p.totalR - 1.6) < 1e-9 && Math.abs(p.maxDrawdownR - 2.2) < 1e-9, 'performance: win rate, total R and max drawdown')
}

const di = process.argv.indexOf('--dump')
if (di > 0) {
  const c = markets[0][1].slice(0, 400)
  const imp = impulseMacd(c, 34, 9, 'close'), mc = regularMacd(c.map((x) => x.close), 12, 26, 9), st = supertrend(c, 12, 10)
  writeFileSync(process.argv[di + 1], JSON.stringify({ candles: c, imp, mc, st }))
  console.log('dumped', process.argv[di + 1])
}
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
