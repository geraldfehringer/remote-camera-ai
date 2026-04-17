import type { WhatsappStatus } from './types'

const TOKEN_STORAGE_KEY = 'whatsapp-admin-token'

export function getStoredAdminToken(): string {
  try { return window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? '' } catch { return '' }
}

export function setStoredAdminToken(token: string): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // localStorage unavailable (private browsing, etc.) — ignore
  }
}

function apiBase(): string {
  // Mirrors lib/api.ts resolution order: VITE_API_BASE_URL then window.origin.
  const viteBase = (import.meta.env as { VITE_API_BASE_URL?: string }).VITE_API_BASE_URL
  return viteBase && viteBase.length > 0 ? viteBase : window.location.origin
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const token = getStoredAdminToken()
  if (!token) throw new WhatsappAuthRequiredError()
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      'x-admin-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) throw new WhatsappAuthRequiredError()
  if (res.status === 503) throw new WhatsappUnavailableError('Kein Admin-Token konfiguriert')
  if (res.status === 502) throw new WhatsappUnavailableError('Sidecar nicht erreichbar')
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as T
}

export class WhatsappAuthRequiredError extends Error {
  constructor() { super('admin token required'); this.name = 'WhatsappAuthRequiredError' }
}
export class WhatsappUnavailableError extends Error {
  constructor(msg: string) { super(msg); this.name = 'WhatsappUnavailableError' }
}

export const whatsappApi = {
  status: () => request<WhatsappStatus>('GET', '/api/whatsapp/status'),
  config: (enabled: boolean, recipientE164: string | null) =>
    request<WhatsappStatus>('POST', '/api/whatsapp/config', { enabled, recipientE164 }),
  logout: () => request<WhatsappStatus>('POST', '/api/whatsapp/logout'),
  test: () => request<{ sent: boolean; reason?: string }>('POST', '/api/whatsapp/test'),
}
