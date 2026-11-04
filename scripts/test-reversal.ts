// Run: npx tsx scripts/test-reversal.ts
import type { Candle } from '../lib/binance'
import { buildReversalRow, resampleAligned, closedOnly } from '../lib/reversal'

function rng(seed: number) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296 }

/** n 1m candles ending right before `endOpen`; price follows `drift(i)` per minute plus noise. */
function make(n: number, endOpen: number, drift: (i: number) => number, seed = 1, vol?: (up: boolean, i: number) => number, noise = 0.0016): Candle[] {
  const r = rng(seed); const out: Candle[] = []; let p = 100
  for (let i = 0; i < n; i++) {
    const o = p; p = Math.max(1, p * (1 + drift(i) + (r() - 0.5) * noise))
    const hi = Math.max(o, p) * 1.0003, lo = Math.min(o, p) * 0.9997
    out.push({ openTime: endOpen - (n - i) * 60000, open: o, high: hi, low: lo, close: p, volume: vol ? vol(p >= o, i) : 100 + r() * 50 })
  }
  return out
}

/** What the API route would receive at this moment: native 400x1m / 300x3m / 300x5m (here built by exact epoch aggregation). */
function feed(all: Candle[], end: number) {
  const m = all.slice(0, end)
  return { oneMin: m.slice(-400), threeMin: resampleAligned(m, 3).slice(-300), fiveMin: resampleAligned(m, 5).slice(-300) }
}

let fails = 0
const ok = (c: boolean, m: string) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }

// 1) alignment: 3m/5m buckets start on real boundaries and are complete
const base = Date.UTC(2026, 9, 8, 10, 1) // 10:01 -> deliberately NOT on a 3/5 boundary
const raw = make(400, base + 400 * 60000, () => 0.0003)
const c3 = resampleAligned(raw, 3), c5 = resampleAligned(raw, 5)
ok(c3.every(c => c.openTime % 180000 === 0) && c5.every(c => c.openTime % 300000 === 0), 'resample is epoch-aligned')
ok(closedOnly(raw, raw[raw.length - 1].openTime + 30000).length === 399, 'forming candle is dropped')

// 2) SELL: long uptrend, then a sustained drop. Replay minute by minute and record every status change.
function replay(sign: 1 | -1) {
  const N = 1700, turnAt = 1500
  const start = Date.UTC(2026, 9, 7, 0, 0)
  const all = make(N, start + N * 60000, (i) => (i < turnAt ? sign * 0.0006 : -sign * 0.0011), sign === 1 ? 7 : 8)
  const seen: string[] = []; let prev = ''; const scores: Record<string, number> = {}
  for (let end = 1380; end <= N; end++) {
    const slice = all.slice(0, end)
    const now = slice[slice.length - 1].openTime + 60000 // candle `end-1` just closed
    const row = buildReversalRow({ symbol: 'TEST', price: slice[end - 1].close, change24h: 0, ...feed(all, end), now })
    if (!row) continue
    if (row.status !== prev) { seen.push(row.status); prev = row.status; scores[row.status] = row.score
      console.log(`  ${sign === 1 ? 'SELL' : 'BUY '} case @${end - turnAt >= 0 ? '+' : ''}${end - turnAt}m  ${row.status.padEnd(18)} score=${row.score} ${row.strength.padEnd(6)} | 1M ${row.tfs['1m'].state} 3M ${row.tfs['3m'].state} 5M ${row.tfs['5m'].state} | ${row.stage} | seq=${row.sequence?.order.join('>')}/${row.sequence?.kind}`) }
  }
  return { seen, scores }
}
const sell = replay(1)
const buy = replay(-1)
const firstIdx = (a: string[], re: RegExp) => a.findIndex(s => re.test(s))
ok(sell.seen.includes('EARLY SELL') || sell.seen.includes('SELL TRIGGER'), 'SELL: early/trigger stage reached')
ok(sell.seen.some(s => s === 'STRONG SELL'), 'SELL: reaches STRONG SELL')
ok(firstIdx(sell.seen, /EARLY SELL|SELL TRIGGER/) < firstIdx(sell.seen, /3M SELL CONFIRMED|5M SELL CONFIRMED|STRONG SELL/), 'SELL: 1M stage comes before higher-TF confirmation (lower-first)')
ok(!sell.seen.some(s => /BUY/.test(s)), 'SELL: no BUY statuses in a downside reversal')
ok(buy.seen.some(s => s === 'STRONG BUY'), 'BUY: mirror case reaches STRONG BUY')
ok(!buy.seen.some(s => /SELL/.test(s)), 'BUY: no SELL statuses in an upside reversal')

// 3) a pure steady trend must NOT produce a signal
const steady = make(1700, Date.UTC(2026, 9, 8, 12, 0), () => 0.0004, 3)
const rs = buildReversalRow({ symbol: 'T', price: 1, change24h: 0, ...feed(steady, 1700), now: steady[1699].openTime + 60000 })!
ok(rs.status === 'WAIT' && rs.score === 0, `steady uptrend stays WAIT (got ${rs.status}, ${rs.stage})`)
// 4) generic replay helper for the filter tests
function run(all: Candle[], from: number, to: number) {
  const rows = []
  for (let end = from; end <= to; end++) {
    const now = all[end - 1].openTime + 60000
    const row = buildReversalRow({ symbol: 'T', price: all[end - 1].close, change24h: 0, ...feed(all, end), now })
    if (row) rows.push(row)
  }
  return rows
}
const START = Date.UTC(2026, 9, 7, 0, 0)

// 4a) whipsaw: uptrend, 12-minute dip (1M flips down), then straight back up -> tagged FAILED, never a 3M/5M/STRONG SELL
const whip = make(1700, START + 1700 * 60000, (i) => (i < 1500 ? 0.0006 : i < 1512 ? -0.0011 : 0.0009), 11)
const wr = run(whip, 1380, 1620)
ok(wr.some((r) => r.failed?.side === 'SELL' && /^FAILED SELL REVERSAL/.test(r.stage)), 'whipsaw: FAILED SELL REVERSAL tag appears')
ok(!wr.some((r) => /3M SELL|5M SELL|STRONG SELL/.test(r.status)), 'whipsaw: never escalates to 3M/5M/STRONG SELL')
ok(wr[wr.length - 1].status === 'WAIT', 'whipsaw: ends back at WAIT')

// 4b) volume: same real sell-off but down-candles carry almost no volume -> TRIGGER / STRONG withheld
const quiet = make(1700, START + 1700 * 60000, (i) => (i < 1500 ? 0.0006 : -0.0011), 7, (up) => (up ? 500 : 20), 0.005)
const qr = run(quiet, 1380, 1700)
ok(qr.some((r) => r.side === 'SELL'), 'volume: reversal itself is still detected')
ok(!qr.some((r) => r.status === 'STRONG SELL'), 'volume: never STRONG SELL without volume support')
const normal = run(make(1700, START + 1700 * 60000, (i) => (i < 1500 ? 0.0006 : -0.0011), 7, undefined, 0.005), 1380, 1700)
ok(qr.filter((r) => r.status === 'SELL TRIGGER').length < normal.filter((r) => r.status === 'SELL TRIGGER').length, 'volume: far fewer TRIGGER rows than with normal volume')
ok(qr.some((r) => r.volume && !r.volume.ok), 'volume: row reports not confirming')

// 4c) chop: zig-zag market -> choppy flag set, and EARLY/TRIGGER suppressed whenever it is set
const zig = make(1700, START + 1700 * 60000, (i) => (i < 1400 ? 0.0004 : Math.floor((i - 1400) / 14) % 2 === 0 ? -0.0013 : 0.0013), 21)
const zr = run(zig, 1380, 1700)
ok(zr.some((r) => r.choppy), 'chop: choppy flag becomes true in a zig-zag market')
ok(!zr.some((r) => r.choppy && /EARLY|TRIGGER/.test(r.status)), 'chop: no EARLY/TRIGGER while choppy')
ok(!wr.some((r) => r.choppy) && !rs.choppy, 'chop: not flagged in whipsaw-free / steady cases')

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
