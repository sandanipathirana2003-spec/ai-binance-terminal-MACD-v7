'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { DEFAULT_MACD, normalizeMacdConfig, type MacdConfig } from '@/lib/macdmtf'
import type { MacdResponse } from '@/app/api/macd/route'

const KEY = 'macd-config-v1'

const fetcher = async (url: string): Promise<MacdResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load MACD data')
  return res.json()
}

/** Only settings that differ from the defaults go into the URL (keeps the SWR key short and stable). */
function toQuery(cfg: MacdConfig): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(DEFAULT_MACD) as Array<keyof MacdConfig>) {
    const v = cfg[k]
    if (JSON.stringify(v) !== JSON.stringify(DEFAULT_MACD[k])) q.set(k, Array.isArray(v) ? v.join(',') : String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function useMacd() {
  const [config, setConfigState] = useState<MacdConfig>(DEFAULT_MACD)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeMacdConfig(JSON.parse(raw)))
    } catch {
      // ignore corrupt storage
    }
  }, [])

  const setConfig = useCallback((next: Partial<MacdConfig>) => {
    const merged = normalizeMacdConfig(next)
    setConfigState(merged)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      // storage can be unavailable (private mode): settings then last for this visit only
    }
  }, [])

  const { data, error, isLoading } = useSWR<MacdResponse>(`/api/macd${toQuery(config)}`, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  return { data, isLoading, isError: Boolean(error), config, setConfig }
}
