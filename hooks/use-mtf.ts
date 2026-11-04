'use client'

import { useCallback, useEffect, useState } from 'react'
import useSWR from 'swr'
import { DEFAULT_MTF, normalizeMtfConfig, type MtfConfig } from '@/lib/mtf'
import type { MtfResponse } from '@/app/api/mtf/route'

const KEY = 'mtf-config-v1'

const fetcher = async (url: string): Promise<MtfResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load MTF data')
  return res.json()
}

/** Only the engine settings that differ from the defaults go into the URL (keeps the SWR key short and stable). */
function toQuery(cfg: MtfConfig): string {
  const q = new URLSearchParams()
  for (const k of Object.keys(DEFAULT_MTF) as Array<keyof MtfConfig>) {
    if (cfg[k] !== DEFAULT_MTF[k]) q.set(k, String(cfg[k]))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

export function useMtf() {
  const [config, setConfigState] = useState<MtfConfig>(DEFAULT_MTF)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(KEY)
      if (raw) setConfigState(normalizeMtfConfig(JSON.parse(raw)))
    } catch {
      // ignore corrupt storage
    }
  }, [])

  const setConfig = useCallback((next: Partial<MtfConfig>) => {
    const merged = normalizeMtfConfig(next)
    setConfigState(merged)
    try {
      window.localStorage.setItem(KEY, JSON.stringify(merged))
    } catch {
      // storage can be unavailable (private mode) — settings then last for this visit only
    }
  }, [])

  const { data, error, isLoading } = useSWR<MtfResponse>(`/api/mtf${toQuery(config)}`, fetcher, {
    refreshInterval: 30000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  return { data, isLoading, isError: Boolean(error), config, setConfig }
}
