import type { AppConfig, SessionLinks, SessionMetadata } from './types'

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getApiBaseUrl() {
  const configured = import.meta.env.VITE_API_BASE_URL?.trim()
  if (configured) {
    return trimTrailingSlash(configured)
  }

  if (typeof window === 'undefined') {
    return 'http://localhost:3000'
  }

  return window.location.origin
}

async function readJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init)
  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status}`)
  }
  return (await response.json()) as T
}

export function getSignalUrl(sessionId: string, role: 'camera' | 'viewer', token: string) {
  const base = new URL(getApiBaseUrl())
  const protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${base.host}/ws?sessionId=${encodeURIComponent(sessionId)}&role=${role}&token=${encodeURIComponent(token)}`
}

export function readConfig() {
  return readJson<AppConfig>(`${getApiBaseUrl()}/api/config`)
}

export function createSession() {
  return readJson<SessionLinks>(`${getApiBaseUrl()}/api/sessions`, {
    method: 'POST',
  })
}

export function getSession(sessionId: string, token: string) {
  return readJson<SessionMetadata>(
    `${getApiBaseUrl()}/api/sessions/${sessionId}?token=${encodeURIComponent(token)}`,
  )
}
