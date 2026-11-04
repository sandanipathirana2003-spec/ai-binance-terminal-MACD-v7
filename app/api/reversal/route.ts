import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch } from '@/lib/binance'
import { buildMaRow, type MaRow } from '@/lib/mareversal'
import { REV_EMA, REV_VIDYA, REVERSAL_WINDOW_MS, buildReversalRow, type ReversalResponse, type ReversalRow } from '@/lib/reversal'

// Same edge-runtime reasoning as /api/market (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Native klines per timeframe (limit < 500 keeps Binance request weight at 2 each). 300+ bars so ATR(200) has history.
const LIMIT_1M = 400 // ~6.6h
const LIMIT_3M = 300 // ~15h
const LIMIT_5M = 300 // ~25h
const CACHE_MS = 45_000 // 1M reversals are time-sensitive, so this is far fresher than the 5-min /api/market cache
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 100 // top by 24h quote volume — 3 requests per coin per refresh, kept modest for Binance rate limits

interface Cache {
  at: number
  rows: ReversalRow[]
  maRows: MaRow[]
}

let cache: Cache | null = null
let inFlight: Promise<Cache> | null = null
let universe: { at: number; symbols: string[] } | null = null

async function getUniverse(): Promise<string[]> {
  if (universe && Date.now() - universe.at < UNIVERSE_CACHE_MS) return universe.symbols
  const symbols = await fetchFuturesUniverse()
  universe = { at: Date.now(), symbols }
  return symbols
}

async function recompute(): Promise<Cache> {
  const [symbols, ticker] = await Promise.all([getUniverse(), fetchBulkTicker24hr()])
  const ranked = symbols
    .filter((s) => ticker.has(s))
    .sort((a, b) => (ticker.get(b)?.quoteVolume ?? 0) - (ticker.get(a)?.quoteVolume ?? 0))
    .slice(0, MAX_COINS)
  const targets = ranked.includes('BTCUSDT') ? ranked : ['BTCUSDT', ...ranked]

  const [k1, k3, k5] = await Promise.all([
    fetchKlinesBatch(targets, '1m', LIMIT_1M, 12),
    fetchKlinesBatch(targets, '3m', LIMIT_3M, 12),
    fetchKlinesBatch(targets, '5m', LIMIT_5M, 12),
  ])
  const now = Date.now()
  const rows: ReversalRow[] = []
  const maRows: MaRow[] = []
  for (const symbol of targets) {
    const oneMin = k1.get(symbol)
    const threeMin = k3.get(symbol)
    const fiveMin = k5.get(symbol)
    const t = ticker.get(symbol)
    if (!oneMin || !threeMin || !fiveMin || !t) continue
    const row = buildReversalRow({ symbol, price: t.price, change24h: t.changePct, oneMin, threeMin, fiveMin, now })
    if (row) rows.push(row)
    const ma = buildMaRow({ symbol, price: t.price, change24h: t.changePct, oneMin, threeMin, fiveMin, now })
    if (ma) maRows.push(ma)
  }
  return { at: now, rows, maRows }
}

export async function GET() {
  const params = {
    vidyaLength: REV_VIDYA.length,
    vidyaMomentum: REV_VIDYA.momentum,
    bandDistance: REV_VIDYA.bandFactor,
    emaFast: REV_EMA.fast,
    emaSlow: REV_EMA.slow,
    windowMin: REVERSAL_WINDOW_MS / 60_000,
  }
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      if (!inFlight) {
        inFlight = recompute().finally(() => {
          inFlight = null
        })
      }
      cache = await inFlight
    }
    const body: ReversalResponse = { rows: cache.rows, maRows: cache.maRows, computedAt: cache.at, live: true, params }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: ReversalResponse = {
      rows: [],
      maRows: [],
      computedAt: Date.now(),
      live: false,
      params,
      error: err instanceof Error ? err.message : 'Unknown error fetching Binance data',
    }
    return NextResponse.json(body, { status: 200 })
  }
}
