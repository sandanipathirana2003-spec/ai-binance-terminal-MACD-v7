import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch, type Candle } from '@/lib/binance'
import { MTF_TFS, buildMtfRow, normalizeMtfConfig, type MtfConfig, type MtfRow, type MtfTf } from '@/lib/mtf'

// Edge runtime for the same reason as the other routes (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Native Binance klines for every timeframe (no resampling). 1M gets 1000 bars (weight 5) so the replayed history covers
// ~16h; the others stay under 500 (weight 2). 5M needs 499 bars for a converged EMA 200.
const LIMITS: Record<MtfTf, number> = { '1m': 1000, '3m': 499, '5m': 499, '15m': 499 }
const CACHE_MS = 30_000
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 60 // 4 requests per coin per refresh

interface Cache {
  at: number
  candles: Record<MtfTf, Map<string, Candle[]>>
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
  const got = await Promise.all(MTF_TFS.map((tf) => fetchKlinesBatch(targets, tf, LIMITS[tf], 12)))
  const candles = {} as Cache['candles']
  MTF_TFS.forEach((tf, i) => (candles[tf] = got[i]))
  if (candles['5m'].size === 0) throw new Error('Binance returned no 5M candles')
  return { at: Date.now(), candles, ticker, targets }
}

export interface MtfResponse {
  rows: MtfRow[]
  computedAt: number
  live: boolean
  config: MtfConfig
  error?: string
}

export async function GET(req: Request) {
  const raw: Record<string, string> = {}
  new URL(req.url).searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const config = normalizeMtfConfig(raw) // every setting is clamped, never trusted raw
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
    const rows: MtfRow[] = []
    for (const symbol of cache.targets) {
      const t = cache.ticker.get(symbol)
      const c = {} as Record<MtfTf, Candle[]>
      let complete = Boolean(t)
      for (const tf of MTF_TFS) {
        const list = cache.candles[tf].get(symbol)
        if (!list) complete = false
        else c[tf] = list
      }
      if (!complete || !t) continue
      const row = buildMtfRow({ symbol, price: t.price, change24h: t.changePct, candles: c, now, cfg: config })
      if (row) rows.push(row)
    }
    const body: MtfResponse = { rows, computedAt: cache.at, live: true, config }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: MtfResponse = { rows: [], computedAt: Date.now(), live: false, config, error: err instanceof Error ? err.message : 'Unknown error fetching Binance data' }
    return NextResponse.json(body, { status: 200 })
  }
}
