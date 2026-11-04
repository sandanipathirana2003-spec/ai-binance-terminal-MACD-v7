'use client'

import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Search, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct, formatPrice } from '@/lib/format'
import { useReversal } from '@/hooks/use-reversal'
import {
  MAX_SCORE,
  REV_TF_LABEL,
  type MaReading,
  type ReversalRow,
  type RevStatus,
  type RevTf,
  type SequenceKind,
  type StrengthLabel,
  type TfReading,
  type TfState,
} from '@/lib/reversal'

/** Higher timeframe on top, like the reference card. */
const DISPLAY_ORDER: RevTf[] = ['5m', '3m', '1m']
const PAGE = 30

type Filter = 'ALL' | 'BUY' | 'SELL' | 'EARLY'
type SortKey = 'STRENGTH' | 'NEWEST' | 'NAME'

const STATUS_RANK: Record<RevStatus, number> = {
  'STRONG BUY': 6,
  'STRONG SELL': 6,
  '5M BUY CONFIRMED': 5,
  '5M SELL CONFIRMED': 5,
  '3M BUY CONFIRMED': 4,
  '3M SELL CONFIRMED': 4,
  'BUY TRIGGER': 3,
  'SELL TRIGGER': 3,
  'EARLY BUY': 2,
  'EARLY SELL': 2,
  WAIT: 0,
}

const STATE_STYLE: Record<TfState, string> = {
  BULLISH: 'border-bull/30 bg-bull/15 text-bull',
  BEARISH: 'border-bear/30 bg-bear/15 text-bear',
  NEUTRAL: 'border-border bg-muted text-muted-foreground',
  'TURNING BULLISH': 'border-warn/50 bg-warn/15 text-bull',
  'TURNING BEARISH': 'border-warn/50 bg-warn/15 text-bear',
}

const SEQ_TEXT: Record<SequenceKind, string> = {
  LOWER_FIRST: 'lower timeframe led (early reversal)',
  HIGHER_FIRST: 'higher timeframe led (top-down)',
  SIMULTANEOUS: 'flipped together',
  MIXED: 'mixed order',
  SINGLE: 'one timeframe so far',
}

const STRENGTH_STYLE: Record<StrengthLabel, string> = {
  NONE: 'text-muted-foreground',
  LOW: 'text-muted-foreground',
  MEDIUM: 'text-warn',
  HIGH: 'text-foreground',
  STRONG: 'text-foreground',
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

function dirWord(d: 'UP' | 'DOWN' | null): string {
  return d === null ? '—' : d
}

function bannerClass(row: ReversalRow): string {
  if (row.status === 'WAIT') return row.failed ? 'border-warn/50 bg-warn/10 text-warn' : 'border-border bg-muted text-muted-foreground'
  const strong = row.status === 'STRONG BUY' || row.status === 'STRONG SELL'
  if (row.side === 'BUY') return strong ? 'border-bull bg-bull text-bull-foreground' : 'border-bull/40 bg-bull/15 text-bull'
  return strong ? 'border-bear bg-bear text-bear-foreground' : 'border-bear/40 bg-bear/15 text-bear'
}

function StatePill({ state, className }: { state: TfState; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded border px-2 py-1 font-mono text-[11px] font-bold uppercase tracking-wide',
        STATE_STYLE[state],
        className,
      )}
    >
      {state}
    </span>
  )
}

function NewTag() {
  return (
    <span className="bg-warn/15 text-warn inline-flex items-center gap-0.5 rounded px-1 py-px font-mono text-[9px] font-bold">
      <Zap className="size-2.5" />
      NEW
    </span>
  )
}

/** "UP → DOWN" + how long ago, or an honest "at least" when the direction predates the loaded candles. */
function changeText(r: TfReading, now: number): { change: string; since: string } {
  if (!r.change) return { change: 'no direction yet', since: '—' }
  const age = fmtDur(now - r.change.time)
  if (r.seeded) return { change: `${dirWord(r.dir)} (prev —)`, since: `≥ ${age}` }
  return { change: `${dirWord(r.prevDir)} → ${dirWord(r.dir)}`, since: `${age} ago` }
}

function StrengthMeter({ row }: { row: ReversalRow }) {
  const fill = row.side === 'BUY' ? 'bg-bull' : row.side === 'SELL' ? 'bg-bear' : 'bg-muted-foreground'
  return (
    <div className="flex items-center gap-2" title={row.scoreParts.join(' · ') || 'No active reversal'}>
      <div className="flex flex-1 gap-0.5" aria-hidden>
        {Array.from({ length: MAX_SCORE }, (_, i) => (
          <span key={i} className={cn('h-2 flex-1 rounded-sm', i < row.score ? fill : 'bg-border')} />
        ))}
      </div>
      <span className={cn('shrink-0 font-mono text-xs font-bold', STRENGTH_STYLE[row.strength])}>
        {row.strength} <span className="text-muted-foreground font-normal">{row.score}/{MAX_SCORE}</span>
      </span>
    </div>
  )
}

function MaLine({ ma, now }: { ma: MaReading; now: number }) {
  const bull = ma.state === 'BULL'
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]">
      <span className={cn('rounded border px-1.5 py-0.5 font-bold', bull ? 'border-bull/30 bg-bull/15 text-bull' : 'border-bear/30 bg-bear/15 text-bear')}>
        EMA9 {bull ? '>' : '<'} EMA21
      </span>
      <span className="text-muted-foreground">
        {ma.cross ? `${ma.cross.type === 'BULL' ? 'crossed up' : 'crossed down'} ${fmtDur(now - ma.cross.time)} ago` : 'no recent cross'}
      </span>
    </span>
  )
}

/** Fake-reversal filters at a glance: volume lean, chop, failed attempt. */
function FilterLine({ row }: { row: ReversalRow }) {
  const tag = 'rounded border px-1.5 py-0.5 font-mono text-[11px] font-bold'
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {row.volume ? (
        <span className={cn(tag, row.volume.ok ? 'border-bull/30 bg-bull/15 text-bull' : 'border-warn/40 bg-warn/15 text-warn')}>
          VOL {row.volume.deltaPct > 0 ? '+' : ''}
          {row.volume.deltaPct.toFixed(0)}% {row.volume.ok ? '✓' : '✗ not confirming'}
        </span>
      ) : null}
      {row.choppy ? <span className={cn(tag, 'border-warn/40 bg-warn/15 text-warn')}>CHOPPY · {row.flips1m} flips/60m</span> : null}
      {row.failed ? <span className={cn(tag, 'border-warn/40 bg-warn/15 text-warn')}>FAILED {row.failed.side}</span> : null}
      {!row.volume && !row.choppy && !row.failed ? <span className="text-muted-foreground font-mono text-[11px]">No warnings</span> : null}
    </span>
  )
}

function SequenceLine({ row }: { row: ReversalRow }) {
  if (!row.sequence) return <span className="text-muted-foreground font-mono text-[11px]">No active reversal sequence</span>
  return (
    <span className="flex flex-wrap items-center gap-x-1 font-mono text-[11px]">
      {row.sequence.order.map((tf, i) => (
        <span key={tf} className="flex items-center gap-1">
          {i > 0 ? <ArrowRight className="text-muted-foreground size-3" /> : null}
          <span className="font-bold">{REV_TF_LABEL[tf]}</span>
        </span>
      ))}
      <span className="text-muted-foreground">· {SEQ_TEXT[row.sequence.kind]}</span>
    </span>
  )
}

// --------------------------------------------------------------------------- mobile card

function TfRowCard({ r, now }: { r: TfReading; now: number }) {
  const t = changeText(r, now)
  return (
    <div className="flex min-h-11 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-7 shrink-0 font-mono text-sm font-bold">{REV_TF_LABEL[r.tf]}</span>
        <StatePill state={r.state} />
        {r.fresh ? <NewTag /> : null}
      </div>
      <div className="shrink-0 text-right font-mono leading-tight">
        <div className="text-[11px] font-semibold">{t.change}</div>
        <div className="text-muted-foreground text-[10px]">{t.since}</div>
      </div>
    </div>
  )
}

function ReversalCard({ row, now, onOpen }: { row: ReversalRow; now: number; onOpen: (s: string) => void }) {
  return (
    <article className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-xl border p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-base font-bold">
          {row.symbol.replace('USDT', '')}
          <span className="text-muted-foreground text-xs font-normal">/USDT</span>
        </h3>
        <span className="font-mono text-xs">
          ${formatPrice(row.price)} <span className={row.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(row.change24h)}</span>
        </span>
      </header>

      <div className={cn('rounded-lg border px-3 py-3 text-center', bannerClass(row))}>
        <div className="text-2xl font-extrabold leading-tight tracking-wide">{row.status}</div>
        <div className="mt-1 font-mono text-[11px] font-semibold uppercase leading-snug opacity-90">{row.stage}</div>
      </div>

      <StrengthMeter row={row} />

      <div className="divide-border/60 divide-y">
        {DISPLAY_ORDER.map((tf) => (
          <TfRowCard key={tf} r={row.tfs[tf]} now={now} />
        ))}
      </div>

      <div className="border-border/60 flex flex-col gap-1.5 border-t pt-2">
        <div className="flex items-start gap-2">
          <span className="w-7 shrink-0 font-mono text-sm font-bold">MA</span>
          <MaLine ma={row.ma} now={now} />
        </div>
        <div className="flex items-start gap-2">
          <span className="w-7 shrink-0 font-mono text-[10px] font-bold leading-4">SEQ</span>
          <SequenceLine row={row} />
        </div>
        <div className="flex items-start gap-2">
          <span className="w-7 shrink-0 font-mono text-[10px] font-bold leading-5">CHK</span>
          <FilterLine row={row} />
        </div>
      </div>

      <button
        type="button"
        onClick={() => onOpen(row.symbol)}
        className="border-border text-muted-foreground active:bg-accent/40 h-11 w-full rounded-md border text-xs font-semibold"
      >
        Open {row.symbol.replace('USDT', '')} in Terminal
      </button>
    </article>
  )
}

// --------------------------------------------------------------------------- desktop table

function TfCell({ r, now }: { r: TfReading; now: number }) {
  const t = changeText(r, now)
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="flex items-center gap-1">
        <StatePill state={r.state} className="px-1.5 py-0.5 text-[10px]" />
        {r.fresh ? <NewTag /> : null}
      </span>
      <span className="text-muted-foreground font-mono text-[10px]">
        {t.change} · {t.since}
      </span>
    </div>
  )
}

function ReversalTable({ rows, now, onOpen }: { rows: ReversalRow[]; now: number; onOpen: (s: string) => void }) {
  return (
    <div className="border-border bg-card hidden overflow-hidden rounded-lg border lg:block">
      <table className="w-full table-fixed text-left">
        <thead className="bg-secondary/40 text-muted-foreground font-mono text-[10px] uppercase">
          <tr>
            <th className="w-[11%] px-3 py-2">Coin</th>
            <th className="w-[16%] px-2 py-2">Status</th>
            <th className="w-[11%] px-2 py-2">Strength</th>
            {DISPLAY_ORDER.map((tf) => (
              <th key={tf} className="w-[15%] px-2 py-2">
                {REV_TF_LABEL[tf]} VIDYA
              </th>
            ))}
            <th className="w-[14%] px-2 py-2">MA 9/21 · Sequence</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.symbol} className="border-border/60 hover:bg-accent/30 cursor-pointer border-t align-top" onClick={() => onOpen(r.symbol)}>
              <td className="px-3 py-2">
                <div className="font-mono text-sm font-bold">{r.symbol.replace('USDT', '')}</div>
                <div className="text-muted-foreground font-mono text-[10px]">
                  ${formatPrice(r.price)} <span className={r.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(r.change24h)}</span>
                </div>
              </td>
              <td className="px-2 py-2">
                <div className={cn('rounded border px-2 py-1 text-center font-mono text-xs font-extrabold', bannerClass(r))}>{r.status}</div>
                <div className="text-muted-foreground mt-1 font-mono text-[9px] uppercase leading-tight">{r.stage}</div>
              </td>
              <td className="px-2 py-2">
                <StrengthMeter row={r} />
              </td>
              {DISPLAY_ORDER.map((tf) => (
                <td key={tf} className="px-2 py-2">
                  <TfCell r={r.tfs[tf]} now={now} />
                </td>
              ))}
              <td className="px-2 py-2">
                <div className="flex flex-col gap-1.5">
                  <MaLine ma={r.ma} now={now} />
                  <SequenceLine row={r} />
                  <FilterLine row={r} />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// --------------------------------------------------------------------------- panel

export function ReversalPanel({ onOpen }: { onOpen: (symbol: string) => void }) {
  const { data, isLoading } = useReversal()
  const [filter, setFilter] = useState<Filter>('ALL')
  const [sort, setSort] = useState<SortKey>('STRENGTH')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [now, setNow] = useState(() => Date.now())

  // Tick so "time since direction changed" keeps counting between 20s refreshes.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => setLimit(PAGE), [filter, sort, query])

  const rows = data?.rows ?? []

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows.filter((r) => r.symbol.toLowerCase().includes(q)) : rows
  }, [rows, query])

  const counts = useMemo(
    () => ({
      ALL: searched.length,
      BUY: searched.filter((r) => r.side === 'BUY').length,
      SELL: searched.filter((r) => r.side === 'SELL').length,
      EARLY: searched.filter((r) => r.early).length,
    }),
    [searched],
  )

  const sorted = useMemo(() => {
    const list = searched.filter((r) => (filter === 'ALL' ? true : filter === 'EARLY' ? r.early : r.side === filter))
    return list.sort((a, b) => {
      if (sort === 'NAME') return a.symbol.localeCompare(b.symbol)
      if (sort === 'NEWEST') return (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.score - a.score || a.symbol.localeCompare(b.symbol)
      return b.score - a.score || STATUS_RANK[b.status] - STATUS_RANK[a.status] || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.symbol.localeCompare(b.symbol)
    })
  }, [searched, filter, sort])

  const visible = sorted.slice(0, limit)
  const p = data?.params

  const FILTERS: Array<{ key: Filter; label: string; cls: string }> = [
    { key: 'ALL', label: 'All', cls: 'border-primary/40 bg-primary/10 text-primary' },
    { key: 'BUY', label: 'Buy', cls: 'border-bull/40 bg-bull/15 text-bull' },
    { key: 'SELL', label: 'Sell', cls: 'border-bear/40 bg-bear/15 text-bear' },
    { key: 'EARLY', label: 'Early', cls: 'border-warn/40 bg-warn/15 text-warn' },
  ]
  const SORTS: Array<{ key: SortKey; label: string }> = [
    { key: 'STRENGTH', label: 'Strength' },
    { key: 'NEWEST', label: 'Newest' },
    { key: 'NAME', label: 'A–Z' },
  ]

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-3 p-3">
      <div className="border-border bg-card flex flex-col gap-3 rounded-lg border p-3">
        <div>
          <h2 className="text-sm font-semibold">Multi-timeframe reversal tracker · 1M / 3M / 5M</h2>
          <p className="text-muted-foreground mt-0.5 font-mono text-[11px] leading-relaxed">
            {p ? `VIDYA ${p.vidyaLength} · ${p.vidyaMomentum} · ${p.bandDistance}  |  EMA ${p.emaFast}/${p.emaSlow}  |  closed candles only` : 'Loading…'}
            {data?.live ? `  |  updated ${fmtDur(now - data.computedAt)} ago` : ''}
          </p>
        </div>

        <div className="grid grid-cols-4 gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn(
                'flex h-14 flex-col items-center justify-center rounded-md border font-mono transition-colors',
                filter === f.key ? f.cls : 'border-border text-muted-foreground',
              )}
            >
              <span className="text-[10px] font-semibold uppercase">{f.label}</span>
              <span className="text-base font-bold">{counts[f.key]}</span>
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search coins…"
              inputMode="search"
              autoCapitalize="characters"
              className="border-border bg-secondary/50 focus:ring-ring h-11 w-full rounded-md border pl-9 pr-3 text-base outline-none focus:ring-2 sm:text-sm"
            />
          </div>
          <div className="grid grid-cols-3 gap-1.5 sm:w-72">
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => setSort(s.key)}
                className={cn(
                  'h-11 rounded-md border font-mono text-xs font-bold transition-colors',
                  sort === s.key ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground',
                )}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {data && !data.live ? (
        <div className="border-bear/30 bg-bear/10 text-bear rounded-md border px-3 py-2 text-center font-mono text-xs">
          Binance data is unavailable ({data.error ?? 'unknown error'}). Nothing fake is shown — retrying automatically.
        </div>
      ) : null}

      {isLoading && !data ? (
        <p className="text-muted-foreground p-8 text-center font-mono text-sm">Loading 1M / 3M / 5M candles…</p>
      ) : visible.length === 0 ? (
        <p className="text-muted-foreground p-8 text-center font-mono text-sm">
          {rows.length === 0 ? 'Waiting for market data…' : 'No coins match these filters.'}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
            {visible.map((r) => (
              <ReversalCard key={r.symbol} row={r} now={now} onOpen={onOpen} />
            ))}
          </div>
          <ReversalTable rows={visible} now={now} onOpen={onOpen} />
          {sorted.length > visible.length ? (
            <button
              type="button"
              onClick={() => setLimit((l) => l + PAGE)}
              className="border-border bg-card h-12 w-full rounded-md border font-mono text-xs font-bold"
            >
              Show {Math.min(PAGE, sorted.length - visible.length)} more ({sorted.length - visible.length} left)
            </button>
          ) : null}
        </>
      )}

      <p className="text-muted-foreground px-1 text-[10px] leading-relaxed">
        Ladder: <b>EARLY</b> = 1M VIDYA flipped while 3M and 5M were still on the other side · <b>TRIGGER</b> = plus 1M EMA 9/21 cross ·{' '}
        <b>3M / 5M CONFIRMED</b> = that timeframe&apos;s VIDYA flipped too · <b>STRONG</b> = all three flipped and the 1M EMA cross is in.
        A reversal only counts if 1M, 3M and 5M all sat on the opposite side before it started and it began within {p?.windowMin ?? 120} minutes.
        TURNING = price has crossed back through the VIDYA line (line slope reversed) but the ATR band has not flipped yet — a heads-up, not a signal.
        Fake-reversal filters: <b>VOL</b> — TRIGGER/STRONG need buy/sell volume since the 1M flip to lean the reversal&apos;s way; <b>CHOPPY</b> — 4+ 1M flips in
        60 minutes suppresses EARLY/TRIGGER; <b>FAILED</b> — an attempt that flipped straight back (1M within 15 candles, 3M within 8, 5M within 6) is flagged and dropped. These cut false
        signals but cannot remove them.
        Strength is a simple additive score (1M VIDYA +1, 1M cross +1, 3M +2, 5M +3, agreement bonus up to +2); it is a filter, not a probability.
        No signal here is guaranteed or risk-free — always size positions and stops yourself.
      </p>
    </div>
  )
}
