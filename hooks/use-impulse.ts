'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { DEFAULT_IMPULSE, normalizeConfig, type ImpulseConfig } from '@/lib/impulse5m'
import type { ImpulseResponse } from '@/app/api/impulse/route'

const KEY = 'imp5m-config-v1'

const fetcher = async (url: string): Promise<ImpulseResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load Impulse MACD data')
  return res.json()
}

/** Only the engine settings that differ from the defaults go into the URL (keeps the SWR key short and stable). */
function toQuery(cfg: ImpulseConfig): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(DEFAULT_IMPULSE) as Array<keyof ImpulseConfig>) {
    if (cfg[k] !== DEFAULT_IMPULSE[k]) q.set(k, String(cfg[k]))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function useImpulse() {
  const [config, setConfigState] = useState<ImpulseConfig>(DEFAULT_IMPULSE)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeConfig(JSON.parse(raw)))
    } catch {
      // ignore corrupt storage
    }
  }, [])

  const setConfig = useCallback((next: Partial<ImpulseConfig>) => {
    const merged = normalizeConfig(next)
    setConfigState(merged)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      // storage can be unavailable (private mode) — settings then last for this visit only
    }
  }, [])

  const { data, error, isLoading } = useSWR<ImpulseResponse>(`/api/impulse${toQuery(config)}`, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  return { data, isLoading, isError: Boolean(error), config, setConfig }
}
