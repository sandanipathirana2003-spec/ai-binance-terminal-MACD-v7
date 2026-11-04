import type { Side, TradeOutcome } from './impulse5m'

/** Minimal shape needed for the performance maths (works for live replays and back-tests alike). */
export interface PerfSig {
  symbol: string
  side: Side
  trigger: string
  time: number
  outcome: TradeOutcome
}

export interface Bucket {
  key: string
  trades: number
  wins: number
  /** Net R after fees and slippage. */
  r: number
  /** Net price move in %, after fees and slippage, unleveraged. */
  pct: number
}

export interface PerfReport {
  total: number
  buys: number
  sells: number
  closed: number
  wins: number
  losses: number
  open: number
  winRate: number
  netR: number
  netPct: number
  avgWinR: number
  avgLossR: number
  avgWinPct: number
  avgLossPct: number
  /** Gross win R / gross loss R. null = no losing trades yet (infinite) or no trades. */
  profitFactor: number | null
  maxDrawdownR: number
  maxDrawdownPct: number
  tpHits: number
  slHits: number
  daily: Bucket[]
  weekly: Bucket[]
  monthly: Bucket[]
  byCoin: Bucket[]
  byTrigger: Bucket[]
}

const iso = (ms: number) => new Date(ms).toISOString()
const dayKey = (ms: number) => iso(ms).slice(0, 10)
const monthKey = (ms: number) => iso(ms).slice(0, 7)
/** Monday (UTC) of the week the timestamp falls in. */
function weekKey(ms: number): string {
  const d = new Date(ms)
  const dow = (d.getUTCDay() + 6) % 7
  return iso(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow))
    .slice(0, 10)
}

function group(closed: PerfSig[], keyOf: (s: PerfSig) => string): Bucket[] {
  const m = new Map<string, Bucket>()
  for (const s of closed) {
    const k = keyOf(s)
    const b = m.get(k) ?? { key: k, trades: 0, wins: 0, r: 0, pct: 0 }
    b.trades++
    if (s.outcome.result === 'WIN') b.wins++
    b.r += s.outcome.r
    b.pct += s.outcome.pnlPct
    m.set(k, b)
  }
  return [...m.values()]
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)

/** Aggregate signals. Open trades are counted as signals but left out of every win / loss / R statistic. */
export function buildPerfReport(signals: PerfSig[]): PerfReport {
  const all = [...signals].sort((a, b) => a.time - b.time)
  const closed = all.filter((s) => s.outcome.result !== 'OPEN')
  const wins = closed.filter((s) => s.outcome.result === 'WIN')
  const losses = closed.filter((s) => s.outcome.result === 'LOSS')
  const grossWin = wins.reduce((a, s) => a + s.outcome.r, 0)
  const grossLoss = Math.abs(losses.reduce((a, s) => a + s.outcome.r, 0))

  let cumR = 0
  let peakR = 0
  let ddR = 0
  let cumP = 0
  let peakP = 0
  let ddP = 0
  for (const s of [...closed].sort((a, b) => (a.outcome.closedAt ?? 0) - (b.outcome.closedAt ?? 0))) {
    cumR += s.outcome.r
    peakR = Math.max(peakR, cumR)
    ddR = Math.max(ddR, peakR - cumR)
    cumP += s.outcome.pnlPct
    peakP = Math.max(peakP, cumP)
    ddP = Math.max(ddP, peakP - cumP)
  }

  const byTime = (b: Bucket[]) => b.sort((x, y) => (x.key < y.key ? 1 : -1))
  const order = ['1m', '3m', '5m', '15m', '30m']
  return {
    total: all.length,
    buys: all.filter((s) => s.side === 'BUY').length,
    sells: all.filter((s) => s.side === 'SELL').length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    open: all.length - closed.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    netR: closed.reduce((a, s) => a + s.outcome.r, 0),
    netPct: closed.reduce((a, s) => a + s.outcome.pnlPct, 0),
    avgWinR: mean(wins.map((s) => s.outcome.r)),
    avgLossR: mean(losses.map((s) => s.outcome.r)),
    avgWinPct: mean(wins.map((s) => s.outcome.pnlPct)),
    avgLossPct: mean(losses.map((s) => s.outcome.pnlPct)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownR: ddR,
    maxDrawdownPct: ddP,
    tpHits: wins.length,
    slHits: losses.length,
    daily: byTime(group(closed, (s) => dayKey(s.time))),
    weekly: byTime(group(closed, (s) => weekKey(s.time))),
    monthly: byTime(group(closed, (s) => monthKey(s.time))),
    byCoin: group(closed, (s) => s.symbol).sort((x, y) => y.r - x.r),
    byTrigger: group(closed, (s) => s.trigger).sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key)),
  }
}
