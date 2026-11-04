import { NextResponse } from 'next/server'
import { fetchBulkTicker24hr, fetchFuturesUniverse, fetchKlinesBatch, type Candle } from '@/lib/binance'
import { MACD_TFS, buildMacdRow, normalizeMacdConfig, type MacdConfig, type MacdRow, type MacdTf } from '@/lib/macdmtf'

// Edge runtime for the same reason as the other routes (Binance blocks US IPs; edge runs near the visitor).
export const runtime = 'edge'
export const dynamic = 'force-dynamic'

// Native Binance klines for every timeframe (nothing is resampled). 1M gets 1000 bars (request weight 5, ~16 h of replay);
// the others stay under 500 (weight 2). 499 bars keeps EMA 200 converged on the 5M trigger and covers ~10 days of 30M.
const LIMITS: Record<MacdTf, number> = { '1m': 1000, '3m': 499, '5m': 499, '15m': 499, '30m': 499 }
const CACHE_MS = 30_000
const UNIVERSE_CACHE_MS = 60 * 60 * 1000
const MAX_COINS = 50 // 5 requests per coin per refresh (~650 request weight, well under Binance's 2400 / minute)

interface Cache {
  at: number
  candles: Record<MacdTf, Map<string, Candle[]>>
  ticker: Map<string, { price: number; changePct: number; quoteVolume: number }>
  targets: string[]
}

let cache: Cache | null = null
let inFlight: Promise<Cache> | null = null
let universe: { at: number; symbols: string[] } | null = null
/** Computed rows per (candle snapshot, config): a second viewer or a re-render does not recompute 50 pairs. */
const rowsCache = new Map<string, MacdRow[]>()

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
  const got = await Promise.all(MACD_TFS.map((tf) => fetchKlinesBatch(targets, tf, LIMITS[tf], 12)))
  const candles = {} as Cache['candles']
  MACD_TFS.forEach((tf, i) => (candles[tf] = got[i]))
  if (candles['5m'].size === 0) throw new Error('Binance returned no 5M candles')
  return { at: Date.now(), candles, ticker, targets }
}

export interface MacdResponse {
  rows: MacdRow[]
  computedAt: number
  live: boolean
  config: MacdConfig
  error?: string
}

export async function GET(req: Request) {
  const raw: Record<string, string> = {}
  new URL(req.url).searchParams.forEach((v, k) => {
    raw[k] = v
  })
  const config = normalizeMacdConfig(raw) // every setting is clamped, never trusted raw
  try {
    if (!cache || Date.now() - cache.at > CACHE_MS) {
      if (!inFlight) {
        inFlight = refresh().finally(() => {
          inFlight = null
        })
      }
      cache = await inFlight
    }
    const snap = cache
    const key = `${snap.at}|${JSON.stringify(config)}`
    let rows = rowsCache.get(key)
    if (!rows) {
      const now = Date.now()
      rows = []
      for (const symbol of snap.targets) {
        const t = snap.ticker.get(symbol)
        const c = {} as Record<MacdTf, Candle[]>
        let complete = Boolean(t)
        for (const tf of MACD_TFS) {
          const list = snap.candles[tf].get(symbol)
          if (!list) complete = false
          else c[tf] = list
        }
        if (!complete || !t) continue
        const row = buildMacdRow({ symbol, price: t.price, change24h: t.changePct, candles: c, now, cfg: config })
        if (row) rows.push(row)
      }
      rowsCache.set(key, rows)
      while (rowsCache.size > 4) rowsCache.delete(rowsCache.keys().next().value as string)
    }
    const body: MacdResponse = { rows, computedAt: snap.at, live: true, config }
    return NextResponse.json(body)
  } catch (err) {
    // Never show made-up data: if Binance is unreachable, say so.
    const body: MacdResponse = { rows: [], computedAt: Date.now(), live: false, config, error: err instanceof Error ? err.message : 'Unknown error fetching Binance data' }
    return NextResponse.json(body, { status: 200 })
  }
}
