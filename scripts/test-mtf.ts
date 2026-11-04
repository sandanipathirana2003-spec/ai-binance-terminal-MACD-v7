// Run: npx tsx scripts/test-mtf.ts
import type { Candle } from '../lib/binance'
import { resampleAligned } from '../lib/reversal'
import { analyzeMtf, MTF_TFS, MTF_MS, DEFAULT_MTF, normalizeMtfConfig, type MtfSignal, type MtfTf } from '../lib/mtf'
import { summarizePerformance } from '../lib/impulse5m'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
/** 1M candles: slow drift regime + waves on several scales + noise. */
function make1m(n: number, seed: number, drift: number): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 900000) * 900000
  for (let i = 0; i < n; i++) {
    const o = p
    const wave = 0.0016 * Math.cos((2 * Math.PI * i) / 45) + 0.0009 * Math.cos((2 * Math.PI * i) / 190) + 0.0007 * Math.cos((2 * Math.PI * i) / 700)
    p = Math.max(1, p * (1 + drift + wave * 0.12 + (r() - 0.5) * 0.0016))
    out.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) * (1 + r() * 0.0003), low: Math.min(o, p) * (1 - r() * 0.0003), close: p, volume: 100 + r() * 50 })
  }
  return out
}
const tfs = (m: Candle[]): Record<MtfTf, Candle[]> => ({ '1m': m, '3m': resampleAligned(m, 3), '5m': resampleAligned(m, 5), '15m': resampleAligned(m, 15) })

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

const all: MtfSignal[] = []
const cases: Array<[string, Candle[]]> = []
for (const seed of [1, 2, 3, 4, 5, 6]) {
  cases.push([`up s${seed}`, make1m(6000, seed, 0.00004)])
  cases.push([`down s${seed}`, make1m(6000, seed + 50, -0.00004)])
  cases.push([`flat s${seed}`, make1m(6000, seed + 90, 0)])
}
for (const strong of [false, true]) {
  const cfg = { level: strong ? 'STRONG' : 'FULL' } as const
  let n = 0
  const sigs: MtfSignal[] = []
  for (const [, m] of cases) {
    const a = analyzeMtf('T', tfs(m), cfg)
    if (a) { sigs.push(...a.signals); n++ }
  }
  console.log(`== level ${cfg.level}: ${sigs.length} signals over ${n} markets (${sigs.filter((s) => s.side === 'BUY').length} BUY / ${sigs.filter((s) => s.side === 'SELL').length} SELL)`)
  if (!strong) all.push(...sigs)
  const lbl = `[${cfg.level}]`
  ok(sigs.length > 0, `${lbl} produces signals`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.entry > s.ema.e200 && s.ema200Pos === 'ABOVE' : s.entry < s.ema.e200 && s.ema200Pos === 'BELOW')), `${lbl} EMA 200: no BUY below / SELL above`)
  const want = (s: MtfSignal) => (s.side === 'BUY' ? 'BUY' : 'SELL')
  ok(sigs.every((s) => MTF_TFS.every((t) => s.tfs[t].st === want(s) || (strong && MTF_TFS.filter((x) => s.tfs[x].st === want(s)).length >= 3))), `${lbl} Supertrend agreement at the signal (${strong ? '>= 3/4' : '4/4'})`)
  ok(sigs.every((s) => MTF_TFS.filter((t) => s.tfs[t].macd === want(s)).length >= (strong ? 3 : 4)), `${lbl} MACD direction agreement at the signal`)
  ok(sigs.every((s) => s.tfs['5m'].st === want(s) && s.tfs['5m'].macd === want(s)), `${lbl} 5M Supertrend and MACD agree with the side`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.macd.line > s.macd.signal && s.macd.hist > 0 : s.macd.line < s.macd.signal && s.macd.hist < 0)), `${lbl} MACD on the right side with supporting histogram`)
  ok(sigs.every((s) => (s.side === 'BUY' ? s.plan.sl < s.entry && s.plan.tp > s.entry : s.plan.sl > s.entry && s.plan.tp < s.entry) && Math.abs(s.plan.reward / s.plan.risk - DEFAULT_MTF.rr) < 1e-9 && s.plan.costR <= 0.5), `${lbl} SL/TP valid, reward = 2 x risk, fees <= 0.5R`)
}

// exactly one popup per setup: same-side signals are separated (min gap) and, per market, never on consecutive candles
{
  let bad = 0
  for (const [, m] of cases) {
    const a = analyzeMtf('T', tfs(m))
    if (!a) continue
    const by = [...a.signals].sort((x, y) => x.time - y.time)
    for (const side of ['BUY', 'SELL']) {
      const s = by.filter((x) => x.side === side)
      for (let i = 1; i < s.length; i++) if (s[i].time - s[i - 1].time < DEFAULT_MTF.minGapBars * MTF_MS['5m']) bad++
    }
    if (new Set(by.map((x) => x.id)).size !== by.length) bad++
  }
  ok(bad === 0, 'no duplicate alerts: unique ids and minimum gap between same-side signals')
}
// strict "agreement" mode is quieter than "cross" re-arming
{
  let a = 0, b = 0
  for (const [, m] of cases) {
    a += analyzeMtf('T', tfs(m), { rearm: 'cross' })?.signals.length ?? 0
    b += analyzeMtf('T', tfs(m), { rearm: 'agreement' })?.signals.length ?? 0
  }
  ok(b <= a, `re-arm on agreement-loss only gives no more signals than re-arm on opposite cross (${b} <= ${a})`)
}

// no repaint / look-ahead: prefix runs reproduce exactly the signals the full run shows up to that time
{
  const m = cases.find(([n]) => n === 'up s1')![1]
  const full = analyzeMtf('T', tfs(m))!.signals
  let cmp = 0, bad = 0
  for (const cut of [2400, 3000, 3600, 4200, 4800, 5400, 6000]) {
    const pre = analyzeMtf('T', tfs(m.slice(0, cut)))
    const T = m[cut - 1].openTime + 60000
    const exp = full.filter((s) => s.time <= T)
    cmp += exp.length
    const key = (s: MtfSignal) => `${s.id}|${s.entry.toFixed(8)}|${s.plan.sl.toFixed(8)}`
    const A = new Set((pre?.signals ?? []).map(key)), B = new Set(exp.map(key))
    if (A.size !== B.size || [...A].some((k) => !B.has(k))) bad++
  }
  ok(bad === 0 && cmp > 0, `no repaint / no look-ahead: prefix runs match the full run (${cmp} signals compared)`)
}

// agreement classification and percentages on live rows
{
  let good = true
  for (const [, m] of cases) {
    const a = analyzeMtf('T', tfs(m))
    if (!a) continue
    const g = a.row.agreement
    const mx = Math.max(g.bull, g.bear)
    if (Math.abs(g.pct - (mx / 4) * 100) > 1e-9) good = false
    if ((g.level === 'FULL') !== (mx === 4)) good = false
    if (g.level === 'FULL' && g.conflicting.length) good = false
    if (g.tradeable && g.level !== 'FULL') good = false // default config = FULL only
    if (a.row.signal && a.row.entry.status !== (a.row.signal.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL')) good = false
  }
  ok(good, 'agreement level / percentage / status are consistent on every market')
}
ok(normalizeMtfConfig({ rr: -4, level: 'x', stMult: 999 }).rr === 0.5 && normalizeMtfConfig({ level: 'x' }).level === 'FULL', 'config input is clamped')
{
  const mk = (r: number, res: 'WIN' | 'LOSS', t: number) => ({ side: 'BUY', time: t, outcome: { result: res, r, pnlPct: r, closedAt: t } }) as never
  const p = summarizePerformance([mk(1.9, 'WIN', 1), mk(-1.1, 'LOSS', 2)])
  ok(p.total === 2 && p.wins === 1, 'shared performance maths accepts MTF signals')
}
console.log(all.length ? `\n(sample FULL-level signals: ${all.length})` : '')
console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`)
process.exit(fails === 0 ? 0 : 1)
