import type { Candle } from './binance'
import { emaSeries, vidyaTrendSeries } from './indicators'
import type { MaRow } from './mareversal'

// ---------------------------------------------------------------------------
// Multi-timeframe VIDYA reversal engine (1M / 3M / 5M).
//
// Everything is computed from CLOSED candles only, so a reading never repaints.
// 1m / 3m / 5m are the exchange's own native klines (the API route fetches all three), so there is no
// resampling drift and ATR(200) has enough history on every timeframe.
// This is pure logic (no I/O) so it can be unit-tested with synthetic candles.
// ---------------------------------------------------------------------------

export const REV_VIDYA = { length: 14, momentum: 9, bandFactor: 1.5 } as const
export const REV_EMA = { fast: 9, slow: 21 } as const
export const REV_TFS = ['1m', '3m', '5m'] as const
export type RevTf = (typeof REV_TFS)[number]
export const REV_TF_LABEL: Record<RevTf, string> = { '1m': '1M', '3m': '3M', '5m': '5M' }
export const TF_MS: Record<RevTf, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000 }

/** A whole reversal progression must have STARTED within this window to still count as a live setup. */
export const REVERSAL_WINDOW_MS = 120 * 60_000
/** The 1M EMA cross may have happened up to this many 1m bars BEFORE the 1M VIDYA flip and still count as the trigger. */
const CROSS_LEAD_BARS = 3
/** A flip this recent (in that timeframe's own candles) is tagged NEW. */
export const FRESH_FLIP_BARS = 3
/** Minimum closed candles per timeframe: ATR(200) bands need >200 bars before a direction can be read at all. */
const MIN_BARS = 230
export const MAX_SCORE = 9

// --- fake-reversal filters ---
/** A flip that reverses again within this many candles of its OWN timeframe is a failed reversal (whipsaw). */
const FLIPBACK_BARS: Record<RevTf, number> = { '1m': 15, '3m': 8, '5m': 6 }
/** A failed reversal stays visible on the card this long. */
const FAILED_SHOW_MS = 30 * 60_000
/** 1M VIDYA flipping this many times inside CHOP_WINDOW_MS = choppy market: EARLY / TRIGGER are suppressed. */
const CHOP_FLIPS = 4
const CHOP_WINDOW_MS = 60 * 60_000
/** Volume since the 1M flip must lean at least this far (|buy-sell|/total, %) in the reversal direction. */
const VOL_MIN_DELTA_PCT = 5
/** ...and be measured over at least this many 1m candles (flip candle included), otherwise it is too noisy to trust. */
const VOL_MIN_BARS = 5

export type Dir = 'UP' | 'DOWN'
export type TfState = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'TURNING BULLISH' | 'TURNING BEARISH'
export type RevStatus =
  | 'WAIT'
  | 'EARLY BUY'
  | 'BUY TRIGGER'
  | '3M BUY CONFIRMED'
  | '5M BUY CONFIRMED'
  | 'STRONG BUY'
  | 'EARLY SELL'
  | 'SELL TRIGGER'
  | '3M SELL CONFIRMED'
  | '5M SELL CONFIRMED'
  | 'STRONG SELL'
export type StrengthLabel = 'NONE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'STRONG'
export type SequenceKind = 'LOWER_FIRST' | 'HIGHER_FIRST' | 'SIMULTANEOUS' | 'MIXED' | 'SINGLE'

export interface DirChange {
  /** null = the very first confirmed direction in the loaded candles (no real "previous"). */
  from: Dir | null
  to: Dir
  /** Close time (ms) of the candle on which the VIDYA flipped. */
  time: number
}

export interface TfReading {
  tf: RevTf
  state: TfState
  /** Confirmed VIDYA direction, null when no band flip has been confirmed in the window. */
  dir: Dir | null
  /** Direction before the last change (null if unknown). */
  prevDir: Dir | null
  change: DirChange | null
  /** Close time (ms) of the candle where the current direction began. */
  changedAt: number | null
  /** Candles of this timeframe since that change. */
  barsSince: number | null
  /** True when the direction was adopted at the first evaluable bar, so its real age is unknown (at least this old). */
  seeded: boolean
  fresh: boolean
  bars: number
  close: number
  vidya: number
}

export interface MaReading {
  ema9: number
  ema21: number
  state: 'BULL' | 'BEAR'
  cross: { type: 'BULL' | 'BEAR'; time: number } | null
}

export interface ReversalRow {
  symbol: string
  price: number
  change24h: number
  tfs: Record<RevTf, TfReading>
  ma: MaReading
  status: RevStatus
  /** Direction of the reversal being tracked, null when WAIT. */
  side: 'BUY' | 'SELL' | null
  /** Human line under the status: what is developing / what is still missing. */
  stage: string
  score: number
  strength: StrengthLabel
  scoreParts: string[]
  /** Order the timeframes flipped in (earliest first) for the tracked reversal. */
  sequence: { order: RevTf[]; kind: SequenceKind } | null
  /** Close time (ms) of the first flip of the tracked reversal. */
  startedAt: number | null
  /** Buy/sell volume balance since the 1M flip (close>open vs close<open candles); null when no reversal is tracked. */
  volume: { deltaPct: number; ok: boolean } | null
  /** 1M VIDYA has flipped too often recently, so EARLY / TRIGGER are suppressed. */
  choppy: boolean
  flips1m: number
  /** A recent reversal attempt that flipped straight back (the classic fake). */
  failed: { side: 'BUY' | 'SELL'; tf: RevTf; time: number; bars: number } | null
  /** Early-reversal bucket: EARLY / TRIGGER statuses, or a timeframe turning while still WAIT. */
  early: boolean
}

export interface ReversalResponse {
  rows: ReversalRow[]
  /** EMA 9/21/50/200 + VIDYA reversal rows (same candles, computed in the same pass). */
  maRows: MaRow[]
  computedAt: number
  live: boolean
  params: { vidyaLength: number; vidyaMomentum: number; bandDistance: number; emaFast: number; emaSlow: number; windowMin: number }
  error?: string
}

// --------------------------------------------------------------------------- candles

/** Drop the still-forming candle(s) so every reading is on closed bars. `ms` = the timeframe length. */
export function closedOnly(candles: Candle[], now: number, ms = 60_000): Candle[] {
  let end = candles.length
  while (end > 0 && candles[end - 1].openTime + ms > now) end--
  return candles.slice(0, end)
}

/** Epoch-aligned aggregation of 1m candles (complete buckets only). Not used live — handy for tests and as a fallback. */
export function resampleAligned(c1: Candle[], factor: number): Candle[] {
  if (factor === 1) return c1
  const span = factor * 60_000
  const out: Candle[] = []
  let cur: Candle[] = []
  let curKey = -1
  const flush = () => {
    if (cur.length !== factor) return
    out.push({
      openTime: cur[0].openTime,
      open: cur[0].open,
      high: Math.max(...cur.map((c) => c.high)),
      low: Math.min(...cur.map((c) => c.low)),
      close: cur[cur.length - 1].close,
      volume: cur.reduce((s, c) => s + c.volume, 0),
    })
  }
  for (const c of c1) {
    const key = Math.floor(c.openTime / span) * span
    if (key !== curKey) {
      flush()
      cur = []
      curKey = key
    }
    cur.push(c)
  }
  flush()
  return out
}

// --------------------------------------------------------------------------- per-timeframe VIDYA

interface TfSeries {
  tf: RevTf
  candles: Candle[]
  dirs: (Dir | null)[]
  line: number[]
  flips: DirChange[]
}

function buildTf(tf: RevTf, candles: Candle[]): TfSeries | null {
  const t = vidyaTrendSeries(candles, {
    length: REV_VIDYA.length,
    momentum: REV_VIDYA.momentum,
    bandFactor: REV_VIDYA.bandFactor,
    seed: true,
  })
  if (!t) return null
  const ms = TF_MS[tf]
  const dirs: (Dir | null)[] = t.up.map((u) => (u === null ? null : u ? 'UP' : 'DOWN'))
  const flips: DirChange[] = []
  let prev: Dir | null = null
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i]
    if (d !== null && d !== prev) {
      flips.push({ from: prev, to: d, time: candles[i].openTime + ms })
      prev = d
    }
  }
  return { tf, candles, dirs, line: t.line, flips }
}

/** Direction in force at time `t` (the last flip at or before it). */
function dirAt(s: TfSeries, t: number): Dir | null {
  let d: Dir | null = null
  for (const f of s.flips) {
    if (f.time <= t) d = f.to
    else break
  }
  return d
}

function readTf(tf: RevTf, s: TfSeries | null): TfReading {
  if (!s) {
    return { tf, state: 'NEUTRAL', dir: null, prevDir: null, change: null, changedAt: null, barsSince: null, seeded: false, fresh: false, bars: 0, close: 0, vidya: 0 }
  }
  const n = s.candles.length
  const last = n - 1
  const dir = s.dirs[last]
  const change = s.flips.length ? s.flips[s.flips.length - 1] : null
  const close = s.candles[last].close
  const line = s.line[last]
  const lineRising = last > 0 && s.line[last] > s.line[last - 1]
  const lineFalling = last > 0 && s.line[last] < s.line[last - 1]

  let state: TfState = 'NEUTRAL'
  if (dir === 'UP') state = close < line && lineFalling ? 'TURNING BEARISH' : 'BULLISH'
  else if (dir === 'DOWN') state = close > line && lineRising ? 'TURNING BULLISH' : 'BEARISH'

  const barsSince = change ? Math.round((s.candles[last].openTime + TF_MS[tf] - change.time) / TF_MS[tf]) : null
  return {
    tf,
    state,
    dir,
    prevDir: change ? change.from : null,
    change,
    changedAt: change ? change.time : null,
    barsSince,
    seeded: change !== null && change.from === null,
    fresh: barsSince !== null && barsSince <= FRESH_FLIP_BARS && !(change !== null && change.from === null),
    bars: n,
    close,
    vidya: line,
  }
}

// --------------------------------------------------------------------------- 1M EMA 9/21

function readMa(c1: Candle[]): MaReading {
  const cl = c1.map((c) => c.close)
  const f = emaSeries(cl, REV_EMA.fast)
  const s = emaSeries(cl, REV_EMA.slow)
  const n = cl.length
  let cross: MaReading['cross'] = null
  // Start after the slow EMA warm-up so the artificial first-bar "cross" is ignored.
  for (let i = n - 1; i > REV_EMA.slow; i--) {
    const nowBull = f[i] > s[i]
    const prevBull = f[i - 1] > s[i - 1]
    if (nowBull !== prevBull) {
      cross = { type: nowBull ? 'BULL' : 'BEAR', time: c1[i].openTime + 60_000 }
      break
    }
  }
  return { ema9: f[n - 1], ema21: s[n - 1], state: f[n - 1] > s[n - 1] ? 'BULL' : 'BEAR', cross }
}

function crossAligned(ma: MaReading, target: Dir, ref: number): boolean {
  const want = target === 'DOWN' ? 'BEAR' : 'BULL'
  return ma.state === want && ma.cross !== null && ma.cross.type === want && ma.cross.time >= ref - CROSS_LEAD_BARS * 60_000
}

// --------------------------------------------------------------------------- fake-reversal filters

/** Buy/sell volume balance on 1m candles from `fromOpen` on, judged against the reversal direction. */
function volumeSince(c1: Candle[], fromOpen: number, target: Dir): { deltaPct: number; ok: boolean } {
  let buy = 0
  let sell = 0
  let bars = 0
  for (const c of c1) {
    if (c.openTime < fromOpen) continue
    bars++
    if (c.close > c.open) buy += c.volume
    else if (c.close < c.open) sell += c.volume
  }
  const total = buy + sell
  const deltaPct = total > 0 ? ((buy - sell) / total) * 100 : 0
  const lean = target === 'DOWN' ? deltaPct <= -VOL_MIN_DELTA_PCT : deltaPct >= VOL_MIN_DELTA_PCT
  const ok = bars >= VOL_MIN_BARS && lean
  return { deltaPct, ok }
}

function chopCount(s: TfSeries | null, now: number): number {
  if (!s) return 0
  return s.flips.filter((f) => f.from !== null && now - f.time <= CHOP_WINDOW_MS).length
}

/** Most recent flip that reversed again within FLIPBACK_BARS candles. */
function findFailed(series: Record<RevTf, TfSeries | null>, now: number): ReversalRow['failed'] {
  let best: ReversalRow['failed'] = null
  for (const tf of REV_TFS) {
    const s = series[tf]
    if (!s || s.flips.length < 2) continue
    const a = s.flips[s.flips.length - 2]
    const b = s.flips[s.flips.length - 1]
    if (a.from === null || b.to !== a.from || now - b.time > FAILED_SHOW_MS) continue
    const bars = Math.round((b.time - a.time) / TF_MS[tf])
    if (bars > FLIPBACK_BARS[tf]) continue
    if (!best || b.time > best.time) best = { side: a.to === 'DOWN' ? 'SELL' : 'BUY', tf, time: b.time, bars }
  }
  return best
}

// --------------------------------------------------------------------------- reversal cycle

interface Member {
  tf: RevTf
  time: number
}

const NAMES = {
  DOWN: { side: 'SELL', early: 'EARLY SELL', trigger: 'SELL TRIGGER', c3: '3M SELL CONFIRMED', c5: '5M SELL CONFIRMED', strong: 'STRONG SELL', turning: 'TURNING BEARISH' },
  UP: { side: 'BUY', early: 'EARLY BUY', trigger: 'BUY TRIGGER', c3: '3M BUY CONFIRMED', c5: '5M BUY CONFIRMED', strong: 'STRONG BUY', turning: 'TURNING BULLISH' },
} as const

interface Evaluation {
  status: RevStatus
  side: 'BUY' | 'SELL' | null
  stage: string
  score: number
  parts: string[]
  members: Member[]
  start: number
  kind: SequenceKind
  vol: { deltaPct: number; ok: boolean }
}

function sequenceKind(members: Member[]): SequenceKind {
  if (members.length < 2) return 'SINGLE'
  if (members.every((m) => m.time === members[0].time)) return 'SIMULTANEOUS'
  const order = members.map((m) => REV_TFS.indexOf(m.tf))
  const asc = order.every((v, i) => i === 0 || v > order[i - 1])
  const desc = order.every((v, i) => i === 0 || v < order[i - 1])
  return asc ? 'LOWER_FIRST' : desc ? 'HIGHER_FIRST' : 'MIXED'
}

/**
 * Looks for a CLEAN reversal toward `target`: every timeframe was on the opposite side just before the first
 * flip, and the timeframes that have since flipped did so within REVERSAL_WINDOW_MS.
 * A single timeframe wobbling while the others disagree never produces a signal (see precondition).
 */
function evaluate(
  target: Dir,
  series: Record<RevTf, TfSeries | null>,
  readings: Record<RevTf, TfReading>,
  ma: MaReading,
  c1: Candle[],
  choppy: boolean,
  now: number,
): Evaluation | null {
  const opp: Dir = target === 'UP' ? 'DOWN' : 'UP'
  const nm = NAMES[target]

  const members: Member[] = []
  for (const tf of REV_TFS) {
    const s = series[tf]
    const f = s && s.flips.length ? s.flips[s.flips.length - 1] : null
    if (f && f.to === target && f.from === opp && now - f.time <= REVERSAL_WINDOW_MS) members.push({ tf, time: f.time })
  }
  if (members.length === 0) return null

  const start = Math.min(...members.map((m) => m.time))
  // Initial state: ALL three timeframes were on the opposite side just before the reversal began.
  for (const tf of REV_TFS) {
    const s = series[tf]
    if (!s || dirAt(s, start - 1) !== opp) return null
  }

  members.sort((a, b) => a.time - b.time || REV_TFS.indexOf(a.tf) - REV_TFS.indexOf(b.tf))
  const has = (tf: RevTf) => members.some((m) => m.tf === tf)
  const m1 = has('1m')
  const m3 = has('3m')
  const m5 = has('5m')
  const flip1m = members.find((m) => m.tf === '1m')?.time ?? start
  const crossOk = crossAligned(ma, target, flip1m)
  // Volume must lean the reversal's way since the 1M flip, otherwise TRIGGER / STRONG are withheld.
  const vol = volumeSince(c1, flip1m - 60_000, target)
  const trigger = m1 && crossOk && vol.ok
  const kind = sequenceKind(members)
  const turning = (tf: RevTf) => readings[tf].state === nm.turning

  // Score: 1M VIDYA +1, 1M EMA cross +1, 3M +2, 5M +3, then agreement bonuses.
  const parts: string[] = []
  let score = 0
  if (m1) { score += 1; parts.push('1M VIDYA reversal +1') }
  if (crossOk) { score += 1; parts.push('1M EMA 9/21 cross +1') }
  if (m3) { score += 2; parts.push('3M VIDYA reversal +2') }
  if (m5) { score += 3; parts.push('5M VIDYA reversal +3') }
  if (members.length >= 2) { score += 1; parts.push('2+ timeframes agree +1') }
  if (members.length === 3) { score += 1; parts.push('All 3 agree +1') }

  // What is still missing, in ladder order 3M -> 5M -> 1M entry -> EMA cross.
  const nextStep = (): string => {
    if (!m3) return turning('3m') ? '3M REVERSAL DEVELOPING' : 'AWAITING 3M CONFIRMATION'
    if (!m5) return turning('5m') ? '5M REVERSAL DEVELOPING' : 'AWAITING 5M CONFIRMATION'
    if (!m1) return turning('1m') ? '1M ENTRY DEVELOPING' : 'AWAITING 1M ENTRY'
    return crossOk && !vol.ok ? 'EMA CROSSED · VOLUME NOT CONFIRMING YET' : 'AWAITING 1M EMA 9/21 CROSS'
  }

  let status: RevStatus
  let side: 'BUY' | 'SELL' | null = nm.side
  let stage: string

  if (members.length === 1 && !m1) {
    // Only a higher timeframe flipped: not enough on its own.
    status = 'WAIT'
    side = null
    score = 0
    parts.length = 0
    stage = `${m3 ? '3M' : '5M'} FLIPPED ${target === 'DOWN' ? 'BEARISH' : 'BULLISH'} · AWAITING OTHER TIMEFRAMES`
  } else if (m1 && m3 && m5 && trigger) {
    status = nm.strong
    stage = `STRONG ${nm.side} REVERSAL`
  } else if (m5) {
    status = nm.c5
    stage = m1 && m3 ? nextStep() : !m1 ? '1M NOT ALIGNED · WAIT FOR ENTRY' : nextStep()
  } else if (m3) {
    status = nm.c3
    stage = nextStep()
  } else {
    status = trigger ? nm.trigger : nm.early
    stage = nextStep()
    if (crossOk && !vol.ok && m1) stage = 'EMA CROSSED · VOLUME NOT CONFIRMING YET'
    // Chop filter: a 1M-only setup in a whipsawing market is exactly where fake reversals live.
    if (choppy) {
      status = 'WAIT'
      side = null
      score = 0
      parts.length = 0
      stage = '1M CHOPPY · EARLY SIGNALS SUPPRESSED'
    }
  }

  return { status, side, stage, score, parts, members, start, kind, vol }
}

// --------------------------------------------------------------------------- public API

function strengthLabel(score: number, status: RevStatus): StrengthLabel {
  if (score <= 0) return 'NONE'
  if (score <= 2) return 'LOW'
  if (score <= 4) return 'MEDIUM'
  if (score <= 7) return 'HIGH'
  // STRONG is reserved for the full ladder (all 3 timeframes + the 1M EMA trigger).
  return status === 'STRONG BUY' || status === 'STRONG SELL' ? 'STRONG' : 'HIGH'
}

function idleStage(readings: Record<RevTf, TfReading>): { text: string; turning: boolean } {
  const turning = REV_TFS.filter((tf) => readings[tf].state === 'TURNING BULLISH' || readings[tf].state === 'TURNING BEARISH')
  if (turning.length) {
    const text = turning.map((tf) => `${REV_TF_LABEL[tf]} ${readings[tf].state}`).join(' · ')
    return { text: `${text} · NOT A SIGNAL YET`, turning: true }
  }
  const dirs = REV_TFS.map((tf) => readings[tf].dir)
  if (dirs.every((d) => d === 'UP')) return { text: 'TREND ALIGNED BULLISH · NO FRESH REVERSAL', turning: false }
  if (dirs.every((d) => d === 'DOWN')) return { text: 'TREND ALIGNED BEARISH · NO FRESH REVERSAL', turning: false }
  if (dirs.some((d) => d === null)) return { text: 'NO CONFIRMED VIDYA TREND YET', turning: false }
  return { text: 'MIXED TIMEFRAMES · NO CLEAN REVERSAL', turning: false }
}

export function buildReversalRow(input: {
  symbol: string
  price: number
  change24h: number
  /** Native Binance klines, oldest -> newest. The still-forming candle is dropped here. */
  oneMin: Candle[]
  threeMin: Candle[]
  fiveMin: Candle[]
  now: number
}): ReversalRow | null {
  const c1 = closedOnly(input.oneMin, input.now, TF_MS['1m'])
  const c3 = closedOnly(input.threeMin, input.now, TF_MS['3m'])
  const c5 = closedOnly(input.fiveMin, input.now, TF_MS['5m'])
  if (c1.length < MIN_BARS || c3.length < MIN_BARS || c5.length < MIN_BARS) return null

  const series: Record<RevTf, TfSeries | null> = {
    '1m': buildTf('1m', c1),
    '3m': buildTf('3m', c3),
    '5m': buildTf('5m', c5),
  }
  const tfs: Record<RevTf, TfReading> = {
    '1m': readTf('1m', series['1m']),
    '3m': readTf('3m', series['3m']),
    '5m': readTf('5m', series['5m']),
  }
  const ma = readMa(c1)
  const flips1m = chopCount(series['1m'], input.now)
  const choppy = flips1m >= CHOP_FLIPS

  const evals = (['DOWN', 'UP'] as const)
    .map((t) => evaluate(t, series, tfs, ma, c1, choppy, input.now))
    .filter((e): e is Evaluation => e !== null)
  // Prefer a real signal over a parked WAIT, then the higher score, then the newer start.
  evals.sort((a, b) => Number(b.status !== 'WAIT') - Number(a.status !== 'WAIT') || b.score - a.score || b.start - a.start)
  const best = evals[0] ?? null

  let row: Pick<ReversalRow, 'status' | 'side' | 'stage' | 'score' | 'scoreParts' | 'sequence' | 'startedAt' | 'early' | 'volume'>
  if (best) {
    const idle = best.status === 'WAIT' ? idleStage(tfs) : null
    row = {
      status: best.status,
      side: best.side,
      stage: best.stage,
      score: best.score,
      scoreParts: best.parts,
      sequence: best.members.length >= 1 && best.status !== 'WAIT' ? { order: best.members.map((m) => m.tf), kind: best.kind } : null,
      startedAt: best.status !== 'WAIT' ? best.start : null,
      early: best.status !== 'WAIT' ? /EARLY|TRIGGER/.test(best.status) : Boolean(idle?.turning),
      volume: best.vol,
    }
  } else {
    const idle = idleStage(tfs)
    row = { status: 'WAIT', side: null, stage: idle.text, score: 0, scoreParts: [], sequence: null, startedAt: null, early: idle.turning, volume: null }
  }

  // Fake-reversal tag: nothing valid is running, but an attempt just flipped straight back.
  const failed = findFailed(series, input.now)
  if (row.status === 'WAIT' && failed && !row.stage.startsWith('1M CHOPPY')) {
    row.stage = `FAILED ${failed.side} REVERSAL · ${REV_TF_LABEL[failed.tf]} FLIPPED BACK AFTER ${failed.bars} CANDLE${failed.bars === 1 ? '' : 'S'}`
    row.early = false
  }

  return {
    symbol: input.symbol,
    price: input.price,
    change24h: input.change24h,
    tfs,
    ma,
    ...row,
    choppy,
    flips1m,
    failed,
    strength: strengthLabel(row.score, row.status),
  }
}
