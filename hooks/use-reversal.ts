'use client'

import useSWR from 'swr'
import type { ReversalResponse } from '@/lib/reversal'

const fetcher = async (url: string): Promise<ReversalResponse> => {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Failed to load reversal data')
  return res.json()
}

export function useReversal() {
  const { data, error, isLoading } = useSWR<ReversalResponse>('/api/reversal', fetcher, {
    refreshInterval: 20000,
    revalidateOnFocus: true,
    keepPreviousData: true,
  })
  return { data, isLoading, isError: Boolean(error) }
}
