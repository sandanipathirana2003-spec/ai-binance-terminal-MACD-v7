import type { Candle } from './binance'
import { atrSeries, emaSeries } from './indicators'
import { regularMacd, supertrend, type Side, type Slope, type TradeOutcome } from './impulse5m'
import { closedOnly } from './reversal'

// ---------------------------------------------------------------------------
// MACD multi-timeframe confirmation engine.
//
//   BUY  : MACD line above its signal line on EVERY selected timeframe (1M, 3M, 5M, 15M, 30M)
//          + the 5M MACD line crossed above its signal (confirmed at the 5M candle close, not older than maxCrossAge bars)
//          + price above the 5M EMA 200 (and not touching it) + 5M Supertrend 12,4 bullish
//          + MACD line rising and histogram positive and growing + not sideways / flat
//   SELL : the exact mirror.
//   Entry = close of the signal candle. SL = the 5M Supertrend line (must be on the right side, otherwise NO trade).
//   TP = entry +/- 2 x risk (strict 1:2). One signal per crossover (the crossover id is part of the signal id).
//
// Every readout uses CLOSED candles only. The other timeframes contribute only candles that had already closed at the
// signal candle's close, so a signal never repaints and never looks ahead. Pure logic (no I/O).
// ---------------------------------------------------------------------------

export const MACD_TFS = ['1m', '3m', '5m', '15m', '30m'] as const
export type MacdTf = (typeof MACD_TFS)[number]
export const MACD_MS: Record<MacdTf, number> = { '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000 }
export const MACD_LABEL: Record<MacdTf, string> = { '1m': '1M', '3m': '3M', '5m': '5M', '15m': '15M', '30m': '30M' }

/** Strict reward : risk. Deliberately not configurable. */
export const RR = 2
/** Closed bars every timeframe needs before its MACD is trusted (EMA warm-up). */
const WARM = 60
/** Trigger-timeframe bars needed before EMA 200 is trusted. */
export const EMA_WARM = 210
/** A setup is rejected when round-trip fees + slippage would cost more than this many R (the stop is too tight to trade). */
const MAX_COST_R = 0.5
const SLOPE_BARS = 10
const SLOPE_FLAT = 0.004
/** MACD is "flat" when its line moved less than this many ATR over the last FLAT_BARS bars. */
const FLAT_BARS = 20
const FLAT_RANGE_ATR = 0.15

export interface MacdConfig {
  fast: number
  slow: number
  signal: number
  stPeriod: number
  stMult: number
  /** Timeframes that must ALL agree (the trigger timeframe is always included). */
  tfs: MacdTf[]
  /** Timeframe whose MACD crossover is the entry event, and whose EMA 200 / Supertrend / candle close are used. Default 5M. */
  trigger: MacdTf
  /** The trigger-timeframe cross may be at most this many bars old when the other timeframes finish agreeing. 0 = same candle only. */
  maxCrossAge: number
  /** Price closer to the EMA 200 than this many ATR = EMA 200 CONFLICT — WAIT. */
  nearEmaAtr: number
  feeBps: number
  slipBps: number
  /** A signal counts as "fresh" (shown as CONFIRMED / popped up) for this many trigger bars after its candle. */
  freshBars: number
}

export const DEFAULT_MACD: MacdConfig = {
  fast: 12,
  slow: 26,
  signal: 9,
  stPeriod: 12,
  stMult: 4,
  tfs: [...MACD_TFS],
  trigger: '5m',
  maxCrossAge: 3,
  nearEmaAtr: 0.25,
  feeBps: 4,
  slipBps: 2,
  freshBars: 2,
}

const clamp = (v: number, lo: number, hi: number, fb: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb)

/** Merge user-supplied values over the defaults and clamp everything (server and tests both use this; nothing raw is trusted). */
export function normalizeMacdConfig(p: Partial<Record<keyof MacdConfig, unknown>> = {}): MacdConfig {
  const d = DEFAULT_MACD
  const num = (k: keyof MacdConfig, lo: number, hi: number) => clamp(Number(p[k] ?? d[k]), lo, hi, d[k] as number)
  const fast = Math.round(num('fast', 2, 50))
  const slow = Math.max(fast + 1, Math.round(num('slow', 5, 100)))
  const trigger = (MACD_TFS as readonly string[]).includes(String(p.trigger)) ? (p.trigger as MacdTf) : d.trigger
  const raw = Array.isArray(p.tfs) ? p.tfs.map(String) : typeof p.tfs === 'string' ? p.tfs.split(',') : d.tfs
  const set = new Set(raw)
  set.add(trigger)
  return {
    fast,
    slow,
    signal: Math.round(num('signal', 2, 50)),
    stPeriod: Math.round(num('stPeriod', 2, 50)),
    stMult: num('stMult', 0.5, 20),
    tfs: MACD_TFS.filter((t) => set.has(t)),
    trigger,
    maxCrossAge: Math.round(num('maxCrossAge', 0, 20)),
    nearEmaAtr: num('nearEmaAtr', 0, 2),
    feeBps: num('feeBps', 0, 50),
    slipBps: num('slipBps', 0, 50),
    freshBars: Math.round(num('freshBars', 1, 12)),
  }
}

// --------------------------------------------------------------------------- types

export type Dir = 'BUY' | 'SELL' | 'NEUTRAL'

export interface TfView {
  tf: MacdTf
  /** True when this timeframe must agree (part of the selected set). */
  selected: boolean
  /** Close time (ms) of this timeframe's latest closed candle. */
  barTime: number
  close: number
  dir: Dir
  line: number
  signal: number
  hist: number
  /** Most recent crossover (always confirmed: closed candles only) and how many of this timeframe's candles ago. */
  cross: { type: 'BULLISH' | 'BEARISH'; barsAgo: number } | null
  momentum: 'STRENGTHENING' | 'WEAKENING'
  moving: 'UP' | 'DOWN' | 'FLAT'
  zero: 'ABOVE' | 'BELOW'
}

export interface TradePlan {
  sl: number
  tp: number
  risk: number
  reward: number
  riskPct: number
  rewardPct: number
  /** Round-trip fees + slippage in R. */
  costR: number
}

export interface MacdSignal extends TradePlan {
  id: string
  symbol: string
  side: Side
  trigger: MacdTf
  /** Close time (ms) of the signal candle. */
  time: number
  /** Trigger bars since the signal candle (0 = the latest closed candle). */
  barsAgo: number
  /** Signal price = close of the signal candle (not an executed fill). */
  entry: number
  /** Trigger bars between the crossover candle and the signal candle. */
  crossAge: number
  macd: { line: number; signal: number; hist: number }
  /** Direction of every timeframe as of the signal candle close. */
  tfs: Record<MacdTf, Dir>
  selectedTfs: MacdTf[]
  ema200: { value: number; position: 'ABOVE' | 'BELOW'; distPct: number; slope: Slope }
  supertrend: { dir: 'BUY' | 'SELL'; line: number }
  conditions: string[]
  outcome: TradeOutcome
}

export type MacdState = 'CONFIRMED BUY' | 'CONFIRMED SELL' | 'DEVELOPING BUY' | 'DEVELOPING SELL' | 'WAIT'

export interface MacdRow {
  symbol: string
  price: number
  change24h: number
  trigger: MacdTf
  barTime: number
  tfs: Record<MacdTf, TfView>
  agreement: {
    selected: MacdTf[]
    bull: number
    bear: number
    total: number
    /** Side all selected timeframes agree on, or null. */
    side: Side | null
    overall: 'BULLISH' | 'BEARISH' | 'MIXED'
    /** Selected timeframes that disagree with the dominant direction. */
    disagreeing: MacdTf[]
  }
  ema200: {
    value: number
    position: 'ABOVE' | 'BELOW'
    slope: Slope
    distPct: number
    distAtr: number
    near: boolean
    trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    buyValid: boolean
    sellValid: boolean
    label: string
  }
  supertrend: { dir: 'BUY' | 'SELL'; line: number; distPct: number; flipBarsAgo: number | null; label: string }
  status: { state: MacdState; text: string; side: Side | null; blocker: string | null; missing: MacdTf[] }
  signal: MacdSignal | null
  history: MacdSignal[]
  /** Signals whose SL / TP have not been reached yet. */
  open: MacdSignal[]
  bars: number
}

// --------------------------------------------------------------------------- series

export interface Series {
  tf: MacdTf
  c: Candle[]
  ms: number
  close: number[]
  ml: number[]
  sg: number[]
  hist: number[]
  stDir: number[]
  stLine: number[]
  e200: number[]
  atr: number[]
}

export type SeriesSet = Record<MacdTf, Series>

function buildSeries(tf: MacdTf, c: Candle[], cfg: MacdConfig): Series {
  const close = c.map((x) => x.close)
  const m = regularMacd(close, cfg.fast, cfg.slow, cfg.signal)
  const st = supertrend(c, cfg.stPeriod, cfg.stMult)
  return { tf, c, ms: MACD_MS[tf], close, ml: m.line, sg: m.signal, hist: m.hist, stDir: st.dir, stLine: st.line, e200: emaSeries(close, 200), atr: atrSeries(c, 14) }
}

/** Indicator series for every timeframe (closed candles only). Null when a timeframe has too little history. */
export function prepareMacd(input: Record<MacdTf, Candle[]>, cfg: MacdConfig): SeriesSet | null {
  const S = {} as SeriesSet
  for (const tf of MACD_TFS) {
    if (!input[tf] || input[tf].length < WARM + 5) return null
    S[tf] = buildSeries(tf, input[tf], cfg)
  }
  if (S[cfg.trigger].c.length < EMA_WARM + 20) return null
  return S
}

const atrAt = (s: Series, i: number) => (Number.isFinite(s.atr[i]) && s.atr[i] > 0 ? s.atr[i] : s.close[i] * 0.001)
const dirAt = (s: Series, i: number): Dir => (s.ml[i] > s.sg[i] ? 'BUY' : s.ml[i] < s.sg[i] ? 'SELL' : 'NEUTRAL')
const crossAt = (s: Series, i: number): 'BULL' | 'BEAR' | null =>
  i < 1 ? null : s.ml[i] > s.sg[i] && s.ml[i - 1] <= s.sg[i - 1] ? 'BULL' : s.ml[i] < s.sg[i] && s.ml[i - 1] >= s.sg[i - 1] ? 'BEAR' : null

function slopeAt(s: Series, i: number): Slope {
  if (i < SLOPE_BARS) return 'FLAT'
  const v = (s.e200[i] - s.e200[i - SLOPE_BARS]) / SLOPE_BARS / atrAt(s, i)
  return v > SLOPE_FLAT ? 'RISING' : v < -SLOPE_FLAT ? 'FALLING' : 'FLAT'
}

function viewAt(s: Series, i: number, selected: boolean): TfView {
  let cross: TfView['cross'] = null
  for (let k = i; k > Math.max(0, i - 80); k--) {
    const c = crossAt(s, k)
    if (c) {
      cross = { type: c === 'BULL' ? 'BULLISH' : 'BEARISH', barsAgo: i - k }
      break
    }
  }
  const dl = s.ml[i] - s.ml[i - 1]
  return {
    tf: s.tf,
    selected,
    barTime: s.c[i].openTime + s.ms,
    close: s.close[i],
    dir: dirAt(s, i),
    line: s.ml[i],
    signal: s.sg[i],
    hist: s.hist[i],
    cross,
    momentum: Math.abs(s.hist[i]) > Math.abs(s.hist[i - 1]) ? 'STRENGTHENING' : 'WEAKENING',
    moving: dl > 0 ? 'UP' : dl < 0 ? 'DOWN' : 'FLAT',
    zero: s.ml[i] >= 0 ? 'ABOVE' : 'BELOW',
  }
}

// --------------------------------------------------------------------------- engine

export interface MacdRun {
  signals: MacdSignal[]
  row: Omit<MacdRow, 'symbol' | 'price' | 'change24h' | 'history' | 'open'>
}

type Check = { ok: true; plan: TradePlan } | { ok: false; reason: string }

/** Replay every trigger-timeframe candle, then read the live state. Used by the dashboard route and by the back-test. */
export function runMacd(symbol: string, S: SeriesSet, cfg: MacdConfig): MacdRun {
  const trig = S[cfg.trigger]
  const n = trig.c.length
  const last = n - 1
  const word = (bull: boolean) => (bull ? 'BULLISH' : 'BEARISH')
  const tfLabel = MACD_LABEL[cfg.trigger]

  const check = (i: number, bull: boolean): Check => {
    const side: Side = bull ? 'BUY' : 'SELL'
    const t = trig
    const momentumOk = bull ? t.ml[i] > t.ml[i - 1] && t.hist[i] > 0 && t.hist[i] >= t.hist[i - 1] : t.ml[i] < t.ml[i - 1] && t.hist[i] < 0 && t.hist[i] <= t.hist[i - 1]
    if (!momentumOk) return { ok: false, reason: `${tfLabel} MACD MOMENTUM NOT CONFIRMED (line / histogram not ${bull ? 'rising' : 'falling'})` }
    const close = t.close[i]
    const e = t.e200[i]
    const a = atrAt(t, i)
    if (bull ? close <= e : close >= e) return { ok: false, reason: `EMA 200 FILTER FAILED — PRICE ${bull ? 'BELOW' : 'ABOVE'} EMA 200` }
    if (Math.abs(close - e) < cfg.nearEmaAtr * a) return { ok: false, reason: 'EMA 200 CONFLICT — PRICE TOO CLOSE TO EMA 200 — WAIT' }
    const stSide: Side = t.stDir[i] === 1 ? 'BUY' : 'SELL'
    if (stSide !== side) return { ok: false, reason: `SUPERTREND ${cfg.stPeriod},${cfg.stMult} STILL ${word(!bull)} — AGAINST THE TRADE` }
    // sideways: price whipping through EMA 200 or MACD crossing over and over
    let e200Cross = 0
    for (let k = Math.max(1, i - 29); k <= i; k++) if (t.close[k] > t.e200[k] !== t.close[k - 1] > t.e200[k - 1]) e200Cross++
    let macdCross = 0
    for (let k = Math.max(1, i - 23); k <= i; k++) if (crossAt(t, k)) macdCross++
    if (e200Cross >= 3 || macdCross >= 5) return { ok: false, reason: 'SIDEWAYS MARKET — NO TRADE' }
    let hi = -Infinity
    let lo = Infinity
    for (let k = Math.max(0, i - FLAT_BARS + 1); k <= i; k++) {
      hi = Math.max(hi, t.ml[k])
      lo = Math.min(lo, t.ml[k])
    }
    if ((hi - lo) / a < FLAT_RANGE_ATR) return { ok: false, reason: 'FLAT MACD / WEAK MOMENTUM — WAIT' }
    // stop = Supertrend line, strictly on the right side of the entry; never forced
    const line = t.stLine[i]
    const valid = Number.isFinite(line) && (bull ? line < close && t.stDir[i] === 1 : line > close && t.stDir[i] === -1)
    const risk = bull ? close - line : line - close
    if (!valid || !(risk > 0)) return { ok: false, reason: 'NO VALID STOP LOSS (Supertrend is not on the correct side of the entry)' }
    const costR = ((2 * (cfg.feeBps + cfg.slipBps)) / 10_000) * (close / risk)
    if (costR > MAX_COST_R) return { ok: false, reason: 'STOP TOO TIGHT — FEES AND SLIPPAGE WOULD EAT THE TRADE' }
    const reward = risk * RR
    return { ok: true, plan: { sl: line, tp: bull ? close + reward : close - reward, risk, reward, riskPct: (risk / close) * 100, rewardPct: (reward / close) * 100, costR } }
  }

  const outcomeOf = (i: number, bull: boolean, p: TradePlan): TradeOutcome => {
    const entry = trig.close[i]
    for (let j = i + 1; j < n; j++) {
      const c = trig.c[j]
      const hitSl = bull ? c.low <= p.sl : c.high >= p.sl
      const hitTp = bull ? c.high >= p.tp : c.low <= p.tp
      // SL and TP inside one candle: the order is unknowable, so the stop is assumed first (conservative)
      if (hitSl || hitTp) {
        const r = (hitSl ? -1 : RR) - p.costR
        return { result: hitSl ? 'LOSS' : 'WIN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt: c.openTime + trig.ms }
      }
    }
    const r = (bull ? trig.close[last] - entry : entry - trig.close[last]) / p.risk - p.costR
    return { result: 'OPEN', r, pnlPct: ((r * p.risk) / entry) * 100, closedAt: null }
  }

  // ---- replay: one trigger-timeframe closed candle at a time
  const ptr = {} as Record<MacdTf, number>
  for (const tf of MACD_TFS) ptr[tf] = -1
  const signals: MacdSignal[] = []
  const signalled: Record<Side, number> = { BUY: -1, SELL: -1 }
  let curCross: { type: 'BULL' | 'BEAR'; idx: number } | null = null

  for (let i = 1; i < n; i++) {
    const T = trig.c[i].openTime + trig.ms
    for (const tf of MACD_TFS) {
      const s = S[tf]
      while (ptr[tf] + 1 < s.c.length && s.c[ptr[tf] + 1].openTime + s.ms <= T) ptr[tf]++
    }
    const cr = crossAt(trig, i)
    if (cr) curCross = { type: cr, idx: i }
    if (i < EMA_WARM || cfg.tfs.some((tf) => ptr[tf] < WARM)) continue
    const dirs = cfg.tfs.map((tf) => dirAt(S[tf], ptr[tf]))
    const agree: Side | null = dirs.every((d) => d === 'BUY') ? 'BUY' : dirs.every((d) => d === 'SELL') ? 'SELL' : null
    if (!agree || !curCross) continue
    const bull = agree === 'BUY'
    if ((curCross.type === 'BULL') !== bull) continue // the trigger crossover must be in the agreed direction
    const age = i - curCross.idx
    if (age > cfg.maxCrossAge || signalled[agree] === curCross.idx) continue
    const r = check(i, bull)
    if (!r.ok) continue

    const tfSnap = {} as Record<MacdTf, Dir>
    for (const tf of MACD_TFS) tfSnap[tf] = dirAt(S[tf], ptr[tf])
    const e = trig.e200[i]
    const close = trig.close[i]
    const w = word(bull).toLowerCase()
    signals.push({
      ...r.plan,
      id: `${symbol}-${cfg.trigger}-${agree}-${trig.c[curCross.idx].openTime + trig.ms}`,
      symbol,
      side: agree,
      trigger: cfg.trigger,
      time: T,
      barsAgo: last - i,
      entry: close,
      crossAge: age,
      macd: { line: trig.ml[i], signal: trig.sg[i], hist: trig.hist[i] },
      tfs: tfSnap,
      selectedTfs: [...cfg.tfs],
      ema200: { value: e, position: close > e ? 'ABOVE' : 'BELOW', distPct: ((close - e) / e) * 100, slope: slopeAt(trig, i) },
      supertrend: { dir: trig.stDir[i] === 1 ? 'BUY' : 'SELL', line: trig.stLine[i] },
      conditions: [
        `MACD ${cfg.fast}/${cfg.slow}/${cfg.signal} ${w} on ${cfg.tfs.map((t) => MACD_LABEL[t]).join(', ')} (all selected timeframes agree)`,
        `${tfLabel} MACD crossed ${bull ? 'above' : 'below'} its signal line ${age === 0 ? 'on the signal candle' : `${age} bar${age === 1 ? '' : 's'} earlier`}, confirmed at the candle close`,
        `${tfLabel} MACD line ${bull ? 'rising' : 'falling'}, histogram ${bull ? 'positive' : 'negative'} and strengthening`,
        `Price ${bull ? 'above' : 'below'} ${tfLabel} EMA 200`,
        `${tfLabel} Supertrend ${cfg.stPeriod},${cfg.stMult} ${w}; stop at the Supertrend line`,
      ],
      outcome: outcomeOf(i, bull, r.plan),
    })
    signalled[agree] = curCross.idx
  }

  // ---- live readout: every timeframe's own latest closed candle
  const views = {} as Record<MacdTf, TfView>
  for (const tf of MACD_TFS) views[tf] = viewAt(S[tf], S[tf].c.length - 1, cfg.tfs.includes(tf))
  const dirsNow = cfg.tfs.map((tf) => views[tf].dir)
  const bullN = dirsNow.filter((d) => d === 'BUY').length
  const bearN = dirsNow.filter((d) => d === 'SELL').length
  const total = cfg.tfs.length
  const agreeNow: Side | null = bullN === total ? 'BUY' : bearN === total ? 'SELL' : null
  const overall: 'BULLISH' | 'BEARISH' | 'MIXED' = bullN === total ? 'BULLISH' : bearN === total ? 'BEARISH' : 'MIXED'
  const dominant: Dir = bullN > bearN ? 'BUY' : bearN > bullN ? 'SELL' : 'NEUTRAL'
  const disagreeing = dominant === 'NEUTRAL' ? [...cfg.tfs] : cfg.tfs.filter((tf) => views[tf].dir !== dominant)

  const fresh = signals.filter((s) => s.barsAgo < cfg.freshBars).pop() ?? null
  let state: MacdState = 'WAIT'
  let text = `WAIT / NO TRADE — MACD TIMEFRAMES DISAGREE (${disagreeing.map((t) => MACD_LABEL[t]).join(', ')})`
  let side: Side | null = null
  let blocker: string | null = null
  let missing: MacdTf[] = []
  const age = curCross ? last - curCross.idx : null

  if (fresh) {
    state = fresh.side === 'BUY' ? 'CONFIRMED BUY' : 'CONFIRMED SELL'
    text = `${state} — MTF MACD + ${tfLabel} CROSS + EMA 200 + SUPERTREND`
    side = fresh.side
  } else if (agreeNow) {
    const bull = agreeNow === 'BUY'
    side = agreeNow
    const matching = curCross !== null && (curCross.type === 'BULL') === bull
    if (!matching) {
      state = bull ? 'DEVELOPING BUY' : 'DEVELOPING SELL'
      text = `DEVELOPING ${agreeNow} — ALL ${total} TIMEFRAMES ${word(bull)} — WAITING FOR THE ${tfLabel} ${bull ? 'BULLISH' : 'BEARISH'} CROSSOVER`
    } else if (age !== null && age > cfg.maxCrossAge) {
      text = `WAIT — THE ${tfLabel} CROSSOVER IS ${age} BARS OLD — WAITING FOR A NEW SETUP`
      blocker = 'CROSSOVER TOO OLD'
    } else if (curCross && signalled[agreeNow] === curCross.idx) {
      text = 'WAIT — THIS CROSSOVER ALREADY SIGNALLED — WAITING FOR A NEW SETUP'
      blocker = 'ALREADY SIGNALLED'
    } else {
      const r = check(last, bull)
      if (r.ok) {
        state = bull ? 'DEVELOPING BUY' : 'DEVELOPING SELL'
        text = `DEVELOPING ${agreeNow} — CONDITIONS MET NOW — CONFIRMATION COMES AT THE ${tfLabel} CANDLE CLOSE`
      } else {
        text = `WAIT — ${r.reason}`
        blocker = r.reason
      }
    }
  } else if (curCross && age !== null && age <= cfg.maxCrossAge) {
    // the trigger timeframe just crossed but other timeframes have not followed yet = a developing (unconfirmed) setup
    const bull = curCross.type === 'BULL'
    const wantDir: Dir = bull ? 'BUY' : 'SELL'
    if (views[cfg.trigger].dir === wantDir) {
      missing = cfg.tfs.filter((tf) => views[tf].dir !== wantDir)
      if (missing.length) {
        state = bull ? 'DEVELOPING BUY' : 'DEVELOPING SELL'
        side = bull ? 'BUY' : 'SELL'
        text = `DEVELOPING ${side} — ${tfLabel} CROSSED ${bull ? 'UP' : 'DOWN'} ${age === 0 ? 'ON THE LAST CANDLE' : `${age} BAR${age === 1 ? '' : 'S'} AGO`} — WAITING FOR ${missing.map((t) => MACD_LABEL[t]).join(', ')}`
      }
    }
  }

  const close = trig.close[last]
  const e = trig.e200[last]
  const a = atrAt(trig, last)
  const slope = slopeAt(trig, last)
  const near = Math.abs(close - e) < cfg.nearEmaAtr * a
  const above = close > e
  const stDir: 'BUY' | 'SELL' = trig.stDir[last] === 1 ? 'BUY' : 'SELL'
  let flip: number | null = null
  for (let k = last; k > 0 && Number.isFinite(trig.stLine[k - 1]); k--) {
    if (trig.stDir[k] !== trig.stDir[k - 1]) {
      flip = last - k
      break
    }
  }

  return {
    signals: [...signals].reverse(),
    row: {
      trigger: cfg.trigger,
      barTime: trig.c[last].openTime + trig.ms,
      tfs: views,
      agreement: { selected: [...cfg.tfs], bull: bullN, bear: bearN, total, side: agreeNow, overall, disagreeing },
      ema200: {
        value: e,
        position: above ? 'ABOVE' : 'BELOW',
        slope,
        distPct: ((close - e) / e) * 100,
        distAtr: Math.abs(close - e) / a,
        near,
        trend: near ? 'NEUTRAL' : above ? 'BULLISH' : 'BEARISH',
        buyValid: above && !near,
        sellValid: !above && !near,
        label: near ? 'EMA 200 CONFLICT — WAIT (price too close)' : above ? 'ABOVE EMA 200 — BULLISH' : 'BELOW EMA 200 — BEARISH',
      },
      supertrend: {
        dir: stDir,
        line: trig.stLine[last],
        distPct: ((close - trig.stLine[last]) / close) * 100,
        flipBarsAgo: flip,
        label: stDir === 'BUY' ? 'BULLISH (green)' : 'BEARISH (red)',
      },
      status: { state, text, side, blocker, missing },
      signal: fresh,
      bars: n,
    },
  }
}

export function analyzeMacd(symbol: string, input: Record<MacdTf, Candle[]>, cfgIn: Partial<MacdConfig> = {}): MacdRun | null {
  const cfg = normalizeMacdConfig(cfgIn)
  const S = prepareMacd(input, cfg)
  return S ? runMacd(symbol, S, cfg) : null
}

export function buildMacdRow(input: {
  symbol: string
  price: number
  change24h: number
  candles: Record<MacdTf, Candle[]>
  now: number
  cfg?: Partial<MacdConfig>
}): MacdRow | null {
  const closed = {} as Record<MacdTf, Candle[]>
  for (const tf of MACD_TFS) closed[tf] = closedOnly(input.candles[tf], input.now, MACD_MS[tf])
  const a = analyzeMacd(input.symbol, closed, input.cfg)
  if (!a) return null
  return {
    symbol: input.symbol,
    price: input.price,
    change24h: input.change24h,
    ...a.row,
    history: a.signals.slice(0, 20),
    open: a.signals.filter((s) => s.outcome.result === 'OPEN'),
  }
}
