import type { Candle } from './binance'
import { atrSeries, emaSeries } from './indicators'
import { impulseMacd, regularMacd, supertrend, type Side, type SlMethod, type SlPlan, type Slope, type TradeOutcome } from './impulse5m'
import { closedOnly } from './reversal'

// ---------------------------------------------------------------------------
// MTF Supertrend + MACD early-entry engine.
//
//   1. Supertrend 12,10 AND regular MACD 12/26/9 agree on 1M, 3M, 5M and 15M   (multi-timeframe agreement)
//   2. the 5M MACD crosses in that direction                                    (the entry EVENT)
//   3. price is on the right side of the 5M EMA 200                             (validation)
//   4. the 5M candle closes with all of it intact -> exactly ONE confirmed BUY / SELL per setup.
//
// A Supertrend flip is never the trigger. Every signal is evaluated "as of" the 5M candle close: the other timeframes
// contribute only candles that had already closed by that moment, so nothing repaints and nothing looks ahead.
// Pure logic (no I/O).
// ---------------------------------------------------------------------------

export const MTF_TFS = ['1m', '3m', '5m', '15m'] as const
export type MtfTf = (typeof MTF_TFS)[number]
export const MTF_MS: Record<MtfTf, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000 }
export const MTF_LABEL: Record<MtfTf, string> = { '1m': '1M', '3m': '3M', '5m': '5M', '15m': '15M' }

const WARM = 40 // closed bars a timeframe needs before its Supertrend / MACD are trusted
const EMA_WARM = 210 // 5M bars before the EMA 200 is trusted
const SLOPE_BARS = 10
const SLOPE_FLAT = 0.004
/** Price closer to the EMA 200 than this (in ATR) is "unclear" -> EMA 200 CONFLICT — WAIT. */
const CLOSE_ATR = 0.25
const MAX_COST_R = 0.5

export type Agreement = 'FULL' | 'STRONG' | 'MIXED' | 'NONE'
export type Dir = 'BULLISH' | 'BEARISH' | 'MIXED'

export interface MtfConfig {
  stPeriod: number
  stMult: number
  macdFast: number
  macdSlow: number
  macdSignal: number
  /** FULL = all four timeframes must agree (default, highest quality). STRONG = at least 3 of 4 with none opposed. */
  level: 'FULL' | 'STRONG'
  /** After a signal the setup stays used until: 'cross' = the agreement is lost OR the 5M MACD crosses back; 'agreement' = only when the agreement is lost. */
  rearm: 'cross' | 'agreement'
  /** Minimum 5M bars between two signals of the same side. */
  minGapBars: number
  slMethod: SlMethod
  rr: number
  atrMult: number
  feeBps: number
  slipBps: number
  freshBars: number
}

export const DEFAULT_MTF: MtfConfig = {
  stPeriod: 12,
  stMult: 10,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  level: 'FULL',
  rearm: 'cross',
  minGapBars: 6,
  slMethod: 'supertrend',
  rr: 2,
  atrMult: 1.5,
  feeBps: 4,
  slipBps: 2,
  freshBars: 2,
}

const clamp = (v: number, lo: number, hi: number, fb: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)

export function normalizeMtfConfig(p: Partial<Record<keyof MtfConfig, unknown>> = {}): MtfConfig {
  const d = DEFAULT_MTF
  const num = (k: keyof MtfConfig, lo: number, hi: number) => clamp(Number(p[k] ?? d[k]), lo, hi, d[k] as number)
  return {
    stPeriod: Math.round(num('stPeriod', 2, 50)),
    stMult: num('stMult', 0.5, 20),
    macdFast: Math.round(num('macdFast', 2, 50)),
    macdSlow: Math.round(num('macdSlow', 5, 100)),
    macdSignal: Math.round(num('macdSignal', 2, 50)),
    level: p.level === 'STRONG' ? 'STRONG' : 'FULL',
    rearm: p.rearm === 'agreement' ? 'agreement' : 'cross',
    minGapBars: Math.round(num('minGapBars', 0, 100)),
    slMethod: p.slMethod === 'swing' || p.slMethod === 'atr' ? p.slMethod : 'supertrend',
    rr: num('rr', 0.5, 10),
    atrMult: num('atrMult', 0.5, 6),
    feeBps: num('feeBps', 0, 50),
    slipBps: num('slipBps', 0, 50),
    freshBars: Math.round(num('freshBars', 1, 12)),
  }
}

// --------------------------------------------------------------------------- types

export interface TfView {
  tf: MtfTf
  /** Close time (ms) of the latest closed candle of this timeframe. */
  barTime: number
  close: number
  st: { dir: 'BUY' | 'SELL'; line: number; distPct: number; flipBarsAgo: number | null }
  macd: {
    line: number
    signal: number
    hist: number
    dir: 'BUY' | 'SELL'
    /** Cross that happened ON this candle. */
    cross: 'BULLISH CROSS' | 'BEARISH CROSS' | null
    /** Bars since the most recent cross (0 = this candle), null if none in the last 60 bars. */
    crossBarsAgo: number | null
    momentum: 'STRENGTHENING' | 'WEAKENING'
    moving: 'UP' | 'DOWN' | 'FLAT'
    zero: 'ABOVE' | 'BELOW'
  }
  ema200: { value: number; position: 'ABOVE' | 'BELOW'; slope: Slope }
  overall: Dir
}

export interface MtfSignal {
  id: string
  symbol: string
  side: Side
  /** Close time (ms) of the 5M signal candle. */
  time: number
  barsAgo: number
  /** Signal price = close of the signal candle (not an executed fill). */
  entry: number
  plan: SlPlan
  ema: { e20: number; e50: number; e100: number; e200: number }
  ema200Pos: 'ABOVE' | 'BELOW'
  ribbon: RibbonStatus
  macd: { line: number; signal: number; hist: number }
  /** Per-timeframe Supertrend and MACD directions AS OF the signal candle close. */
  tfs: Record<MtfTf, { st: 'BUY' | 'SELL'; macd: 'BUY' | 'SELL' }>
  impulse: ImpulseView
  conditions: string[]
  outcome: TradeOutcome | null
}

export type RibbonStatus = 'BULLISH ALIGNMENT' | 'BEARISH ALIGNMENT' | 'MIXED'

export interface ImpulseView {
  hist: number
  signal: number
  upper: number
  lower: number
  state: 'OVERBOUGHT' | 'OVERSOLD' | 'BULLISH MOMENTUM' | 'BEARISH MOMENTUM'
  momentum: 'STRENGTHENING' | 'WEAKENING'
  /** Impulse histogram changed direction on this candle. */
  turn: 'UP' | 'DOWN' | null
}

export type EntryStatus =
  | 'WAITING FOR BULLISH CROSSOVER'
  | 'WAITING FOR BEARISH CROSSOVER'
  | 'MACD CROSSOVER DETECTED'
  | 'MACD CROSS DETECTED — EMA 200 INVALID'
  | 'EMA 200 CONFLICT — WAIT'
  | 'EMA 200 CONFIRMED'
  | 'CONFIRMED BUY'
  | 'CONFIRMED SELL'
  | 'SETUP ALREADY SIGNALLED — WAITING FOR NEW SETUP'
  | 'WAIT — NO VALID ENTRY'

export interface MtfRow {
  symbol: string
  price: number
  change24h: number
  tfs: Record<MtfTf, TfView>
  agreement: {
    bull: number
    bear: number
    /** Timeframes where Supertrend alone is bullish / bearish. */
    stBull: number
    stBear: number
    macdBull: number
    macdBear: number
    level: Agreement
    dominant: Dir
    /** Share of the four timeframes agreeing with the dominant direction (Supertrend + MACD both). */
    pct: number
    conflicting: MtfTf[]
    /** The side an entry would be taken on, only when the configured level is met. */
    tradeable: Side | null
    headline: string
    status: string
  }
  ema: { e20: number; e50: number; e100: number; e200: number }
  ribbon: { status: RibbonStatus; direction: Dir }
  ema200: {
    position: 'ABOVE' | 'BELOW'
    slope: Slope
    distPct: number
    distAtr: number
    buyValid: boolean
    sellValid: boolean
    note: string
  }
  impulse: ImpulseView
  entry: { status: EntryStatus; side: Side | null; armed: Record<Side, boolean> }
  signal: MtfSignal | null
  history: MtfSignal[]
  bars: number
}

// --------------------------------------------------------------------------- series per timeframe

interface TfSeries {
  tf: MtfTf
  c: Candle[]
  ms: number
  close: number[]
  stDir: number[]
  stLine: number[]
  ml: number[]
  sg: number[]
  hist: number[]
  e200: number[]
  atr: number[]
}

function buildSeries(tf: MtfTf, c: Candle[], cfg: MtfConfig): TfSeries {
  const close = c.map((x) => x.close)
  const st = supertrend(c, cfg.stPeriod, cfg.stMult)
  const m = regularMacd(close, cfg.macdFast, cfg.macdSlow, cfg.macdSignal)
  return { tf, c, ms: MTF_MS[tf], close, stDir: st.dir, stLine: st.line, ml: m.line, sg: m.signal, hist: m.hist, e200: emaSeries(close, 200), atr: atrSeries(c, 14) }
}

const atrAt = (s: TfSeries, i: number) => (Number.isFinite(s.atr[i]) && s.atr[i] > 0 ? s.atr[i] : s.close[i] * 0.001)

function slopeAt(s: TfSeries, i: number): Slope {
  if (i < SLOPE_BARS) return 'FLAT'
  const v = (s.e200[i] - s.e200[i - SLOPE_BARS]) / SLOPE_BARS / atrAt(s, i)
  return v > SLOPE_FLAT ? 'RISING' : v < -SLOPE_FLAT ? 'FALLING' : 'FLAT'
}

const macdDir = (s: TfSeries, i: number): 'BUY' | 'SELL' => (s.ml[i] > s.sg[i] ? 'BUY' : 'SELL')
const stDirAt = (s: TfSeries, i: number): 'BUY' | 'SELL' => (s.stDir[i] === 1 ? 'BUY' : 'SELL')
const crossAt = (s: TfSeries, i: number): 'BULLISH CROSS' | 'BEARISH CROSS' | null =>
  i < 1 ? null : s.ml[i] > s.sg[i] && s.ml[i - 1] <= s.sg[i - 1] ? 'BULLISH CROSS' : s.ml[i] < s.sg[i] && s.ml[i - 1] >= s.sg[i - 1] ? 'BEARISH CROSS' : null

function viewAt(s: TfSeries, i: number): TfView {
  const st = stDirAt(s, i)
  const md = macdDir(s, i)
  let crossBarsAgo: number | null = null
  for (let k = i; k > Math.max(0, i - 60); k--) {
    if (crossAt(s, k)) {
      crossBarsAgo = i - k
      break
    }
  }
  let flip: number | null = null
  for (let k = i; k > 0 && Number.isFinite(s.stLine[k - 1]); k--) {
    if (s.stDir[k] !== s.stDir[k - 1]) {
      flip = i - k
      break
    }
  }
  const dl = s.ml[i] - s.ml[i - 1]
  const overall: Dir = st === 'BUY' && md === 'BUY' ? 'BULLISH' : st === 'SELL' && md === 'SELL' ? 'BEARISH' : 'MIXED'
  return {
    tf: s.tf,
    barTime: s.c[i].openTime + s.ms,
    close: s.close[i],
    st: { dir: st, line: s.stLine[i], distPct: ((s.close[i] - s.stLine[i]) / s.close[i]) * 100, flipBarsAgo: flip },
    macd: {
      line: s.ml[i],
      signal: s.sg[i],
      hist: s.hist[i],
      dir: md,
      cross: crossAt(s, i),
      crossBarsAgo,
      momentum: Math.abs(s.hist[i]) > Math.abs(s.hist[i - 1]) ? 'STRENGTHENING' : 'WEAKENING',
      moving: dl > 0 ? 'UP' : dl < 0 ? 'DOWN' : 'FLAT',
      zero: s.ml[i] >= 0 ? 'ABOVE' : 'BELOW',
    },
    ema200: { value: s.e200[i], position: s.close[i] > s.e200[i] ? 'ABOVE' : 'BELOW', slope: slopeAt(s, i) },
    overall,
  }
}

/** Combine per-timeframe (Supertrend, MACD) directions into the agreement summary. */
function agree(st: Array<'BUY' | 'SELL'>, md: Array<'BUY' | 'SELL'>, level: 'FULL' | 'STRONG') {
  const overall = st.map((x, k): Dir => (x === 'BUY' && md[k] === 'BUY' ? 'BULLISH' : x === 'SELL' && md[k] === 'SELL' ? 'BEARISH' : 'MIXED'))
  const bull = overall.filter((o) => o === 'BULLISH').length
  const bear = overall.filter((o) => o === 'BEARISH').length
  const max = Math.max(bull, bear)
  const lvl: Agreement = max === 4 ? 'FULL' : max === 3 && Math.min(bull, bear) === 0 ? 'STRONG' : max >= 2 ? 'MIXED' : 'NONE'
  const dominant: Dir = bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'MIXED'
  const ok = level === 'FULL' ? lvl === 'FULL' : lvl === 'FULL' || lvl === 'STRONG'
  const tradeable: Side | null = ok ? (bull > bear ? 'BUY' : 'SELL') : null
  return { overall, bull, bear, lvl, dominant, tradeable, stBull: st.filter((x) => x === 'BUY').length, stBear: st.filter((x) => x === 'SELL').length, macdBull: md.filter((x) => x === 'BUY').length, macdBear: md.filter((x) => x === 'SELL').length }
}

function percentile(sorted: number[], p: number) {
  const pos = ((sorted.length - 1) * p) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

// --------------------------------------------------------------------------- analysis

export interface MtfAnalysis {
  signals: MtfSignal[]
  row: Omit<MtfRow, 'symbol' | 'price' | 'change24h' | 'history'>
}

export function analyzeMtf(symbol: string, input: Record<MtfTf, Candle[]>, cfgIn: Partial<MtfConfig> = {}): MtfAnalysis | null {
  const cfg = { ...DEFAULT_MTF, ...cfgIn }
  const S = {} as Record<MtfTf, TfSeries>
  for (const tf of MTF_TFS) {
    if (input[tf].length < WARM + 5) return null
    S[tf] = buildSeries(tf, input[tf], cfg)
  }
  const s5 = S['5m']
  const n = s5.c.length
  if (n < EMA_WARM + 20) return null
  const last = n - 1
  const close = s5.close
  const e20 = emaSeries(close, 20)
  const e50 = emaSeries(close, 50)
  const e100 = emaSeries(close, 100)
  const imp = impulseMacd(s5.c, 34, 9, 'close')

  const ribbonAt = (i: number): RibbonStatus =>
    e20[i] > e50[i] && e50[i] > e100[i] && e100[i] > s5.e200[i] ? 'BULLISH ALIGNMENT' : e20[i] < e50[i] && e50[i] < e100[i] && e100[i] < s5.e200[i] ? 'BEARISH ALIGNMENT' : 'MIXED'

  const impulseAt = (i: number): ImpulseView => {
    const h = imp.hist[i]
    const w = imp.hist.slice(Math.max(0, i - 199), i + 1).filter(Number.isFinite).sort((a, b) => a - b)
    const upper = w.length >= 30 ? percentile(w, 90) : NaN
    const lower = w.length >= 30 ? percentile(w, 10) : NaN
    const pv = imp.hist[i - 1]
    const pv2 = imp.hist[i - 2]
    return {
      hist: h,
      signal: imp.signal[i],
      upper,
      lower,
      state: h >= upper && upper > 0 ? 'OVERBOUGHT' : h <= lower && lower < 0 ? 'OVERSOLD' : h >= 0 ? 'BULLISH MOMENTUM' : 'BEARISH MOMENTUM',
      momentum: Math.abs(h) > Math.abs(pv) ? 'STRENGTHENING' : 'WEAKENING',
      turn: h > pv && pv <= pv2 ? 'UP' : h < pv && pv >= pv2 ? 'DOWN' : null,
    }
  }

  const buildPlan = (i: number, bull: boolean): SlPlan | null => {
    const entry = close[i]
    const a = atrAt(s5, i)
    const stLine = s5.stLine[i]
    const stOk = Number.isFinite(stLine) && (bull ? stLine < entry && s5.stDir[i] === 1 : stLine > entry && s5.stDir[i] === -1)
    let lo = Infinity
    let hi = -Infinity
    for (let k = Math.max(0, i - 9); k <= i; k++) {
      lo = Math.min(lo, s5.c[k].low)
      hi = Math.max(hi, s5.c[k].high)
    }
    const swing = bull ? lo - 0.1 * a : hi + 0.1 * a
    const cands: Array<[SlMethod, number, boolean]> = [
      ['supertrend', stLine, stOk],
      ['swing', swing, bull ? swing < entry : swing > entry],
      ['atr', bull ? entry - cfg.atrMult * a : entry + cfg.atrMult * a, true],
    ]
    const order: SlMethod[] = cfg.slMethod === 'supertrend' ? ['supertrend', 'swing', 'atr'] : cfg.slMethod === 'swing' ? ['swing', 'atr'] : ['atr']
    for (const m of order) {
      const c = cands.find((x) => x[0] === m)!
      if (!c[2]) continue
      const risk = bull ? entry - c[1] : c[1] - entry
      if (!(risk > 0)) continue
      const costR = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (entry / risk)
      if (costR > MAX_COST_R) continue
      const reward = risk * cfg.rr
      return { sl: c[1], tp: bull ? entry + reward : entry - reward, risk, reward, riskPct: (risk / entry) * 100, costR, method: m, fallback: m !== cfg.slMethod }
    }
    return null
  }

  const outcomeOf = (i: number, bull: boolean, plan: SlPlan): TradeOutcome => {
    const entry = close[i]
    for (let j = i + 1; j < n; j++) {
      const c = s5.c[j]
      const hitSl = bull ? c.low <= plan.sl : c.high >= plan.sl
      const hitTp = bull ? c.high >= plan.tp : c.low <= plan.tp
      if (hitSl || hitTp) {
        const r = (hitSl ? -1 : cfg.rr) - plan.costR // both in one candle: stop assumed first
        return { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * plan.risk) / entry) * 100, closedAt: c.openTime + MTF_MS['5m'] }
      }
    }
    const r = (bull ? close[last] - entry : entry - close[last]) / plan.risk - plan.costR
    return { result: 'OPEN', r, pnlPct: ((r * plan.risk) / entry) * 100, closedAt: null }
  }

  // ---- replay, one 5M closed candle at a time. Other timeframes contribute only candles closed by that moment.
  const ptr: Record<MtfTf, number> = { '1m': -1, '3m': -1, '5m': -1, '15m': -1 }
  const signals: MtfSignal[] = []
  const armed: Record<Side, boolean> = { BUY: true, SELL: true }
  const lastFire: Record<Side, number> = { BUY: -999, SELL: -999 }
  let invalid: { idx: number; kind: 'EMA 200 INVALID' | 'EMA 200 CONFLICT' | 'DETECTED'; side: Side } | null = null

  for (let i = 1; i < n; i++) {
    const T = s5.c[i].openTime + MTF_MS['5m']
    for (const tf of MTF_TFS) {
      const s = S[tf]
      while (ptr[tf] + 1 < s.c.length && s.c[ptr[tf] + 1].openTime + s.ms <= T) ptr[tf]++
    }
    if (i < EMA_WARM || MTF_TFS.some((tf) => ptr[tf] < WARM)) continue
    const st = MTF_TFS.map((tf) => stDirAt(S[tf], ptr[tf]))
    const md = MTF_TFS.map((tf) => macdDir(S[tf], ptr[tf]))
    const ag = agree(st, md, cfg.level)

    // re-arm rules
    for (const side of ['BUY', 'SELL'] as Side[]) {
      if (ag.tradeable !== side) armed[side] = true
    }
    const cr = crossAt(s5, i)
    if (cfg.rearm === 'cross') {
      if (cr === 'BEARISH CROSS') armed.BUY = true
      if (cr === 'BULLISH CROSS') armed.SELL = true
    }
    if (!cr || !ag.tradeable) continue
    const side = ag.tradeable
    const bull = side === 'BUY'
    if ((cr === 'BULLISH CROSS') !== bull) continue // the 5M cross must be in the agreed direction
    if (st[2] !== side) continue // the main 5M Supertrend must always support the trade, even in strong-majority mode
    if (!armed[side] || i - lastFire[side] < cfg.minGapBars) continue

    const a = atrAt(s5, i)
    const onSide = bull ? close[i] > s5.e200[i] : close[i] < s5.e200[i]
    if (!onSide) {
      invalid = { idx: i, kind: 'EMA 200 INVALID', side }
      continue
    }
    if (Math.abs(close[i] - s5.e200[i]) < CLOSE_ATR * a) {
      invalid = { idx: i, kind: 'EMA 200 CONFLICT', side }
      continue
    }
    const moving = bull ? s5.ml[i] > s5.ml[i - 1] : s5.ml[i] < s5.ml[i - 1]
    const histOk = bull ? s5.hist[i] > 0 && s5.hist[i] > s5.hist[i - 1] : s5.hist[i] < 0 && s5.hist[i] < s5.hist[i - 1]
    if (!moving || !histOk) continue
    const plan = buildPlan(i, bull)
    if (!plan) continue // no valid stop: reject, never force one

    const tfSnap = {} as MtfSignal['tfs']
    MTF_TFS.forEach((tf, k) => (tfSnap[tf] = { st: st[k], macd: md[k] }))
    signals.push({
      id: `${symbol}-${side}-${T}`,
      symbol,
      side,
      time: T,
      barsAgo: last - i,
      entry: close[i],
      plan,
      ema: { e20: e20[i], e50: e50[i], e100: e100[i], e200: s5.e200[i] },
      ema200Pos: bull ? 'ABOVE' : 'BELOW',
      ribbon: ribbonAt(i),
      macd: { line: s5.ml[i], signal: s5.sg[i], hist: s5.hist[i] },
      tfs: tfSnap,
      impulse: impulseAt(i),
      conditions: [
        `Supertrend 12,10 ${bull ? 'bullish' : 'bearish'} on 1M, 3M, 5M and 15M${cfg.level === 'STRONG' && ag.lvl !== 'FULL' ? ' (strong majority)' : ''}`,
        `MACD direction ${bull ? 'bullish' : 'bearish'} on all agreeing timeframes`,
        `5M MACD crossed ${bull ? 'above' : 'below'} its signal line (line ${bull ? 'rising' : 'falling'}, histogram ${bull ? 'positive' : 'negative'} and growing)`,
        `Price ${bull ? 'above' : 'below'} EMA 200`,
        '5M candle closed with the crossover confirmed',
      ],
      outcome: outcomeOf(i, bull, plan),
    })
    armed[side] = false
    lastFire[side] = i
  }

  // ---- live readout: each timeframe's own latest closed candle
  const views = {} as Record<MtfTf, TfView>
  for (const tf of MTF_TFS) views[tf] = viewAt(S[tf], S[tf].c.length - 1)
  const liveSt = MTF_TFS.map((tf) => views[tf].st.dir)
  const liveMd = MTF_TFS.map((tf) => views[tf].macd.dir)
  const ag = agree(liveSt, liveMd, cfg.level)
  const conflicting = MTF_TFS.filter((tf) => ag.dominant !== 'MIXED' && views[tf].overall !== ag.dominant)
  const pct = (Math.max(ag.bull, ag.bear) / 4) * 100
  const word = ag.dominant === 'BULLISH' ? 'BULLISH' : 'BEARISH'
  let headline = 'MTF TREND AGREEMENT: '
  headline += ag.dominant === 'MIXED' ? `${ag.bull}/4 BULLISH · ${ag.bear}/4 BEARISH` : `${Math.max(ag.bull, ag.bear)}/4 ${word}`
  const fresh = signals.filter((s) => s.barsAgo < cfg.freshBars).pop() ?? null
  const sideNow = ag.tradeable
  let status: string
  if (sideNow) status = `${sideNow === 'BUY' ? 'BULLISH' : 'BEARISH'} MTF AGREEMENT — WAITING FOR MACD CROSSOVER`
  else if (ag.lvl === 'STRONG') status = `STRONG MAJORITY ${word} — WAITING FOR FULL AGREEMENT (${conflicting.map((t) => MTF_LABEL[t]).join(', ')} not agreeing)`
  else if (ag.dominant === 'MIXED') status = 'WAIT — MTF CONFLICT (no dominant direction)'
  else status = `WAIT — MTF CONFLICT (${conflicting.map((t) => MTF_LABEL[t]).join(', ')} disagree${conflicting.length === 1 ? 's' : ''}; dominant ${word})`
  if (sideNow && ag.lvl === 'FULL') status = `${word} TREND ESTABLISHED — WAITING FOR MACD ENTRY`
  const a5 = atrAt(s5, last)
  const dist = close[last] - s5.e200[last]
  const tooClose = Math.abs(dist) < CLOSE_ATR * a5

  let entryStatus: EntryStatus = 'WAIT — NO VALID ENTRY'
  let entrySide: Side | null = null
  if (fresh) {
    entryStatus = fresh.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL'
    entrySide = fresh.side
  } else if (invalid && last - invalid.idx < cfg.freshBars) {
    entrySide = invalid.side
    entryStatus = invalid.kind === 'EMA 200 INVALID' ? 'MACD CROSS DETECTED — EMA 200 INVALID' : invalid.kind === 'EMA 200 CONFLICT' ? 'EMA 200 CONFLICT — WAIT' : 'MACD CROSSOVER DETECTED'
  } else if (sideNow) {
    entrySide = sideNow
    entryStatus = !armed[sideNow] ? 'SETUP ALREADY SIGNALLED — WAITING FOR NEW SETUP' : sideNow === 'BUY' ? 'WAITING FOR BULLISH CROSSOVER' : 'WAITING FOR BEARISH CROSSOVER'
  } else if (tooClose && ag.dominant !== 'MIXED') entryStatus = 'EMA 200 CONFLICT — WAIT'

  const ribbon = ribbonAt(last)
  const e200 = s5.e200[last]
  const slope = slopeAt(s5, last)
  const aboveNow = close[last] > e200
  return {
    signals: [...signals].reverse(),
    row: {
      tfs: views,
      agreement: {
        bull: ag.bull,
        bear: ag.bear,
        stBull: ag.stBull,
        stBear: ag.stBear,
        macdBull: ag.macdBull,
        macdBear: ag.macdBear,
        level: ag.lvl,
        dominant: ag.dominant,
        pct,
        conflicting,
        tradeable: sideNow,
        headline,
        status,
      },
      ema: { e20: e20[last], e50: e50[last], e100: e100[last], e200 },
      ribbon: { status: ribbon, direction: ribbon === 'BULLISH ALIGNMENT' ? 'BULLISH' : ribbon === 'BEARISH ALIGNMENT' ? 'BEARISH' : 'MIXED' },
      ema200: {
        position: aboveNow ? 'ABOVE' : 'BELOW',
        slope,
        distPct: (dist / e200) * 100,
        distAtr: Math.abs(dist) / a5,
        buyValid: aboveNow && !tooClose,
        sellValid: !aboveNow && !tooClose,
        note: tooClose ? 'EMA 200 CONFLICT — WAIT (price within 0.25 ATR of EMA 200)' : aboveNow ? 'Price above EMA 200: BUY side valid, SELL blocked' : 'Price below EMA 200: SELL side valid, BUY blocked',
      },
      impulse: impulseAt(last),
      entry: { status: entryStatus, side: entrySide, armed: { ...armed } },
      signal: fresh,
      bars: n,
    },
  }
}

export function buildMtfRow(input: {
  symbol: string
  price: number
  change24h: number
  candles: Record<MtfTf, Candle[]>
  now: number
  cfg?: Partial<MtfConfig>
}): MtfRow | null {
  const closed = {} as Record<MtfTf, Candle[]>
  for (const tf of MTF_TFS) closed[tf] = closedOnly(input.candles[tf], input.now, MTF_MS[tf])
  const a = analyzeMtf(input.symbol, closed, input.cfg)
  if (!a) return null
  return { symbol: input.symbol, price: input.price, change24h: input.change24h, ...a.row, history: a.signals.slice(0, 20) }
}
