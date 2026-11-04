import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch, type Candle } from '@/lib/binance'
import { buildImpulseRow, normalizeConfig, type ImpulseConfig, type ImpulseRow } from '@/lib/impulse5m'

// Same edge-runtime reasoning as /api/market and /api/reversal (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// 499 bars keeps Binance request weight at 2 per call (limit < 500) and gives EMA 200 ~250 bars of warm-up before the
// engine starts replaying (the remaining ~250 bars = ~21h of replayed signals for the history panel).
const LIMIT_5M = 499
const CACHE_MS = 30_000
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 100

interface Cache {
  at: number
  candles: Map<string, Candle[]>
  ticker: Map<string, { price: number; changePct: number; quoteVolume: number }>
  targets: string[]
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

async function refresh(): Promise<Cache> {
  const [symbols, ticker] = await Promise.all([getUniverse(), fetchBulkTicker24hr()])
  const ranked = symbols
    .filter((s) => ticker.has(s))
    .sort((a, b) => (ticker.get(b)?.quoteVolume ?? 0) - (ticker.get(a)?.quoteVolume ?? 0))
    .slice(0, MAX_COINS)
  const targets = ranked.includes('BTCUSDT') ? ranked : ['BTCUSDT', ...ranked]
  const candles = await fetchKlinesBatch(targets, '5m', LIMIT_5M, 12)
  if (candles.size === 0) throw new Error('Binance returned no 5M candles')
  return { at: Date.now(), candles, ticker, targets }
}

export interface ImpulseResponse {
  rows: ImpulseRow[]
  computedAt: number
  live: boolean
  config: ImpulseConfig
  error?: string
}

export async function GET(req: Request) {
  // Every dashboard setting arrives as a query param and is clamped by normalizeConfig (never trusted raw).
  const raw: Record<string, string> = {}
  new URL(req.url).searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const config = normalizeConfig(raw)
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = null
        })
      }
      cache = await inFlight
    }
    const now = Date.now()
    const rows: ImpulseRow[] = []
    for (const symbol of cache.targets) {
      const candles = cache.candles.get(symbol)
      const t = cache.ticker.get(symbol)
      if (!candles || !t) continue
      const row = buildImpulseRow({ symbol, price: t.price, change24h: t.changePct, candles, now, cfg: config })
      if (row) rows.push(row)
    }
    const body: ImpulseResponse = { rows, computedAt: cache.at, live: true, config }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: ImpulseResponse = {
      rows: [],
      computedAt: Date.now(),
      live: false,
      config,
      error: err instanceof Error ? err.message : 'Unknown error fetching Binance data',
    }
    return NextResponse.json(body, { status: 200 })
  }
}
