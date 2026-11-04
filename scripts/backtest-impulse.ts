// Back-test the 5M Impulse MACD strategy on real Binance history and compare variants.
//
//   npx tsx scripts/backtest-impulse.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 90
//   npx tsx scripts/backtest-impulse.ts --synthetic            (offline smoke test of this script on generated candles)
//
// Options: --fee 4 --slip 2 (bps per side)  --rr 2  --csv trades.csv
//
// Why this is free of look-ahead: analyzeImpulse() only reads bars <= i at bar i (EMA/ATR recursions, thresholds from a
// trailing window, signals fire on the close). scripts/test-impulse.ts proves it by comparing prefix runs with the full run.
// Fills: entry = signal candle close; SL/TP are checked on later candles; if both sit inside one candle the SL counts first.
import { writeFileSync } from 'node:fs'
import type { Candle } from '../lib/binance'
import { analyzeImpulse, normalizeConfig, summarizePerformance, IMPULSE_TF_MS, type ImpulseConfig, type ImpulseSignal } from '../lib/impulse5m'

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const has = (k: string) => process.argv.includes(`--${k}`)

async function fetchHistory(symbol: string, days: number): Promise<Candle[]> {
  const end = Math.floor(Date.now() / IMPULSE_TF_MS) * IMPULSE_TF_MS
  let start = end - days * 86_400_000
  const out: Candle[] = []
  while (start < end) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=5m&startTime=${start}&limit=1000`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`)
    const raw = (await res.json()) as unknown[][]
    if (raw.length === 0) break
    for (const k of raw) out.push({ openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string) })
    start = (raw[raw.length - 1][0] as number) + IMPULSE_TF_MS
    await new Promise((r) => setTimeout(r, 120))
  }
  return out.filter((c) => c.openTime + IMPULSE_TF_MS <= end) // closed candles only
}

function synthetic(seed: number): Candle[] {
  let s = seed
  const r = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
  const out: Candle[] = []
  let p = 100
  const t0 = Date.UTC(2026, 0, 1)
  for (let i = 0; i < 30_000; i++) {
    const o = p
    const regime = Math.sin(i / 2500) * 0.00012
    p = Math.max(1, p * (1 + regime + (0.01 * Math.cos((2 * Math.PI * i) / 60) * 2 * Math.PI) / 60 + (r() - 0.5) * 0.003))
    out.push({ openTime: t0 + i * IMPULSE_TF_MS, open: o, high: Math.max(o, p) * (1 + r() * 0.0006), low: Math.min(o, p) * (1 - r() * 0.0006), close: p, volume: 100 + r() * 80 })
  }
  return out
}

interface Variant {
  name: string
  cfg: Partial<ImpulseConfig>
}

async function main() {
  const symbols = (arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT') as string).split(',')
  const days = Number(arg('days', '90'))
  const base = normalizeConfig({ feeBps: arg('fee'), slipBps: arg('slip'), rr: arg('rr') })
  const data = new Map<string, Candle[]>()
  if (has('synthetic')) {
    console.log('*** SYNTHETIC periodic data: this only proves the script runs. The numbers below say NOTHING about the strategy. ***')
    ;[1, 2, 3].forEach((n) => data.set(`SYN${n}`, synthetic(n * 77)))
  } else {
    for (const s of symbols) {
      process.stdout.write(`fetching ${s} (${days}d of 5M)… `)
      data.set(s, await fetchHistory(s, days))
      console.log(`${data.get(s)!.length} candles`)
    }
  }

  const variants: Variant[] = [
    { name: 'FULL strategy (defaults)', cfg: {} },
    { name: 'lookback 100', cfg: { lookback: 100 } },
    { name: 'lookback 300', cfg: { lookback: 300 } },
    { name: 'zone = recent extremes (80%)', cfg: { thresholdMode: 'extreme' } },
    { name: 'zone = P5/P95', cfg: { lowerPct: 5, upperPct: 95 } },
    { name: 'NO EMA 200 filter', cfg: { requireEma200: false } },
    { name: 'NO MACD cross (exit only)', cfg: { requireMacdCross: false } },
    { name: 'MACD cross + EMA 200 only (no impulse)', cfg: { requireImpulse: false } },
    { name: 'stop = swing', cfg: { slMethod: 'swing' } },
    { name: 'stop = ATR x1.5', cfg: { slMethod: 'atr' } },
    { name: 'hlc3 source (LazyBear original)', cfg: { source: 'hlc3' } },
  ]

  const rows: string[] = []
  let fullSignals: ImpulseSignal[] = []
  for (const v of variants) {
    const sigs: ImpulseSignal[] = []
    for (const [sym, candles] of data) {
      const a = analyzeImpulse(sym, candles, { ...base, ...v.cfg })
      if (a) sigs.push(...a.signals)
    }
    if (v === variants[0]) fullSignals = sigs
    const p = summarizePerformance(sigs)
    const done = p.wins + p.losses
    rows.push(
      `${v.name.padEnd(42)} ${String(p.total).padStart(6)} ${String(done).padStart(6)} ${(done ? p.winRate.toFixed(1) + '%' : '-').padStart(7)} ${(done ? p.expectancyR.toFixed(3) : '-').padStart(9)} ${(done ? p.totalR.toFixed(1) : '-').padStart(8)} ${(done ? p.maxDrawdownR.toFixed(1) : '-').padStart(7)}`,
    )
  }
  console.log(`\n${'variant'.padEnd(42)} ${'signals'.padStart(6)} ${'closed'.padStart(6)} ${'win%'.padStart(7)} ${'expect(R)'.padStart(9)} ${'total R'.padStart(8)} ${'maxDD R'.padStart(7)}`)
  console.log(rows.join('\n'))
  console.log(`\nFees ${base.feeBps} bps + slippage ${base.slipBps} bps per side are included in every R figure. Expectancy = average net R per closed trade.`)
  console.log('A positive number on one sample is not proof of an edge: check it across symbols, months and the fee/slippage you actually pay.')

  const p = summarizePerformance(fullSignals)
  console.log('\nFULL strategy by month:', p.monthly.map((m) => `${m.month}: ${m.trades} trades ${m.r >= 0 ? '+' : ''}${m.r.toFixed(1)}R`).join(' | ') || 'no closed trades')
  const csv = arg('csv')
  if (csv) {
    const head = 'symbol,side,time,entry,sl,tp,method,result,netR,pnlPct'
    const lines = fullSignals.map((s) => [s.symbol, s.side, new Date(s.time).toISOString(), s.entry, s.plan.sl, s.plan.tp, s.plan.method, s.outcome?.result ?? '', s.outcome?.r.toFixed(3) ?? '', s.outcome?.pnlPct.toFixed(3) ?? ''].join(','))
    writeFileSync(csv, [head, ...lines].join('\n'))
    console.log(`wrote ${csv}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
