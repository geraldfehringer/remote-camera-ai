import { randomUUID } from 'node:crypto'
import qrcode from 'qrcode'
// whatsapp-web.js is CommonJS; keep the require() shape Node resolves.
import pkg from 'whatsapp-web.js'
const { Client, LocalAuth } = pkg
import type { WhatsappConfig, WhatsappState, WhatsappStatus } from './types.js'

type Logger = {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

type ClientHandle = {
  destroy(): Promise<void>
  sendMessage(chatId: string, text: string): Promise<void>
}

export type WhatsappClientOptions = {
  authDir: string
  log: Logger
  executablePath: string
  clientId?: string
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'not-ready' | 'timeout' | 'error'; error?: string }

// Wraps the whatsapp-web.js Client in a narrow state machine so the Fastify
// routes have a single surface to query and mutate.
export class WhatsappClient {
  private state: WhatsappState = 'disconnected'
  private qrDataUrl: string | undefined
  private linkedPhoneE164: string | undefined
  private linkedPushName: string | undefined
  private lastError: string | undefined
  private lastSentAt: string | undefined
  private sentCount = 0
  private rateLimitedCount = 0
  private sendErrorCount = 0
  private inner: ClientHandle | null = null
  private initializing = false

  constructor(private readonly options: WhatsappClientOptions) {}

  getSnapshot(config: WhatsappConfig): WhatsappStatus {
    return {
      state: this.state,
      qrDataUrl: this.state === 'qr' ? this.qrDataUrl : undefined,
      linkedPhoneE164: this.linkedPhoneE164,
      linkedPushName: this.linkedPushName,
      recipientE164: config.recipientE164 ?? undefined,
      enabled: config.enabled,
      lastError: this.lastError,
      lastSentAt: this.lastSentAt,
      sentCount: this.sentCount,
      rateLimitedCount: this.rateLimitedCount,
      sendErrorCount: this.sendErrorCount,
    }
  }

  noteRateLimited(): void { this.rateLimitedCount += 1 }
  noteSent(): void { this.sentCount += 1; this.lastSentAt = new Date().toISOString() }
  noteSendError(msg: string): void { this.sendErrorCount += 1; this.lastError = msg }

  async start(): Promise<void> {
    if (this.initializing || this.inner) return
    this.initializing = true
    this.state = 'authenticating'
    this.lastError = undefined

    const client = new Client({
      authStrategy: new LocalAuth({
        clientId: this.options.clientId ?? 'remote-camera-ai',
        dataPath: this.options.authDir,
      }),
      puppeteer: {
        headless: true,
        executablePath: this.options.executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        ],
      },
    })

    client.on('qr', async (qr: string) => {
      try {
        this.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 })
      } catch (err) {
        this.options.log.warn({ err }, 'qr render failed')
      }
      this.state = 'qr'
    })

    client.on('authenticated', () => {
      this.state = 'authenticating'
      this.qrDataUrl = undefined
    })

    client.on('auth_failure', (msg: string) => {
      this.lastError = msg || 'auth failure'
      this.state = 'error'
    })

    client.on('ready', () => {
      const info = (client as unknown as { info?: { wid?: { user?: string }; pushname?: string } }).info
      const user = info?.wid?.user
      this.linkedPhoneE164 = user ? `+${user}` : undefined
      this.linkedPushName = info?.pushname
      this.state = 'ready'
      this.lastError = undefined
      this.options.log.info({ phone: this.linkedPhoneE164 }, 'whatsapp ready')
    })

    client.on('disconnected', (reason: string) => {
      this.lastError = `disconnected: ${reason}`
      this.state = 'error'
      this.inner = null
      this.initializing = false
      // Attempt one auto-reinit to surface a fresh QR if auth was revoked.
      setTimeout(() => { void this.start().catch(() => {}) }, 2_000)
    })

    // The whatsapp-web.js Client narrowly matches ClientHandle
    // (sendMessage + destroy). Cast once instead of re-declaring types.
    this.inner = client as unknown as ClientHandle

    try {
      await (client as unknown as { initialize(): Promise<void> }).initialize()
    } catch (err) {
      this.lastError = (err as Error).message ?? 'initialize failed'
      this.state = 'error'
      this.inner = null
    } finally {
      this.initializing = false
    }
  }

  async logout(): Promise<void> {
    if (this.inner) {
      try { await this.inner.destroy() } catch {}
    }
    this.inner = null
    this.state = 'disconnected'
    this.qrDataUrl = undefined
    this.linkedPhoneE164 = undefined
    this.linkedPushName = undefined
    this.lastError = undefined
  }

  async send(recipientE164: string, text: string): Promise<SendResult> {
    if (!this.inner || this.state !== 'ready') {
      return { ok: false, reason: 'not-ready' }
    }
    // whatsapp-web.js chat id format: <digits>@c.us (no +)
    const chatId = `${recipientE164.replace(/^\+/, '')}@c.us`
    try {
      await Promise.race([
        this.inner.sendMessage(chatId, text),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('send timeout')), 10_000)),
      ])
      this.noteSent()
      return { ok: true }
    } catch (err) {
      const msg = (err as Error).message ?? 'send failed'
      this.noteSendError(msg)
      if (msg === 'send timeout') return { ok: false, reason: 'timeout' }
      return { ok: false, reason: 'error', error: msg }
    }
  }

  // Used by a unit-like test harness that just exercises state transitions.
  _debugForceState(next: WhatsappState, extra?: { phone?: string; error?: string; qr?: string }): void {
    this.state = next
    if (extra?.phone !== undefined) this.linkedPhoneE164 = extra.phone
    if (extra?.error !== undefined) this.lastError = extra.error
    if (extra?.qr !== undefined) this.qrDataUrl = extra.qr
  }
}

export function newIdempotencyKey(): string {
  return randomUUID()
}
