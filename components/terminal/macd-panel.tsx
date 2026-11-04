'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatPct } from '@/lib/format'
import { MACD_LABEL, MACD_MS, MACD_TFS, type MacdConfig, type MacdRow, type MacdSignal, type TfView } from '@/lib/macdmtf'
import type { MacdResponse } from '@/app/api/macd/route'
import type { MacdAlerts } from '@/hooks/use-macd-alerts'
import { useLivePrice } from '@/hooks/use-live-price'
import { AlertsTab } from './macd-alerts'
import { BacktestTab, PerformanceTab } from './macd-perf'
import { SettingsTab } from './macd-settings'
import { Chip, Pill, Row, Section, TONE, clock, coinName, dirTone, mmss, px, signed, small, useNow, when, type Tone } from './macd-ui'

type Sub = 'dashboard' | 'scanner' | 'alerts' | 'active' | 'performance' | 'backtest' | 'settings'
const SUBS: Array<{ key: Sub; label: string }> = [
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'scanner', label: 'MACD Scanner' },
  { key: 'alerts', label: 'Confirmation Alerts' },
  { key: 'active', label: 'Active Trades' },
  { key: 'performance', label: 'MACD Performance' },
  { key: 'backtest', label: 'Backtesting' },
  { key: 'settings', label: 'Settings' },
]

function stateTone(r: MacdRow): Tone {
  const s = r.status.state
  if (s === 'CONFIRMED BUY') return 'bull'
  if (s === 'CONFIRMED SELL') return 'bear'
  if (s === 'DEVELOPING BUY') return 'bull'
  if (s === 'DEVELOPING SELL') return 'bear'
  return r.status.blocker ? 'warn' : 'muted'
}

/** Short label for lists. */
function shortStatus(r: MacdRow): string {
  const s = r.status.state
  if (s !== 'WAIT') return s
  if (r.agreement.side) return r.status.blocker ? 'WAIT — BLOCKED' : `ALL ${r.agreement.side === 'BUY' ? 'BULLISH' : 'BEARISH'}`
  return `WAIT ${Math.max(r.agreement.bull, r.agreement.bear)}/${r.agreement.total}`
}

// ------------------------------------------------------------------ MACD timeframe card

function TfCard({ t, trigger }: { t: TfView; trigger: boolean }) {
  const tone: Tone = t.selected ? dirTone(t.dir) : 'muted'
  const crossText = t.cross ? `${t.cross.type} CROSS CONFIRMED · ${t.cross.barsAgo === 0 ? 'this candle' : `${t.cross.barsAgo} bar${t.cross.barsAgo === 1 ? '' : 's'} ago`}` : 'no recent crossover'
  return (
    <div className={cn('min-w-0 rounded-lg border p-2', TONE[tone])}>
      <div className="flex items-center justify-between gap-1">
        <span className="font-mono text-sm font-extrabold">
          {MACD_LABEL[t.tf]}
          {trigger ? ' ★' : ''}
        </span>
        <span className="font-mono text-xs font-extrabold">{t.dir === 'BUY' ? 'BUY ↑' : t.dir === 'SELL' ? 'SELL ↓' : 'NEUTRAL'}</span>
      </div>
      <div className="text-foreground mt-1 font-mono text-[10px] leading-snug">
        <div>
          Blue {small(t.line)} · Signal {small(t.signal)}
        </div>
        <div>
          Hist {small(t.hist)} · {t.momentum.toLowerCase()}
        </div>
        <div>{crossText}</div>
        <div className="opacity-80">
          {t.zero.toLowerCase()} zero · line {t.moving.toLowerCase()}
        </div>
        <div className="font-bold">{t.selected ? 'closed candle · confirmed' : 'not required (excluded in Settings)'}</div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ trade plan

function Plan({ s, price, now }: { s: MacdSignal; price: number; now: number }) {
  const bull = s.side === 'BUY'
  const ms = MACD_MS[s.trigger]
  return (
    <div className={cn('rounded-lg border-2 p-3', bull ? 'border-bull bg-bull/10' : 'border-bear bg-bear/10')}>
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry (signal price)</div>
          <div className="font-mono text-base font-extrabold sm:text-xl">{px(s.entry)}</div>
        </div>
        <div>
          <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
          <div className="text-bear font-mono text-base font-extrabold sm:text-xl">{px(s.sl)}</div>
        </div>
        <div>
          <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
          <div className="text-bull font-mono text-base font-extrabold sm:text-xl">{px(s.tp)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-4 sm:grid-cols-3">
        <Row k="Risk" v={`${px(s.risk)} (${s.riskPct.toFixed(2)}%)`} />
        <Row k="Reward" v={`${px(s.reward)} (${s.rewardPct.toFixed(2)}%)`} />
        <Row k="Risk : reward" v="1 : 2" />
        <Row k="Live price" v={px(price)} />
        <Row k="Fees + slippage" v={`≈ ${s.costR.toFixed(2)}R`} />
        <Row k={`Next ${MACD_LABEL[s.trigger]} candle`} v={mmss(ms - (now % ms))} />
      </div>
      <div className="text-muted-foreground mt-1 font-mono text-[10px] leading-snug">
        Entry is the {MACD_LABEL[s.trigger]} candle close, not an executed fill: check the live price and slippage before ordering. Stop = {MACD_LABEL[s.trigger]} Supertrend line. Candle closed {when(s.time)}.
      </div>
      {s.riskPct > 3 ? (
        <div className="text-warn mt-1 flex items-start gap-1.5 font-mono text-[11px] font-bold">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          Wide stop ({s.riskPct.toFixed(1)}% of price). Size the position for that distance.
        </div>
      ) : null}
    </div>
  )
}

// ------------------------------------------------------------------ pair list (used by the dashboard and the scanner)

type Filter = 'ALL' | 'CONFIRMED' | 'DEVELOPING' | 'BULL' | 'BEAR'
const rank = (r: MacdRow) => (r.signal ? 4 : r.status.state.startsWith('DEVELOPING') ? 3 : r.agreement.side ? 2 : Math.max(r.agreement.bull, r.agreement.bear) >= r.agreement.total - 1 ? 1 : 0)

function PairList({ rows, selected, onPick, compact }: { rows: MacdRow[]; selected: string; onPick: (s: string) => void; compact?: boolean }) {
  const [filter, setFilter] = useState<Filter>('ALL')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(compact ? 12 : 25)
  const list = useMemo(() => {
    const t = q.trim().toUpperCase()
    return rows
      .filter((r) => (t ? r.symbol.includes(t) : true))
      .filter((r) =>
        filter === 'CONFIRMED' ? r.signal : filter === 'DEVELOPING' ? r.status.state.startsWith('DEVELOPING') : filter === 'BULL' ? r.agreement.side === 'BUY' : filter === 'BEAR' ? r.agreement.side === 'SELL' : true,
      )
      .sort((a, b) => rank(b) - rank(a) || a.symbol.localeCompare(b.symbol))
  }, [rows, filter, q])
  useEffect(() => setLimit(compact ? 12 : 25), [filter, q, compact])
  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{compact ? 'Live coin scanner' : 'Scanner'} ({list.length})</h3>
        <label className="border-border bg-background flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-md border px-2 sm:max-w-48">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search pair" className="min-w-0 flex-1 bg-transparent font-mono text-xs outline-none" />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(['ALL', 'CONFIRMED', 'DEVELOPING', 'BULL', 'BEAR'] as Filter[]).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} className={cn('h-8 rounded-md border px-2.5 font-mono text-[11px] font-semibold', filter === f ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}>
            {f === 'BULL' ? 'ALL BULLISH' : f === 'BEAR' ? 'ALL BEARISH' : f}
          </button>
        ))}
      </div>
      <ul className="divide-border/60 divide-y">
        {list.slice(0, limit).map((r) => (
          <li key={r.symbol}>
            <button type="button" onClick={() => onPick(r.symbol)} className={cn('flex min-h-11 w-full flex-col gap-1.5 px-1 py-2 text-left', r.symbol === selected && 'bg-accent/40')}>
              <span className="flex items-center justify-between gap-2">
                <span className="min-w-0">
                  <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>{' '}
                  <span className="text-muted-foreground font-mono text-[10px]">
                    ${px(r.price)} <span className={r.change24h >= 0 ? 'text-bull' : 'text-bear'}>{formatPct(r.change24h)}</span>
                  </span>
                </span>
                <Chip tone={stateTone(r)}>{shortStatus(r)}</Chip>
              </span>
              <span className="grid grid-cols-5 gap-1">
                {MACD_TFS.map((tf) => {
                  const t = r.tfs[tf]
                  return (
                    <span key={tf} className={cn('rounded border px-0.5 py-0.5 text-center font-mono text-[9px] font-bold leading-tight', t.selected ? TONE[dirTone(t.dir)] : TONE.muted)}>
                      {MACD_LABEL[tf]}
                      <span className="block">{t.dir === 'BUY' ? '▲ BUY' : t.dir === 'SELL' ? '▼ SELL' : '—'}</span>
                    </span>
                  )
                })}
              </span>
              {!compact ? (
                <span className="text-muted-foreground flex flex-wrap gap-x-3 font-mono text-[10px]">
                  <span>EMA200: {r.ema200.near ? 'CLOSE — WAIT' : r.ema200.position}</span>
                  <span>ST 12,4: {r.supertrend.dir}</span>
                  <span className="truncate">{r.status.text}</span>
                </span>
              ) : null}
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

// ------------------------------------------------------------------ dashboard

function Dashboard({ row, rows, data, isError, config, onPick }: { row: MacdRow; rows: MacdRow[]; data: MacdResponse | undefined; isError: boolean; config: MacdConfig; onPick: (s: string) => void }) {
  const now = useNow(1000)
  const ws = useLivePrice(row.symbol)
  const wsFresh = ws.status === 'live' && ws.at !== null && now - ws.at < 15_000
  const price = wsFresh && ws.price !== null ? ws.price : row.price
  const ageS = data ? Math.max(0, Math.round((now - data.computedAt) / 1000)) : 0
  const conn: { tone: Tone; text: string } = isError
    ? { tone: 'bear', text: 'DISCONNECTED — retrying' }
    : ageS > 180
      ? { tone: 'bear', text: `STALE DATA (${ageS}s)` }
      : ageS > 90
        ? { tone: 'warn', text: `DATA DELAYED (${ageS}s)` }
        : { tone: 'bull', text: 'CONNECTED' }
  const g = row.agreement
  const e = row.ema200
  const st = row.supertrend
  const tone = stateTone(row)
  const sig = row.signal
  const bullAll = rows.filter((r) => r.agreement.side === 'BUY').length
  const bearAll = rows.filter((r) => r.agreement.side === 'SELL').length
  const btc = rows.find((r) => r.symbol === 'BTCUSDT')
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <section className="border-border bg-card rounded-xl border-2 p-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 className="font-mono text-xl font-extrabold sm:text-2xl">
              {coinName(row.symbol)}
              <span className="text-muted-foreground text-sm font-normal">/USDT · {MACD_LABEL[row.trigger]}</span>
            </h2>
            <div className="font-mono text-base sm:text-lg">
              ${px(price)} <span className={cn('text-xs', row.change24h >= 0 ? 'text-bull' : 'text-bear')}>{formatPct(row.change24h)} 24h</span>
            </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <Chip tone={conn.tone}>{conn.text}</Chip>
            <Chip tone={wsFresh ? 'bull' : ws.status === 'connecting' ? 'muted' : 'warn'} title="Live last price over the Binance WebSocket. Signals never use it: they use closed candles only.">
              PRICE {wsFresh ? `LIVE · ${Math.max(0, Math.round((now - (ws.at ?? now)) / 1000))}s` : ws.status === 'connecting' ? 'CONNECTING' : 'POLLING'}
            </Chip>
            <Chip tone="muted">CANDLES UPDATED {data ? clock(data.computedAt) : '—'}</Chip>
            <Chip tone="muted">LAST CLOSED {MACD_LABEL[row.trigger]} {clock(row.barTime)}</Chip>
          </div>
        </section>

        <section className={cn('rounded-xl border-2 p-3 text-center', TONE[tone])}>
          <div className="font-mono text-[10px] uppercase opacity-80">Signal status</div>
          <div className="text-xl font-extrabold leading-tight sm:text-3xl">{sig ? `MACD CONFIRMED ${sig.side}` : row.status.state === 'WAIT' ? 'WAIT / NO TRADE' : row.status.state}</div>
          <div className="mt-1 font-mono text-[11px] font-bold leading-snug opacity-90 sm:text-xs">{sig ? row.status.text : row.status.text}</div>
        </section>

        {sig ? <Plan s={sig} price={price} now={now} /> : null}
        {sig ? (
          <ul className="border-border bg-card text-muted-foreground list-inside list-disc rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed">
            {sig.conditions.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        ) : null}

        <Section title="MACD multi-timeframe direction">
          <div className={cn('rounded-lg border p-2 text-center font-mono text-xs font-extrabold', TONE[g.side ? dirTone(g.side) : 'warn'])}>
            {g.side ? `ALL ${g.total} TIMEFRAMES ${g.side === 'BUY' ? 'BULLISH' : 'BEARISH'}` : `NOT AGREEING — ${g.bull} BULLISH / ${g.bear} BEARISH${g.disagreeing.length ? ` · ${g.disagreeing.map((t) => MACD_LABEL[t]).join(', ')} disagree` : ''}`}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
            {MACD_TFS.map((tf) => (
              <TfCard key={tf} t={row.tfs[tf]} trigger={tf === row.trigger} />
            ))}
          </div>
        </Section>

        <div className="grid gap-3 sm:grid-cols-2">
          <Section title={`EMA 200 filter (${MACD_LABEL[row.trigger]})`}>
            <div>
              <Row k="Current price" v={px(price)} />
              <Row k="EMA 200" v={px(e.value)} cls="text-primary" />
              <Row k="Price vs EMA 200" v={`${e.position} · ${signed(e.distPct)}% · ${e.distAtr.toFixed(1)} ATR`} cls={e.near ? 'text-warn' : e.position === 'ABOVE' ? 'text-bull' : 'text-bear'} />
              <Row k="Trend status" v={e.trend} cls={e.trend === 'BULLISH' ? 'text-bull' : e.trend === 'BEARISH' ? 'text-bear' : 'text-warn'} />
              <Row k="EMA 200 slope" v={e.slope} cls={e.slope === 'RISING' ? 'text-bull' : e.slope === 'FALLING' ? 'text-bear' : ''} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Pill tone={e.buyValid ? 'bull' : 'muted'}>BUY {e.buyValid ? 'VALID' : 'BLOCKED'}</Pill>
              <Pill tone={e.sellValid ? 'bear' : 'muted'}>SELL {e.sellValid ? 'VALID' : 'BLOCKED'}</Pill>
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">{e.label}</div>
          </Section>
          <Section title={`Supertrend ${config.stPeriod},${config.stMult} (${MACD_LABEL[row.trigger]})`}>
            <Pill tone={dirTone(st.dir)} className="text-sm">
              {st.dir === 'BUY' ? 'BULLISH · BUY' : 'BEARISH · SELL'}
            </Pill>
            <div>
              <Row k="Supertrend value (stop reference)" v={px(st.line)} />
              <Row k="Price distance" v={`${signed(st.distPct)}%`} />
              <Row k="Last flip" v={st.flipBarsAgo === null ? 'none in window' : `${st.flipBarsAgo} bar${st.flipBarsAgo === 1 ? '' : 's'} ago`} />
              <Row k="Status" v={st.label} />
            </div>
            <div className="text-muted-foreground font-mono text-[10px]">A signal needs the Supertrend to agree with the MACD side; a flip alone never creates one.</div>
          </Section>
        </div>

        <Section title="Active TP / SL">
          {row.open.length === 0 ? (
            <p className="text-muted-foreground font-mono text-xs">No open signal on {coinName(row.symbol)}. WAIT — NO VALID ENTRY.</p>
          ) : (
            <ul className="divide-border/60 divide-y">
              {row.open.map((s) => (
                <li key={s.id} className="py-1.5">
                  <div className="flex items-center gap-2">
                    <Chip tone={s.side === 'BUY' ? 'bull' : 'bear'}>{s.side}</Chip>
                    <span className="text-muted-foreground font-mono text-[10px]">{when(s.time)}</span>
                  </div>
                  <div className="font-mono text-[11px]">
                    Entry {px(s.entry)} · <span className="text-bear">SL {px(s.sl)}</span> · <span className="text-bull">TP {px(s.tp)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        <Section title="Overall market direction">
          <Pill tone={g.side ? dirTone(g.side) : 'warn'} className="text-sm">
            {coinName(row.symbol)}: {g.overall}
          </Pill>
          <Row k={btc ? 'BTC (all timeframes)' : 'BTC'} v={btc ? (btc.agreement.side === 'BUY' ? 'ALL BULLISH' : btc.agreement.side === 'SELL' ? 'ALL BEARISH' : `MIXED ${btc.agreement.bull}↑ ${btc.agreement.bear}↓`) : '—'} cls={btc?.agreement.side ? (btc.agreement.side === 'BUY' ? 'text-bull' : 'text-bear') : 'text-warn'} />
          <Row k="Pairs all-timeframe bullish" v={`${bullAll} / ${rows.length}`} cls="text-bull" />
          <Row k="Pairs all-timeframe bearish" v={`${bearAll} / ${rows.length}`} cls="text-bear" />
        </Section>
        <PairList rows={rows} selected={row.symbol} onPick={onPick} compact />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ active trades

function ActiveTrades({ rows, onSelect }: { rows: MacdRow[]; onSelect: (s: string) => void }) {
  const open = useMemo(() => rows.flatMap((r) => r.open.map((s) => ({ s, price: r.price }))).sort((a, b) => b.s.time - a.s.time), [rows])
  return (
    <Section title={`Active trades (${open.length})`}>
      <p className="text-muted-foreground font-mono text-[10px] leading-snug">
        Confirmed signals whose stop-loss and take-profit have not been touched yet, tracked on the real candles since the signal. A trade closes the moment a candle&apos;s high or low reaches SL or TP. These are signals, not orders placed on your account.
      </p>
      {open.length === 0 ? (
        <p className="text-muted-foreground font-mono text-xs">No open signals. WAIT — NO VALID ENTRY.</p>
      ) : (
        <ul className="divide-border/60 divide-y">
          {open.map(({ s, price }) => {
            const bull = s.side === 'BUY'
            const unreal = ((bull ? price - s.entry : s.entry - price) / s.risk)
            const toSl = (Math.abs(price - s.sl) / price) * 100
            const toTp = (Math.abs(s.tp - price) / price) * 100
            return (
              <li key={s.id} className="py-2">
                <button type="button" onClick={() => onSelect(s.symbol)} className="flex min-h-9 w-full items-center justify-between gap-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={bull ? 'bull' : 'bear'}>{s.side}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(s.symbol)}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">{MACD_LABEL[s.trigger]} · {when(s.time)}</span>
                  </span>
                  <span className={cn('font-mono text-xs font-extrabold', unreal >= 0 ? 'text-bull' : 'text-bear')}>{signed(unreal, 2)}R</span>
                </button>
                <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
                  <Row k="Entry" v={px(s.entry)} />
                  <Row k="SL" v={`${px(s.sl)} (${toSl.toFixed(2)}% away)`} cls="text-bear" />
                  <Row k="TP" v={`${px(s.tp)} (${toTp.toFixed(2)}% away)`} cls="text-bull" />
                  <Row k="Live price" v={px(price)} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <p className="text-muted-foreground font-mono text-[10px]">Unrealised R uses the live price and ignores fees; the Performance tab includes fees and slippage.</p>
    </Section>
  )
}

// ------------------------------------------------------------------ panel

export interface MacdPanelProps {
  data: MacdResponse | undefined
  isLoading: boolean
  isError: boolean
  config: MacdConfig
  onConfig: (c: Partial<MacdConfig>) => void
  selected: string
  onSelect: (s: string) => void
  onOpenTerminal: (s: string) => void
  alerts: MacdAlerts
}

export function MacdPanel({ data, isLoading, isError, config, onConfig, selected, onSelect, onOpenTerminal, alerts }: MacdPanelProps) {
  const [sub, setSub] = useState<Sub>('dashboard')
  const rows = useMemo(() => data?.rows ?? [], [data])
  const row = rows.find((r) => r.symbol === selected) ?? rows.find((r) => r.symbol === 'BTCUSDT') ?? rows[0]
  const pick = (s: string) => {
    onSelect(s)
    setSub('dashboard')
  }
  const confirmed = rows.filter((r) => r.signal).length

  const body = () => {
    if (isLoading && !data) return <div className="text-muted-foreground p-6 text-center font-mono text-sm">Loading 1M / 3M / 5M / 15M / 30M candles…</div>
    if (data && !data.live) {
      return (
        <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">
          Binance data is unavailable right now ({data.error ?? 'unknown error'}). No signals are shown — retrying automatically, nothing fake is being displayed.
        </div>
      )
    }
    if (isError && !data) return <div className="border-bear/30 bg-bear/10 text-bear rounded-lg border p-3 font-mono text-xs">Could not reach the MACD data service. Retrying automatically.</div>
    switch (sub) {
      case 'settings':
        return <SettingsTab config={config} onApply={onConfig} />
      case 'backtest':
        return <BacktestTab config={config} onDone={() => undefined} />
      case 'performance':
        return <PerformanceTab rows={rows} config={config} />
      case 'alerts':
        return <AlertsTab rows={rows} alerts={alerts} onSelect={pick} />
      case 'active':
        return <ActiveTrades rows={rows} onSelect={pick} />
      case 'scanner':
        return <PairList rows={rows} selected={row?.symbol ?? ''} onPick={pick} />
      default:
        return row ? (
          <Dashboard row={row} rows={rows} data={data} isError={isError} config={config} onPick={onSelect} />
        ) : (
          <div className="text-muted-foreground p-6 text-center font-mono text-sm">No pairs have enough candle history yet.</div>
        )
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-3 p-2 sm:p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-base font-extrabold sm:text-lg">MACD Multi-Timeframe Confirmation</h1>
          <p className="text-muted-foreground font-mono text-[10px]">
            {rows.length} pairs · 1M 3M 5M 15M 30M · closed candles only · {config.tfs.length === 5 ? 'all 5 timeframes must agree' : `${config.tfs.map((t) => MACD_LABEL[t]).join(' + ')} must agree`}
          </p>
        </div>
        {confirmed > 0 ? <Chip tone="bull">{confirmed} CONFIRMED NOW</Chip> : null}
      </header>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-7">
        {SUBS.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setSub(s.key)}
            className={cn('h-10 rounded-md border px-2 font-mono text-[11px] font-semibold leading-tight', sub === s.key ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground')}
          >
            {s.label}
            {s.key === 'alerts' && alerts.popups.length > 0 ? ` (${alerts.popups.length})` : ''}
          </button>
        ))}
      </div>

      <label className={cn('text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase lg:hidden', sub !== 'dashboard' && 'hidden')}>
        Trading pair
        <select value={row?.symbol ?? ''} onChange={(e) => onSelect(e.target.value)} className="border-border bg-card text-foreground h-11 rounded-md border px-2 font-mono text-sm">
          {[...rows].sort((a, b) => a.symbol.localeCompare(b.symbol)).map((r) => (
            <option key={r.symbol} value={r.symbol}>
              {coinName(r.symbol)}
              {r.signal ? ` — CONFIRMED ${r.signal.side}` : r.status.state.startsWith('DEVELOPING') ? ` — ${r.status.state.toLowerCase()}` : ''}
            </option>
          ))}
        </select>
      </label>

      {body()}

      {row && sub === 'dashboard' ? (
        <button type="button" onClick={() => onOpenTerminal(row.symbol)} className="border-border text-muted-foreground h-11 w-full rounded-md border text-xs font-semibold">
          Open {coinName(row.symbol)} in Live Terminal
        </button>
      ) : null}
    </div>
  )
}
