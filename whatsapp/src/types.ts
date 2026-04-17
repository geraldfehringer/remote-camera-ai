export type WhatsappState =
  | 'disconnected'
  | 'qr'
  | 'authenticating'
  | 'ready'
  | 'error'

export type WhatsappStatus = {
  state: WhatsappState
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

export type WhatsappConfig = {
  enabled: boolean
  recipientE164: string | null
  updatedAt: string
}

// E.164 phone number: leading +, 7..15 digits, no leading zero on first digit.
export const E164_REGEX = /^\+[1-9]\d{6,14}$/
