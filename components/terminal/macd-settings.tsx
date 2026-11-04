'use client'

import { useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { DEFAULT_MACD, MACD_LABEL, MACD_TFS, RR, normalizeMacdConfig, type MacdConfig, type MacdTf } from '@/lib/macdmtf'
import { Section } from './macd-ui'

type NumKey = 'fast' | 'slow' | 'signal' | 'stPeriod' | 'stMult' | 'maxCrossAge' | 'nearEmaAtr' | 'feeBps' | 'slipBps'
const NUM_FIELDS: Array<{ key: NumKey; label: string; step: number; hint?: string }> = [
  { key: 'fast', label: 'MACD fast', step: 1 },
  { key: 'slow', label: 'MACD slow', step: 1 },
  { key: 'signal', label: 'MACD signal', step: 1 },
  { key: 'stPeriod', label: 'Supertrend ATR period', step: 1 },
  { key: 'stMult', label: 'Supertrend multiplier', step: 0.5 },
  { key: 'maxCrossAge', label: 'Max crossover age (bars)', step: 1, hint: '0 = the crossover must be on the signal candle' },
  { key: 'nearEmaAtr', label: 'EMA 200 "too close" (ATR)', step: 0.05 },
  { key: 'feeBps', label: 'Fee (bps per side)', step: 1 },
  { key: 'slipBps', label: 'Slippage (bps per side)', step: 1 },
]

export function SettingsTab({ config, onApply }: { config: MacdConfig; onApply: (c: Partial<MacdConfig>) => void }) {
  const [d, setD] = useState<MacdConfig>(config)
  useEffect(() => setD(config), [config])
  const lab = 'text-muted-foreground flex flex-col gap-1 font-mono text-[10px] uppercase'
  const toggle = (tf: MacdTf) => setD({ ...d, tfs: d.tfs.includes(tf) ? d.tfs.filter((t) => t !== tf) : MACD_TFS.filter((t) => t === tf || d.tfs.includes(t)) })
  const preview = normalizeMacdConfig(d)
  return (
    <div className="flex flex-col gap-3">
      <Section title="Strategy settings">
        <div>
          <div className="text-muted-foreground mb-1 font-mono text-[10px] uppercase">Timeframes that must ALL agree</div>
          <div className="grid grid-cols-5 gap-1.5">
            {MACD_TFS.map((tf) => {
              const on = preview.tfs.includes(tf)
              const locked = tf === preview.trigger
              return (
                <button
                  key={tf}
                  type="button"
                  disabled={locked}
                  onClick={() => toggle(tf)}
                  className={cn('h-11 rounded-md border font-mono text-xs font-bold', on ? 'border-primary/40 bg-primary/15 text-primary' : 'border-border text-muted-foreground', locked && 'opacity-80')}
                >
                  {MACD_LABEL[tf]}
                  {locked ? ' ★' : ''}
                </button>
              )
            })}
          </div>
          <p className="text-muted-foreground mt-1 font-mono text-[10px]">★ = the trigger timeframe, always required. Fewer timeframes means more signals and weaker confirmation.</p>
        </div>
        <label className={lab}>
          Entry trigger timeframe (crossover, EMA 200, Supertrend, stop and candle close all use it)
          <select
            value={d.trigger}
            onChange={(e) => setD({ ...d, trigger: e.target.value as MacdTf })}
            className="border-border bg-background text-foreground h-10 rounded-md border px-2 font-mono text-sm normal-case"
          >
            {MACD_TFS.map((t) => (
              <option key={t} value={t}>
                {MACD_LABEL[t]}
                {t === DEFAULT_MACD.trigger ? ' (default, main trading timeframe)' : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {NUM_FIELDS.map((f) => (
            <label key={f.key} className={lab} title={f.hint}>
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
        </div>
        <div className="border-border text-muted-foreground rounded-md border p-2 font-mono text-[11px]">
          Risk : reward is fixed at 1 : {RR}. The stop is always the {MACD_LABEL[preview.trigger]} Supertrend line; if it is on the wrong side of the entry the trade is rejected (no substitute stop).
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
          The rules themselves (all selected timeframes agree, trigger-timeframe MACD crossover confirmed at the close, EMA 200 filter, Supertrend confirmation, no sideways / flat market) are fixed. Sound and notification controls are on the Alerts tab. Settings are
          saved in this browser.
        </p>
      </Section>
    </div>
  )
}
