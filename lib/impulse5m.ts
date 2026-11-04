import type { Candle } from './binance'
import { atrSeries, emaSeries } from './indicators'
import { closedOnly } from './reversal'

// ---------------------------------------------------------------------------
// 5M Impulse MACD reversal engine.
//
//   EMA 200 direction filter  ->  Impulse MACD (LazyBear) enters an extreme zone  ->  turns and EXITS the zone
//   ->  regular MACD 12/26/9 crosses the same way  ->  5M candle CLOSE  ->  CONFIRMED BUY / SELL (+ Entry / SL / TP)
//
// Supertrend 12,10 is NOT an entry trigger: it is the default stop-loss reference and a risk warning.
// Everything runs on CLOSED 5M candles only. Every value at bar i uses bars <= i, so a signal never repaints and has no
// look-ahead (scripts/test-impulse.ts checks this by comparing prefix runs with the full run).
// Pure logic (no I/O) so it can be unit-tested and back-tested with plain candle arrays.
// ---------------------------------------------------------------------------

export const IMPULSE_TF_MS = 300_000
/** Bars needed before the engine starts replaying (EMA 200 warm-up). */
const MIN_BARS = 260
const REPLAY_FROM = 250
const SLOPE_BARS = 10
const SLOPE_FLAT = 0.004 // ATR units per bar (same threshold the MA Rev engine uses for EMA 200)
/** Price further than this many ATR from EMA 200 counts as over-extended (ABNORMAL VOLATILITY — WAIT). */
const EXTENDED_ATR = 20
/** A setup is rejected when round-trip fees + slippage would cost more than this many R (the stop is too tight to trade). */
const MAX_COST_R = 0.5

export type Side = 'BUY' | 'SELL'
export type SlMethod = 'supertrend' | 'swing' | 'atr'
export type ThresholdMode = 'percentile' | 'extreme'

export interface ImpulseConfig {
  /** Impulse MACD length (LazyBear lengthMA). */
  length: number
  /** Impulse MACD signal length (LazyBear lengthSignal). */
  signalLength: number
  /** Price source of the ZLEMA. LazyBear's original uses hlc3; the strategy brief defaults to close. */
  source: 'close' | 'hlc3'
  /** Bars of histogram history used for the dynamic extreme zone. */
  lookback: number
  thresholdMode: ThresholdMode
  /** percentile mode: histogram >= this percentile = overbought. */
  upperPct: number
  /** percentile mode: histogram <= this percentile = oversold. */
  lowerPct: number
  /** extreme mode: zone starts at this fraction of the recent max / min histogram. */
  extremeFrac: number
  macdFast: number
  macdSlow: number
  macdSignal: number
  stPeriod: number
  stMult: number
  slMethod: SlMethod
  /** Take-profit = entry +/- risk x rr. */
  rr: number
  /** ATR multiple for the ATR stop and the swing-stop buffer fallback. */
  atrMult: number
  /** MACD cross must arrive within this many bars AFTER the impulse exit (or on the same bar). */
  maxCrossWait: number
  feeBps: number
  slipBps: number
  /** Ablation switches for back-tests. The live dashboard always runs with all three true. */
  requireEma200: boolean
  requireImpulse: boolean
  requireMacdCross: boolean
  /** A signal stays "active" for this many closed bars after its candle. */
  freshBars: number
}

export const DEFAULT_IMPULSE: ImpulseConfig = {
  length: 34,
  signalLength: 9,
  source: 'close',
  lookback: 200,
  thresholdMode: 'percentile',
  upperPct: 90,
  lowerPct: 10,
  extremeFrac: 0.8,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  stPeriod: 12,
  stMult: 10,
  slMethod: 'supertrend',
  rr: 2,
  atrMult: 1.5,
  maxCrossWait: 6,
  feeBps: 4,
  slipBps: 2,
  requireEma200: true,
  requireImpulse: true,
  requireMacdCross: true,
  freshBars: 2,
}

const clamp = (v: number, lo: number, hi: number, fb: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)

/** Merge user-supplied values over the defaults, clamping everything to sane ranges (server + tests both use this). */
export function normalizeConfig(p: Partial<Record<keyof ImpulseConfig, unknown>> = {}): ImpulseConfig {
  const d = DEFAULT_IMPULSE
  const num = (k: keyof ImpulseConfig, lo: number, hi: number) => clamp(Number(p[k] ?? d[k]), lo, hi, d[k] as number)
  const bool = (k: keyof ImpulseConfig) => (p[k] === undefined ? (d[k] as boolean) : p[k] === true || p[k] === 'true' || p[k] === '1')
  const lowerPct = Math.round(num('lowerPct', 1, 30))
  const upperPct = Math.round(num('upperPct', 70, 99))
  return {
    length: Math.round(num('length', 5, 100)),
    signalLength: Math.round(num('signalLength', 2, 30)),
    source: p.source === 'hlc3' ? 'hlc3' : 'close',
    lookback: Math.round(num('lookback', 50, 300)),
    thresholdMode: p.thresholdMode === 'extreme' ? 'extreme' : 'percentile',
    upperPct,
    lowerPct,
    extremeFrac: num('extremeFrac', 0.3, 0.95),
    macdFast: Math.round(num('macdFast', 2, 50)),
    macdSlow: Math.round(num('macdSlow', 5, 100)),
    macdSignal: Math.round(num('macdSignal', 2, 50)),
    stPeriod: Math.round(num('stPeriod', 2, 50)),
    stMult: num('stMult', 0.5, 20),
    slMethod: p.slMethod === 'swing' || p.slMethod === 'atr' ? p.slMethod : 'supertrend',
    rr: num('rr', 0.5, 10),
    atrMult: num('atrMult', 0.5, 6),
    maxCrossWait: Math.round(num('maxCrossWait', 0, 20)),
    feeBps: num('feeBps', 0, 50),
    slipBps: num('slipBps', 0, 50),
    requireEma200: bool('requireEma200'),
    requireImpulse: bool('requireImpulse'),
    requireMacdCross: bool('requireMacdCross'),
    freshBars: Math.round(num('freshBars', 1, 12)),
  }
}

// --------------------------------------------------------------------------- types

export type Slope = 'RISING' | 'FALLING' | 'FLAT'
export type MarketLabel =
  | 'SUITABLE'
  | 'CHOPPY MARKET — NO TRADE'
  | 'LOW VOLATILITY — WAIT'
  | 'ABNORMAL VOLATILITY — WAIT'
  | 'POOR MARKET CONDITIONS — WAIT'

export type ImpulseStatus =
  | 'WAITING FOR IMPULSE'
  | 'IMPULSE OVERSOLD DETECTED'
  | 'IMPULSE OVERBOUGHT DETECTED'
  | 'IMPULSE REVERSAL STARTED'
  | 'IMPULSE EXITED OVERSOLD'
  | 'IMPULSE EXITED OVERBOUGHT'
  | 'WAITING FOR MACD CROSS'
  | 'WAITING FOR EMA 200 AGREEMENT'
  | 'EMA 200 CONFLICT'
  | 'MACD CONFIRMATION RECEIVED'
  | 'CHOPPY MARKET — NO TRADE'
  | 'LOW VOLATILITY — WAIT'
  | 'ABNORMAL VOLATILITY — WAIT'
  | 'POOR MARKET CONDITIONS — WAIT'
  | 'CONFIRMED BUY'
  | 'CONFIRMED SELL'
  | 'SIGNAL INVALIDATED'

export interface TradeOutcome {
  result: 'WIN' | 'LOSS' | 'OPEN'
  /** Net R multiple after fees and slippage (for OPEN: unrealised, marked at the last close). */
  r: number
  /** Net P/L in % of entry (price move only, not leveraged). */
  pnlPct: number
  /** Close time (ms) of the bar that resolved it, null while OPEN. */
  closedAt: number | null
}

export interface SlPlan {
  sl: number
  tp: number
  risk: number
  reward: number
  riskPct: number
  /** Round-trip fees + slippage expressed in R (cost / risk). */
  costR: number
  /** Method actually used (differs from the requested one when a fallback was needed). */
  method: SlMethod
  fallback: boolean
}

export interface ImpulseSignal {
  id: string
  symbol: string
  side: Side
  /** Close time (ms) of the signal candle — the moment the signal became confirmed. */
  time: number
  barsAgo: number
  /** Signal price = close of the signal candle (not an executed order price). */
  entry: number
  plan: SlPlan
  /** SL/TP for each method, so the UI can show alternatives. */
  plans: Record<SlMethod, SlPlan | null>
  supertrend: { dir: 'BUY' | 'SELL'; line: number; against: boolean }
  ema: { e20: number; e50: number; e100: number; e200: number }
  ema200Pos: 'ABOVE' | 'BELOW'
  ribbon: 'BULLISH' | 'BEARISH' | 'MIXED'
  impulse: { hist: number; threshold: number; zoneBars: number; extreme: number }
  macd: { line: number; signal: number; hist: number }
  crossLagBars: number
  tpNote: string | null
  conditions: string[]
  outcome: TradeOutcome | null
}

export interface ImpulseRow {
  symbol: string
  price: number
  change24h: number
  /** Close time (ms) of the latest closed 5M candle used. */
  barTime: number
  ema: { e20: number; e50: number; e100: number; e200: number }
  ema200: {
    position: 'ABOVE' | 'BELOW'
    slope: Slope
    distPct: number
    distAtr: number
    label: 'ABOVE EMA 200 — BULLISH BIAS' | 'BELOW EMA 200 — BEARISH BIAS' | 'EMA 200 FLAT — WEAK TREND' | 'EMA 200 CONFLICT — NO TRADE'
  }
  ribbon: 'BULLISH' | 'BEARISH' | 'MIXED'
  impulse: {
    hist: number
    signal: number
    prevHist: number
    upper: number
    lower: number
    state: 'OVERSOLD' | 'OVERBOUGHT' | 'REVERSING UP' | 'REVERSING DOWN' | 'EXITED OVERSOLD' | 'EXITED OVERBOUGHT' | 'NEUTRAL'
    momentum: 'POSITIVE' | 'NEGATIVE'
    weakening: boolean
    direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  }
  macd: {
    line: number
    signal: number
    hist: number
    state: 'BULLISH CROSS' | 'BEARISH CROSS' | 'WAITING'
    zero: 'ABOVE' | 'BELOW'
    momentum: 'STRENGTHENING' | 'WEAKENING'
    direction: 'BULLISH' | 'BEARISH'
  }
  supertrend: { dir: 'BUY' | 'SELL'; line: number; distPct: number; flip: 'BULLISH' | 'BEARISH' | null; flipBarsAgo: number | null }
  market: { label: MarketLabel; reasons: string[]; atrPct: number }
  status: ImpulseStatus
  setupSide: Side | null
  /** Active (fresh) confirmed signal, if any. */
  signal: ImpulseSignal | null
  /** Replayed signals over the fetched window, newest first. */
  history: ImpulseSignal[]
  bars: number
}

// --------------------------------------------------------------------------- indicator maths

const isNum = (v: number) => Number.isFinite(v)

function smaSeries(v: number[], n: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  for (let i = n - 1; i < v.length; i++) {
    let s = 0
    let ok = true
    for (let k = i - n + 1; k <= i; k++) {
      if (!isNum(v[k])) {
        ok = false
        break
      }
      s += v[k]
    }
    if (ok) out[i] = s / n
  }
  return out
}

/** Pine smma / RMA: seeded with the SMA of the first `len` values. */
function smmaSeries(v: number[], len: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  let prev = NaN
  for (let i = 0; i < v.length; i++) {
    if (i === len - 1) {
      let s = 0
      for (let k = 0; k < len; k++) s += v[k]
      prev = s / len
      out[i] = prev
    } else if (i >= len) {
      prev = (prev * (len - 1) + v[i]) / len
      out[i] = prev
    }
  }
  return out
}

function zlemaSeries(v: number[], len: number): number[] {
  const e1 = emaSeries(v, len)
  const e2 = emaSeries(e1, len)
  return e1.map((x, i) => x + (x - e2[i]))
}

/**
 * LazyBear "Impulse MACD":
 *   hi = smma(high, len), lo = smma(low, len), mi = zlema(src, len)
 *   md = mi > hi ? mi - hi : mi < lo ? mi - lo : 0
 *   sb = sma(md, signalLen), sh = md - sb   (histogram)
 */
export function impulseMacd(candles: Candle[], length: number, signalLength: number, source: 'close' | 'hlc3' = 'close') {
  const src = candles.map((c) => (source === 'hlc3' ? (c.high + c.low + c.close) / 3 : c.close))
  const hi = smmaSeries(candles.map((c) => c.high), length)
  const lo = smmaSeries(candles.map((c) => c.low), length)
  const mi = zlemaSeries(src, length)
  const md = mi.map((m, i) => (!isNum(hi[i]) || !isNum(lo[i]) ? NaN : m > hi[i] ? m - hi[i] : m < lo[i] ? m - lo[i] : 0))
  const sb = smaSeries(md, signalLength)
  const sh = md.map((m, i) => (isNum(m) && isNum(sb[i]) ? m - sb[i] : NaN))
  return { md, signal: sb, hist: sh }
}

export function regularMacd(closes: number[], fast: number, slow: number, signal: number) {
  const f = emaSeries(closes, fast)
  const s = emaSeries(closes, slow)
  const line = f.map((x, i) => x - s[i])
  const sig = emaSeries(line, signal)
  return { line, signal: sig, hist: line.map((x, i) => x - sig[i]) }
}

/** Supertrend (TradingView definition: hl2 source, Wilder ATR). dir 1 = up (line below price), -1 = down. */
export function supertrend(candles: Candle[], period: number, mult: number) {
  const n = candles.length
  const atr = atrSeries(candles, period)
  const line = new Array<number>(n).fill(NaN)
  const dir = new Array<number>(n).fill(1)
  let up = NaN
  let dn = NaN
  let trend = 1
  for (let i = 0; i < n; i++) {
    if (!isNum(atr[i])) continue
    const hl2 = (candles[i].high + candles[i].low) / 2
    let nu = hl2 - mult * atr[i]
    let nd = hl2 + mult * atr[i]
    if (isNum(up) && candles[i - 1].close > up) nu = Math.max(nu, up)
    if (isNum(dn) && candles[i - 1].close < dn) nd = Math.min(nd, dn)
    if (isNum(up) && isNum(dn)) {
      if (trend === -1 && candles[i].close > dn) trend = 1
      else if (trend === 1 && candles[i].close < up) trend = -1
    }
    up = nu
    dn = nd
    dir[i] = trend
    line[i] = trend === 1 ? up : dn
  }
  return { line, dir }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  const pos = ((sorted.length - 1) * p) / 100
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const median = (v: number[]) => {
  const a = v.filter(isNum).sort((x, y) => x - y)
  return a.length ? percentile(a, 50) : NaN
}

function pivotHighs(c: Candle[], upTo: number, maxAge: number): number[] {
  const out: number[] = []
  for (let i = Math.max(2, upTo - maxAge); i <= upTo - 2; i++) {
    let ok = true
    for (let k = 1; k <= 2; k++) if (c[i - k].high >= c[i].high || c[i + k].high >= c[i].high) ok = false
    if (ok) out.push(c[i].high)
  }
  return out
}
function pivotLows(c: Candle[], upTo: number, maxAge: number): number[] {
  const out: number[] = []
  for (let i = Math.max(2, upTo - maxAge); i <= upTo - 2; i++) {
    let ok = true
    for (let k = 1; k <= 2; k++) if (c[i - k].low <= c[i].low || c[i + k].low <= c[i].low) ok = false
    if (ok) out.push(c[i].low)
  }
  return out
}

// --------------------------------------------------------------------------- the engine

interface SideState {
  phase: 0 | 1 | 2 // 0 idle, 1 inside the extreme zone, 2 exited the zone (waiting for the MACD cross)
  zoneIdx: number
  zoneExtreme: number
  exitIdx: number
  blocked: string | null
  macdCrossedFirst: boolean
}
const fresh = (): SideState => ({ phase: 0, zoneIdx: -1, zoneExtreme: 0, exitIdx: -1, blocked: null, macdCrossedFirst: false })

export interface ImpulseAnalysis {
  signals: ImpulseSignal[]
  row: Omit<ImpulseRow, 'symbol' | 'price' | 'change24h' | 'history' | 'signal'> & { signal: ImpulseSignal | null }
}

/** Run the whole state machine over closed candles. Used by the live row builder and by the back-test script. */
export function analyzeImpulse(symbol: string, candles: Candle[], cfgIn: Partial<ImpulseConfig> = {}): ImpulseAnalysis | null {
  const cfg = { ...DEFAULT_IMPULSE, ...cfgIn }
  const n = candles.length
  if (n < MIN_BARS) return null
  const last = n - 1
  const cl = candles.map((c) => c.close)

  const e20 = emaSeries(cl, 20)
  const e50 = emaSeries(cl, 50)
  const e100 = emaSeries(cl, 100)
  const e200 = emaSeries(cl, 200)
  const atr14 = atrSeries(candles, 14)
  const imp = impulseMacd(candles, cfg.length, cfg.signalLength, cfg.source)
  const mc = regularMacd(cl, cfg.macdFast, cfg.macdSlow, cfg.macdSignal)
  const st = supertrend(candles, cfg.stPeriod, cfg.stMult)
  const sh = imp.hist

  // Dynamic extreme zone: thresholds at bar i use only histogram values up to and including bar i.
  const upper = new Array<number>(n).fill(NaN)
  const lower = new Array<number>(n).fill(NaN)
  const firstValid = sh.findIndex(isNum)
  for (let i = Math.max(firstValid + 30, 0); i < n; i++) {
    const w = sh.slice(Math.max(firstValid, i - cfg.lookback + 1), i + 1).filter(isNum)
    if (w.length < 30) continue
    if (cfg.thresholdMode === 'percentile') {
      const s = [...w].sort((a, b) => a - b)
      upper[i] = percentile(s, cfg.upperPct)
      lower[i] = percentile(s, cfg.lowerPct)
    } else {
      upper[i] = Math.max(...w) * cfg.extremeFrac
      lower[i] = Math.min(...w) * cfg.extremeFrac
    }
  }

  const atrAt = (i: number) => (isNum(atr14[i]) && atr14[i] > 0 ? atr14[i] : cl[i] * 0.001)
  const slopeAt = (i: number): Slope => {
    if (i < SLOPE_BARS) return 'FLAT'
    const s = (e200[i] - e200[i - SLOPE_BARS]) / SLOPE_BARS / atrAt(i)
    return s > SLOPE_FLAT ? 'RISING' : s < -SLOPE_FLAT ? 'FALLING' : 'FLAT'
  }
  const ribbonAt = (i: number): 'BULLISH' | 'BEARISH' | 'MIXED' =>
    e20[i] > e50[i] && e50[i] > e100[i] && e100[i] > e200[i] ? 'BULLISH' : e20[i] < e50[i] && e50[i] < e100[i] && e100[i] < e200[i] ? 'BEARISH' : 'MIXED'
  const emaOk = (i: number, bull: boolean) => {
    if (!cfg.requireEma200) return true
    const s = slopeAt(i)
    return bull ? cl[i] > e200[i] && s !== 'FALLING' : cl[i] < e200[i] && s !== 'RISING'
  }
  const crossUp = (i: number) => mc.line[i] > mc.signal[i] && mc.line[i - 1] <= mc.signal[i - 1]
  const crossDn = (i: number) => mc.line[i] < mc.signal[i] && mc.line[i - 1] >= mc.signal[i - 1]

  const marketAt = (i: number): { label: MarketLabel; reasons: string[]; atrPct: number } => {
    const a = atrAt(i)
    const atrPct = (a / cl[i]) * 100
    const reasons: string[] = []
    // sideways
    let e200Cross = 0
    for (let k = i - 29; k <= i; k++) if (k > 0 && cl[k] > e200[k] !== cl[k - 1] > e200[k - 1]) e200Cross++
    let macdCross = 0
    for (let k = i - 23; k <= i; k++) if (k > 0 && (crossUp(k) || crossDn(k))) macdCross++
    const distAtr = Math.abs(cl[i] - e200[i]) / a
    const spread = (Math.max(e20[i], e50[i], e100[i], e200[i]) - Math.min(e20[i], e50[i], e100[i], e200[i])) / a
    const flat = slopeAt(i) === 'FLAT'
    if (e200Cross >= 3) reasons.push(`price crossed EMA 200 ${e200Cross}x in 30 bars`)
    if (macdCross >= 5) reasons.push(`MACD crossed ${macdCross}x in 24 bars`)
    if (distAtr < 0.25) reasons.push('price too close to EMA 200')
    if (flat && spread < 1) reasons.push('EMA 200 flat and ribbon overlapping')
    if (reasons.length) return { label: 'CHOPPY MARKET — NO TRADE', reasons, atrPct }
    const med = median(atr14.slice(Math.max(0, i - 99), i + 1))
    if (atrPct < 0.1 || (isNum(med) && a < med * 0.5)) {
      return { label: 'LOW VOLATILITY — WAIT', reasons: [`ATR ${atrPct.toFixed(2)}% of price${isNum(med) ? `, ${(a / med).toFixed(2)}x its 100-bar median` : ''}`], atrPct }
    }
    const range = candles[i].high - candles[i].low
    if ((isNum(med) && a > med * 2.5) || range > 4 * (isNum(atr14[i - 1]) ? atr14[i - 1] : a) || distAtr > EXTENDED_ATR) {
      return { label: 'ABNORMAL VOLATILITY — WAIT', reasons: [distAtr > 12 ? `price ${distAtr.toFixed(1)} ATR from EMA 200` : 'ATR expansion / extreme candle'], atrPct }
    }
    const vr = candles.slice(i - 11, i + 1).reduce((s, c) => s + c.volume, 0) / 12
    const vb = candles.slice(Math.max(0, i - 99), i + 1).reduce((s, c) => s + c.volume, 0) / Math.min(100, i + 1)
    if (vb > 0 && vr < vb * 0.35) return { label: 'POOR MARKET CONDITIONS — WAIT', reasons: [`volume ${Math.round((vr / vb) * 100)}% of its 100-bar average`], atrPct }
    return { label: 'SUITABLE', reasons: [], atrPct }
  }

  // ---- stop-loss / take-profit
  const buildPlan = (i: number, bull: boolean, method: SlMethod): SlPlan | null => {
    const entry = cl[i]
    const a = atrAt(i)
    const stOk = isNum(st.line[i]) && (bull ? st.line[i] < entry && st.dir[i] === 1 : st.line[i] > entry && st.dir[i] === -1)
    const swing = (() => {
      let lo = Infinity
      let hi = -Infinity
      for (let k = Math.max(0, i - 9); k <= i; k++) {
        lo = Math.min(lo, candles[k].low)
        hi = Math.max(hi, candles[k].high)
      }
      return bull ? lo - 0.1 * a : hi + 0.1 * a
    })()
    const swingOk = bull ? swing < entry : swing > entry
    const atrStop = bull ? entry - cfg.atrMult * a : entry + cfg.atrMult * a
    const candidates: Array<[SlMethod, number, boolean]> = [
      ['supertrend', st.line[i], stOk],
      ['swing', swing, swingOk],
      ['atr', atrStop, true],
    ]
    const order: SlMethod[] = method === 'supertrend' ? ['supertrend', 'swing', 'atr'] : method === 'swing' ? ['swing', 'atr'] : ['atr']
    for (const m of order) {
      const c = candidates.find((x) => x[0] === m)!
      if (!c[2]) continue
      const risk = bull ? entry - c[1] : c[1] - entry
      if (!(risk > 0)) continue
      const costR = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (entry / risk)
      if (costR > MAX_COST_R) continue // too tight: fees would eat the trade — try the next stop method
      const reward = risk * cfg.rr
      return { sl: c[1], tp: bull ? entry + reward : entry - reward, risk, reward, riskPct: (risk / entry) * 100, costR, method: m, fallback: m !== method }
    }
    return null
  }

  const outcomeOf = (i: number, bull: boolean, plan: SlPlan | null): TradeOutcome | null => {
    if (!plan) return null
    const entry = cl[i]
    const costR = plan.costR
    for (let j = i + 1; j < n; j++) {
      const c = candles[j]
      const hitSl = bull ? c.low <= plan.sl : c.high >= plan.sl
      const hitTp = bull ? c.high >= plan.tp : c.low <= plan.tp
      // If both levels sit inside one candle we cannot know the order: assume the stop was hit first (conservative).
      if (hitSl || hitTp) {
        const r = (hitSl ? -1 : cfg.rr) - costR
        return { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * plan.risk) / entry) * 100, closedAt: c.openTime + IMPULSE_TF_MS }
      }
    }
    const move = bull ? cl[last] - entry : entry - cl[last]
    const r = move / plan.risk - costR
    return { result: 'OPEN', r, pnlPct: ((r * plan.risk) / entry) * 100, closedAt: null }
  }

  const signals: ImpulseSignal[] = []
  const states: Record<Side, SideState> = { BUY: fresh(), SELL: fresh() }
  const lastFire: Record<Side, number> = { BUY: -999, SELL: -999 }
  let invalid: { side: Side; idx: number; why: string } | null = null

  const fire = (i: number, bull: boolean, s: SideState) => {
    const side: Side = bull ? 'BUY' : 'SELL'
    const entry = cl[i]
    const plans = {
      supertrend: buildPlan(i, bull, 'supertrend'),
      swing: buildPlan(i, bull, 'swing'),
      atr: buildPlan(i, bull, 'atr'),
    }
    const plan = buildPlan(i, bull, cfg.slMethod)
    if (!plan) {
      // No valid stop on the right side of the entry (or too tight to cover costs): reject the setup, never force a stop.
      invalid = { side, idx: i, why: 'no valid stop-loss' }
      states[side] = fresh()
      return
    }
    const stDir: 'BUY' | 'SELL' = st.dir[i] === 1 ? 'BUY' : 'SELL'
    let tpNote: string | null = null
    {
      const levels = bull ? pivotHighs(candles, i, 200).filter((h) => h > entry).sort((a, b) => a - b) : pivotLows(candles, i, 200).filter((l) => l < entry).sort((a, b) => b - a)
      const near = levels[0]
      if (near !== undefined && (bull ? near < plan.tp : near > plan.tp)) {
        tpNote = `${bull ? 'Resistance' : 'Support'} at ${Number(near.toPrecision(6))} sits before the target (${(Math.abs(near - entry) / plan.risk).toFixed(1)}R) — consider an earlier exit`
      }
    }
    const conditions = [
      `Price ${bull ? 'above' : 'below'} EMA 200 (EMA 200 ${slopeAt(i).toLowerCase()})`,
      `Impulse MACD reached ${bull ? 'oversold' : 'overbought'} (${Math.max(1, s.exitIdx - s.zoneIdx)} bar(s) in the zone)`,
      `Impulse MACD exited ${bull ? 'oversold upward' : 'overbought downward'} ${i - s.exitIdx === 0 ? 'on this candle' : `${i - s.exitIdx} bar(s) ago`}`,
      `MACD ${cfg.macdFast}/${cfg.macdSlow}/${cfg.macdSignal} crossed ${bull ? 'above' : 'below'} its signal`,
      `5M candle closed with the conditions intact`,
    ]
    const sig: ImpulseSignal = {
      id: `${symbol}-${side}-${candles[i].openTime + IMPULSE_TF_MS}`,
      symbol,
      side,
      time: candles[i].openTime + IMPULSE_TF_MS,
      barsAgo: last - i,
      entry,
      plan,
      plans,
      supertrend: { dir: stDir, line: st.line[i], against: stDir !== side },
      ema: { e20: e20[i], e50: e50[i], e100: e100[i], e200: e200[i] },
      ema200Pos: cl[i] > e200[i] ? 'ABOVE' : 'BELOW',
      ribbon: ribbonAt(i),
      impulse: { hist: sh[i], threshold: bull ? lower[i] : upper[i], zoneBars: s.exitIdx >= 0 && s.zoneIdx >= 0 ? s.exitIdx - s.zoneIdx : 0, extreme: s.zoneExtreme },
      macd: { line: mc.line[i], signal: mc.signal[i], hist: mc.hist[i] },
      crossLagBars: s.exitIdx >= 0 ? i - s.exitIdx : 0,
      tpNote,
      conditions,
      outcome: outcomeOf(i, bull, plan),
    }
    signals.push(sig)
    lastFire[side] = i
    states[side] = fresh()
  }

  for (let i = REPLAY_FROM; i < n; i++) {
    if (!isNum(sh[i]) || !isNum(upper[i]) || !isNum(lower[i]) || !isNum(sh[i - 1])) continue
    for (const side of ['BUY', 'SELL'] as Side[]) {
      const bull = side === 'BUY'
      const s = states[side]
      const cross = bull ? crossUp(i) : crossDn(i)
      const support = bull ? mc.hist[i] > mc.hist[i - 1] : mc.hist[i] < mc.hist[i - 1]
      const ok = emaOk(i, bull)

      // Baseline (ablation only): MACD cross + EMA 200, no impulse requirement.
      if (!cfg.requireImpulse) {
        if (cross && support && ok && i - lastFire[side] > 12) {
          const mk = marketAt(i)
          if (mk.label === 'SUITABLE') fire(i, bull, { ...s, exitIdx: i, zoneIdx: i })
        }
        continue
      }

      const inZone = bull ? lower[i] < 0 && sh[i] <= lower[i] : upper[i] > 0 && sh[i] >= upper[i]
      if (inZone) {
        if (!ok) {
          states[side] = fresh()
          continue
        }
        if (s.phase !== 1) {
          states[side] = { ...fresh(), phase: 1, zoneIdx: i, zoneExtreme: sh[i], macdCrossedFirst: bull ? mc.line[i] > mc.signal[i] : mc.line[i] < mc.signal[i] }
        } else {
          s.zoneExtreme = bull ? Math.min(s.zoneExtreme, sh[i]) : Math.max(s.zoneExtreme, sh[i])
        }
        continue
      }

      if (s.phase === 1) {
        const turning = bull ? sh[i] > sh[i - 1] : sh[i] < sh[i - 1]
        if (turning && ok) {
          s.phase = 2
          s.exitIdx = i
          s.blocked = null
        } else {
          states[side] = fresh()
        }
      }

      if (states[side].phase === 2) {
        const t = states[side]
        if (!ok) {
          invalid = { side, idx: i, why: 'EMA 200 no longer agrees' }
          states[side] = fresh()
          continue
        }
        if (i - t.exitIdx > cfg.maxCrossWait) {
          invalid = { side, idx: i, why: 'MACD cross did not arrive in time' }
          states[side] = fresh()
          continue
        }
        const confirmed = cfg.requireMacdCross ? cross && support : true
        if (!confirmed) continue
        const mk = marketAt(i)
        if (mk.label !== 'SUITABLE') {
          t.blocked = mk.label
          continue
        }
        fire(i, bull, t)
      }
    }
  }

  // ---- latest-bar readout
  const i = last
  const bullNow = cl[i] > e200[i]
  const slope = slopeAt(i)
  const market = marketAt(i)
  const distAtr = Math.abs(cl[i] - e200[i]) / atrAt(i)
  const conflict = (bullNow && slope === 'FALLING') || (!bullNow && slope === 'RISING')
  const ema200Label = conflict
    ? 'EMA 200 CONFLICT — NO TRADE'
    : slope === 'FLAT'
      ? 'EMA 200 FLAT — WEAK TREND'
      : bullNow
        ? 'ABOVE EMA 200 — BULLISH BIAS'
        : 'BELOW EMA 200 — BEARISH BIAS'

  const hist = sh[i]
  const prevHist = sh[i - 1]
  const inOversold = lower[i] < 0 && hist <= lower[i]
  const inOverbought = upper[i] > 0 && hist >= upper[i]
  const activeSide: Side | null = states.BUY.phase ? 'BUY' : states.SELL.phase ? 'SELL' : null
  const as = activeSide ? states[activeSide] : null
  const freshSig = signals.filter((s) => s.barsAgo < cfg.freshBars).pop() ?? null

  let impState: ImpulseRow['impulse']['state'] = 'NEUTRAL'
  if (inOversold) impState = hist > prevHist ? 'REVERSING UP' : 'OVERSOLD'
  else if (inOverbought) impState = hist < prevHist ? 'REVERSING DOWN' : 'OVERBOUGHT'
  else if (as && as.phase === 2) impState = activeSide === 'BUY' ? 'EXITED OVERSOLD' : 'EXITED OVERBOUGHT'

  let status: ImpulseStatus = 'WAITING FOR IMPULSE'
  const extremeAgainstEma = (inOversold && !emaOk(i, true)) || (inOverbought && !emaOk(i, false))
  if (freshSig) status = freshSig.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL'
  else if (as && activeSide) {
    const bull = activeSide === 'BUY'
    if (as.phase === 1) status = hist > prevHist === bull ? 'IMPULSE REVERSAL STARTED' : bull ? 'IMPULSE OVERSOLD DETECTED' : 'IMPULSE OVERBOUGHT DETECTED'
    else if (as.blocked) status = 'MACD CONFIRMATION RECEIVED'
    else status = as.exitIdx === i ? (bull ? 'IMPULSE EXITED OVERSOLD' : 'IMPULSE EXITED OVERBOUGHT') : 'WAITING FOR MACD CROSS'
  } else if (invalid && last - invalid.idx < 3) status = 'SIGNAL INVALIDATED'
  else if (extremeAgainstEma) status = (inOversold ? bullNow : !bullNow) ? 'WAITING FOR EMA 200 AGREEMENT' : 'EMA 200 CONFLICT'
  else if (market.label !== 'SUITABLE') status = market.label

  const flipIdx = (() => {
    for (let k = i; k > 0 && isNum(st.line[k - 1]); k--) if (st.dir[k] !== st.dir[k - 1]) return k
    return -1
  })()
  const macdState: ImpulseRow['macd']['state'] = crossUp(i) ? 'BULLISH CROSS' : crossDn(i) ? 'BEARISH CROSS' : 'WAITING'

  return {
    signals: [...signals].reverse(),
    row: {
      barTime: candles[i].openTime + IMPULSE_TF_MS,
      ema: { e20: e20[i], e50: e50[i], e100: e100[i], e200: e200[i] },
      ema200: { position: bullNow ? 'ABOVE' : 'BELOW', slope, distPct: ((cl[i] - e200[i]) / e200[i]) * 100, distAtr, label: ema200Label },
      ribbon: ribbonAt(i),
      impulse: {
        hist,
        signal: imp.signal[i],
        prevHist,
        upper: upper[i],
        lower: lower[i],
        state: impState,
        momentum: hist >= 0 ? 'POSITIVE' : 'NEGATIVE',
        weakening: Math.abs(hist) < Math.abs(prevHist),
        direction: hist > prevHist && hist > imp.signal[i] ? 'BULLISH' : hist < prevHist && hist < imp.signal[i] ? 'BEARISH' : 'NEUTRAL',
      },
      macd: {
        line: mc.line[i],
        signal: mc.signal[i],
        hist: mc.hist[i],
        state: macdState,
        zero: mc.line[i] >= 0 ? 'ABOVE' : 'BELOW',
        momentum: Math.abs(mc.hist[i]) > Math.abs(mc.hist[i - 1]) ? 'STRENGTHENING' : 'WEAKENING',
        direction: mc.line[i] > mc.signal[i] ? 'BULLISH' : 'BEARISH',
      },
      supertrend: {
        dir: st.dir[i] === 1 ? 'BUY' : 'SELL',
        line: st.line[i],
        distPct: ((cl[i] - st.line[i]) / cl[i]) * 100,
        flip: flipIdx >= 0 ? (st.dir[flipIdx] === 1 ? 'BULLISH' : 'BEARISH') : null,
        flipBarsAgo: flipIdx >= 0 ? i - flipIdx : null,
      },
      market,
      status,
      setupSide: freshSig ? freshSig.side : activeSide,
      signal: freshSig,
      bars: n,
    },
  }
}

export function buildImpulseRow(input: {
  symbol: string
  price: number
  change24h: number
  candles: Candle[]
  now: number
  cfg?: Partial<ImpulseConfig>
}): ImpulseRow | null {
  const closed = closedOnly(input.candles, input.now, IMPULSE_TF_MS)
  const a = analyzeImpulse(input.symbol, closed, input.cfg)
  if (!a) return null
  const { signal, ...rest } = a.row
  return { symbol: input.symbol, price: input.price, change24h: input.change24h, ...rest, signal, history: a.signals.slice(0, 20) }
}

// --------------------------------------------------------------------------- performance

export interface PerfStats {
  total: number
  buys: number
  sells: number
  wins: number
  losses: number
  open: number
  winRate: number
  totalPnlPct: number
  totalR: number
  avgR: number
  expectancyR: number
  maxDrawdownR: number
  monthly: Array<{ month: string; trades: number; wins: number; r: number }>
}

/** Aggregate a list of signals (any symbols). Open trades are counted but excluded from win rate / R stats. */
/** Minimal shape needed for performance maths (shared with the MTF engine). */
export interface PerfSignal {
  side: Side
  time: number
  outcome: TradeOutcome | null
}

export function summarizePerformance(signals: PerfSignal[]): PerfStats {
  const sorted = [...signals].sort((a, b) => a.time - b.time)
  const closed = sorted.filter((s) => s.outcome && s.outcome.result !== 'OPEN')
  const wins = closed.filter((s) => s.outcome!.result === 'WIN').length
  const totalR = closed.reduce((a, s) => a + s.outcome!.r, 0)
  let peak = 0
  let cum = 0
  let dd = 0
  for (const s of closed.sort((a, b) => (a.outcome!.closedAt ?? 0) - (b.outcome!.closedAt ?? 0))) {
    cum += s.outcome!.r
    peak = Math.max(peak, cum)
    dd = Math.max(dd, peak - cum)
  }
  const months = new Map<string, { trades: number; wins: number; r: number }>()
  for (const s of closed) {
    const key = new Date(s.time).toISOString().slice(0, 7)
    const m = months.get(key) ?? { trades: 0, wins: 0, r: 0 }
    m.trades++
    if (s.outcome!.result === 'WIN') m.wins++
    m.r += s.outcome!.r
    months.set(key, m)
  }
  return {
    total: sorted.length,
    buys: sorted.filter((s) => s.side === 'BUY').length,
    sells: sorted.filter((s) => s.side === 'SELL').length,
    wins,
    losses: closed.length - wins,
    open: sorted.filter((s) => s.outcome?.result === 'OPEN').length,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    totalPnlPct: closed.reduce((a, s) => a + s.outcome!.pnlPct, 0),
    totalR,
    avgR: closed.length ? totalR / closed.length : 0,
    expectancyR: closed.length ? totalR / closed.length : 0,
    maxDrawdownR: dd,
    monthly: [...months.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).map(([month, v]) => ({ month, ...v })),
  }
}
