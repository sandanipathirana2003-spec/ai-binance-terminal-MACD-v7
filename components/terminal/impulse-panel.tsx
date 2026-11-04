'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, BellOff, Search, Settings2, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct } from '@/lib/format'
import {
  summarizePerformance,
  type ImpulseConfig,
  type ImpulseRow,
  type ImpulseSignal,
  type ImpulseStatus,
  type SlMethod,
} from '@/lib/impulse5m'
import type { ImpulseResponse } from '@/app/api/impulse/route'
import type { ImpulsePopup } from '@/hooks/use-impulse-alerts'

// ------------------------------------------------------------------ formatting helpers

/** Price with enough digits for both BTC and sub-cent coins. */
function px(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (a >= 1) return v.toFixed(4)
  if (a >= 0.01) return v.toFixed(5)
  return v.toPrecision(4)
}
const small = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 1 ? v.toFixed(2) : v.toPrecision(3)) : '—')
const coinName = (s: string) => s.replace('USDT', '')
const when = (ms: number) =>
  new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

const SETUP: ImpulseStatus[] = [
  'IMPULSE OVERSOLD DETECTED',
  'IMPULSE OVERBOUGHT DETECTED',
  'IMPULSE REVERSAL STARTED',
  'IMPULSE EXITED OVERSOLD',
  'IMPULSE EXITED OVERBOUGHT',
  'WAITING FOR MACD CROSS',
  'MACD CONFIRMATION RECEIVED',
]

type Tone = 'bull' | 'bear' | 'warn' | 'muted' | 'primary'
const TONE: Record<Tone, string> = {
  bull: 'border-bull/40 bg-bull/15 text-bull',
  bear: 'border-bear/40 bg-bear/15 text-bear',
  warn: 'border-warn/50 bg-warn/10 text-warn',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  muted: 'border-border bg-muted text-muted-foreground',
}

function statusTone(s: ImpulseStatus, side: 'BUY' | 'SELL' | null): Tone {
  if (s === 'CONFIRMED BUY') return 'bull'
  if (s === 'CONFIRMED SELL') return 'bear'
  if (SETUP.includes(s)) return side === 'BUY' ? 'bull' : side === 'SELL' ? 'bear' : 'primary'
  if (s === 'WAITING FOR IMPULSE') return 'muted'
  return 'warn'
}

function Chip({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold', TONE[tone])}>
      {children}
    </span>
  )
}

function Card({ title, tone, value, sub }: { title: string; tone: Tone; value: string; sub?: string }) {
  return (
    <div className="border-border bg-card min-w-0 rounded-lg border p-2.5">
      <div className="text-muted-foreground font-mono text-[10px] uppercase">{title}</div>
      <div className={cn('mt-1 rounded border px-2 py-1 text-center font-mono text-[11px] font-extrabold leading-tight', TONE[tone])}>{value}</div>
      {sub ? <div className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">{sub}</div> : null}
    </div>
  )
}

function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground font-mono text-[11px]">{k}</span>
      <span className={cn('text-right font-mono text-[11px] font-semibold', cls)}>{v}</span>
    </div>
  )
}

// ------------------------------------------------------------------ trade plan

function TradePlan({ s, price, method }: { s: ImpulseSignal; price: number; method: SlMethod }) {
  const p = s.plan
  const bull = s.side === 'BUY'
  const tone = bull ? 'border-bull bg-bull/10' : 'border-bear bg-bear/10'
  if (!p) {
    return (
      <div className="border-warn/50 bg-warn/10 text-warn rounded-lg border p-3 font-mono text-xs">
        Setup rejected: no valid stop-loss ({method} and its fallbacks), or the stop was too tight to cover fees. WAIT — NO CONFIRMED TRADE.
      </div>
    )
  }
  return (
    <div className={cn('rounded-lg border-2 p-3', tone)}>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry (signal price)</div>
          <div className="font-mono text-base font-extrabold sm:text-lg">{px(s.entry)}</div>
        </div>
        <div>
          <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
          <div className="text-bear font-mono text-base font-extrabold sm:text-lg">{px(p.sl)}</div>
        </div>
        <div>
          <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
          <div className="text-bull font-mono text-base font-extrabold sm:text-lg">{px(p.tp)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 sm:grid-cols-5">
        <Row k="Risk" v={`${px(p.risk)} (${p.riskPct.toFixed(2)}%)`} />
        <Row k="Reward" v={px(p.reward)} />
        <Row k="R:R" v={`1:${(p.reward / p.risk).toFixed(1)}`} />
        <Row k="Live price" v={px(price)} />
        <Row k="Fees + slippage" v={`≈ ${p.costR.toFixed(2)}R`} />
      </div>
      <div className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">
        Entry is the signal candle close, not an executed order price — check the live price and slippage before ordering. Stop: {p.method.toUpperCase()}
        {p.fallback ? ` (fallback — ${method} was not valid)` : ''}. Signal candle closed {when(s.time)}.
      </div>
      {s.supertrend.against ? (
        <div className="text-warn mt-1.5 flex items-start gap-1.5 font-mono text-[11px] font-bold">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Supertrend 12,10 still points {s.supertrend.dir === 'BUY' ? 'up' : 'down'} against this entry — elevated reversal risk (signal not cancelled).
        </div>
      ) : null}
      {p.riskPct > 3 ? (
        <div className="text-warn mt-1 flex items-start gap-1.5 font-mono text-[11px] font-bold">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Wide stop: {p.riskPct.toFixed(1)}% of price. Size the position for that distance or switch the stop method in Settings.
        </div>
      ) : null}
      {s.tpNote ? <div className="text-warn mt-1 font-mono text-[11px]">{s.tpNote}</div> : null}
    </div>
  )
}

// ------------------------------------------------------------------ selected pair dashboard

function PairDashboard({ row, config }: { row: ImpulseRow; config: ImpulseConfig }) {
  const sig = row.signal
  const tone = statusTone(row.status, row.setupSide)
  const e = row.ema200
  const imp = row.impulse
  const emaTone: Tone = e.label.startsWith('ABOVE') ? 'bull' : e.label.startsWith('BELOW') ? 'bear' : e.label.includes('FLAT') ? 'warn' : 'warn'
  const impTone: Tone = imp.state.includes('OVERSOLD') || imp.state === 'REVERSING UP' ? 'bull' : imp.state.includes('OVERBOUGHT') || imp.state === 'REVERSING DOWN' ? 'bear' : 'muted'
  const mk = row.market.label === 'SUITABLE'
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="border-border bg-card rounded-xl border p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="font-mono text-xl font-extrabold">
            {coinName(row.symbol)}
            <span className="text-muted-foreground text-sm font-normal">/USDT · 5M</span>
          </h2>
          <div className="font-mono text-sm">
            ${px(row.price)} <span className={row.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(row.change24h)}</span>
            <span className="text-muted-foreground text-[10px]"> 24h</span>
          </div>
        </div>
        <div className="text-muted-foreground mt-0.5 font-mono text-[10px]">Last closed 5M candle: {when(row.barTime)} · confirmed signals use closed candles only</div>
      </div>

      <div className={cn('rounded-xl border-2 p-3 text-center', TONE[tone])}>
        <div className="font-mono text-[10px] uppercase opacity-80">Signal status</div>
        <div className="text-xl font-extrabold leading-tight tracking-wide sm:text-2xl">
          {sig ? `CONFIRMED ${sig.side} — IMPULSE REVERSAL + EMA 200 + MACD CROSS` : row.status}
        </div>
        {!sig ? <div className="mt-1 font-mono text-[11px] font-bold opacity-90">WAIT — NO CONFIRMED TRADE</div> : null}
        {!sig && row.market.reasons.length && !mk ? <div className="mt-1 font-mono text-[10px] opacity-80">{row.market.reasons.join(' · ')}</div> : null}
      </div>

      {sig ? <TradePlan s={sig} price={row.price} method={config.slMethod} /> : null}
      {sig ? (
        <ul className="border-border bg-card text-muted-foreground list-inside list-disc rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed">
          {sig.conditions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Card title="EMA 200" tone={emaTone} value={e.label} sub={`${e.distPct >= 0 ? '+' : ''}${e.distPct.toFixed(2)}% · ${e.distAtr.toFixed(1)} ATR · slope ${e.slope.toLowerCase()}`} />
        <Card
          title="EMA ribbon 20/50/100/200"
          tone={row.ribbon === 'BULLISH' ? 'bull' : row.ribbon === 'BEARISH' ? 'bear' : 'muted'}
          value={row.ribbon}
          sub={row.ribbon === 'MIXED' ? 'not aligned (not required)' : 'fully aligned = stronger'}
        />
        <Card
          title="Impulse MACD"
          tone={impTone}
          value={imp.state}
          sub={`hist ${small(imp.hist)} · zone ≤ ${small(imp.lower)} / ≥ ${small(imp.upper)}`}
        />
        <Card
          title="Regular MACD"
          tone={row.macd.state === 'BULLISH CROSS' ? 'bull' : row.macd.state === 'BEARISH CROSS' ? 'bear' : 'muted'}
          value={row.macd.state}
          sub={`${row.macd.direction.toLowerCase()} · ${row.macd.momentum.toLowerCase()} · ${row.macd.zero.toLowerCase()} zero`}
        />
        <Card
          title="Supertrend 12,10"
          tone={row.supertrend.dir === 'BUY' ? 'bull' : 'bear'}
          value={row.supertrend.dir}
          sub={`line ${px(row.supertrend.line)} · ${Math.abs(row.supertrend.distPct).toFixed(2)}% away${row.supertrend.flipBarsAgo != null ? ` · flipped ${row.supertrend.flipBarsAgo} bars ago` : ''}`}
        />
        <Card title="Market condition" tone={mk ? 'bull' : 'warn'} value={row.market.label} sub={`ATR ${row.market.atrPct.toFixed(2)}%${row.market.reasons[0] ? ` · ${row.market.reasons[0]}` : ''}`} />
      </div>

      <div className="border-border bg-card grid gap-x-6 rounded-lg border p-3 sm:grid-cols-2">
        <div>
          <div className="text-muted-foreground mb-1 font-mono text-[10px] uppercase">EMA ribbon</div>
          <Row k="EMA 20" v={px(row.ema.e20)} />
          <Row k="EMA 50" v={px(row.ema.e50)} />
          <Row k="EMA 100" v={px(row.ema.e100)} />
          <Row k="EMA 200" v={px(row.ema.e200)} cls="text-primary" />
        </div>
        <div>
          <div className="text-muted-foreground mb-1 font-mono text-[10px] uppercase">
            Impulse MACD {config.length}/{config.signalLength} · {config.source}
          </div>
          <Row k="Histogram" v={small(imp.hist)} cls={imp.hist >= 0 ? 'text-bull' : 'text-bear'} />
          <Row k="Signal line" v={small(imp.signal)} />
          <Row k="Momentum" v={`${imp.momentum}${imp.weakening ? ' · weakening' : ' · building'}`} />
          <Row k="Impulse direction" v={imp.direction} cls={imp.direction === 'BULLISH' ? 'text-bull' : imp.direction === 'BEARISH' ? 'text-bear' : ''} />
          <Row k="Extreme zone" v={`≤ ${small(imp.lower)} / ≥ ${small(imp.upper)}`} />
          <div className="text-muted-foreground font-mono text-[10px]">
            {config.thresholdMode === 'percentile' ? `P${config.lowerPct} / P${config.upperPct} of the last ${config.lookback} bars` : `${Math.round(config.extremeFrac * 100)}% of the ${config.lookback}-bar min / max`}
          </div>
        </div>
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ scanner

type Filter = 'ALL' | 'SIGNALS' | 'SETUPS' | 'BUY' | 'SELL'

function Scanner({ rows, selected, onSelect }: { rows: ImpulseRow[]; selected: string; onSelect: (s: string) => void }) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(25)
  const rank = (r: ImpulseRow) => (r.signal ? 3 : SETUP.includes(r.status) ? 2 : r.history.length ? 1 : 0)
  const list = useMemo(() => {
    const t = q.trim().toUpperCase()
    return rows
      .filter((r) => (t ? r.symbol.includes(t) : true))
      .filter((r) => (filter === 'SIGNALS' ? r.signal : filter === 'SETUPS' ? SETUP.includes(r.status) : filter === 'BUY' ? r.setupSide === 'BUY' : filter === 'SELL' ? r.setupSide === 'SELL' : true))
      .sort((a, b) => rank(b) - rank(a) || a.symbol.localeCompare(b.symbol))
  }, [rows, filter, q])
  useEffect(() => setLimit(25), [filter, q])
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Pairs ({list.length})</h3>
        <label className="border-border bg-background flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 sm:max-w-48">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pair" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(['ALL', 'SIGNALS', 'SETUPS', 'BUY', 'SELL'] as Filter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn('h-8 rounded-md border px-2.5 font-mono text-[11px] font-semibold', filter === f ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
          >
            {f}
          </button>
        ))}
      </div>
      <ul className="divide-border/60 divide-y">
        {list.slice(0, limit).map((r) => {
          const t = statusTone(r.status, r.setupSide)
          return (
            <li key={r.symbol}>
              <button
                type="button"
                onClick={() => onSelect(r.symbol)}
                className={cn('flex min-h-11 w-full items-center justify-between gap-2 px-1 py-2 text-left', r.symbol === selected && 'bg-accent/40')}
              >
                <span className="min-w-0">
                  <span className="block font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                  <span className="text-muted-foreground block font-mono text-[10px]">
                    ${px(r.price)} <span className={r.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(r.change24h)}</span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <Chip tone={t}>{r.signal ? `CONFIRMED ${r.signal.side}` : r.status}</Chip>
                  <span className="text-muted-foreground font-mono text-[9px]">{r.ema200.position} EMA200 · {r.impulse.state}</span>
                </span>
              </button>
            </li>
          )
        })}
        {list.length === 0 ? <li className="text-muted-foreground p-4 text-center font-mono text-xs">No pairs match.</li> : null}
      </ul>
      {list.length > limit ? (
        <button type="button" onClick={() => setLimit((l) => l + 25)} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
          Show more
        </button>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------------ history + performance

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="border-border min-w-0 rounded-lg border p-2">
      <div className="text-muted-foreground font-mono text-[10px] uppercase">{k}</div>
      <div className={cn('font-mono text-base font-extrabold', cls)}>{v}</div>
    </div>
  )
}

function History({ rows, hours, config, onSelect }: { rows: ImpulseRow[]; hours: number; config: ImpulseConfig; onSelect: (s: string) => void }) {
  const all = useMemo(() => rows.flatMap((r) => r.history).sort((a, b) => b.time - a.time), [rows])
  const perf = useMemo(() => summarizePerformance(all), [all])
  const [limit, setLimit] = useState(20)
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-3">
      <div>
        <h3 className="text-sm font-bold">Signal history &amp; performance</h3>
        <p className="text-muted-foreground mt-0.5 font-mono text-[10px] leading-snug">
          Replay of the last ~{hours}h of 5M candles for the pairs above (most recent 20 per pair), with {config.feeBps} bps fee + {config.slipBps} bps slippage per side. If SL and TP sit
          in one candle the stop is assumed hit first. A short replay is not a backtest and proves nothing about future results — run scripts/backtest-impulse.ts for months of history.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat k="BUY signals" v={String(perf.buys)} cls="text-bull" />
        <Stat k="SELL signals" v={String(perf.sells)} cls="text-bear" />
        <Stat k="Wins / losses" v={`${perf.wins} / ${perf.losses}`} />
        <Stat k="Win rate" v={perf.wins + perf.losses ? `${perf.winRate.toFixed(0)}%` : '—'} />
        <Stat k="Total R (net)" v={perf.wins + perf.losses ? `${perf.totalR >= 0 ? '+' : ''}${perf.totalR.toFixed(1)}R` : '—'} cls={perf.totalR >= 0 ? 'text-bull' : 'text-bear'} />
        <Stat k="Avg R / trade" v={perf.wins + perf.losses ? `${perf.avgR >= 0 ? '+' : ''}${perf.avgR.toFixed(2)}R` : '—'} />
        <Stat k="Max drawdown" v={perf.wins + perf.losses ? `${perf.maxDrawdownR.toFixed(1)}R` : '—'} cls="text-bear" />
        <Stat k="Price P/L sum" v={perf.wins + perf.losses ? formatPct(perf.totalPnlPct) : '—'} />
      </div>
      {perf.monthly.length ? (
        <div className="text-muted-foreground font-mono text-[11px]">
          Monthly: {perf.monthly.map((m) => `${m.month} ${m.trades} trades ${m.r >= 0 ? '+' : ''}${m.r.toFixed(1)}R`).join(' · ')}
        </div>
      ) : null}
      <ul className="divide-border/60 divide-y">
        {all.slice(0, limit).map((s) => {
          const o = s.outcome
          const res = o ? o.result : '—'
          return (
            <li key={s.id} className="py-2">
              <div className="flex items-center justify-between gap-2">
                <button type="button" onClick={() => onSelect(s.symbol)} className="flex min-h-9 items-center gap-2 text-left">
                  <Chip tone={s.side === 'BUY' ? 'bull' : 'bear'}>{s.side}</Chip>
                  <span className="font-mono text-sm font-bold">{coinName(s.symbol)}</span>
                  <span className="text-muted-foreground font-mono text-[10px]">{when(s.time)}</span>
                </button>
                <span className={cn('font-mono text-xs font-extrabold', res === 'WIN' ? 'text-bull' : res === 'LOSS' ? 'text-bear' : 'text-muted-foreground')}>
                  {res}
                  {o ? ` ${o.r >= 0 ? '+' : ''}${o.r.toFixed(2)}R (${formatPct(o.pnlPct)})` : ''}
                </span>
              </div>
              <div className="text-muted-foreground font-mono text-[10px]">
                Entry {px(s.entry)} · SL {s.plan ? px(s.plan.sl) : '—'} · TP {s.plan ? px(s.plan.tp) : '—'}
              </div>
              <details className="text-muted-foreground font-mono text-[10px]">
                <summary className="cursor-pointer py-0.5">conditions</summary>
                <ul className="list-inside list-disc leading-relaxed">
                  {s.conditions.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                  <li>
                    Supertrend {s.supertrend.dir}
                    {s.supertrend.against ? ' (against entry)' : ''}
                  </li>
                </ul>
              </details>
            </li>
          )
        })}
        {all.length === 0 ? <li className="text-muted-foreground p-4 text-center font-mono text-xs">No confirmed signals in the replay window — the full rule is strict by design.</li> : null}
      </ul>
      {all.length > limit ? (
        <button type="button" onClick={() => setLimit((l) => l + 20)} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
          Show more
        </button>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------------ settings

type NumKey = 'length' | 'signalLength' | 'lookback' | 'upperPct' | 'lowerPct' | 'extremeFrac' | 'rr' | 'atrMult' | 'maxCrossWait'

const NUM_FIELDS: Array<{ key: NumKey; label: string; step: number }> = [
  { key: 'length', label: 'Impulse length', step: 1 },
  { key: 'signalLength', label: 'Impulse signal', step: 1 },
  { key: 'lookback', label: 'Zone lookback (bars)', step: 10 },
  { key: 'lowerPct', label: 'Oversold percentile', step: 1 },
  { key: 'upperPct', label: 'Overbought percentile', step: 1 },
  { key: 'extremeFrac', label: 'Extreme fraction', step: 0.05 },
  { key: 'maxCrossWait', label: 'MACD wait (bars)', step: 1 },
  { key: 'rr', label: 'Reward : risk', step: 0.5 },
  { key: 'atrMult', label: 'ATR stop multiple', step: 0.1 },
]

function Settings({ config, onApply }: { config: ImpulseConfig; onApply: (c: Partial<ImpulseConfig>) => void }) {
  const [d, setD] = useState<ImpulseConfig>(config)
  useEffect(() => setD(config), [config])
  const sel = 'border-border bg-background h-10 w-full rounded-md border px-2 font-mono text-xs'
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className="flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground">
            {f.label}
            <input
              type="number"
              inputMode="decimal"
              step={f.step}
              value={d[f.key]}
              onChange={(e) => setD({ ...d, [f.key]: Number(e.target.value) })}
              className="border-border bg-background text-foreground h-10 rounded-md border px-2 text-sm normal-case"
            />
          </label>
        ))}
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground">
          Zone method
          <select className={sel} value={d.thresholdMode} onChange={(e) => setD({ ...d, thresholdMode: e.target.value as ImpulseConfig['thresholdMode'] })}>
            <option value="percentile">Rolling percentile</option>
            <option value="extreme">Recent extremes</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground">
          Price source
          <select className={sel} value={d.source} onChange={(e) => setD({ ...d, source: e.target.value as ImpulseConfig['source'] })}>
            <option value="close">Close</option>
            <option value="hlc3">HLC3 (LazyBear original)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground">
          Stop-loss method
          <select className={sel} value={d.slMethod} onChange={(e) => setD({ ...d, slMethod: e.target.value as SlMethod })}>
            <option value="supertrend">Supertrend 12,10 (default)</option>
            <option value="swing">Recent swing high/low</option>
            <option value="atr">ATR</option>
          </select>
        </label>
      </div>
      <div className="flex gap-2">
        <button type="button" onClick={() => onApply(d)} className="bg-primary text-primary-foreground h-10 flex-1 rounded-md text-sm font-semibold">
          Apply
        </button>
        <button type="button" onClick={() => onApply({})} className="border-border text-muted-foreground h-10 rounded-md border px-4 text-sm font-semibold">
          Reset defaults
        </button>
      </div>
      <p className="text-muted-foreground font-mono text-[10px] leading-snug">
        The strategy rules (EMA 200 filter, Impulse MACD exit, MACD cross, closed candle) are fixed. Changing numbers changes what counts as an extreme zone or how stops are sized; it does not make the signal more
        accurate. Settings are saved in this browser.
      </p>
    </section>
  )
}

// ------------------------------------------------------------------ popups (rendered once, from the terminal shell)

export function ImpulsePopups({ popups, onDismiss, onOpen }: { popups: ImpulsePopup[]; onDismiss: (id: string) => void; onOpen: (s: string) => void }) {
  if (popups.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 flex max-h-dvh flex-col items-center gap-2 overflow-y-auto p-2 sm:items-end">
      {popups.slice(0, 1).map(({ signal: s, row }) => {
        const bull = s.side === 'BUY'
        const p = s.plan!
        return (
          <article key={s.id} className={cn('bg-card pointer-events-auto w-full max-w-md rounded-xl border-2 p-3 shadow-2xl', bull ? 'border-bull' : 'border-bear')}>
            <header className="flex items-start justify-between gap-2">
              <div>
                <div className={cn('text-base font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>CONFIRMED {s.side} — 5M IMPULSE REVERSAL</div>
                <div className="font-mono text-sm font-bold">{coinName(s.symbol)}/USDT · 5M</div>
              </div>
              <button type="button" onClick={() => onDismiss(s.id)} aria-label="Dismiss" className="text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md">
                <X className="size-5" />
              </button>
            </header>
            <div className="mt-2 grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry</div>
                <div className="font-mono text-base font-extrabold">{px(s.entry)}</div>
              </div>
              <div>
                <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
                <div className="text-bear font-mono text-base font-extrabold">{px(p.sl)}</div>
              </div>
              <div>
                <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
                <div className="text-bull font-mono text-base font-extrabold">{px(p.tp)}</div>
              </div>
            </div>
            <div className="mt-2">
              <Row k="EMA 20 / 50" v={`${px(s.ema.e20)} / ${px(s.ema.e50)}`} />
              <Row k="EMA 100 / 200" v={`${px(s.ema.e100)} / ${px(s.ema.e200)}`} />
              <Row k="EMA 200 position" v={s.ema200Pos} cls={bull ? 'text-bull' : 'text-bear'} />
              <Row k="Impulse MACD" v={bull ? 'EXITED OVERSOLD' : 'EXITED OVERBOUGHT'} />
              <Row k="Impulse direction" v={bull ? 'BULLISH' : 'BEARISH'} />
              <Row k="Regular MACD" v={bull ? 'BULLISH CROSSOVER' : 'BEARISH CROSSOVER'} />
              <Row k="Histogram" v={`${small(s.macd.hist)} · ${bull ? 'bullish' : 'bearish'} confirmation`} />
              <Row k="Supertrend 12,10" v={`${s.supertrend.dir}${s.supertrend.against ? ' — AGAINST (higher risk)' : ''}`} cls={s.supertrend.against ? 'text-warn' : ''} />
              <Row k="Market condition" v="SUITABLE" />
              <Row k="Signal time (candle close)" v={when(s.time)} />
              <Row k="Live price now" v={px(row.price)} />
            </div>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  onOpen(s.symbol)
                  onDismiss(s.id)
                }}
                className="bg-primary text-primary-foreground h-11 flex-1 rounded-md text-sm font-semibold"
              >
                Open {coinName(s.symbol)}
              </button>
              <button type="button" onClick={() => onDismiss(s.id)} className="border-border text-muted-foreground h-11 rounded-md border px-4 text-sm font-semibold">
                Dismiss
              </button>
            </div>
            {popups.length > 1 ? <div className="text-primary mt-1.5 text-center font-mono text-[11px] font-bold">+{popups.length - 1} more confirmed signal{popups.length > 2 ? 's' : ''} waiting</div> : null}
            <p className="text-muted-foreground mt-1.5 font-mono text-[10px] leading-snug">A filter, not a prediction. Entry is the candle close; confirm the live price before ordering.</p>
          </article>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ panel

export interface ImpulsePanelProps {
  data: ImpulseResponse | undefined
  isLoading: boolean
  config: ImpulseConfig
  onConfig: (c: Partial<ImpulseConfig>) => void
  selected: string
  onSelect: (s: string) => void
  alerts: { permission: NotificationPermission | 'unsupported'; requestPermission: () => void; soundEnabled: boolean; toggleSound: () => void }
}

export function ImpulsePanel({ data, isLoading, config, onConfig, selected, onSelect, alerts }: ImpulsePanelProps) {
  const [showSettings, setShowSettings] = useState(false)
  const rows = data?.rows ?? []
  const row = rows.find((r) => r.symbol === selected) ?? rows.find((r) => r.symbol === 'BTCUSDT') ?? rows[0]
  const hours = Math.max(1, Math.round(((rows[0]?.bars ?? 0) - 250) / 12))

  if (isLoading && !data) return <div className="text-muted-foreground p-6 text-center font-mono text-sm">Loading 5M candles…</div>
  if (data && !data.live) {
    return (
      <div className="border-bear/30 bg-bear/10 text-bear m-3 rounded-lg border p-3 font-mono text-xs">
        Binance data is unavailable right now ({data.error ?? 'unknown error'}). No signals are shown — retrying automatically, nothing fake is being displayed.
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-2 sm:p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-extrabold sm:text-lg">5M Impulse MACD + EMA 200 + MACD Cross</h1>
          <p className="text-muted-foreground font-mono text-[10px]">
            {rows.length} pairs · updated {data ? new Date(data.computedAt).toLocaleTimeString([], { hour12: false }) : '—'} · closed candles only
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <button type="button" onClick={alerts.toggleSound} aria-label="Toggle sound" className="border-border text-muted-foreground flex size-10 items-center justify-center rounded-md border">
            {alerts.soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
          </button>
          {alerts.permission !== 'unsupported' ? (
            <button
              type="button"
              onClick={alerts.requestPermission}
              disabled={alerts.permission !== 'default'}
              aria-label="Browser notifications"
              className={cn('flex h-10 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold', alerts.permission === 'granted' ? 'border-bull/40 text-bull' : 'border-border text-muted-foreground')}
            >
              {alerts.permission === 'granted' ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {alerts.permission === 'granted' ? 'Alerts on' : alerts.permission === 'denied' ? 'Blocked' : 'Enable alerts'}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Settings"
            className={cn('flex size-10 items-center justify-center rounded-md border', showSettings ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
          >
            <Settings2 className="size-4" />
          </button>
        </div>
      </header>

      {showSettings ? <Settings config={config} onApply={onConfig} /> : null}

      <label className="flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground lg:hidden">
        Trading pair
        <select value={row?.symbol ?? ''} onChange={(e) => onSelect(e.target.value)} className="border-border bg-card text-foreground h-11 rounded-md border px-2 font-mono text-sm">
          {[...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((r) => (
            <option key={r.symbol} value={r.symbol}>
              {coinName(r.symbol)}
              {r.signal ? ` — CONFIRMED ${r.signal.side}` : ''}
            </option>
          ))}
        </select>
      </label>

      <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]">
        {row ? <PairDashboard row={row} config={config} /> : <div className="text-muted-foreground p-6 text-center font-mono text-sm">No pairs have enough candle history yet.</div>}
        <div className="flex min-w-0 flex-col gap-3 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto">
          <Scanner rows={rows} selected={row?.symbol ?? ''} onSelect={onSelect} />
        </div>
      </div>

      <History rows={rows} hours={hours} config={config} onSelect={onSelect} />
    </div>
  )
}
