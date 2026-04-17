import { useCallback, useEffect, useRef, useState } from 'react'
import {
  WhatsappDisabledError,
  WhatsappUnavailableError,
  whatsappApi,
} from '../lib/whatsappApi'
import type { WhatsappStatus } from '../lib/types'

export type WhatsappStatusError =
  | { kind: 'disabled' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'other'; message: string }

export type WhatsappStatusSnapshot = {
  status: WhatsappStatus | null
  error: WhatsappStatusError | null
  loading: boolean
  refresh: () => Promise<void>
}

const POLL_INTERVAL_MS = 3_000

export function useWhatsappStatus(pollEnabled = true): WhatsappStatusSnapshot {
  const [status, setStatus] = useState<WhatsappStatus | null>(null)
  const [error, setError] = useState<WhatsappStatusError | null>(null)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    try {
      const next = await whatsappApi.status()
      if (ac.signal.aborted) return
      setStatus(next)
      setError(null)
    } catch (err) {
      if (ac.signal.aborted) return
      if (err instanceof WhatsappDisabledError) setError({ kind: 'disabled' })
      else if (err instanceof WhatsappUnavailableError) setError({ kind: 'unavailable', message: err.message })
      else setError({ kind: 'other', message: (err as Error).message })
    } finally {
      if (!ac.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    if (!pollEnabled) return
    const id = window.setInterval(() => { void refresh() }, POLL_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [pollEnabled, refresh])

  return { status, error, loading, refresh }
}
