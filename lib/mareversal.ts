import type { Candle } from './binance'
import { atrSeries, emaSeries, vidyaTrendSeries } from './indicators'
import { REV_TFS, REV_TF_LABEL, REV_VIDYA, TF_MS, closedOnly, type RevTf } from './reversal'

// ---------------------------------------------------------------------------
// MA-ribbon reversal engine (EMA 9 / 21 / 50 / 200) with Volumatic VIDYA confirmation.
//
//   EMA 9   = early reversal trigger          EMA 50  = medium-term context
//   EMA 21  = reversal confirmation           EMA 200 = major trend context
//   VIDYA   = momentum / trend confirmation   Price structure (swing highs/lows) = confirmation
//
// EMA 50/200 are NEVER required to turn for an early signal: they are only labelled
// OLD TREND / FLATTENING / FOLLOWING. A 9/21 cross alone never produces a signal: it also needs a candle
// close beyond the MAs, EMA 9 slope in the new direction and VIDYA not opposing. Closed candles only.
// Pure logic (no I/O) so it can be unit-tested with synthetic candles.
// ---------------------------------------------------------------------------

export const MA_PERIODS = { e9: 9, e21: 21, e50: 50, e200: 200 } as const
/** A 9/21 cross keeps feeding stages 1-3 for this many candles (own timeframe); after that only full alignment (stage 4) remains. */
export const CONFIRM_BARS = 40
/** A cross followed by price returning through both MAs inside this many candles is a possible fake. */
const FAKE_BARS = 10
/** An opposite cross this soon after a cross means the first one failed. */
const CROSSBACK_BARS = 8
const MIN_BARS = 230
const MOM_BARS = 9
const STRUCT_MAX_AGE = 40

/** EMA slope = change per bar in ATR(14) units. [bars measured over, flat threshold]. Slower EMAs use longer spans and tighter thresholds. */
const SLOPE_CFG = { e9: [2, 0.03], e21: [3, 0.02], e50: [5, 0.01], e200: [10, 0.004] } as const
const VIDYA_SLOPE: [number, number] = [2, 0.02]

export type Side = 'BUY' | 'SELL'
export type Slope = 'RISING' | 'FALLING' | 'FLAT'
export type MaSignal =
  | 'STRONG EARLY BUY'
  | 'EARLY BUY'
  | 'CONFIRMED BUY'
  | 'STRONG EARLY SELL'
  | 'EARLY SELL'
  | 'CONFIRMED SELL'
  | 'WEAK REVERSAL'
  | 'POSSIBLE FAKE REVERSAL'
  | 'WAIT'
export type MaStage = 0 | 1 | 2 | 3 | 4
export const STAGE_LABEL: Record<MaStage, string> = {
  0: 'OLD TREND',
  1: 'EARLY REVERSAL',
  2: 'REVERSAL CONFIRMING',
  3: 'TREND CONFIRMED',
  4: 'FULL TREND',
}
export type VidyaState = 'BULLISH' | 'TURNING BULLISH' | 'NEUTRAL' | 'TURNING BEARISH' | 'BEARISH'
export type Relation = 'REVERSAL' | 'CONFIRMED' | 'WEAK' | 'SUPPORT' | 'COUNTER-TREND' | 'NEUTRAL'
export type Ctx = 'OLD TREND' | 'FLATTENING' | 'FOLLOWING'

export interface MaTf {
  tf: RevTf
  close: number
  ema: { e9: number; e21: number; e50: number; e200: number }
  slopes: Record<'e9' | 'e21' | 'e50' | 'e200', Slope>
  /** Slow-MA ordering only (21 vs 50 vs 200), independent of the fast pair. */
  trend: 'BULLISH' | 'BEARISH' | 'MIXED'
  priceVs: 'ABOVE BOTH' | 'BELOW BOTH' | 'BETWEEN'
  cross: { type: 'BULL' | 'BEAR'; barsAgo: number; time: number } | null
  structure: { label: 'HIGHER LOWS' | 'LOWER HIGHS' | 'RANGE' | 'UNCLEAR'; higherLow: boolean; lowerHigh: boolean; break: 'HIGH' | 'LOW' | null }
  vidya: {
    state: VidyaState
    band: 'UP' | 'DOWN' | null
    slope: Slope
    line: number
    cmoPct: number
    volDeltaPct: number
    momentum: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  }
  stage: MaStage
  signal: MaSignal
  side: Side | null
  alignment: 'FULL BULLISH ALIGNMENT' | 'FULL BEARISH ALIGNMENT' | null
  /** CONFIRMED only because the trend is long established (no 9/21 cross inside CONFIRM_BARS): a continuation, not a reversal. */
  established: boolean
  /** How 50/200 relate to the signal side (null when there is no side). */
  ctx: { e50: Ctx; e200: Ctx } | null
  reason: string
}

export interface MaRow {
  symbol: string
  price: number
  change24h: number
  tfs: Record<RevTf, MaTf>
  signal: MaSignal
  side: Side | null
  primaryTf: RevTf | null
  rels: Record<RevTf, Relation>
  headline: string
  risk: 'HIGH RISK' | 'MEDIUM RISK' | 'LOWER RISK' | null
  reason: string
  score: number
  startedAt: number | null
  early: boolean
  /** Full EMA alignment / confirmed trend with NO fresh 9/21 cross: a continuation, ranked low so it cannot bury new reversals. */
  established: boolean
}

// --------------------------------------------------------------------------- helpers

function slopeOf(series: number[], bars: number, flat: number, atr: number): Slope {
  const i = series.length - 1
  if (i < bars) return 'FLAT'
  const s = (series[i] - series[i - bars]) / bars / atr
  return s > flat ? 'RISING' : s < -flat ? 'FALLING' : 'FLAT'
}

interface Pivot {
  i: number
  v: number
}

function pivots(c: Candle[], left = 2, right = 2): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = []
  const lows: Pivot[] = []
  for (let i = left; i < c.length - right; i++) {
    let hi = true
    let lo = true
    for (let k = 1; k <= left; k++) {
      if (c[i - k].high >= c[i].high) hi = false
      if (c[i - k].low <= c[i].low) lo = false
    }
    for (let k = 1; k <= right; k++) {
      if (c[i + k].high >= c[i].high) hi = false
      if (c[i + k].low <= c[i].low) lo = false
    }
    if (hi) highs.push({ i, v: c[i].high })
    if (lo) lows.push({ i, v: c[i].low })
  }
  return { highs, lows }
}

interface Cross {
  type: 'BULL' | 'BEAR'
  idx: number
}

/** Latest two 9/21 crosses (newest first). Skips the EMA warm-up so the artificial first-bar "cross" is ignored. */
function lastCrosses(e9: number[], e21: number[]): Cross[] {
  const out: Cross[] = []
  for (let i = e9.length - 1; i > MA_PERIODS.e21 && out.length < 2; i--) {
    const nowBull = e9[i] > e21[i]
    if (nowBull !== e9[i - 1] > e21[i - 1]) out.push({ type: nowBull ? 'BULL' : 'BEAR', idx: i })
  }
  return out
}

function momentum(c: Candle[]): { cmoPct: number; volDeltaPct: number; state: 'BULLISH' | 'BEARISH' | 'NEUTRAL' } {
  const n = c.length
  let up = 0
  let dn = 0
  let buy = 0
  let sell = 0
  for (let i = n - MOM_BARS; i < n; i++) {
    const d = c[i].close - c[i - 1].close
    if (d > 0) up += d
    else dn -= d
    if (c[i].close > c[i].open) buy += c[i].volume
    else if (c[i].close < c[i].open) sell += c[i].volume
  }
  const cmo = up + dn > 0 ? (up - dn) / (up + dn) : 0
  const vt = buy + sell
  const vd = vt > 0 ? (buy - sell) / vt : 0
  const state = cmo > 0.15 && vd >= -0.05 ? 'BULLISH' : cmo < -0.15 && vd <= 0.05 ? 'BEARISH' : 'NEUTRAL'
  return { cmoPct: cmo * 100, volDeltaPct: vd * 100, state }
}

const fmtAgo = (bars: number) => (bars === 0 ? 'this candle' : `${bars} candle${bars === 1 ? '' : 's'} ago`)

// --------------------------------------------------------------------------- per-timeframe evaluation

const RANK: Record<MaSignal, number> = {
  'CONFIRMED BUY': 6,
  'CONFIRMED SELL': 6,
  'STRONG EARLY BUY': 5,
  'STRONG EARLY SELL': 5,
  'EARLY BUY': 4,
  'EARLY SELL': 4,
  'WEAK REVERSAL': 2,
  'POSSIBLE FAKE REVERSAL': 1,
  WAIT: 0,
}

interface SideEval {
  side: Side
  signal: MaSignal
  stage: MaStage
  reason: string
  crossIdx: number
  rank: number
}

function evaluateTf(tf: RevTf, candles: Candle[]): MaTf | null {
  const n = candles.length
  if (n < MIN_BARS) return null
  const last = n - 1
  const cl = candles.map((c) => c.close)
  const close = cl[last]
  const e = {
    e9: emaSeries(cl, MA_PERIODS.e9),
    e21: emaSeries(cl, MA_PERIODS.e21),
    e50: emaSeries(cl, MA_PERIODS.e50),
    e200: emaSeries(cl, MA_PERIODS.e200),
  }
  const v = { e9: e.e9[last], e21: e.e21[last], e50: e.e50[last], e200: e.e200[last] }
  const atrArr = atrSeries(candles, 14)
  const atr = Number.isFinite(atrArr[last]) && atrArr[last] > 0 ? atrArr[last] : close * 0.001

  const slopes = {
    e9: slopeOf(e.e9, ...SLOPE_CFG.e9, atr),
    e21: slopeOf(e.e21, ...SLOPE_CFG.e21, atr),
    e50: slopeOf(e.e50, ...SLOPE_CFG.e50, atr),
    e200: slopeOf(e.e200, ...SLOPE_CFG.e200, atr),
  }
  const trend = v.e21 > v.e50 && v.e50 > v.e200 ? 'BULLISH' : v.e21 < v.e50 && v.e50 < v.e200 ? 'BEARISH' : 'MIXED'
  const hiMa = Math.max(v.e9, v.e21)
  const loMa = Math.min(v.e9, v.e21)
  const priceVs = close > hiMa ? 'ABOVE BOTH' : close < loMa ? 'BELOW BOTH' : 'BETWEEN'

  // crosses
  const crosses = lastCrosses(e.e9, e.e21)
  const lastCross = crosses[0] ?? null
  const ms = TF_MS[tf]
  const crossInfo = lastCross
    ? { type: lastCross.type, barsAgo: last - lastCross.idx, time: candles[lastCross.idx].openTime + ms }
    : null

  // price structure from confirmed swing pivots
  const pv = pivots(candles)
  const lows = pv.lows.filter((p) => p.i >= last - STRUCT_MAX_AGE).slice(-2)
  const highs = pv.highs.filter((p) => p.i >= last - STRUCT_MAX_AGE).slice(-2)
  const higherLow = lows.length === 2 && lows[1].v > lows[0].v
  const lowerHigh = highs.length === 2 && highs[1].v < highs[0].v
  const lastHigh = pv.highs.length ? pv.highs[pv.highs.length - 1] : null
  const lastLow = pv.lows.length ? pv.lows[pv.lows.length - 1] : null
  const brk = lastHigh && close > lastHigh.v ? 'HIGH' : lastLow && close < lastLow.v ? 'LOW' : null
  const structure = {
    label: (higherLow && lowerHigh ? 'RANGE' : higherLow ? 'HIGHER LOWS' : lowerHigh ? 'LOWER HIGHS' : 'UNCLEAR') as MaTf['structure']['label'],
    higherLow,
    lowerHigh,
    break: brk as 'HIGH' | 'LOW' | null,
  }

  // VIDYA (14 / 9 / 1.5) + momentum
  const vt = vidyaTrendSeries(candles, { length: REV_VIDYA.length, momentum: REV_VIDYA.momentum, bandFactor: REV_VIDYA.bandFactor, seed: true })
  const mom = momentum(candles)
  const vLine = vt ? vt.line[last] : close
  const vSlope = vt ? slopeOf(vt.line, ...VIDYA_SLOPE, atr) : 'FLAT'
  const bandRaw = vt ? vt.up[last] : null
  const band = bandRaw === null ? null : bandRaw ? 'UP' : 'DOWN'
  const above = close > vLine
  const below = close < vLine
  const vState: VidyaState =
    above && vSlope === 'RISING' && mom.state === 'BULLISH'
      ? 'BULLISH'
      : above && vSlope !== 'FALLING'
        ? 'TURNING BULLISH'
        : below && vSlope === 'FALLING' && mom.state === 'BEARISH'
          ? 'BEARISH'
          : below && vSlope !== 'RISING'
            ? 'TURNING BEARISH'
            : 'NEUTRAL'

  const evalSide = (side: Side): SideEval => {
    const bull = side === 'BUY'
    const want = bull ? 'BULL' : 'BEAR'
    const word = bull ? 'above' : 'below'
    const dirWord = bull ? 'rising' : 'falling'
    const pairOk = bull ? v.e9 > v.e21 : v.e9 < v.e21
    const sameCross = lastCross !== null && lastCross.type === want
    const barsAgo = lastCross ? last - lastCross.idx : 999
    const s9 = slopes.e9 === (bull ? 'RISING' : 'FALLING')
    const s21ok = slopes.e21 !== (bull ? 'FALLING' : 'RISING')
    const s50ok = slopes.e50 !== (bull ? 'FALLING' : 'RISING')
    const aboveAny = bull ? close > loMa : close < hiMa
    const aboveBoth = bull ? close > hiMa : close < loMa
    const struct = bull ? higherLow : lowerHigh
    const brokeSwing = bull ? brk === 'HIGH' : brk === 'LOW'
    const full: VidyaState = bull ? 'BULLISH' : 'BEARISH'
    const turn: VidyaState = bull ? 'TURNING BULLISH' : 'TURNING BEARISH'
    const vOk = vState === full || vState === turn
    const strongOpp = bull ? vState === 'BEARISH' && band === 'DOWN' : vState === 'BULLISH' && band === 'UP'
    const stack = bull ? v.e9 > v.e21 && v.e21 > v.e50 && v.e50 > v.e200 : v.e9 < v.e21 && v.e21 < v.e50 && v.e50 < v.e200

    // a cross of this side that failed: opposite cross soon after it
    const prev = crosses[1] ?? null
    const crossBack = lastCross !== null && prev !== null && prev.type === want && lastCross.type !== want && lastCross.idx - prev.idx <= CROSSBACK_BARS && barsAgo <= FAKE_BARS

    const facts: string[] = []
    const mk = (signal: MaSignal, stage: MaStage, extra?: string): SideEval => ({
      side,
      signal,
      stage,
      crossIdx: lastCross ? lastCross.idx : -1,
      rank: RANK[signal],
      reason: [...facts, extra].filter(Boolean).join(' + '),
    })

    // --- possible fake reversal ---
    if (crossBack) {
      return { ...mk('POSSIBLE FAKE REVERSAL', 0), reason: `9 crossed ${bull ? 'above' : 'below'} 21 but crossed straight back (${fmtAgo(barsAgo)}) + possible fake reversal` }
    }
    if (sameCross && barsAgo <= FAKE_BARS) {
      const returned = bull ? close < loMa : close > hiMa
      if (returned) {
        return { ...mk('POSSIBLE FAKE REVERSAL', 0), reason: `9 crossed ${bull ? 'above' : 'below'} 21 but price failed to hold and closed back through both MAs + possible fake reversal` }
      }
      if (strongOpp && !aboveBoth) {
        return { ...mk('POSSIBLE FAKE REVERSAL', 0), reason: `9 crossed ${bull ? 'above' : 'below'} 21 but VIDYA is still strongly ${bull ? 'bearish' : 'bullish'} and price is not clear of 9/21 + possible fake reversal` }
      }
    }

    // --- stages ---
    const base = pairOk && sameCross && barsAgo <= CONFIRM_BARS && s9 && aboveAny
    let stage: MaStage = 0
    if (stack) stage = 4
    else if (base) {
      stage = 1
      if (struct && s21ok) stage = 2
      if (stage === 2 && s50ok) stage = 3
    }

    if (pairOk && sameCross && barsAgo <= CONFIRM_BARS) facts.push(`9 crossed ${bull ? 'above' : 'below'} 21 ${fmtAgo(barsAgo)}`)
    else if (stack) facts.push(`9 ${bull ? '>' : '<'} 21 ${bull ? '>' : '<'} 50 ${bull ? '>' : '<'} 200`)
    if (s9) facts.push(`9 ${dirWord}`)
    if (aboveAny) facts.push(aboveBoth ? `price ${word} 9/21` : `price ${word} 21`)
    if (s21ok && stage >= 1) facts.push(slopes.e21 === (bull ? 'RISING' : 'FALLING') ? `21 ${dirWord}` : '21 flattening')
    if (struct) facts.push(bull ? 'higher low' : 'lower high')
    if (brokeSwing) facts.push(bull ? 'broke swing high' : 'broke swing low')
    if (vOk) facts.push(`VIDYA ${vState.toLowerCase()}`)
    if (stage >= 3 && s50ok) facts.push('50 flattening/following')

    if (stage === 0) {
      const sig: MaSignal = 'WAIT'
      return mk(sig, 0)
    }
    if (stage === 4 && !aboveAny) return mk('WAIT', 4, `full ${bull ? 'bullish' : 'bearish'} alignment but price pulled back through the 21`)
    if (!vOk) {
      const why = strongOpp ? `VIDYA still strongly ${bull ? 'bearish' : 'bullish'}` : `VIDYA not yet confirming (${vState.toLowerCase()})`
      return mk(stage === 4 ? 'WAIT' : 'WEAK REVERSAL', stage, why)
    }
    if (stage >= 3) return mk(bull ? 'CONFIRMED BUY' : 'CONFIRMED SELL', stage)
    const strong = vState === full && aboveBoth && struct
    return mk(strong ? (bull ? 'STRONG EARLY BUY' : 'STRONG EARLY SELL') : bull ? 'EARLY BUY' : 'EARLY SELL', stage)
  }

  const evals = [evalSide('BUY'), evalSide('SELL')].sort((a, b) => b.rank - a.rank || b.crossIdx - a.crossIdx)
  const best = evals[0]
  const active = best.signal !== 'WAIT'
  const side: Side | null = active ? best.side : null

  const ctxOf = (slope: Slope, s: Side): Ctx =>
    slope === 'FLAT' ? 'FLATTENING' : (s === 'BUY') === (slope === 'RISING') ? 'FOLLOWING' : 'OLD TREND'
  const ctx = side ? { e50: ctxOf(slopes.e50, side), e200: ctxOf(slopes.e200, side) } : null

  const alignment = v.e9 > v.e21 && v.e21 > v.e50 && v.e50 > v.e200 ? 'FULL BULLISH ALIGNMENT' : v.e9 < v.e21 && v.e21 < v.e50 && v.e50 < v.e200 ? 'FULL BEARISH ALIGNMENT' : null

  const established =
    active && best.signal.startsWith('CONFIRMED') && !(crossInfo && crossInfo.type === (best.side === 'BUY' ? 'BULL' : 'BEAR') && crossInfo.barsAgo <= CONFIRM_BARS)

  let reason = best.reason
  if (!active) {
    reason = `No active reversal · 9 ${v.e9 > v.e21 ? '>' : '<'} 21 · EMA stack ${trend.toLowerCase()} · VIDYA ${vState.toLowerCase()}`
  } else if (ctx && (ctx.e50 === 'OLD TREND' || ctx.e200 === 'OLD TREND') && best.signal !== 'POSSIBLE FAKE REVERSAL') {
    reason += ` · 50/200 = OLD TREND (not required)`
  }

  return {
    tf,
    close,
    ema: v,
    slopes,
    trend,
    priceVs,
    cross: crossInfo,
    structure,
    vidya: { state: vState, band, slope: vSlope, line: vLine, cmoPct: mom.cmoPct, volDeltaPct: mom.volDeltaPct, momentum: mom.state },
    stage: best.stage,
    signal: best.signal,
    side,
    alignment,
    established,
    ctx,
    reason,
  }
}

// --------------------------------------------------------------------------- multi-timeframe roll-up

function relationOf(t: MaTf, s: Side): Relation {
  const bull = s === 'BUY'
  if (t.side === s) {
    if (t.signal === 'CONFIRMED BUY' || t.signal === 'CONFIRMED SELL') return 'CONFIRMED'
    if (t.signal === 'WEAK REVERSAL') return 'WEAK'
    if (t.signal !== 'POSSIBLE FAKE REVERSAL') return 'REVERSAL'
  }
  const pairAligned = bull ? t.ema.e9 > t.ema.e21 : t.ema.e9 < t.ema.e21
  const vAligned = bull ? t.vidya.state === 'BULLISH' || t.vidya.state === 'TURNING BULLISH' : t.vidya.state === 'BEARISH' || t.vidya.state === 'TURNING BEARISH'
  const trendAligned = t.trend === (bull ? 'BULLISH' : 'BEARISH')
  if (trendAligned || (pairAligned && vAligned)) return 'SUPPORT'
  const trendOpp = t.trend === (bull ? 'BEARISH' : 'BULLISH')
  if (trendOpp || !pairAligned) return 'COUNTER-TREND'
  return 'NEUTRAL'
}

export function buildMaRow(input: {
  symbol: string
  price: number
  change24h: number
  oneMin: Candle[]
  threeMin: Candle[]
  fiveMin: Candle[]
  now: number
}): MaRow | null {
  const tfs = {} as Record<RevTf, MaTf>
  const src: Record<RevTf, Candle[]> = { '1m': input.oneMin, '3m': input.threeMin, '5m': input.fiveMin }
  for (const tf of REV_TFS) {
    const t = evaluateTf(tf, closedOnly(src[tf], input.now, TF_MS[tf]))
    if (!t) return null
    tfs[tf] = t
  }

  // Primary = strongest FRESH signal; ties go to the LOWER timeframe (earliest warning). An established-trend
  // continuation (e.g. an old 5M downtrend) is ranked below even a fake/weak warning so it can never hide a new reversal.
  const eff = (t: MaTf) => (t.established ? 0.5 : RANK[t.signal])
  const ranked = [...REV_TFS].sort((a, b) => eff(tfs[b]) - eff(tfs[a]) || REV_TFS.indexOf(a) - REV_TFS.indexOf(b))
  const top = ranked[0]
  const primary = eff(tfs[top]) > 0 ? tfs[top] : null
  const dirSide = primary && primary.side

  const rels = {} as Record<RevTf, Relation>
  for (const tf of REV_TFS) rels[tf] = dirSide ? relationOf(tfs[tf], dirSide) : 'NEUTRAL'

  let headline = 'NO ACTIVE REVERSAL'
  let risk: MaRow['risk'] = null
  if (primary && dirSide) {
    headline = REV_TFS.map((tf) => `${REV_TF_LABEL[tf]} ${rels[tf]}`).join(' — ')
    const higher = REV_TFS.slice(REV_TFS.indexOf(primary.tf) + 1)
    const pool = higher.length ? higher : REV_TFS.filter((t) => t !== primary.tf)
    const good = pool.filter((t) => ['SUPPORT', 'CONFIRMED', 'REVERSAL'].includes(rels[t])).length
    const bad = pool.filter((t) => rels[t] === 'COUNTER-TREND').length
    risk = good === pool.length ? 'LOWER RISK' : bad === pool.length ? 'HIGH RISK' : 'MEDIUM RISK'
    if (primary.signal === 'POSSIBLE FAKE REVERSAL') {
      headline = `${REV_TF_LABEL[primary.tf]} POSSIBLE FAKE REVERSAL`
      risk = null
    } else if (primary.signal.startsWith('CONFIRMED') && good !== pool.length) {
      headline += ' · HIGHER TFs NOT CONFIRMING'
    } else if (primary.signal === 'WEAK REVERSAL') {
      headline = `${REV_TF_LABEL[primary.tf]} WEAK REVERSAL · VIDYA NOT CONFIRMING`
    }
    if (risk && !primary.signal.startsWith('CONFIRMED') && primary.signal !== 'WEAK REVERSAL' && primary.signal !== 'POSSIBLE FAKE REVERSAL') {
      headline = `${REV_TF_LABEL[primary.tf]} EARLY REVERSAL — ${risk}  ·  ${headline}`
    }
  }

  const good = primary && dirSide ? REV_TFS.filter((t) => t !== primary.tf && ['SUPPORT', 'CONFIRMED', 'REVERSAL'].includes(rels[t])).length : 0
  const established = Boolean(primary && primary.established)
  const score = primary ? (established ? 10 : RANK[primary.signal] * 10 + good * 3 + primary.stage) : 0
  const sig = primary ? primary.signal : 'WAIT'
  return {
    symbol: input.symbol,
    price: input.price,
    change24h: input.change24h,
    tfs,
    signal: sig,
    side: primary ? primary.side : null,
    primaryTf: primary ? primary.tf : null,
    rels,
    headline,
    risk,
    reason: primary ? `${REV_TF_LABEL[primary.tf]}: ${primary.reason}` : tfs['1m'].reason,
    score,
    startedAt: primary && primary.cross ? primary.cross.time : null,
    established,
    early: sig === 'EARLY BUY' || sig === 'EARLY SELL' || sig === 'STRONG EARLY BUY' || sig === 'STRONG EARLY SELL',
  }
}
