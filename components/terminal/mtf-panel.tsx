'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, BellOff, Search, Settings2, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct } from '@/lib/format'
import { summarizePerformance, type SlMethod } from '@/lib/impulse5m'
import { MTF_LABEL, MTF_TFS, type Dir, type MtfConfig, type MtfRow, type MtfSignal, type TfView } from '@/lib/mtf'
import type { MtfResponse } from '@/app/api/mtf/route'
import type { MtfPopup } from '@/hooks/use-mtf-alerts'

// ------------------------------------------------------------------ helpers

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
const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })

type Tone = 'bull' | 'bear' | 'warn' | 'muted' | 'primary'
const TONE: Record<Tone, string> = {
  bull: 'border-bull/40 bg-bull/15 text-bull',
  bear: 'border-bear/40 bg-bear/15 text-bear',
  warn: 'border-warn/50 bg-warn/10 text-warn',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  muted: 'border-border bg-muted text-muted-foreground',
}
const dirTone = (d: Dir | 'BUY' | 'SELL' | 'ABOVE' | 'BELOW'): Tone =>
  d === 'BULLISH' || d === 'BUY' || d === 'ABOVE' ? 'bull' : d === 'BEARISH' || d === 'SELL' || d === 'BELOW' ? 'bear' : 'warn'

function entryTone(s: string, side: 'BUY' | 'SELL' | null): Tone {
  if (s === 'CONFIRMED BUY') return 'bull'
  if (s === 'CONFIRMED SELL') return 'bear'
  if (s.startsWith('WAITING') || s === 'MACD CROSSOVER DETECTED' || s === 'EMA 200 CONFIRMED') return side === 'BUY' ? 'bull' : side === 'SELL' ? 'bear' : 'primary'
  if (s.startsWith('WAIT')) return 'muted'
  return 'warn'
}

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={cn('inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold', TONE[tone])}>{children}</span>
}

function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded border px-1.5 py-1.5 text-center font-mono text-[11px] font-extrabold leading-tight sm:text-xs', TONE[tone], className)}>{children}</div>
}

function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground font-mono text-[11px]">{k}</span>
      <span className={cn('text-right font-mono text-[11px] font-semibold', cls)}>{v}</span>
    </div>
  )
}

function Section({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-2.5 rounded-xl border p-3">
      <h2 className="flex items-center gap-2 text-sm font-extrabold uppercase tracking-wide">
        <span className="bg-primary/15 text-primary flex size-5 items-center justify-center rounded font-mono text-[11px]">{n}</span>
        {title}
      </h2>
      {children}
    </section>
  )
}

// ------------------------------------------------------------------ 1. Supertrend MTF scanner

function SupertrendScanner({ row, updatedAt }: { row: MtfRow; updatedAt: number }) {
  const g = row.agreement
  const tone: Tone = g.tradeable ? dirTone(g.tradeable === 'BUY' ? 'BULLISH' : 'BEARISH') : g.level === 'STRONG' ? dirTone(g.dominant) : g.dominant === 'MIXED' ? 'muted' : 'warn'
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-xl border-2 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="font-mono text-xl font-extrabold sm:text-2xl">
          {coinName(row.symbol)}
          <span className="text-muted-foreground text-sm font-normal">/USDT</span>
        </h2>
        <div className="font-mono text-base sm:text-lg">
          ${px(row.price)} <span className={cn('text-xs', row.change24h >= 0 ? 'text-bull' : 'text-bear')}>{formatPct(row.change24h)} 24h</span>
        </div>
      </div>

      <div className={cn('rounded-lg border-2 p-3 text-center', TONE[tone])}>
        <div className="font-mono text-[11px] font-bold uppercase opacity-80 sm:text-xs">{g.headline}</div>
        <div className="mt-0.5 text-base font-extrabold leading-tight sm:text-xl">{row.signal ? `CONFIRMED ${row.signal.side} — SEE ENTRY SIGNAL (SECTION 4)` : g.status}</div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-5">
        <Pill tone="bull">
          {g.bull}/4 BULLISH
        </Pill>
        <Pill tone="bear">
          {g.bear}/4 BEARISH
        </Pill>
        <Pill tone={g.level === 'FULL' ? dirTone(g.dominant) : g.level === 'STRONG' ? 'warn' : 'muted'}>
          {g.level === 'FULL' ? 'FULL AGREEMENT' : g.level === 'STRONG' ? 'STRONG MAJORITY' : g.level === 'MIXED' ? 'MIXED TREND' : 'NO AGREEMENT'}
        </Pill>
        <Pill tone="muted">AGREEMENT {g.pct.toFixed(0)}%</Pill>
        <Pill tone={dirTone(g.dominant)} className="col-span-2 sm:col-span-1">
          {g.dominant === 'MIXED' ? 'DIRECTION: NEUTRAL' : `OVERALL: ${g.dominant}`}
        </Pill>
      </div>

      {/* The multi-timeframe table: a grid, not a <table>, so it never overflows a phone. */}
      <div className="border-border overflow-hidden rounded-lg border">
        <div className="bg-secondary/40 text-muted-foreground grid grid-cols-[3rem_repeat(4,minmax(0,1fr))] gap-1.5 px-2 py-1.5 font-mono text-[9px] uppercase sm:grid-cols-[4rem_repeat(4,minmax(0,1fr))] sm:text-[10px]">
          <span>TF</span>
          <span className="text-center">Supertrend</span>
          <span className="text-center">MACD</span>
          <span className="text-center">EMA 200</span>
          <span className="text-center">Overall</span>
        </div>
        {MTF_TFS.map((tf) => {
          const t = row.tfs[tf]
          return (
            <div key={tf} className="border-border/60 grid grid-cols-[3rem_repeat(4,minmax(0,1fr))] items-center gap-1.5 border-t px-2 py-2 sm:grid-cols-[4rem_repeat(4,minmax(0,1fr))]">
              <span className="font-mono text-sm font-extrabold sm:text-base">{MTF_LABEL[tf]}</span>
              <Pill tone={dirTone(t.st.dir)}>{t.st.dir}</Pill>
              <Pill tone={dirTone(t.macd.dir)}>{t.macd.dir}</Pill>
              <Pill tone={dirTone(t.ema200.position)}>{t.ema200.position === 'ABOVE' ? 'Above' : 'Below'}</Pill>
              <Pill tone={dirTone(t.overall)}>{t.overall === 'MIXED' ? 'Mixed' : t.overall === 'BULLISH' ? 'Bullish' : 'Bearish'}</Pill>
            </div>
          )
        })}
      </div>

      {g.conflicting.length > 0 && g.dominant !== 'MIXED' ? (
        <div className="text-warn font-mono text-[11px] font-bold">
          Conflicting: {g.conflicting.map((t) => `${MTF_LABEL[t]} (ST ${row.tfs[t].st.dir}, MACD ${row.tfs[t].macd.dir})`).join(' · ')} · dominant {g.dominant}
        </div>
      ) : null}
      <div className="text-muted-foreground font-mono text-[10px]">
        Supertrend 12,10 per timeframe, closed candles only · each row uses that timeframe&apos;s latest closed candle · updated {new Date(updatedAt).toLocaleTimeString([], { hour12: false })} · Supertrend flips never trigger an entry
      </div>
    </section>
  )
}

// ------------------------------------------------------------------ 2. MACD MTF

function MacdCard({ t }: { t: TfView }) {
  const m = t.macd
  return (
    <div className={cn('min-w-0 rounded-lg border p-2', TONE[dirTone(m.dir)])}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-sm font-extrabold">{MTF_LABEL[t.tf]}</span>
        <span className="font-mono text-xs font-extrabold">{m.dir === 'BUY' ? 'BULLISH ↑' : 'BEARISH ↓'}</span>
      </div>
      <div className="text-foreground mt-1 font-mono text-[10px] leading-snug">
        <div>
          {m.cross ? m.cross : m.crossBarsAgo != null ? `${m.dir === 'BUY' ? 'bullish' : 'bearish'} cross ${m.crossBarsAgo} bar${m.crossBarsAgo === 1 ? '' : 's'} ago` : 'no recent cross'}
        </div>
        <div>
          line {small(m.line)} · sig {small(m.signal)}
        </div>
        <div>hist {small(m.hist)}</div>
        <div>
          {m.momentum.toLowerCase()} · line {m.moving.toLowerCase()} · {m.zero.toLowerCase()} zero
        </div>
      </div>
    </div>
  )
}

function MacdMtf({ row }: { row: MtfRow }) {
  const g = row.agreement
  const full = g.macdBull === 4 || g.macdBear === 4
  return (
    <Section n={2} title="MACD multi-timeframe direction">
      <div className={cn('rounded-lg border p-2 text-center font-mono text-xs font-extrabold', TONE[g.macdBull === 4 ? 'bull' : g.macdBear === 4 ? 'bear' : 'warn'])}>
        {g.macdBull === 4 ? 'BULLISH MACD AGREEMENT 4/4' : g.macdBear === 4 ? 'BEARISH MACD AGREEMENT 4/4' : `MACD NOT AGREEING — ${g.macdBull} BULLISH / ${g.macdBear} BEARISH`}
        {full ? '' : ' · WAIT'}
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {MTF_TFS.map((tf) => (
          <MacdCard key={tf} t={row.tfs[tf]} />
        ))}
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ 3. EMA 200 entry filter

function EmaFilter({ row }: { row: MtfRow }) {
  const e = row.ema200
  return (
    <Section n={3} title="EMA 200 entry filter (5M)">
      <div className="grid gap-x-6 sm:grid-cols-2">
        <div>
          <Row k="Current price" v={px(row.price)} />
          <Row k="EMA 200" v={px(row.ema.e200)} cls="text-primary" />
          <Row k="Price vs EMA 200" v={`${e.position} (${e.distPct >= 0 ? '+' : ''}${e.distPct.toFixed(2)}% · ${e.distAtr.toFixed(1)} ATR)`} cls={e.position === 'ABOVE' ? 'text-bull' : 'text-bear'} />
          <Row k="EMA 200 slope" v={e.slope} cls={e.slope === 'RISING' ? 'text-bull' : e.slope === 'FALLING' ? 'text-bear' : ''} />
          <div className="mt-1 grid grid-cols-2 gap-2">
            <Pill tone={e.buyValid ? 'bull' : 'muted'}>BUY {e.buyValid ? 'VALID' : 'BLOCKED'}</Pill>
            <Pill tone={e.sellValid ? 'bear' : 'muted'}>SELL {e.sellValid ? 'VALID' : 'BLOCKED'}</Pill>
          </div>
          <div className="text-muted-foreground mt-1 font-mono text-[10px]">{e.note}</div>
        </div>
        <div>
          <Row k="EMA 20" v={px(row.ema.e20)} />
          <Row k="EMA 50" v={px(row.ema.e50)} />
          <Row k="EMA 100" v={px(row.ema.e100)} />
          <Row k="Ribbon" v={row.ribbon.status} cls={row.ribbon.direction === 'BULLISH' ? 'text-bull' : row.ribbon.direction === 'BEARISH' ? 'text-bear' : 'text-warn'} />
          <div className="text-muted-foreground font-mono text-[10px]">Ribbon is extra strength information only; it never delays an entry.</div>
          <div className="border-border mt-2 border-t pt-1.5">
            <div className="text-muted-foreground font-mono text-[10px] uppercase">Impulse MACD 34/9 (supplementary, 5M)</div>
            <Row k="State" v={row.impulse.state} cls={row.impulse.state.includes('BULL') || row.impulse.state === 'OVERSOLD' ? 'text-bull' : 'text-bear'} />
            <Row k="Histogram" v={`${small(row.impulse.hist)} · ${row.impulse.momentum.toLowerCase()}`} />
            <Row k="Direction change" v={row.impulse.turn ? `turned ${row.impulse.turn} this candle` : 'none'} />
            <Row k="Extreme zone" v={`≤ ${small(row.impulse.lower)} / ≥ ${small(row.impulse.upper)}`} />
          </div>
        </div>
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ 4. MACD entry signal

function Plan({ s, price, method }: { s: MtfSignal; price: number; method: SlMethod }) {
  const p = s.plan
  const bull = s.side === 'BUY'
  return (
    <div className={cn('rounded-lg border-2 p-3', bull ? 'border-bull bg-bull/10' : 'border-bear bg-bear/10')}>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry (signal price)</div>
          <div className="font-mono text-base font-extrabold sm:text-xl">{px(s.entry)}</div>
        </div>
        <div>
          <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
          <div className="text-bear font-mono text-base font-extrabold sm:text-xl">{px(p.sl)}</div>
        </div>
        <div>
          <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
          <div className="text-bull font-mono text-base font-extrabold sm:text-xl">{px(p.tp)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 sm:grid-cols-5">
        <Row k="Risk" v={`${px(p.risk)} (${p.riskPct.toFixed(2)}%)`} />
        <Row k="Reward" v={px(p.reward)} />
        <Row k="R:R" v={`1:${(p.reward / p.risk).toFixed(1)}`} />
        <Row k="Live price" v={px(price)} />
        <Row k="Fees+slip" v={`≈ ${p.costR.toFixed(2)}R`} />
      </div>
      <div className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">
        Entry is the 5M candle close, not an executed fill — check the live price first. Stop: {p.method === 'supertrend' ? '5M SUPERTREND 12,10' : p.method.toUpperCase()}
        {p.fallback ? ` (fallback — ${method} was not valid)` : ''}. Candle closed {when(s.time)}.
      </div>
      {p.riskPct > 3 ? (
        <div className="text-warn mt-1 flex items-start gap-1.5 font-mono text-[11px] font-bold">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Wide stop ({p.riskPct.toFixed(1)}% of price). Size for that distance or choose another stop method in Settings.
        </div>
      ) : null}
    </div>
  )
}

function EntrySignal({ row, config }: { row: MtfRow; config: MtfConfig }) {
  const e = row.entry
  const s = row.signal
  const tone = entryTone(e.status, e.side)
  const steps = [
    { k: 'MTF agreement', done: Boolean(row.agreement.tradeable) || Boolean(s) },
    { k: '5M MACD crossover', done: Boolean(s) || e.status === 'MACD CROSS DETECTED — EMA 200 INVALID' || e.status === 'EMA 200 CONFLICT — WAIT' || e.status === 'MACD CROSSOVER DETECTED' },
    { k: 'EMA 200 confirmed', done: Boolean(s) },
    { k: 'One confirmed popup', done: Boolean(s) },
  ]
  return (
    <Section n={4} title="MACD entry signal (5M)">
      <div className={cn('rounded-xl border-2 p-3 text-center', TONE[tone])}>
        <div className="text-lg font-extrabold leading-tight sm:text-2xl">
          {s ? `CONFIRMED ${s.side} — MTF SUPERTREND + MACD CROSS + EMA 200` : e.status}
        </div>
        {!s ? <div className="mt-1 font-mono text-[11px] font-bold opacity-90">WAIT — NO VALID ENTRY</div> : null}
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {steps.map((st) => (
          <div key={st.k} className={cn('rounded border px-2 py-1 text-center font-mono text-[10px] font-bold', st.done ? TONE[s ? (s.side === 'BUY' ? 'bull' : 'bear') : 'primary'] : TONE.muted)}>
            {st.done ? '✓ ' : '○ '}
            {st.k}
          </div>
        ))}
      </div>
      {s ? (
        <>
          <Plan s={s} price={row.price} method={config.slMethod} />
          <ul className="text-muted-foreground list-inside list-disc font-mono text-[11px] leading-relaxed">
            {s.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="text-muted-foreground font-mono text-[10px]">
        Setup state: BUY {e.armed.BUY ? 'armed' : 'used'} · SELL {e.armed.SELL ? 'armed' : 'used'} — one popup per setup; a setup re-arms when the agreement is lost
        {config.rearm === 'cross' ? ' or the 5M MACD crosses back' : ''}.
      </div>
    </Section>
  )
}

// ------------------------------------------------------------------ 5 + 6. history and performance

function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="border-border min-w-0 rounded-lg border p-2">
      <div className="text-muted-foreground font-mono text-[10px] uppercase">{k}</div>
      <div className={cn('font-mono text-base font-extrabold', cls)}>{v}</div>
    </div>
  )
}

function History({ rows, hours, config, onSelect }: { rows: MtfRow[]; hours: number; config: MtfConfig; onSelect: (s: string) => void }) {
  const all = useMemo(() => rows.flatMap((r) => r.history).sort((a, b) => b.time - a.time), [rows])
  const perf = useMemo(() => summarizePerformance(all), [all])
  const [limit, setLimit] = useState(20)
  const done = perf.wins + perf.losses
  return (
    <>
      <Section n={5} title="Trade history">
        <p className="text-muted-foreground font-mono text-[10px] leading-snug">
          Replay of the last ~{hours}h (limited by the 1M history) for the pairs shown, newest 20 per pair, {config.feeBps} bps fee + {config.slipBps} bps slippage per side. If SL and TP fall inside one candle the stop counts first. Not a back-test — run scripts/backtest-mtf.ts for months of data.
        </p>
        <ul className="divide-border/60 divide-y">
          {all.slice(0, limit).map((s) => {
            const o = s.outcome
            return (
              <li key={s.id} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <button type="button" onClick={() => onSelect(s.symbol)} className="flex min-h-9 items-center gap-2 text-left">
                    <Chip tone={s.side === 'BUY' ? 'bull' : 'bear'}>{s.side}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(s.symbol)}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">{when(s.time)}</span>
                  </button>
                  <span className={cn('font-mono text-xs font-extrabold', o?.result === 'WIN' ? 'text-bull' : o?.result === 'LOSS' ? 'text-bear' : 'text-muted-foreground')}>
                    {o ? `${o.result} ${o.r >= 0 ? '+' : ''}${o.r.toFixed(2)}R (${formatPct(o.pnlPct)})` : '—'}
                  </span>
                </div>
                <div className="text-muted-foreground font-mono text-[10px]">
                  Entry {px(s.entry)} · SL {px(s.plan.sl)} · TP {px(s.plan.tp)}
                </div>
              </li>
            )
          })}
          {all.length === 0 ? <li className="text-muted-foreground p-4 text-center font-mono text-xs">No confirmed signals in the replay window — full agreement on four timeframes is rare by design.</li> : null}
        </ul>
        {all.length > limit ? (
          <button type="button" onClick={() => setLimit((l) => l + 20)} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
            Show more
          </button>
        ) : null}
      </Section>
      <Section n={6} title="Performance analytics">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat k="Total signals" v={String(perf.total)} />
          <Stat k="BUY / SELL" v={`${perf.buys} / ${perf.sells}`} />
          <Stat k="Win rate" v={done ? `${perf.winRate.toFixed(0)}%` : '—'} />
          <Stat k="Wins / losses" v={`${perf.wins} / ${perf.losses}`} />
          <Stat k="Total P&L (price %)" v={done ? formatPct(perf.totalPnlPct) : '—'} cls={perf.totalPnlPct >= 0 ? 'text-bull' : 'text-bear'} />
          <Stat k="Total R (net)" v={done ? `${perf.totalR >= 0 ? '+' : ''}${perf.totalR.toFixed(1)}R` : '—'} cls={perf.totalR >= 0 ? 'text-bull' : 'text-bear'} />
          <Stat k="Avg reward/risk" v={done ? `${perf.avgR >= 0 ? '+' : ''}${perf.avgR.toFixed(2)}R` : '—'} />
          <Stat k="Max drawdown" v={done ? `${perf.maxDrawdownR.toFixed(1)}R` : '—'} cls="text-bear" />
        </div>
        <div className="text-muted-foreground font-mono text-[11px]">
          Monthly: {perf.monthly.length ? perf.monthly.map((m) => `${m.month} ${m.trades} trades ${m.r >= 0 ? '+' : ''}${m.r.toFixed(1)}R`).join(' · ') : 'no closed trades yet (a replay this short spans at most two months)'}
        </div>
        <div className="text-muted-foreground font-mono text-[10px]">Open trades are counted as signals but left out of win rate and R. Past replay results do not predict future results.</div>
      </Section>
    </>
  )
}

// ------------------------------------------------------------------ pairs list

type Filter = 'ALL' | 'SIGNALS' | 'AGREE' | 'BUY' | 'SELL'

function Pairs({ rows, selected, onSelect }: { rows: MtfRow[]; selected: string; onSelect: (s: string) => void }) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(25)
  const rank = (r: MtfRow) => (r.signal ? 3 : r.agreement.tradeable ? 2 : r.agreement.level === 'STRONG' ? 1 : 0)
  const list = useMemo(() => {
    const t = q.trim().toUpperCase()
    return rows
      .filter((r) => (t ? r.symbol.includes(t) : true))
      .filter((r) =>
        filter === 'SIGNALS' ? r.signal : filter === 'AGREE' ? r.agreement.tradeable : filter === 'BUY' ? r.agreement.dominant === 'BULLISH' : filter === 'SELL' ? r.agreement.dominant === 'BEARISH' : true,
      )
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
        {(['ALL', 'SIGNALS', 'AGREE', 'BUY', 'SELL'] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={cn('h-8 rounded-md border px-2.5 font-mono text-[11px] font-semibold', filter === f ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
            {f === 'AGREE' ? 'AGREEMENT' : f}
          </button>
        ))}
      </div>
      <ul className="divide-border/60 divide-y">
        {list.slice(0, limit).map((r) => (
          <li key={r.symbol}>
            <button type="button" onClick={() => onSelect(r.symbol)} className={cn('flex min-h-11 w-full items-center justify-between gap-2 px-1 py-2 text-left', r.symbol === selected && 'bg-accent/40')}>
              <span className="min-w-0">
                <span className="block font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                <span className="text-muted-foreground block font-mono text-[10px]">
                  ${px(r.price)} <span className={r.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(r.change24h)}</span>
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-0.5">
                <Chip tone={r.signal ? entryTone(r.entry.status, r.entry.side) : dirTone(r.agreement.dominant)}>{r.signal ? `CONFIRMED ${r.signal.side}` : r.agreement.level === 'FULL' ? `FULL ${r.agreement.dominant}` : `${Math.max(r.agreement.bull, r.agreement.bear)}/4 ${r.agreement.dominant}`}</Chip>
                <span className="flex gap-0.5">
                  {MTF_TFS.map((tf) => (
                    <span key={tf} title={MTF_LABEL[tf]} className={cn('size-2.5 rounded-sm', r.tfs[tf].overall === 'BULLISH' ? 'bg-bull' : r.tfs[tf].overall === 'BEARISH' ? 'bg-bear' : 'bg-warn')} />
                  ))}
                </span>
              </span>
            </button>
          </li>
        ))}
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

// ------------------------------------------------------------------ settings

type NumKey = 'stPeriod' | 'stMult' | 'macdFast' | 'macdSlow' | 'macdSignal' | 'rr' | 'atrMult' | 'minGapBars' | 'feeBps' | 'slipBps'
const NUM_FIELDS: Array<{ key: NumKey; label: string; step: number }> = [
  { key: 'stPeriod', label: 'Supertrend ATR period', step: 1 },
  { key: 'stMult', label: 'Supertrend multiplier', step: 0.5 },
  { key: 'macdFast', label: 'MACD fast', step: 1 },
  { key: 'macdSlow', label: 'MACD slow', step: 1 },
  { key: 'macdSignal', label: 'MACD signal', step: 1 },
  { key: 'rr', label: 'Reward : risk', step: 0.5 },
  { key: 'atrMult', label: 'ATR stop multiple', step: 0.1 },
  { key: 'minGapBars', label: 'Min bars between signals', step: 1 },
  { key: 'feeBps', label: 'Fee (bps / side)', step: 1 },
  { key: 'slipBps', label: 'Slippage (bps / side)', step: 1 },
]

function Settings({ config, onApply }: { config: MtfConfig; onApply: (c: Partial<MtfConfig>) => void }) {
  const [d, setD] = useState<MtfConfig>(config)
  useEffect(() => setD(config), [config])
  const sel = 'border-border bg-background h-10 w-full rounded-md border px-2 font-mono text-xs'
  const lab = 'flex flex-col gap-1 font-mono text-[10px] uppercase text-muted-foreground'
  return (
    <section className="border-border bg-card flex flex-col gap-3 rounded-xl border p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className={lab}>
            {f.label}
            <input type="number" inputMode="decimal" step={f.step} value={d[f.key]} onChange={(e) => setD({ ...d, [f.key]: Number(e.target.value) })} className="border-border bg-background text-foreground h-10 rounded-md border px-2 text-sm normal-case" />
          </label>
        ))}
        <label className={lab}>
          Agreement required
          <select className={sel} value={d.level} onChange={(e) => setD({ ...d, level: e.target.value as MtfConfig['level'] })}>
            <option value="FULL">Full — all 4 timeframes (default)</option>
            <option value="STRONG">Strong majority — 3 of 4</option>
          </select>
        </label>
        <label className={lab}>
          Setup re-arms
          <select className={sel} value={d.rearm} onChange={(e) => setD({ ...d, rearm: e.target.value as MtfConfig['rearm'] })}>
            <option value="cross">Agreement lost or 5M MACD crosses back</option>
            <option value="agreement">Only when agreement is lost</option>
          </select>
        </label>
        <label className={lab}>
          Stop-loss method
          <select className={sel} value={d.slMethod} onChange={(e) => setD({ ...d, slMethod: e.target.value as SlMethod })}>
            <option value="supertrend">5M Supertrend (default)</option>
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
      <p className="text-muted-foreground font-mono text-[10px] leading-snug">The rules (MTF agreement, 5M MACD cross as the trigger, EMA 200 validation, closed candle) are fixed. Settings are saved in this browser.</p>
    </section>
  )
}

// ------------------------------------------------------------------ popup (mounted once from the terminal shell)

export function MtfPopups({ popups, onDismiss, onOpen }: { popups: MtfPopup[]; onDismiss: (id: string) => void; onOpen: (s: string) => void }) {
  if (popups.length === 0) return null
  const { signal: s, row } = popups[0]
  const bull = s.side === 'BUY'
  return (
    <div className="pointer-events-none fixed inset-x-0 top-[env(safe-area-inset-top)] z-50 flex max-h-dvh flex-col items-center gap-2 overflow-y-auto p-2 sm:items-end">
      <article className={cn('bg-card pointer-events-auto w-full max-w-md rounded-xl border-2 p-3 shadow-2xl', bull ? 'border-bull' : 'border-bear')}>
        <header className="flex items-start justify-between gap-2">
          <div>
            <div className={cn('text-base font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>
              CONFIRMED {s.side}
              <span className="block text-[11px] font-bold opacity-90">MTF SUPERTREND + MACD CROSS + EMA 200</span>
            </div>
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
            <div className="text-bear font-mono text-[10px] uppercase">SL</div>
            <div className="text-bear font-mono text-base font-extrabold">{px(s.plan.sl)}</div>
          </div>
          <div>
            <div className="text-bull font-mono text-[10px] uppercase">TP</div>
            <div className="text-bull font-mono text-base font-extrabold">{px(s.plan.tp)}</div>
          </div>
        </div>
        <div className="mt-2">
          <Row k="MTF Supertrend" v={bull ? 'BULLISH AGREEMENT' : 'BEARISH AGREEMENT'} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k="MTF MACD" v={bull ? 'BULLISH AGREEMENT' : 'BEARISH AGREEMENT'} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k="5M MACD" v={bull ? 'BULLISH CROSSOVER' : 'BEARISH CROSSOVER'} />
          <Row k="MACD direction" v={bull ? 'UP' : 'DOWN'} />
          <Row k="EMA 200" v={bull ? 'PRICE ABOVE' : 'PRICE BELOW'} />
          <Row k="EMA ribbon" v={s.ribbon} />
          <Row k="Impulse MACD" v={`${s.impulse.state} · ${s.impulse.momentum.toLowerCase()}`} />
          <Row k="Risk / reward" v={`${px(s.plan.risk)} / ${px(s.plan.reward)} (1:${(s.plan.reward / s.plan.risk).toFixed(1)})`} />
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
    </div>
  )
}

// ------------------------------------------------------------------ panel

export interface MtfPanelProps {
  data: MtfResponse | undefined
  isLoading: boolean
  config: MtfConfig
  onConfig: (c: Partial<MtfConfig>) => void
  selected: string
  onSelect: (s: string) => void
  alerts: { permission: NotificationPermission | 'unsupported'; requestPermission: () => void; soundEnabled: boolean; toggleSound: () => void }
}

export function MtfPanel({ data, isLoading, config, onConfig, selected, onSelect, alerts }: MtfPanelProps) {
  const [showSettings, setShowSettings] = useState(false)
  const rows = data?.rows ?? []
  const row = rows.find((r) => r.symbol === selected) ?? rows.find((r) => r.symbol === 'BTCUSDT') ?? rows[0]
  const hours = Math.max(1, Math.round((1000 - 40) / 60))

  if (isLoading && !data) return <div className="text-muted-foreground p-6 text-center font-mono text-sm">Loading 1M / 3M / 5M / 15M candles…</div>
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
          <h1 className="text-base font-extrabold sm:text-lg">MTF Supertrend + MACD Early Entry + EMA 200</h1>
          <p className="text-muted-foreground font-mono text-[10px]">
            {rows.length} pairs · 1M/3M/5M/15M · updated {data ? new Date(data.computedAt).toLocaleTimeString([], { hour12: false }) : '—'} · closed candles only
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
          <button type="button" onClick={() => setShowSettings((s) => !s)} aria-label="Settings" className={cn('flex size-10 items-center justify-center rounded-md border', showSettings ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
            <Settings2 className="size-4" />
          </button>
        </div>
      </header>

      {showSettings ? <Settings config={config} onApply={onConfig} /> : null}

      <label className="text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase lg:hidden">
        Trading pair
        <select value={row?.symbol ?? ''} onChange={(e) => onSelect(e.target.value)} className="border-border bg-card text-foreground h-11 rounded-md border px-2 font-mono text-sm">
          {[...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((r) => (
            <option key={r.symbol} value={r.symbol}>
              {coinName(r.symbol)}
              {r.signal ? ` — CONFIRMED ${r.signal.side}` : r.agreement.tradeable ? ` — ${r.agreement.dominant} agreement` : ''}
            </option>
          ))}
        </select>
      </label>

      {row ? (
        <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="flex min-w-0 flex-col gap-3">
            <SupertrendScanner row={row} updatedAt={data?.computedAt ?? Date.now()} />
            <MacdMtf row={row} />
            <EmaFilter row={row} />
            <EntrySignal row={row} config={config} />
          </div>
          <div className="flex min-w-0 flex-col gap-3 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto">
            <Pairs rows={rows} selected={row.symbol} onSelect={onSelect} />
          </div>
        </div>
      ) : (
        <div className="text-muted-foreground p-6 text-center font-mono text-sm">No pairs have enough candle history yet.</div>
      )}

      <History rows={rows} hours={hours} config={config} onSelect={onSelect} />
    </div>
  )
}
