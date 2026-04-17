import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import qrcode from 'qrcode'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { WhatsappConfig, WhatsappState, WhatsappStatus } from './types.js'

type Logger = {
  info: (obj: unknown, msg?: string) => void
  warn: (obj: unknown, msg?: string) => void
  error: (obj: unknown, msg?: string) => void
}

export type WhatsappClientOptions = {
  authDir: string
  log: Logger
  clientId?: string
}

export type SendResult =
  | { ok: true }
  | { ok: false; reason: 'not-ready' | 'timeout' | 'error'; error?: string }

// Wraps Baileys in the same narrow state machine the Fastify routes expect.
// Baileys talks the WhatsApp WebSocket protocol directly — no Chromium, no
// DOM scraping. Much more resilient to Meta UI changes than whatsapp-web.js.
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
  private sock: WASocket | null = null
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
    if (this.initializing || this.sock) return
    this.initializing = true
    this.state = 'authenticating'
    this.lastError = undefined

    try {
      const authSubdir = path.join(
        this.options.authDir,
        this.options.clientId ?? 'remote-camera-ai',
      )
      await mkdir(authSubdir, { recursive: true })
      const { state: auth, saveCreds } = await useMultiFileAuthState(authSubdir)

      // Pull the latest compatible WA protocol version from Baileys' CDN.
      // Without this, Baileys uses its bundled baseline which Meta rejects
      // with a 405 Connection Failure once it ages.
      const { version } = await fetchLatestBaileysVersion()
      this.options.log.info({ version }, 'baileys using wa version')

      const sock = makeWASocket({
        auth,
        version,
        printQRInTerminal: false,
        browser: Browsers.macOS('Desktop'),
      })

      sock.ev.on('creds.update', saveCreds)

      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr) {
          try {
            this.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, width: 320 })
            this.state = 'qr'
            this.options.log.info({ state: 'qr' }, 'baileys qr ready')
          } catch (err) {
            this.options.log.warn({ err }, 'qr render failed')
          }
        }

        if (connection === 'connecting') {
          // Fires after QR scan while Baileys handshakes with Meta.
          if (this.state !== 'qr') {
            this.state = 'authenticating'
            this.options.log.info({ state: 'authenticating' }, 'baileys connecting')
          }
        }

        if (connection === 'open') {
          const id = sock.user?.id // e.g. '491701234567:18@s.whatsapp.net'
          if (id) {
            const num = id.split('@')[0]?.split(':')[0]
            if (num) this.linkedPhoneE164 = `+${num}`
          }
          this.linkedPushName = sock.user?.name
          this.state = 'ready'
          this.qrDataUrl = undefined
          this.lastError = undefined
          this.options.log.info(
            { phone: this.linkedPhoneE164, name: this.linkedPushName },
            'baileys ready',
          )
        }

        if (connection === 'close') {
          const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined
          const code = err?.output?.statusCode
          const loggedOut = code === DisconnectReason.loggedOut
          this.options.log.warn({ code, loggedOut }, 'baileys disconnected')
          this.lastError = `disconnected: ${code ?? 'unknown'}`
          this.state = 'error'
          this.sock = null
          this.initializing = false
          // Single reconnect unless explicitly logged out by the user/phone.
          if (!loggedOut) {
            setTimeout(() => { void this.start().catch(() => {}) }, 2_000)
          }
        }
      })

      this.sock = sock
    } catch (err) {
      this.lastError = (err as Error).message ?? 'initialize failed'
      this.state = 'error'
      this.sock = null
      this.options.log.error({ err }, 'baileys start failed')
    } finally {
      this.initializing = false
    }
  }

  async logout(): Promise<void> {
    if (this.sock) {
      try { await this.sock.logout() } catch {}
    }
    this.sock = null
    this.state = 'disconnected'
    this.qrDataUrl = undefined
    this.linkedPhoneE164 = undefined
    this.linkedPushName = undefined
    this.lastError = undefined
  }

  async send(recipientE164: string, text: string): Promise<SendResult> {
    if (!this.sock || this.state !== 'ready') {
      return { ok: false, reason: 'not-ready' }
    }
    const jid = `${recipientE164.replace(/^\+/, '')}@s.whatsapp.net`
    try {
      await Promise.race([
        this.sock.sendMessage(jid, { text }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('send timeout')), 10_000),
        ),
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

  // Diagnostic: expose what we know about the current socket. Baileys doesn't
  // scrape DOM so there's no `window.Store` concern anymore — kept for parity.
  async debugProbe(): Promise<Record<string, unknown>> {
    return {
      state: this.state,
      hasSock: !!this.sock,
      user: this.sock?.user ?? null,
      qrDataUrlLength: this.qrDataUrl?.length ?? 0,
    }
  }

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
