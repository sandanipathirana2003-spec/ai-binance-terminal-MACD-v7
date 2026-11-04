'use client'

import { Bell, BellOff, Volume2, VolumeX, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MACD_LABEL, MACD_MS, MACD_TFS, type MacdRow } from '@/lib/macdmtf'
import type { MacdAlerts, MacdPopup, PopupMode } from '@/hooks/use-macd-alerts'
import { Chip, Pill, Row, Section, TONE, clock, coinName, dirTone, mmss, px, useNow, when } from './macd-ui'

// ------------------------------------------------------------------ popup (mounted once from the terminal shell)

/** Full-screen on phones, a corner card on desktop. Shows ONE confirmed signal at a time; more wait behind it. */
export function MacdPopups({ popups, mode, onDismiss, onDismissAll, onMode, onOpen }: { popups: MacdPopup[]; mode: PopupMode; onDismiss: (id: string) => void; onDismissAll: () => void; onMode: (m: PopupMode) => void; onOpen: (s: string) => void }) {
  const now = useNow(1000)
  if (popups.length === 0 || mode === 'off') return null
  const { signal: s, row } = popups[0]
  const bull = s.side === 'BUY'
  const ms = MACD_MS[s.trigger]
  const next = ms - (now % ms)
  if (mode === 'banner') {
    // Small, non-blocking card: no backdrop, sits above the phone tab bar, everything behind stays usable.
    return (
      <div className="pointer-events-none fixed inset-x-2 bottom-20 z-50 sm:inset-x-auto sm:bottom-4 sm:right-4 sm:w-80">
        <article className={cn('bg-card pointer-events-auto rounded-xl border-2 p-2.5 shadow-2xl', bull ? 'border-bull' : 'border-bear')}>
          <header className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className={cn('text-base font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>MACD CONFIRMED {s.side}</div>
              <div className="font-mono text-xs font-bold">
                {coinName(s.symbol)}/USDT · {MACD_LABEL[s.trigger]} · next candle {mmss(next)}
              </div>
            </div>
            <button type="button" onClick={() => onDismiss(s.id)} aria-label="Dismiss" className="text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
              <X className="size-4" />
            </button>
          </header>
          <div className="mt-1 font-mono text-[11px]">
            Entry {px(s.entry)} · <span className="text-bear">SL {px(s.sl)}</span> · <span className="text-bull">TP {px(s.tp)}</span> · 1:2 · risk {s.riskPct.toFixed(2)}%
          </div>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              onClick={() => {
                onOpen(s.symbol)
                onDismiss(s.id)
              }}
              className="bg-primary text-primary-foreground h-10 flex-1 rounded-md text-xs font-semibold"
            >
              Open {coinName(s.symbol)}
            </button>
            <button type="button" onClick={() => onDismiss(s.id)} className="border-border text-muted-foreground h-10 rounded-md border px-3 text-xs font-semibold">
              Dismiss
            </button>
            <button type="button" onClick={() => onMode('off')} className="border-border text-muted-foreground h-10 rounded-md border px-3 text-xs font-semibold" title="Stop showing popups (sound, notifications and the log stay on)">
              Mute
            </button>
          </div>
          {popups.length > 1 ? (
            <button type="button" onClick={onDismissAll} className="text-primary mt-1 w-full text-center font-mono text-[11px] font-bold">
              +{popups.length - 1} more waiting · dismiss all
            </button>
          ) : null}
        </article>
      </div>
    )
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/70 p-2 sm:items-start sm:justify-end sm:bg-transparent sm:pointer-events-none">
      <article className={cn('bg-card pointer-events-auto my-auto w-full max-w-md rounded-xl border-2 p-3 shadow-2xl sm:my-0', bull ? 'border-bull' : 'border-bear')}>
        <header className="flex items-start justify-between gap-2">
          <div>
            <div className={cn('text-2xl font-extrabold leading-tight', bull ? 'text-bull' : 'text-bear')}>MACD CONFIRMED {s.side}</div>
            <div className="font-mono text-sm font-bold">
              {coinName(s.symbol)}/USDT · {MACD_LABEL[s.trigger]}
            </div>
          </div>
          <button type="button" onClick={() => onDismiss(s.id)} aria-label="Dismiss" className="text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-md">
            <X className="size-5" />
          </button>
        </header>

        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-muted-foreground font-mono text-[10px] uppercase">Entry</div>
            <div className="font-mono text-lg font-extrabold">{px(s.entry)}</div>
          </div>
          <div>
            <div className="text-bear font-mono text-[10px] uppercase">Stop loss</div>
            <div className="text-bear font-mono text-lg font-extrabold">{px(s.sl)}</div>
          </div>
          <div>
            <div className="text-bull font-mono text-[10px] uppercase">Take profit</div>
            <div className="text-bull font-mono text-lg font-extrabold">{px(s.tp)}</div>
          </div>
        </div>

        <div className="mt-2">
          <Row k="Risk-to-reward" v="1 : 2" />
          <Row k="Risk / reward" v={`${s.riskPct.toFixed(2)}% / ${s.rewardPct.toFixed(2)}%`} />
        </div>

        <div className="mt-1.5">
          <div className="text-muted-foreground font-mono text-[10px] uppercase">MACD confirmation across timeframes</div>
          <div className="mt-1 grid grid-cols-5 gap-1">
            {MACD_TFS.map((tf) => {
              const used = s.selectedTfs.includes(tf)
              return (
                <Pill key={tf} tone={used ? dirTone(s.tfs[tf]) : 'muted'} className="px-0.5 py-1 text-[10px]">
                  {MACD_LABEL[tf]}
                  <span className="block">{used ? s.tfs[tf] : '—'}</span>
                </Pill>
              )
            })}
          </div>
        </div>

        <div className="mt-1.5">
          <Row k={`EMA 200 (${MACD_LABEL[s.trigger]})`} v={`PRICE ${s.ema200.position} · ${bull ? 'BULLISH' : 'BEARISH'} CONFIRMED`} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k={'Supertrend 12,4'} v={`${s.supertrend.dir === 'BUY' ? 'BULLISH' : 'BEARISH'} CONFIRMED`} cls={bull ? 'text-bull' : 'text-bear'} />
          <Row k={`${MACD_LABEL[s.trigger]} crossover`} v={`${bull ? 'BULLISH' : 'BEARISH'} · ${s.crossAge === 0 ? 'this candle' : `${s.crossAge} bar${s.crossAge === 1 ? '' : 's'} ago`}`} />
          <Row k="Signal time (candle close)" v={when(s.time)} />
          <Row k="Live price now" v={px(row.price)} />
        </div>

        <div className={cn('mt-2 rounded border px-2 py-1.5 text-center font-mono text-xs font-bold', TONE.primary)}>
          Next {MACD_LABEL[s.trigger]} candle in {mmss(next)}
        </div>

        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={() => {
              onOpen(s.symbol)
              onDismiss(s.id)
            }}
            className="bg-primary text-primary-foreground h-12 flex-1 rounded-md text-sm font-semibold"
          >
            Open {coinName(s.symbol)}
          </button>
          <button type="button" onClick={() => onDismiss(s.id)} className="border-border text-muted-foreground h-12 rounded-md border px-5 text-sm font-semibold">
            Dismiss
          </button>
          <button type="button" onClick={() => onMode('banner')} className="border-border text-muted-foreground h-12 rounded-md border px-3 text-xs font-semibold" title="Use the small banner instead of this big popup">
            Smaller
          </button>
        </div>
        {popups.length > 1 ? <div className="text-primary mt-1.5 text-center font-mono text-[11px] font-bold">+{popups.length - 1} more confirmed signal{popups.length > 2 ? 's' : ''} waiting</div> : null}
        <p className="text-muted-foreground mt-1.5 font-mono text-[10px] leading-snug">A filter, not a prediction. Entry is the candle close, not an executed fill: check the live price before ordering.</p>
      </article>
    </div>
  )
}

// ------------------------------------------------------------------ MACD CONFIRMATION ALERTS tab

export function AlertsTab({ rows, alerts, onSelect }: { rows: MacdRow[]; alerts: MacdAlerts; onSelect: (s: string) => void }) {
  const fresh = rows.filter((r) => r.signal)
  const developing = rows.filter((r) => !r.signal && r.status.state.startsWith('DEVELOPING'))
  return (
    <div className="flex flex-col gap-3">
      <Section title="MACD confirmation alerts">
        <p className="text-muted-foreground font-mono text-[11px] leading-snug">
          A popup appears only when every rule is satisfied, once per crossover, never for disagreeing timeframes, a failed EMA 200 filter, a failed Supertrend, or a sideways / weak market. Alerts work while this page is open; a phone only gets a notification
          while the browser or installed app is running.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <button type="button" onClick={alerts.toggleSound} className={cn('flex h-11 items-center justify-center gap-2 rounded-md border text-xs font-semibold', alerts.soundEnabled ? TONE.bull : TONE.muted)}>
            {alerts.soundEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}
            Sound {alerts.soundEnabled ? 'ON' : 'OFF'}
          </button>
          {alerts.permission === 'unsupported' ? (
            <div className={cn('flex h-11 items-center justify-center rounded-md border text-xs font-semibold', TONE.muted)}>Notifications unsupported here</div>
          ) : (
            <button
              type="button"
              onClick={alerts.requestPermission}
              disabled={alerts.permission !== 'default'}
              className={cn('flex h-11 items-center justify-center gap-2 rounded-md border text-xs font-semibold', alerts.permission === 'granted' ? TONE.bull : alerts.permission === 'denied' ? TONE.bear : TONE.warn)}
            >
              {alerts.permission === 'granted' ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              {alerts.permission === 'granted' ? 'Notifications ON' : alerts.permission === 'denied' ? 'Blocked in browser settings' : 'Enable notifications'}
            </button>
          )}
          <div className="border-border flex flex-col gap-1 rounded-md border p-1.5 sm:col-span-3">
            <div className="text-muted-foreground font-mono text-[10px] uppercase">Popup style (sound, notification and the log work in every mode)</div>
            <div className="grid grid-cols-3 gap-1.5">
              {([['full', 'Full popup'], ['banner', 'Small banner'], ['off', 'No popup']] as Array<[PopupMode, string]>).map(([m, label]) => (
                <button key={m} type="button" onClick={() => alerts.setPopupMode(m)} className={cn('h-10 rounded-md border text-xs font-semibold', alerts.popupMode === m ? TONE.primary : TONE.muted)}>
                  {label}
                </button>
              ))}
            </div>
            <label className="text-muted-foreground mt-1 flex items-center justify-between gap-2 font-mono text-[11px]">
              Skip alerts whose stop is wider than (% of price, 0 = never skip)
              <input
                type="number"
                inputMode="decimal"
                min={0}
                step={0.5}
                value={alerts.maxRiskPct}
                onChange={(e) => alerts.setMaxRiskPct(Number(e.target.value))}
                className="border-border bg-background text-foreground h-9 w-20 rounded-md border px-2 text-sm"
              />
            </label>
          </div>
          <button type="button" onClick={alerts.sendTest} className="border-border text-muted-foreground h-11 rounded-md border text-xs font-semibold">
            Send test alert (no signal)
          </button>
        </div>
      </Section>

      <Section title={`Confirmed now (${fresh.length})`}>
        {fresh.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No pair has a fresh confirmed signal. WAIT — NO VALID ENTRY.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {fresh.map((r) => (
              <li key={r.symbol}>
                <button type="button" onClick={() => onSelect(r.symbol)} className="flex min-h-11 w-full items-center justify-between gap-2 py-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={r.signal!.side === 'BUY' ? 'bull' : 'bear'}>{r.signal!.side}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                  </span>
                  <span className="text-muted-foreground font-mono text-[10px]">
                    {px(r.signal!.entry)} · SL {px(r.signal!.sl)} · TP {px(r.signal!.tp)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Developing, not confirmed (${developing.length})`}>
        {developing.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">Nothing developing right now.</p>
        ) : (
          <ul className="divide-border/60 divide-y">
            {developing.slice(0, 15).map((r) => (
              <li key={r.symbol}>
                <button type="button" onClick={() => onSelect(r.symbol)} className="flex min-h-11 w-full flex-col items-start gap-0.5 py-2 text-left">
                  <span className="flex items-center gap-2">
                    <Chip tone={dirTone(r.status.side ?? 'NEUTRAL')}>{r.status.state}</Chip>
                    <span className="font-mono text-sm font-bold">{coinName(r.symbol)}</span>
                  </span>
                  <span className="text-muted-foreground font-mono text-[10px] leading-snug">{r.status.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground font-mono text-[10px]">Developing setups never trigger a popup, sound or notification.</p>
      </Section>

      <Section title={`Alert log (${alerts.log.length})`}>
        {alerts.log.length === 0 ? (
          <p className="text-muted-foreground font-mono text-xs">No confirmed alert has fired in this browser yet.</p>
        ) : (
          <>
            <ul className="divide-border/60 divide-y">
              {alerts.log.map((a) => (
                <li key={a.id} className="py-2">
                  <button type="button" onClick={() => onSelect(a.symbol)} className="flex min-h-9 w-full items-center justify-between gap-2 text-left">
                    <span className="flex items-center gap-2">
                      <Chip tone={a.side === 'BUY' ? 'bull' : 'bear'}>{a.side}</Chip>
                      <span className="font-mono text-sm font-bold">{coinName(a.symbol)}</span>
                      <span className="text-muted-foreground font-mono text-[10px]">{a.trigger}</span>
                    </span>
                    <span className="text-muted-foreground font-mono text-[10px]">{when(a.signalTime)}</span>
                  </button>
                  <div className="text-muted-foreground font-mono text-[10px]">
                    Entry {px(a.entry)} · SL {px(a.sl)} · TP {px(a.tp)} · alerted {clock(a.alertedAt)}
                  </div>
                </li>
              ))}
            </ul>
            <button type="button" onClick={alerts.clearLog} className="border-border text-muted-foreground h-10 rounded-md border text-xs font-semibold">
              Clear log
            </button>
          </>
        )}
      </Section>
    </div>
  )
}

