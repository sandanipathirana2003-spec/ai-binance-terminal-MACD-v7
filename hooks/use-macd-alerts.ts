'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { MACD_LABEL, type MacdRow, type MacdSignal } from '@/lib/macdmtf'

const SEEN_KEY = 'macd-seen-v1'
const LOG_KEY = 'macd-alert-log-v1'
const SOUND_KEY = 'macd-sound'
const MODE_KEY = 'macd-popup-mode'
const RISK_KEY = 'macd-popup-maxrisk'
export type PopupMode = 'full' | 'banner' | 'off'
/** Default cap on the stop distance for alerts (% of price). 0 = no cap. */
export const DEFAULT_MAX_RISK_PCT = 5
const MAX_SEEN = 500
const MAX_LOG = 100

export interface MacdPopup {
  signal: MacdSignal
  row: MacdRow
}

/** One entry of the persisted alert log (compact: just what the Alerts tab lists). */
export interface AlertLogEntry {
  id: string
  symbol: string
  side: 'BUY' | 'SELL'
  trigger: string
  entry: number
  sl: number
  tp: number
  signalTime: number
  alertedAt: number
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // storage can be unavailable (private mode)
  }
}

async function notify(title: string, body: string, tag: string) {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    // Phones (Android Chrome) only allow notifications through a service worker registration.
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, { body, tag, icon: '/icon-192.png', vibrate: [200, 100, 200] } as NotificationOptions)
      return
    }
  } catch {
    // fall through to the page-level API
  }
  try {
    new Notification(title, { body, tag })
  } catch {
    // not allowed in this context
  }
}

/**
 * Watches every refresh for a NEW confirmed signal. One alert per signal id (the id contains the crossover time, so a
 * crossover can only ever alert once); ids persist in localStorage so a reload never repeats an alert.
 * Fires: in-page popup, sound, browser / phone notification, vibration, and an entry in the alert log.
 */
export function useMacdAlerts(rows: MacdRow[] | undefined) {
  const [popups, setPopups] = useState<MacdPopup[]>([])
  const [log, setLog] = useState<AlertLogEntry[]>([])
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>('default')
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [popupMode, setPopupModeState] = useState<PopupMode>('banner')
  const [maxRiskPct, setMaxRiskState] = useState(DEFAULT_MAX_RISK_PCT)
  const seen = useRef<Set<string> | null>(null)
  const modeRef = useRef<PopupMode>('banner')
  const riskRef = useRef(DEFAULT_MAX_RISK_PCT)

  useEffect(() => {
    seen.current = new Set(read<string[]>(SEEN_KEY, []))
    setLog(read<AlertLogEntry[]>(LOG_KEY, []))
    setPermission(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission)
    const s = read<string | null>(SOUND_KEY, null)
    if (s != null) setSoundEnabled(s === '1')
    const m = read<string | null>(MODE_KEY, null)
    if (m === 'full' || m === 'banner' || m === 'off') {
      setPopupModeState(m)
      modeRef.current = m
    }
    const r = read<number | null>(RISK_KEY, null)
    if (typeof r === 'number' && r >= 0) {
      setMaxRiskState(r)
      riskRef.current = r
    }
  }, [])

  const chime = useCallback((side: 'BUY' | 'SELL' | 'TEST') => {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      const ctx = new Ctx()
      const notes = side === 'BUY' ? [660, 880] : side === 'SELL' ? [880, 660] : [770]
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
    const fresh: MacdPopup[] = []
    for (const row of rows) {
      const s = row.signal
      if (s && !seen.current.has(s.id)) {
        seen.current.add(s.id)
        // A very wide stop is still a valid signal (it stays in "Confirmed now") but it does not interrupt you.
        if (riskRef.current > 0 && s.riskPct > riskRef.current) continue
        fresh.push({ signal: s, row })
      }
    }
    write(SEEN_KEY, [...seen.current].slice(-MAX_SEEN))
    if (fresh.length === 0) return
    if (modeRef.current !== 'off') setPopups((prev) => [...fresh, ...prev].slice(0, 8))
    const entries: AlertLogEntry[] = fresh.map(({ signal: s }) => ({
      id: s.id,
      symbol: s.symbol,
      side: s.side,
      trigger: MACD_LABEL[s.trigger],
      entry: s.entry,
      sl: s.sl,
      tp: s.tp,
      signalTime: s.time,
      alertedAt: Date.now(),
    }))
    setLog((prev) => {
      const next = [...entries, ...prev].slice(0, MAX_LOG)
      write(LOG_KEY, next)
      return next
    })
    for (const { signal: s, row } of fresh) {
      void notify(`MACD CONFIRMED ${s.side} — ${s.symbol.replace('USDT', '')} ${MACD_LABEL[s.trigger]}`, `Entry ${s.entry} · SL ${s.sl.toPrecision(6)} · TP ${s.tp.toPrecision(6)} · 1:2 · live ${row.price}`, s.id)
    }
    if (soundEnabled) chime(fresh[0].signal.side)
    // Browsers only allow vibration after the user has interacted with the page.
    if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.([200, 100, 200])
  }, [rows, soundEnabled, chime])

  const requestPermission = useCallback(async () => {
    if (typeof Notification === 'undefined') return
    setPermission(await Notification.requestPermission())
  }, [])

  const toggleSound = useCallback(() => {
    setSoundEnabled((p) => {
      write(SOUND_KEY, p ? '0' : '1')
      return !p
    })
  }, [])

  /** Plays the sound and sends a clearly labelled TEST notification. No signal is created or logged. */
  const sendTest = useCallback(() => {
    chime('TEST')
    void notify('TEST — MACD alerts are working', 'This is only a test. No trade signal was generated.', `test-${Date.now()}`)
  }, [chime])

  const setPopupMode = useCallback((m: PopupMode) => {
    modeRef.current = m
    setPopupModeState(m)
    write(MODE_KEY, m)
    if (m === 'off') setPopups([])
  }, [])
  const setMaxRiskPct = useCallback((v: number) => {
    const n = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : DEFAULT_MAX_RISK_PCT
    riskRef.current = n
    setMaxRiskState(n)
    write(RISK_KEY, n)
  }, [])
  const dismissAll = useCallback(() => setPopups([]), [])
  const dismiss = useCallback((id: string) => setPopups((p) => p.filter((x) => x.signal.id !== id)), [])
  const clearLog = useCallback(() => {
    setLog([])
    write(LOG_KEY, [])
  }, [])

  return { popups, dismiss, dismissAll, popupMode, setPopupMode, maxRiskPct, setMaxRiskPct, log, clearLog, permission, requestPermission, soundEnabled, toggleSound, sendTest }
}

export type MacdAlerts = ReturnType<typeof useMacdAlerts>
