// Run: npx tsx scripts/test-mareversal.ts
import type { Candle } from '../lib/binance'
import { resampleAligned } from '../lib/reversal'
import { buildMaRow, type MaRow } from '../lib/mareversal'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }
function make(n: number, endOpen: number, drift: (i: number) => number, seed = 1, noise = 0.0016): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  for (let i = 0; i < n; i++) {
    const o = p; p = Math.max(1, p * (1 + drift(i) + (r() - 0.5) * noise))
    out.push({ openTime: endOpen - (n - i) * 60000, open: o, high: Math.max(o, p) * 1.0003, low: Math.min(o, p) * 0.9997, close: p, volume: 100 + r() * 50 })
  }
  return out
}
function feed(all: Candle[], end: number) {
  const m = all.slice(0, end)
  return { oneMin: m.slice(-400), threeMin: resampleAligned(m, 3).slice(-300), fiveMin: resampleAligned(m, 5).slice(-300) }
}
function run(all: Candle[], from: number, to: number): MaRow[] {
  const rows: MaRow[] = []
  for (let end = from; end <= to; end++) {
    const r = buildMaRow({ symbol: 'T', price: all[end - 1].close, change24h: 0, ...feed(all, end), now: all[end - 1].openTime + 60000 })
    if (r) rows.push(r)
  }
  return rows
}
let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
const START = Date.UTC(2026, 9, 7, 0, 0)
const N = 1800, TURN = 1500

function trace(name: string, rows: MaRow[], from: number) {
  console.log('==', name); let prev = ''
  rows.forEach((r, k) => {
    const t = r.tfs['1m']; const key = r.signal + '|' + t.signal + '|' + t.stage
    if (key !== prev) { prev = key
      console.log(`  @${from + k - TURN >= 0 ? '+' : ''}${from + k - TURN}m main=${r.signal.padEnd(18)} 1M=${t.signal.padEnd(18)} S${t.stage} 3M=${r.tfs['3m'].signal} 5M=${r.tfs['5m'].signal} | 50${t.slopes.e50[0]} 200${t.slopes.e200[0]} ctx=${t.ctx ? t.ctx.e50 + '/' + t.ctx.e200 : '-'} | ${r.headline}`)
      if (t.signal !== 'WAIT') console.log(`        reason: ${t.reason}`) }
  })
}

// 1) V-reversal UP: long downtrend then sharp up-move
const up = make(N, START + N * 60000, (i) => (i < TURN ? -0.0006 : 0.0012), 5)
const R1 = run(up, 1400, 1700); trace('BULLISH V-reversal', R1, 1400)
ok(R1.some((r) => r.tfs['1m'].signal === 'EARLY BUY' || r.tfs['1m'].signal === 'STRONG EARLY BUY'), 'BUY: 1M EARLY/STRONG EARLY BUY appears')
const early1 = R1.find((r) => r.tfs['1m'].signal === 'EARLY BUY' || r.tfs['1m'].signal === 'STRONG EARLY BUY')!
ok(early1 && early1.tfs['1m'].ctx?.e50 !== 'FOLLOWING' && early1.tfs['1m'].ctx?.e200 !== 'FOLLOWING', 'BUY: early signal shown while 50 and 200 are NOT yet following (old trend / flattening)')
ok(early1 && early1.tfs['1m'].slopes.e200 !== 'RISING', 'BUY: EMA200 still not rising at the first early signal')
ok(R1.some((r) => r.tfs['1m'].signal === 'CONFIRMED BUY'), 'BUY: later upgrades to CONFIRMED BUY on 1M')
const iFirstEarly = R1.findIndex((r) => r.early)
ok(iFirstEarly >= 0 && R1[iFirstEarly].signal.includes('EARLY BUY') && /EARLY REVERSAL/.test(R1[iFirstEarly].headline), 'BUY: main status becomes EARLY BUY (not the old CONFIRMED SELL trend) with an EARLY REVERSAL headline')
ok(R1[iFirstEarly] && R1[iFirstEarly].rels['5m'] === 'COUNTER-TREND', 'BUY: 5M shown as COUNTER-TREND / old sell trend, early signal not rejected')
ok(!R1.slice(iFirstEarly).some((r) => r.signal === 'CONFIRMED SELL' && !r.established), 'BUY: no fresh CONFIRMED SELL after the turn')
const gaps = R1.slice(iFirstEarly, iFirstEarly + 40).filter((r) => r.signal === 'WAIT').length
ok(gaps === 0, `BUY: no WAIT gap while the reversal develops (${gaps} gap rows in the 40 candles after first early)`)

// 2) V-reversal DOWN (mirror)
const dn = make(N, START + N * 60000, (i) => (i < TURN ? 0.0006 : -0.0012), 6)
const R2 = run(dn, 1400, 1700); trace('BEARISH V-reversal', R2, 1400)
ok(R2.some((r) => r.tfs['1m'].signal === 'EARLY SELL' || r.tfs['1m'].signal === 'STRONG EARLY SELL'), 'SELL: 1M EARLY/STRONG EARLY SELL appears')
ok(R2.some((r) => r.tfs['1m'].signal === 'CONFIRMED SELL'), 'SELL: later upgrades to CONFIRMED SELL on 1M')

// 3) fake: downtrend, short bounce that rolls over again
const fake = make(N, START + N * 60000, (i) => (i < TURN ? -0.0006 : i < TURN + 9 ? 0.0014 : -0.0010), 9)
const R3 = run(fake, 1480, 1640); trace('FAKE bounce in a downtrend', R3, 1480)
ok(R3.some((r) => r.tfs['1m'].signal === 'POSSIBLE FAKE REVERSAL'), 'FAKE: POSSIBLE FAKE REVERSAL is shown')
ok(!R3.some((r) => r.tfs['1m'].signal === 'CONFIRMED BUY'), 'FAKE: never reaches CONFIRMED BUY')

// 4) steady uptrend: only an established-trend continuation, never an early signal, ranked low
const steady = make(N, START + N * 60000, () => 0.0005, 3)
const R4 = run(steady, 1700, 1800)
const last4 = R4[R4.length - 1]
ok(!R4.some((r) => r.early), 'STEADY: no early signals in a plain trend')
ok(last4.established && last4.score <= 10, `STEADY: continuation flagged established and ranked low (score ${last4.score}, ${last4.signal})`)

// 5) invariants over every row of every scenario: no signal from a cross alone
const all = [...R1, ...R2, ...R3, ...R4]
let bad = 0
for (const r of all) for (const tf of ['1m', '3m', '5m'] as const) {
  const t = r.tfs[tf]
  if (!/^(STRONG EARLY|EARLY|CONFIRMED)/.test(t.signal)) continue
  const bull = t.side === 'BUY'
  const vOk = bull ? t.vidya.state.includes('BULLISH') : t.vidya.state.includes('BEARISH')
  const priceOk = bull ? t.priceVs !== 'BELOW BOTH' : t.priceVs !== 'ABOVE BOTH'
  const s9 = t.stage === 4 || t.slopes.e9 === (bull ? 'RISING' : 'FALLING')
  if (!vOk || !priceOk || !s9) bad++
}
ok(bad === 0, `INVARIANT: every early/confirmed signal has VIDYA aligned + price beyond the MAs + EMA9 slope aligned (${all.length * 3} readings, ${bad} violations)`)
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
