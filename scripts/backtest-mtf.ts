// Back-test the MTF Supertrend + MACD cross strategy on real Binance history and compare variants.
//
//   npx tsx scripts/backtest-mtf.ts --symbols BTCUSDT,ETHUSDT,SOLUSDT --days 60
//   npx tsx scripts/backtest-mtf.ts --synthetic        (offline smoke test of this script only)
//
// Options: --fee 4 --slip 2 (bps per side)  --rr 2  --csv trades.csv
// No look-ahead: each 5M signal only sees candles of the other timeframes that had CLOSED by that 5M close
// (scripts/test-mtf.ts proves prefix runs reproduce the full run). SL and TP in one candle -> the stop counts first.
import { writeFileSync } from 'node:fs'
import type { Candle } from '../lib/binance'
import { summarizePerformance } from '../lib/impulse5m'
import { analyzeMtf, normalizeMtfConfig, MTF_MS, MTF_TFS, type MtfConfig, type MtfSignal, type MtfTf } from '../lib/mtf'
import { resampleAligned } from '../lib/reversal'

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? process.argv[i + 1] : d
}
const has = (k: string) => process.argv.includes(`--${k}`)

async function fetchTf(symbol: string, tf: MtfTf, days: number): Promise<Candle[]> {
  const ms = MTF_MS[tf]
  const end = Math.floor(Date.now() / ms) * ms
  let start = end - days * 86_400_000
  const out: Candle[] = []
  while (start < end) {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&startTime=${start}&limit=1500`)
    if (!res.ok) throw new Error(`${symbol} ${tf}: HTTP ${res.status}`)
    const raw = (await res.json()) as unknown[][]
    if (raw.length === 0) break
    for (const k of raw) out.push({ openTime: k[0] as number, open: +(k[1] as string), high: +(k[2] as string), low: +(k[3] as string), close: +(k[4] as string), volume: +(k[5] as string) })
    start = (raw[raw.length - 1][0] as number) + ms
    await new Promise((r) => setTimeout(r, 120))
  }
  return out.filter((c) => c.openTime + ms <= end)
}

function synthetic(seed: number): Candle[] {
  let s = seed
  const r = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296
  const out: Candle[] = []
  let p = 100
  const t0 = Math.floor(Date.UTC(2026, 0, 1) / 900000) * 900000
  for (let i = 0; i < 30_000; i++) {
    const o = p
    const w = 0.0016 * Math.cos((2 * Math.PI * i) / 45) + 0.0009 * Math.cos((2 * Math.PI * i) / 190) + 0.0007 * Math.cos((2 * Math.PI * i) / 700)
    p = Math.max(1, p * (1 + Math.sin(i / 9000) * 0.00005 + w * 0.12 + (r() - 0.5) * 0.0016))
    out.push({ openTime: t0 + i * 60000, open: o, high: Math.max(o, p) * (1 + r() * 0.0003), low: Math.min(o, p) * (1 - r() * 0.0003), close: p, volume: 100 + r() * 50 })
  }
  return out
}

async function main() {
  const days = Number(arg('days', '60'))
  const base = normalizeMtfConfig({ feeBps: arg('fee'), slipBps: arg('slip'), rr: arg('rr') })
  const data = new Map<string, Record<MtfTf, Candle[]>>()
  if (has('synthetic')) {
    console.log('*** SYNTHETIC data: this only proves the script runs. The numbers say NOTHING about the strategy. ***')
    ;[1, 2].forEach((n) => {
      const m = synthetic(n * 31)
      data.set(`SYN${n}`, { '1m': m, '3m': resampleAligned(m, 3), '5m': resampleAligned(m, 5), '15m': resampleAligned(m, 15) })
    })
  } else {
    for (const s of (arg('symbols', 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT') as string).split(',')) {
      const rec = {} as Record<MtfTf, Candle[]>
      for (const tf of MTF_TFS) {
        process.stdout.write(`fetching ${s} ${tf}… `)
        rec[tf] = await fetchTf(s, tf, days)
        console.log(rec[tf].length)
      }
      data.set(s, rec)
    }
  }
  const variants: Array<{ name: string; cfg: Partial<MtfConfig> }> = [
    { name: 'FULL agreement (defaults)', cfg: {} },
    { name: 'strong majority (3 of 4)', cfg: { level: 'STRONG' } },
    { name: 're-arm only when agreement lost', cfg: { rearm: 'agreement' } },
    { name: 'min gap 12 bars', cfg: { minGapBars: 12 } },
    { name: 'stop = swing', cfg: { slMethod: 'swing' } },
    { name: 'stop = ATR x1.5', cfg: { slMethod: 'atr' } },
    { name: 'R:R 1:1.5', cfg: { rr: 1.5 } },
    { name: 'R:R 1:3', cfg: { rr: 3 } },
    { name: 'Supertrend 10,3 (comparison only)', cfg: { stMult: 3, stPeriod: 10 } },
  ]
  const lines: string[] = []
  let main: MtfSignal[] = []
  for (const v of variants) {
    const sigs: MtfSignal[] = []
    for (const [sym, c] of data) sigs.push(...(analyzeMtf(sym, c, { ...base, ...v.cfg })?.signals ?? []))
    if (v === variants[0]) main = sigs
    const p = summarizePerformance(sigs)
    const done = p.wins + p.losses
    lines.push(`${v.name.padEnd(36)} ${String(p.total).padStart(6)} ${String(done).padStart(6)} ${(done ? p.winRate.toFixed(1) + '%' : '-').padStart(7)} ${(done ? p.expectancyR.toFixed(3) : '-').padStart(9)} ${(done ? p.totalR.toFixed(1) : '-').padStart(8)} ${(done ? p.maxDrawdownR.toFixed(1) : '-').padStart(7)}`)
  }
  console.log(`\n${'variant'.padEnd(36)} ${'signals'.padStart(6)} ${'closed'.padStart(6)} ${'win%'.padStart(7)} ${'expect(R)'.padStart(9)} ${'total R'.padStart(8)} ${'maxDD R'.padStart(7)}`)
  console.log(lines.join('\n'))
  console.log(`\nFees ${base.feeBps} bps + slippage ${base.slipBps} bps per side are included. A good number on one sample is not proof of an edge: check other symbols, months and your real fees.`)
  const p = summarizePerformance(main)
  console.log('Default strategy by month:', p.monthly.map((m) => `${m.month}: ${m.trades} trades ${m.r >= 0 ? '+' : ''}${m.r.toFixed(1)}R`).join(' | ') || 'no closed trades')
  const csv = arg('csv')
  if (csv) {
    writeFileSync(csv, ['symbol,side,time,entry,sl,tp,method,result,netR,pnlPct', ...main.map((s) => [s.symbol, s.side, new Date(s.time).toISOString(), s.entry, s.plan.sl, s.plan.tp, s.plan.method, s.outcome?.result ?? '', s.outcome?.r.toFixed(3) ?? '', s.outcome?.pnlPct.toFixed(3) ?? ''].join(','))].join('\n'))
    console.log(`wrote ${csv}`)
  }
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
