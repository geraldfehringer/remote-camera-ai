import React, { useCallback, useEffect, useState } from 'react'
import {
  WhatsappAuthRequiredError,
  WhatsappUnavailableError,
  setStoredAdminToken,
  whatsappApi,
} from '../lib/whatsappApi'
import { useWhatsappStatus } from '../hooks/useWhatsappStatus'

const E164_REGEX = /^\+[1-9]\d{6,14}$/

export function WhatsappCard(): React.ReactElement {
  const { status, error, refresh } = useWhatsappStatus(true)
  const [tokenInput, setTokenInput] = useState('')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    if (status?.recipientE164 && recipient === '') setRecipient(status.recipientE164)
  }, [status?.recipientE164, recipient])

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true)
    setFlash(null)
    try {
      await fn()
      await refresh()
    } catch (err) {
      if (err instanceof WhatsappAuthRequiredError) setFlash('Admin-Token ungültig.')
      else if (err instanceof WhatsappUnavailableError) setFlash(`WhatsApp-Dienst: ${err.message}`)
      else setFlash((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const submitToken = useCallback(async () => {
    const trimmed = tokenInput.trim()
    if (!trimmed) return
    setStoredAdminToken(trimmed)
    setTokenInput('')
    await refresh()
  }, [tokenInput, refresh])

  const saveRecipient = useCallback(async () => {
    if (!E164_REGEX.test(recipient)) {
      setFlash('Telefonnummer muss im Format +49… sein.')
      return
    }
    await run(async () => {
      await whatsappApi.config(status?.enabled ?? true, recipient)
    })
  }, [recipient, run, status?.enabled])

  const toggleEnabled = useCallback(async () => {
    if (!status?.recipientE164) {
      setFlash('Zuerst Telefonnummer speichern.')
      return
    }
    await run(async () => { await whatsappApi.config(!status.enabled, status.recipientE164 ?? null) })
  }, [run, status])

  const sendTest = useCallback(async () => {
    await run(async () => { await whatsappApi.test() })
    setFlash('Testnachricht ausgelöst.')
  }, [run])

  const logout = useCallback(async () => {
    await run(async () => { await whatsappApi.logout() })
  }, [run])

  if (error?.kind === 'auth-required') {
    return (
      <section className="card whatsapp-card" data-testid="whatsapp-card">
        <header className="card__header">
          <h2>Benachrichtigungen</h2>
        </header>
        <p className="card__hint">
          WhatsApp-Alerts erfordern einen Admin-Token (<code>WHATSAPP_ADMIN_TOKEN</code> in <code>.env</code>).
        </p>
        <div className="form-row">
          <input
            type="password"
            placeholder="Admin-Token"
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            data-testid="whatsapp-token-input"
          />
          <button type="button" onClick={() => void submitToken()} data-testid="whatsapp-token-submit">
            Speichern
          </button>
        </div>
      </section>
    )
  }

  if (error?.kind === 'unavailable') {
    return (
      <section className="card whatsapp-card" data-testid="whatsapp-card">
        <header className="card__header">
          <h2>Benachrichtigungen</h2>
        </header>
        <p className="card__hint">WhatsApp-Dienst nicht erreichbar: {error.message}</p>
      </section>
    )
  }

  if (!status) {
    return (
      <section className="card whatsapp-card" data-testid="whatsapp-card">
        <header className="card__header"><h2>Benachrichtigungen</h2></header>
        <p className="card__hint">Status wird geladen …</p>
      </section>
    )
  }

  return (
    <section className="card whatsapp-card" data-testid="whatsapp-card">
      <header className="card__header">
        <h2>Benachrichtigungen</h2>
        <span className={`wa-badge wa-badge--${status.state}`}>{labelForState(status.state)}</span>
      </header>

      {status.state === 'disconnected' && (
        <>
          <p className="card__hint">
            Einmalige Einrichtung: scanne den QR-Code mit deinem Telefon in
            WhatsApp → Einstellungen → Verknüpfte Geräte.
          </p>
          <button type="button" disabled={busy} onClick={() => void run(() => whatsappApi.status().then(() => {}))}>
            Verbinden
          </button>
        </>
      )}

      {status.state === 'qr' && status.qrDataUrl && (
        <>
          <div className="qr-tile">
            <img src={status.qrDataUrl} alt="WhatsApp QR-Code" data-testid="whatsapp-qr" />
          </div>
          <p className="card__hint">QR mit WhatsApp scannen (Einstellungen → Verknüpfte Geräte → Gerät verknüpfen).</p>
          <button type="button" disabled={busy} onClick={() => void logout()}>Abbrechen</button>
        </>
      )}

      {status.state === 'authenticating' && <p className="card__hint">Wird verbunden …</p>}

      {status.state === 'ready' && (
        <>
          <p className="card__hint">
            ✅ Verbunden als <strong>{status.linkedPushName ?? 'Benutzer'}</strong>{' '}
            ({status.linkedPhoneE164 ?? '—'})
          </p>
          <div className="form-row">
            <label htmlFor="wa-recipient">Empfänger</label>
            <input
              id="wa-recipient"
              type="tel"
              placeholder="+491701234567"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              data-testid="whatsapp-recipient"
            />
            <button type="button" disabled={busy} onClick={() => void saveRecipient()}>Speichern</button>
          </div>
          <div className="wa-toggle">
            <label>
              <input
                type="checkbox"
                checked={status.enabled}
                onChange={() => void toggleEnabled()}
                disabled={busy}
                data-testid="whatsapp-enabled"
              />
              Alerts aktiv
            </label>
            <button type="button" disabled={busy || !status.enabled} onClick={() => void sendTest()}>
              Testnachricht
            </button>
            <button type="button" disabled={busy} onClick={() => void logout()} className="secondary">
              Trennen
            </button>
          </div>
          <p className="card__hint card__hint--small">
            Gesendet: {status.sentCount} · Rate-limited: {status.rateLimitedCount} · Fehler: {status.sendErrorCount}
            {status.lastSentAt && ` · zuletzt ${formatLocalTime(status.lastSentAt)}`}
          </p>
        </>
      )}

      {status.state === 'error' && (
        <>
          <p className="card__hint">⚠ Verbindungsfehler: {status.lastError ?? 'unbekannt'}</p>
          <button type="button" disabled={busy} onClick={() => void refresh()}>Erneut verbinden</button>
        </>
      )}

      {flash && <p className="card__flash">{flash}</p>}
    </section>
  )
}

function labelForState(state: string): string {
  switch (state) {
    case 'ready': return 'Verbunden'
    case 'qr': return 'QR scannen'
    case 'authenticating': return 'Verbinden …'
    case 'error': return 'Fehler'
    default: return 'Getrennt'
  }
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
