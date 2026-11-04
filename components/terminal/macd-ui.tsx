'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import type { Dir } from '@/lib/macdmtf'

// Small shared pieces for the MACD tab (formatting, colour tokens, layout atoms).

/** Price with enough digits for both BTC and sub-cent coins. */
export function px(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 100) return v.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (a >= 1) return v.toFixed(4)
  if (a >= 0.01) return v.toFixed(5)
  return v.toPrecision(4)
}
export const small = (v: number) => (Number.isFinite(v) ? (Math.abs(v) >= 1 ? v.toFixed(2) : Math.abs(v) < 0.001 && v !== 0 ? v.toExponential(2) : v.toPrecision(3)) : '—')
export const coinName = (s: string) => s.replace('USDT', '')
export const when = (ms: number) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false })
export const signed = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}`
export function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** Re-renders every `ms` so countdowns and "x seconds ago" labels stay live. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

export type Tone = 'bull' | 'bear' | 'warn' | 'muted' | 'primary'
export const TONE: Record<Tone, string> = {
  bull: 'border-bull/40 bg-bull/15 text-bull',
  bear: 'border-bear/40 bg-bear/15 text-bear',
  warn: 'border-warn/50 bg-warn/10 text-warn',
  primary: 'border-primary/40 bg-primary/10 text-primary',
  muted: 'border-border bg-muted text-muted-foreground',
}
export const dirTone = (d: Dir | 'ABOVE' | 'BELOW' | 'BULLISH' | 'BEARISH' | 'MIXED' | 'NEUTRAL'): Tone =>
  d === 'BUY' || d === 'ABOVE' || d === 'BULLISH' ? 'bull' : d === 'SELL' || d === 'BELOW' || d === 'BEARISH' ? 'bear' : d === 'MIXED' ? 'warn' : 'muted'

export function Chip({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] font-bold', TONE[tone])}>
      {children}
    </span>
  )
}

export function Pill({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <div className={cn('rounded border px-1.5 py-1.5 text-center font-mono text-[11px] font-extrabold leading-tight sm:text-xs', TONE[tone], className)}>{children}</div>
}

export function Row({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground font-mono text-[11px]">{k}</span>
      <span className={cn('text-right font-mono text-[11px] font-semibold', cls)}>{v}</span>
    </div>
  )
}

export function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('border-border bg-card flex min-w-0 flex-col gap-2.5 rounded-xl border p-3', className)}>
      <h2 className="text-sm font-extrabold uppercase tracking-wide">{title}</h2>
      {children}
    </section>
  )
}

export function Stat({ k, v, cls }: { k: string; v: string; cls?: string }) {
  return (
    <div className="border-border min-w-0 rounded-lg border p-2">
      <div className="text-muted-foreground font-mono text-[10px] uppercase leading-tight">{k}</div>
      <div className={cn('font-mono text-base font-extrabold', cls)}>{v}</div>
    </div>
  )
}
