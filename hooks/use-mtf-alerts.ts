'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { MtfRow, MtfSignal } from '@/lib/mtf'

const SEEN_KEY = 'mtf-seen-v1'
const SOUND_KEY = 'mtf-sound'
const MAX_SEEN = 400

function loadSeen(): string[] {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY)
    const parsed = raw ? (JSON.parse(raw) as string[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export interface MtfPopup {
  signal: MtfSignal
  row: MtfRow
}

/**
 * Watches every refresh for a NEW confirmed 5M signal. One alert per signal id (stored in localStorage so a reload
 * does not repeat it). Fires: in-page popup, sound, browser notification (if permitted) and a phone vibration.
 */
export function useMtfAlerts(rows: MtfRow[] | undefined) {
  const [popups, setPopups] = useState<MtfPopup[]>([])
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [soundEnabled, setSoundEnabled] = useState(true)
  const seen = useRef<Set<string> | null>(null)

  useEffect(() => {
    seen.current = new Set(loadSeen())
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    try {
      const s = window.localStorage.getItem(SOUND_KEY)
      if (s != null) setSoundEnabled(s === '1')
    } catch {
      // ignore
    }
  }, [])

  const chime = useCallback((side: 'BUY' | 'SELL') => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const notes = side === 'BUY' ? [660, 880] : [880, 660]
      notes.forEach((f, i) => {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.type = 'sine'
        osc.frequency.value = f
        const t = ctx.currentTime + i * 0.18
        gain.gain.setValueAtTime(0.001, t)
        gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(t)
        osc.stop(t + 0.35)
      })
    } catch {
      // the browser may block audio until the page has been interacted with
    }
  }, [])

  useEffect(() => {
    if (!rows || rows.length === 0 || !seen.current) return
    const fresh: MtfPopup[] = []
    for (const row of rows) {
      const s = row.signal
      if (s && !seen.current.has(s.id)) {
        seen.current.add(s.id)
        fresh.push({ signal: s, row })
      }
    }
    if (fresh.length === 0) return
    try {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen.current].slice(-MAX_SEEN)))
    } catch {
      // ignore
    }
    setPopups((prev) => [...fresh, ...prev].slice(0, 6))
    for (const { signal, row } of fresh) {
      const coin = signal.symbol.replace('USDT', '')
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try {
          new Notification(`CONFIRMED ${signal.side} — ${coin} MTF SUPERTREND + MACD CROSS + EMA 200`, {
            body: `Signal price ${signal.entry} · SL ${signal.plan.sl.toPrecision(6)} · TP ${signal.plan.tp.toPrecision(6)} · live ${row.price}`,
            tag: signal.id,
          })
        } catch {
          // some mobile browsers only allow notifications from a service worker
        }
      }
    }
    if (soundEnabled) chime(fresh[0].signal.side)
    try {
      // Browsers only allow vibration after the user has interacted with the page.
      if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200])
    } catch {
      // ignore
    }
  }, [rows, soundEnabled, chime])

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }, [])

  const toggleSound = useCallback(() => {
    setSoundEnabled((p) => {
      try {
        window.localStorage.setItem(SOUND_KEY, p ? '0' : '1')
      } catch {
        // ignore
      }
      return !p
    })
  }, [])

  const dismiss = useCallback((id: string) => setPopups((p) => p.filter((x) => x.signal.id !== id)), [])

  return { popups, dismiss, permission, requestPermission, soundEnabled, toggleSound }
}
