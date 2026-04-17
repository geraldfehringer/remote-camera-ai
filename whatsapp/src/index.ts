import { rm } from 'node:fs/promises'
import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { z } from 'zod'
import { WhatsappClient } from './client.js'
import { loadConfig, saveConfig } from './config.js'
import { IdempotencyLru, PerRecipientCooldown } from './rateLimit.js'
import { E164_REGEX } from './types.js'

const PORT = Number(process.env.PORT ?? 8091)
const HOST = process.env.HOST ?? '0.0.0.0'
const AUTH_DIR = process.env.AUTH_DIR ?? '/app/auth'
const EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium'
const COOLDOWN_MS = Number(process.env.WA_COOLDOWN_MS ?? 15_000)

const app = Fastify({
  logger: { level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' },
})
await app.register(sensible)

const client = new WhatsappClient({
  authDir: AUTH_DIR,
  executablePath: EXECUTABLE_PATH,
  log: app.log,
})

const cooldown = new PerRecipientCooldown(COOLDOWN_MS)
const idempotency = new IdempotencyLru(200)

const configBodySchema = z.object({
  enabled: z.boolean(),
  recipientE164: z.string().regex(E164_REGEX).nullable(),
})
const sendBodySchema = z.object({
  text: z.string().min(1).max(1000),
  idempotencyKey: z.string().min(1).max(128),
})

app.get('/health', async () => ({ ok: true }))

app.get('/status', async () => client.getSnapshot(await loadConfig(AUTH_DIR)))

app.post('/config', async (req, reply) => {
  const parsed = configBodySchema.safeParse(req.body)
  if (!parsed.success) return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '))
  const next = await saveConfig(AUTH_DIR, parsed.data)
  return client.getSnapshot(next)
})

app.post('/logout', async () => {
  await client.logout()
  // Wipe LocalAuth dir so the next start() produces a fresh QR.
  try { await rm(`${AUTH_DIR}/session-remote-camera-ai`, { recursive: true, force: true }) } catch {}
  await saveConfig(AUTH_DIR, { enabled: false, recipientE164: null })
  return client.getSnapshot(await loadConfig(AUTH_DIR))
})

app.post('/send', async (req, reply) => {
  const parsed = sendBodySchema.safeParse(req.body)
  if (!parsed.success) return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '))

  const config = await loadConfig(AUTH_DIR)
  if (!config.enabled || !config.recipientE164) {
    reply.code(202)
    return { sent: false, reason: 'disabled' }
  }

  if (idempotency.has(parsed.data.idempotencyKey)) {
    reply.code(202)
    return { sent: false, reason: 'duplicate' }
  }

  const gate = cooldown.check(config.recipientE164)
  if (!gate.ok) {
    client.noteRateLimited()
    reply.code(202)
    return { sent: false, reason: 'rate-limited', retryInMs: gate.retryInMs }
  }

  const result = await client.send(config.recipientE164, parsed.data.text)
  if (!result.ok) {
    reply.code(202)
    return { sent: false, reason: result.reason, error: result.error }
  }

  idempotency.add(parsed.data.idempotencyKey)
  cooldown.mark(config.recipientE164)
  return { sent: true }
})

async function bootstrap(): Promise<void> {
  try {
    await app.listen({ host: HOST, port: PORT })
    app.log.info(`whatsapp sidecar listening on ${HOST}:${PORT}`)
    // Kick off client init in the background so /health responds immediately.
    void client.start().catch((err) => app.log.error({ err }, 'client.start failed'))
  } catch (err) {
    app.log.error({ err }, 'failed to start whatsapp sidecar')
    process.exit(1)
  }
}

void bootstrap()
