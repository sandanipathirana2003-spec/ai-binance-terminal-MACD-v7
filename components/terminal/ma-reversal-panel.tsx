'use client'

import { useEffect, useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct, formatPrice } from '@/lib/format'
import { useReversal } from '@/hooks/use-reversal'
import { REV_TFS, REV_TF_LABEL, type RevTf } from '@/lib/reversal'
import { STAGE_LABEL, type MaRow, type MaSignal, type MaTf, type Relation, type Slope } from '@/lib/mareversal'

const PAGE = 25
type Filter = 'ALL' | 'BUY' | 'SELL' | 'EARLY' | 'FAKE'
type SortKey = 'STRENGTH' | 'NEWEST' | 'NAME'

const ARROW: Record<Slope, string> = { RISING: '↑', FALLING: '↓', FLAT: '→' }
const SLOPE_CLS: Record<Slope, string> = {
  RISING: 'border-bull/30 bg-bull/15 text-bull',
  FALLING: 'border-bear/30 bg-bear/15 text-bear',
  FLAT: 'border-border bg-muted text-muted-foreground',
}
const REL_CLS: Record<Relation, string> = {
  REVERSAL: 'text-warn',
  CONFIRMED: 'text-foreground',
  WEAK: 'text-muted-foreground',
  SUPPORT: 'text-primary',
  'COUNTER-TREND': 'text-bear',
  NEUTRAL: 'text-muted-foreground',
}

function fmtDur(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`
}

function signalCls(sig: MaSignal, side: 'BUY' | 'SELL' | null, solid: boolean): string {
  if (sig === 'WAIT') return 'border-border bg-muted text-muted-foreground'
  if (sig === 'POSSIBLE FAKE REVERSAL') return 'border-warn/50 bg-warn/10 text-warn'
  if (sig === 'WEAK REVERSAL') return 'border-border bg-secondary text-foreground'
  const strong = sig.startsWith('CONFIRMED') || sig.startsWith('STRONG')
  if (side === 'BUY') return solid && strong ? 'border-bull bg-bull text-bull-foreground' : 'border-bull/40 bg-bull/15 text-bull'
  return solid && strong ? 'border-bear bg-bear text-bear-foreground' : 'border-bear/40 bg-bear/15 text-bear'
}

function Chip({ cls, children, title }: { cls: string; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold', cls)}>
      {children}
    </span>
  )
}

/** Compact indicator badges for one timeframe: EMAs, VIDYA, cross, structure. */
function TfChips({ t }: { t: MaTf }) {
  const old = (k: 'e50' | 'e200') => t.ctx?.[k] === 'OLD TREND'
  const vBull = t.vidya.state.includes('BULLISH')
  const vBear = t.vidya.state.includes('BEARISH')
  return (
    <div className="flex flex-wrap gap-1">
      <Chip cls={SLOPE_CLS[t.slopes.e9]}>9{ARROW[t.slopes.e9]}</Chip>
      <Chip cls={SLOPE_CLS[t.slopes.e21]}>21{ARROW[t.slopes.e21]}</Chip>
      <Chip cls={SLOPE_CLS[t.slopes.e50]}>
        50{ARROW[t.slopes.e50]}
        {old('e50') ? ' OLD' : ''}
      </Chip>
      <Chip cls={SLOPE_CLS[t.slopes.e200]}>
        200{ARROW[t.slopes.e200]}
        {old('e200') ? ' OLD' : ''}
      </Chip>
      <Chip
        cls={vBull ? 'border-bull/30 bg-bull/15 text-bull' : vBear ? 'border-bear/30 bg-bear/15 text-bear' : 'border-border bg-muted text-muted-foreground'}
        title={`VIDYA 14/9/1.5 · band ${t.vidya.band ?? '—'} · CMO ${t.vidya.cmoPct.toFixed(0)}% · volume ${t.vidya.volDeltaPct.toFixed(0)}%`}
      >
        VIDYA {t.vidya.state.replace('TURNING ', '↗ ').replace('↗ BEARISH', '↘ BEARISH')} {ARROW[t.vidya.slope]}
      </Chip>
      <Chip cls={t.vidya.momentum === 'BULLISH' ? 'border-bull/30 bg-bull/15 text-bull' : t.vidya.momentum === 'BEARISH' ? 'border-bear/30 bg-bear/15 text-bear' : 'border-border bg-muted text-muted-foreground'}>
        MOM {t.vidya.cmoPct > 0 ? '+' : ''}
        {t.vidya.cmoPct.toFixed(0)}% · VOL {t.vidya.volDeltaPct > 0 ? '+' : ''}
        {t.vidya.volDeltaPct.toFixed(0)}%
      </Chip>
      {t.cross ? (
        <Chip cls={t.cross.type === 'BULL' ? 'border-bull/30 bg-bull/15 text-bull' : 'border-bear/30 bg-bear/15 text-bear'}>
          9/21 {t.cross.type === 'BULL' ? '✕↑' : '✕↓'} {t.cross.barsAgo}c
        </Chip>
      ) : null}
      <Chip cls="border-border bg-muted text-muted-foreground">
        {t.structure.label === 'HIGHER LOWS' ? 'HL' : t.structure.label === 'LOWER HIGHS' ? 'LH' : t.structure.label === 'RANGE' ? 'RANGE' : 'NO STRUCT'}
        {t.structure.break === 'HIGH' ? ' · BRK↑' : t.structure.break === 'LOW' ? ' · BRK↓' : ''}
      </Chip>
    </div>
  )
}

function TfBlock({ tf, row }: { tf: RevTf; row: MaRow }) {
  const t = row.tfs[tf]
  const rel = row.rels[tf]
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="w-7 shrink-0 font-mono text-sm font-bold">{REV_TF_LABEL[tf]}</span>
          <span className={cn('rounded border px-2 py-0.5 font-mono text-[11px] font-extrabold', signalCls(t.signal, t.side, false))}>{t.signal}</span>
        </div>
        <div className="shrink-0 text-right font-mono text-[10px] leading-tight">
          <div className="font-semibold">
            S{t.stage} {STAGE_LABEL[t.stage]}
          </div>
          {row.side ? <div className={REL_CLS[rel]}>{rel}</div> : null}
        </div>
      </div>
      <TfChips t={t} />
      {t.alignment ? <div className="text-primary font-mono text-[10px] font-bold">{t.alignment}</div> : null}
    </div>
  )
}

function MaCard({ row, onOpen }: { row: MaRow; onOpen: (s: string) => void }) {
  return (
    <article className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-3">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-mono text-base font-bold">
          {row.symbol.replace('USDT', '')}
          <span className="text-muted-foreground text-xs font-normal">/USDT</span>
        </h3>
        <span className="font-mono text-xs">
          ${formatPrice(row.price)} <span className={row.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(row.change24h)}</span>
        </span>
      </header>

      <div className={cn('rounded-lg border px-3 py-2.5 text-center', signalCls(row.signal, row.side, true))}>
        <div className="text-2xl font-extrabold leading-tight tracking-wide">{row.signal}</div>
        <div className="mt-1 font-mono text-[11px] font-semibold uppercase leading-snug opacity-90">{row.headline}</div>
        {row.established ? <div className="mt-0.5 font-mono text-[10px] opacity-80">ESTABLISHED TREND · NO FRESH 9/21 CROSS</div> : null}
      </div>
      <p className="text-muted-foreground font-mono text-[11px] leading-snug">{row.reason}</p>

      <div className="divide-border/60 divide-y">
        {REV_TFS.map((tf) => (
          <TfBlock key={tf} tf={tf} row={row} />
        ))}
      </div>

      <button type="button" onClick={() => onOpen(row.symbol)} className="border-border text-muted-foreground active:bg-accent/40 h-11 w-full rounded-md border text-xs font-semibold">
        Open {row.symbol.replace('USDT', '')} in Terminal
      </button>
    </article>
  )
}

function MaTable({ rows, onOpen }: { rows: MaRow[]; onOpen: (s: string) => void }) {
  return (
    <div className="border-border bg-card hidden overflow-hidden rounded-lg border lg:block">
      <table className="w-full table-fixed text-left">
        <thead className="bg-secondary/40 text-muted-foreground font-mono text-[10px] uppercase">
          <tr>
            <th className="w-[12%] px-3 py-2">Coin</th>
            <th className="w-[19%] px-2 py-2">Signal · Overall</th>
            {REV_TFS.map((tf) => (
              <th key={tf} className="w-[23%] px-2 py-2">
                {REV_TF_LABEL[tf]}
              </th>
            ))}
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
                <div className={cn('rounded border px-2 py-1 text-center font-mono text-xs font-extrabold', signalCls(r.signal, r.side, true))}>{r.signal}</div>
                <div className="text-muted-foreground mt-1 font-mono text-[9px] uppercase leading-tight">{r.headline}</div>
                <div className="text-muted-foreground mt-1 font-mono text-[9px] leading-tight normal-case">{r.reason}</div>
              </td>
              {REV_TFS.map((tf) => (
                <td key={tf} className="px-2 py-2">
                  <div className="mb-1 flex items-center gap-1.5">
                    <span className={cn('rounded border px-1.5 py-0.5 font-mono text-[10px] font-extrabold', signalCls(r.tfs[tf].signal, r.tfs[tf].side, false))}>{r.tfs[tf].signal}</span>
                    <span className="text-muted-foreground font-mono text-[9px]">S{r.tfs[tf].stage}</span>
                  </div>
                  <TfChips t={r.tfs[tf]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MaReversalPanel({ onOpen }: { onOpen: (symbol: string) => void }) {
  const { data, isLoading } = useReversal()
  const [filter, setFilter] = useState<Filter>('ALL')
  const [sort, setSort] = useState<SortKey>('STRENGTH')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => setLimit(PAGE), [filter, sort, query])

  const rows = data?.maRows ?? []
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? rows.filter((r) => r.symbol.toLowerCase().includes(q)) : rows
  }, [rows, query])
  const counts = useMemo(
    () => ({
      ALL: searched.length,
      BUY: searched.filter((r) => r.side === 'BUY' && r.signal !== 'POSSIBLE FAKE REVERSAL').length,
      SELL: searched.filter((r) => r.side === 'SELL' && r.signal !== 'POSSIBLE FAKE REVERSAL').length,
      EARLY: searched.filter((r) => r.early).length,
      FAKE: searched.filter((r) => r.signal === 'POSSIBLE FAKE REVERSAL').length,
    }),
    [searched],
  )
  const sorted = useMemo(() => {
    const list = searched.filter((r) =>
      filter === 'ALL' ? true : filter === 'EARLY' ? r.early : filter === 'FAKE' ? r.signal === 'POSSIBLE FAKE REVERSAL' : r.side === filter && r.signal !== 'POSSIBLE FAKE REVERSAL',
    )
    return list.sort((a, b) => {
      if (sort === 'NAME') return a.symbol.localeCompare(b.symbol)
      if (sort === 'NEWEST') return (b.startedAt ?? 0) - (a.startedAt ?? 0) || b.score - a.score
      return b.score - a.score || (b.startedAt ?? 0) - (a.startedAt ?? 0) || a.symbol.localeCompare(b.symbol)
    })
  }, [searched, filter, sort])
  const visible = sorted.slice(0, limit)

  const FILTERS: Array<{ key: Filter; label: string; cls: string }> = [
    { key: 'ALL', label: 'All', cls: 'border-primary/40 bg-primary/10 text-primary' },
    { key: 'BUY', label: 'Buy', cls: 'border-bull/40 bg-bull/15 text-bull' },
    { key: 'SELL', label: 'Sell', cls: 'border-bear/40 bg-bear/15 text-bear' },
    { key: 'EARLY', label: 'Early', cls: 'border-warn/40 bg-warn/15 text-warn' },
    { key: 'FAKE', label: 'Fake?', cls: 'border-warn/40 bg-warn/15 text-warn' },
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
          <h2 className="text-sm font-semibold">MA ribbon + VIDYA early reversals · 1M / 3M / 5M</h2>
          <p className="text-muted-foreground mt-0.5 font-mono text-[11px] leading-relaxed">
            EMA 9 · 21 · 50 · 200 | VIDYA 14 · 9 · 1.5 | closed candles only
            {data?.live ? ` | updated ${fmtDur(now - data.computedAt)} ago` : ''}
          </p>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={cn('flex h-14 flex-col items-center justify-center rounded-md border font-mono transition-colors', filter === f.key ? f.cls : 'border-border text-muted-foreground')}
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
                className={cn('h-11 rounded-md border font-mono text-xs font-bold transition-colors', sort === s.key ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
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
        <p className="text-muted-foreground p-8 text-center font-mono text-sm">{rows.length === 0 ? 'Waiting for market data…' : 'No coins match these filters.'}</p>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:hidden">
            {visible.map((r) => (
              <MaCard key={r.symbol} row={r} onOpen={onOpen} />
            ))}
          </div>
          <MaTable rows={visible} onOpen={onOpen} />
          {sorted.length > visible.length ? (
            <button type="button" onClick={() => setLimit((l) => l + PAGE)} className="border-border bg-card h-12 w-full rounded-md border font-mono text-xs font-bold">
              Show {Math.min(PAGE, sorted.length - visible.length)} more ({sorted.length - visible.length} left)
            </button>
          ) : null}
        </>
      )}

      <p className="text-muted-foreground px-1 text-[10px] leading-relaxed">
        <b>9</b> = early trigger · <b>21</b> = confirmation · <b>50/200</b> = context only (never required; shown as OLD while still pointing the old way) · <b>VIDYA</b> = momentum filter ·{' '}
        <b>HL/LH</b> = higher lows / lower highs from swing points · arrows are EMA slope (↑ rising, → flat, ↓ falling). A 9/21 cross alone never signals: it also needs a candle close beyond
        the MAs, EMA 9 slope in the new direction and VIDYA not opposing. Stages: S0 old trend → S1 early (cross + 9 turned + price beyond MAs) → S2 confirming (+ structure, 21 not against)
        → S3 trend confirmed (+ 50 flat/following) → S4 full 9/21/50/200 alignment. Risk tags compare against the higher timeframes; none of this is a guarantee, so size and place stops yourself.
      </p>
    </div>
  )
}
