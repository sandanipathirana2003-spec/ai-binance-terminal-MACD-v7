'use client'

import { useEffect, useState } from 'react'

export interface LivePrice {
  price: number | null
  /** Exchange event time (ms) of the last tick. */
  at: number | null
  status: 'connecting' | 'live' | 'offline'
}

/**
 * Live last price of ONE symbol over Binance's futures WebSocket (miniTicker). It only drives the displayed price and the
 * connection / freshness indicator: signals are always computed from closed candles, so a tick can never create one.
 * Reconnects with back-off; when the socket is unavailable the dashboard falls back to the polled price.
 */
export function useLivePrice(symbol: string | undefined): LivePrice {
  const [state, setState] = useState<LivePrice>({ price: null, at: null, status: 'connecting' })

  useEffect(() => {
    if (!symbol || typeof WebSocket === 'undefined') return
    let ws: WebSocket | null = null
    let closed = false
    let retry = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    setState({ price: null, at: null, status: 'connecting' })

    const connect = () => {
      try {
        ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@miniTicker`)
      } catch {
        setState((s) => ({ ...s, status: 'offline' }))
        return
      }
      ws.onopen = () => {
        retry = 0
      }
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(String(e.data)) as { c?: string; E?: number }
          const p = Number(m.c)
          if (Number.isFinite(p) && p > 0) setState({ price: p, at: Number(m.E) || Date.now(), status: 'live' })
        } catch {
          // ignore malformed frames
        }
      }
      ws.onerror = () => ws?.close()
      ws.onclose = () => {
        if (closed) return
        setState((s) => ({ ...s, status: 'offline' }))
        retry++
        timer = setTimeout(connect, Math.min(15000, 1000 * 2 ** retry))
      }
    }
    connect()
    return () => {
      closed = true
      if (timer) clearTimeout(timer)
      ws?.close()
    }
  }, [symbol])

  return state
}
