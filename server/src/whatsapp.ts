// Proxy + client helpers for the whatsapp sidecar. Keeps index.ts lean.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export type WhatsappStatus = {
  state: 'disconnected' | 'qr' | 'authenticating' | 'ready' | 'error'
  qrDataUrl?: string
  linkedPhoneE164?: string
  linkedPushName?: string
  recipientE164?: string
  enabled: boolean
  lastError?: string
  lastSentAt?: string
  sentCount: number
  rateLimitedCount: number
  sendErrorCount: number
}

export type WhatsappEnv = {
  enabled: boolean
  serviceUrl: string
}

// Short text format used for every alert push. Single line, no newlines.
// Examples:
//   🔔 Vogel erkannt · 92% · 17:24 Uhr · "Kleine Meise auf Ast"
//   🔔 Person erkannt · 64% · 08:02 Uhr
export function formatAlertText(
  target: string,
  confidence: number,
  createdAtIso: string,
  shortSummary?: string
): string {
  const label = labelForTarget(target)
  const pct = `${Math.round(confidence * 100)}%`
  const hhmm = formatHHMM(createdAtIso)
  const base = `🔔 ${label} erkannt · ${pct} · ${hhmm} Uhr`
  if (shortSummary && shortSummary.trim().length > 0) {
    return `${base} · "${shortSummary.trim()}"`
  }
  return base
}

function labelForTarget(target: string): string {
  switch (target) {
    case 'bird': return 'Vogel'
    case 'cat': return 'Katze'
    case 'squirrel': return 'Eichhörnchen'
    case 'person': return 'Person'
    case 'motion-only': return 'Bewegung'
    default: return target
  }
}

function formatHHMM(iso: string): string {
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

// Fire-and-forget: never throws, never awaits beyond 500 ms.
// Safe to call from the alert mint path.
export async function dispatchAlert(
  env: WhatsappEnv,
  log: FastifyInstance['log'],
  body: { text: string; idempotencyKey: string }
): Promise<void> {
  if (!env.enabled) return
  try {
    const response = await fetch(`${env.serviceUrl}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok && response.status !== 202) {
      log.warn({ status: response.status }, 'whatsapp send non-ok')
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'whatsapp send failed')
  }
}


async function proxy(
  env: WhatsappEnv,
  req: FastifyRequest,
  reply: FastifyReply,
  subpath: string,
  init: RequestInit = {}
): Promise<unknown> {
  try {
    // Only advertise JSON content-type when we actually send a body.
    // Fastify 5 rejects empty body + application/json with FST_ERR_CTP_EMPTY_JSON_BODY.
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) }
    if (init.body !== undefined && init.body !== null) {
      headers['content-type'] = 'application/json'
    }
    const response = await fetch(`${env.serviceUrl}${subpath}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(5_000),
    })
    reply.code(response.status)
    const text = await response.text()
    return text ? JSON.parse(text) : {}
  } catch (err) {
    reply.code(502)
    return { error: 'whatsapp sidecar unreachable', message: (err as Error).message }
  }
}

export function registerWhatsappRoutes(app: FastifyInstance, env: WhatsappEnv): void {
  if (!env.enabled) return

  app.get('/api/whatsapp/status', async (req, reply) =>
    proxy(env, req, reply, '/status'),
  )

  app.post('/api/whatsapp/config', async (req, reply) =>
    proxy(env, req, reply, '/config', {
      method: 'POST',
      body: JSON.stringify(req.body ?? {}),
    }),
  )

  app.post('/api/whatsapp/logout', async (req, reply) =>
    proxy(env, req, reply, '/logout', { method: 'POST' }),
  )

  app.post('/api/whatsapp/test', async (req, reply) =>
    proxy(env, req, reply, '/send', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Testnachricht vom Remote-Camera-AI',
        idempotencyKey: `test-${Date.now()}`,
      }),
    }),
  )
}
