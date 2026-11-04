// Run: npx tsx scripts/test-macd.ts
import type { Candle } from '../lib/binance'
import { resampleAligned } from '../lib/reversal'
import { analyzeMacd, buildMacdRow, DEFAULT_MACD, MACD_MS, MACD_TFS, RR, normalizeMacdConfig, type MacdSignal, type MacdTf } from '../lib/macdmtf'
import { buildPerfReport } from '../lib/macd-perf'
import { backtestSymbol, defaultVariants } from '../lib/macd-backtest'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
/** 1M candles: slow drift regime + waves on several scales + noise (aligned to a 30M boundary so every timeframe resamples cleanly). */
function make1m(n: number, seed: number, drift: number): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1_800_000) * 1_800_000
  for (let i = 0; i < n; i++) {
    const o = p
    const wave = 0.0016 * Math.cos((2 * Math.PI * i) / 45) + 0.0009 * Math.cos((2 * Math.PI * i) / 190) + 0.0007 * Math.cos((2 * Math.PI * i) / 700) + 0.0006 * Math.cos((2 * Math.PI * i) / 2400)
    p = Math.max(1, p * (1 + drift + wave * 0.12 + (r() - 0.5) * 0.0016))
    out.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) * (1 + r() * 0.0003), low: Math.min(o, p) * (1 - r() * 0.0003), close: p, volume: 100 + r() * 50 })
  }
  return out
}
const tfs = (m: Candle[]): Record<MacdTf, Candle[]> => ({ '1m': m, '3m': resampleAligned(m, 3), '5m': resampleAligned(m, 5), '15m': resampleAligned(m, 15), '30m': resampleAligned(m, 30) })

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const cases: Array<[string, Candle[]]> = []
for (const seed of [1, 2, 3, 4, 5, 6]) {
  cases.push([`up s${seed}`, make1m(9000, seed, 0.00004)])
  cases.push([`down s${seed}`, make1m(9000, seed + 50, -0.00004)])
  cases.push([`flat s${seed}`, make1m(9000, seed + 90, 0)])
}

// ---- default strategy (5M trigger, all five timeframes)
const sigs: MacdSignal[] = []
cases.forEach(([, m], k) => sigs.push(...(analyzeMacd(`T${k}`, tfs(m))?.signals ?? [])))
console.log(`== default: ${sigs.length} signals over ${cases.length} markets (${sigs.filter((s) => s.side === 'BUY').length} BUY / ${sigs.filter((s) => s.side === 'SELL').length} SELL)`)
ok(sigs.length >= 5 && sigs.some((s) => s.side === 'BUY') && sigs.some((s) => s.side === 'SELL'), 'produces BUY and SELL signals')
const want = (s: MacdSignal) => s.side
ok(sigs.every((s) => MACD_TFS.every((t) => s.tfs[t] === want(s))), 'MACD agreement: every one of the 5 timeframes is on the signal side at the signal close')
ok(sigs.every((s) => (s.side === 'BUY' ? s.macd.line > s.macd.signal && s.macd.hist > 0 : s.macd.line < s.macd.signal && s.macd.hist < 0)), '5M MACD line on the right side of its signal with a supporting histogram')
ok(sigs.every((s) => s.crossAge >= 0 && s.crossAge <= DEFAULT_MACD.maxCrossAge), `5M crossover is at most ${DEFAULT_MACD.maxCrossAge} bars old (never an old cross)`)
ok(sigs.every((s) => (s.side === 'BUY' ? s.entry > s.ema200.value && s.ema200.position === 'ABOVE' : s.entry < s.ema200.value && s.ema200.position === 'BELOW')), 'EMA 200: no BUY below / SELL above')
ok(sigs.every((s) => Math.abs(s.entry - s.ema200.value) > 0), 'price never exactly on EMA 200')
ok(sigs.every((s) => s.supertrend.dir === s.side), 'Supertrend 12,4 agrees with the side')
ok(sigs.every((s) => s.sl === s.supertrend.line), 'stop-loss is the 5M Supertrend line (no substitutes)')
ok(sigs.every((s) => (s.side === 'BUY' ? s.sl < s.entry && s.tp > s.entry : s.sl > s.entry && s.tp < s.entry)), 'SL and TP are on the correct side of the entry')
ok(sigs.every((s) => Math.abs(s.reward / s.risk - RR) < 1e-9 && Math.abs(Math.abs(s.tp - s.entry) - 2 * Math.abs(s.entry - s.sl)) < 1e-9), 'reward is exactly 2 x risk')
ok(sigs.every((s) => s.costR <= 0.5 && s.risk > 0 && s.riskPct > 0 && Math.abs(s.rewardPct / s.riskPct - 2) < 1e-9), 'risk % / reward % consistent, fees <= 0.5R')
ok(new Set(sigs.map((s) => s.id)).size === sigs.length, 'no duplicate signal ids')
{
  // one alert per crossover: the crossover time inside the id is unique per side per market
  let dup = 0
  for (const [, m] of cases) {
    const a = analyzeMacd('T', tfs(m))?.signals ?? []
    const keys = a.map((s) => `${s.side}|${s.id.split('-').pop()}`)
    if (new Set(keys).size !== keys.length) dup++
  }
  ok(dup === 0, 'exactly one signal per crossover')
}

// ---- selected-timeframe subset
{
  const sub = ['5m', '15m'] as MacdTf[]
  const out: MacdSignal[] = []
  for (const [, m] of cases) out.push(...(analyzeMacd('T', tfs(m), { tfs: sub })?.signals ?? []))
  ok(out.length > 0 && out.every((s) => s.selectedTfs.join() === '5m,15m' && s.tfs['5m'] === s.side && s.tfs['15m'] === s.side), `subset of timeframes (${sub.join(', ')}): only those must agree (${out.length} signals)`)
}

// ---- other trigger timeframes
for (const trig of ['3m', '15m'] as MacdTf[]) {
  const out: MacdSignal[] = []
  for (const [, m] of cases) out.push(...(analyzeMacd('T', tfs(m), { trigger: trig })?.signals ?? []))
  ok(out.length > 0 && out.every((s) => s.trigger === trig && s.time % MACD_MS[trig] === 0 && s.tfs[trig] === s.side), `trigger ${trig}: signals land on ${trig} candle closes (${out.length} signals)`)
}

// ---- no repaint / look-ahead
{
  const m = cases[0][1]
  const full = analyzeMacd('T', tfs(m))!.signals
  let cmp = 0, bad = 0
  for (const cut of [4000, 5000, 6000, 7000, 8000, 9000]) {
    const pre = analyzeMacd('T', tfs(m.slice(0, cut)))
    const T = m[cut - 1].openTime + 60000
    const exp = full.filter((s) => s.time <= T)
    cmp += exp.length
    const key = (s: MacdSignal) => `${s.id}|${s.entry.toFixed(8)}|${s.sl.toFixed(8)}|${s.time}`
    const A = new Set((pre?.signals ?? []).map(key)), B = new Set(exp.map(key))
    if (A.size !== B.size || [...A].some((k) => !B.has(k))) bad++
  }
  ok(bad === 0 && cmp > 0, `no repaint / no look-ahead: prefix runs match the full run (${cmp} signals compared)`)
}

// ---- live status consistency + which reasons are reachable
{
  let good = true
  const seen = new Map<string, number>()
  for (const [, m] of cases) {
    // evaluate the status at many points in time, as the live dashboard does
    for (const cut of [5200, 6100, 7000, 7900, 9000]) {
      const part = m.slice(0, cut)
      const row = buildMacdRow({ symbol: 'T', price: part[part.length - 1].close, change24h: 0, candles: tfs(part), now: part[part.length - 1].openTime + 60000 })
      if (!row) { good = false; continue }
      const st = row.status
      const key = st.state === 'CONFIRMED BUY' || st.state === 'CONFIRMED SELL' || st.state.startsWith('DEVELOPING') ? st.state : st.text.replace(/\d+/g, 'N').slice(0, 60)
      seen.set(key, (seen.get(key) ?? 0) + 1)
      if (row.signal && st.state !== (row.signal.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL')) good = false
      if (!row.signal && st.state.startsWith('CONFIRMED')) good = false
      if (row.agreement.side && row.agreement.disagreeing.length && row.agreement.overall === 'MIXED') good = false
      if (row.agreement.bull + row.agreement.bear > row.agreement.total) good = false
      if (row.ema200.buyValid && row.ema200.sellValid) good = false
      if (st.state === 'WAIT' && !st.text.startsWith('WAIT')) good = false
    }
  }
  ok(good, 'live status is consistent with signals, agreement counts and EMA 200 validity')
  console.log('   statuses seen:', [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}x ${k}`).join(' | '))
}

// ---- config clamping
{
  const c = normalizeMacdConfig({ fast: 40, slow: 3, stMult: 999, trigger: 'x', tfs: '1m,zz', maxCrossAge: -4 })
  ok(c.slow === 41 && c.stMult === 20 && c.trigger === '5m' && c.tfs.join() === '1m,5m' && c.maxCrossAge === 0, 'config input is clamped; trigger timeframe is always included')
}

// ---- performance maths (hand-made numbers)
{
  const mk = (sym: string, trig: string, t: number, r: number, res: 'WIN' | 'LOSS' | 'OPEN') => ({ symbol: sym, side: 'BUY' as const, trigger: trig, time: t, outcome: { result: res, r, pnlPct: r / 2, closedAt: t + 1 } })
  const d = Date.UTC(2026, 9, 5) // a Monday
  const p = buildPerfReport([mk('A', '5m', d, 1.9, 'WIN'), mk('A', '5m', d + 3600e3, -1.1, 'LOSS'), mk('B', '5m', d + 86400e3, -1.1, 'LOSS'), mk('B', '15m', d + 2 * 86400e3, 1.9, 'WIN'), mk('B', '15m', d + 3 * 86400e3, 0.5, 'OPEN')])
  ok(p.total === 5 && p.closed === 4 && p.open === 1 && p.wins === 2 && p.losses === 2 && p.tpHits === 2 && p.slHits === 2, 'performance: counts (open trades excluded from win/loss)')
  ok(Math.abs(p.winRate - 50) < 1e-9 && Math.abs(p.netR - 1.6) < 1e-9 && Math.abs(p.avgWinR - 1.9) < 1e-9 && Math.abs(p.avgLossR + 1.1) < 1e-9, 'performance: win rate, net R, average win / loss')
  ok(Math.abs((p.profitFactor ?? 0) - 3.8 / 2.2) < 1e-9, 'performance: profit factor = gross win / gross loss')
  ok(Math.abs(p.maxDrawdownR - 2.2) < 1e-9, 'performance: max drawdown (peak 0.8R -> trough -1.4R)')
  ok(p.daily.length === 3 && p.daily[0].key === '2026-10-07' && p.daily[2].trades === 2 && p.weekly.length === 1 && p.weekly[0].key === '2026-10-05' && p.monthly[0].key === '2026-10' && p.byCoin.length === 2 && p.byTrigger.map((b) => b.key).join() === '5m,15m', 'performance: daily / weekly / monthly / coin / timeframe groupings')
  ok(buildPerfReport([mk('A', '5m', d, 1.9, 'WIN')]).profitFactor === null, 'performance: no losses -> profit factor not computed (null)')
}

// ---- back-test runner (offline smoke test on synthetic data: proves the plumbing, says nothing about the strategy)
{
  const m = cases[0][1]
  const data = tfs(m)
  const res = backtestSymbol('T', data, {}, 0)
  ok(res.length === defaultVariants().length && res.every((r) => r.signals.every((s) => s.trigger === r.trigger)), 'back-test runner: every variant returns signals tagged with its trigger timeframe')
  const mtf5 = res.find((r) => r.trigger === '5m' && r.mtf)!, solo5 = res.find((r) => r.trigger === '5m' && !r.mtf)!
  ok(solo5.signals.length >= mtf5.signals.length, `trigger-only variant fires at least as often as the all-timeframe variant (${solo5.signals.length} >= ${mtf5.signals.length})`)
  const cut = m[6000].openTime
  ok(backtestSymbol('T', data, {}, cut).every((r) => r.signals.every((s) => s.time >= cut)), 'back-test window drops warm-up signals')
}

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
