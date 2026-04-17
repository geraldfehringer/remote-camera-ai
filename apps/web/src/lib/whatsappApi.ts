import type { WhatsappStatus } from './types'

function apiBase(): string {
  const viteBase = (import.meta.env as { VITE_API_BASE_URL?: string }).VITE_API_BASE_URL
  return viteBase && viteBase.length > 0 ? viteBase : window.location.origin
}

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 404) throw new WhatsappDisabledError()
  if (res.status === 502) throw new WhatsappUnavailableError('Sidecar nicht erreichbar')
  if (!res.ok && res.status !== 202) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text || res.statusText}`)
  }
  return (await res.json()) as T
}

export class WhatsappDisabledError extends Error {
  constructor() { super('whatsapp feature disabled'); this.name = 'WhatsappDisabledError' }
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
