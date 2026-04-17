import React, { useCallback, useEffect, useState } from 'react'
import {
  WhatsappDisabledError,
  WhatsappUnavailableError,
  whatsappApi,
} from '../lib/whatsappApi'
import { useWhatsappStatus } from '../hooks/useWhatsappStatus'

const E164_REGEX = /^\+[1-9]\d{6,14}$/

export function WhatsappCard(): React.ReactElement {
  const { status, error, refresh } = useWhatsappStatus(true)
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
      if (err instanceof WhatsappDisabledError) setFlash('WhatsApp-Feature ist deaktiviert.')
      else if (err instanceof WhatsappUnavailableError) setFlash(`WhatsApp-Dienst: ${err.message}`)
      else setFlash((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const saveRecipient = useCallback(async () => {
    if (!E164_REGEX.test(recipient)) {
      setFlash('Telefonnummer muss im Format +49… sein.')
      return
    }
    await run(async () => {
      await whatsappApi.config(status?.enabled ?? true, recipient)
    })
    setFlash(`Empfänger gespeichert: ${recipient}`)
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

  if (error?.kind === 'disabled') {
    return (
      <section className="card whatsapp-card" data-testid="whatsapp-card">
        <header className="card__header"><h2>Benachrichtigungen</h2></header>
        <p className="card__hint">
          WhatsApp-Alerts sind aktuell deaktiviert. Setze <code>WHATSAPP_ENABLED=true</code> in <code>.env</code> und
          starte die api-Container neu, um das Feature zu aktivieren.
        </p>
      </section>
    )
  }

  if (error?.kind === 'unavailable') {
    return (
      <section className="card whatsapp-card" data-testid="whatsapp-card">
        <header className="card__header"><h2>Benachrichtigungen</h2></header>
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
            WhatsApp. Dein Handy wird als „Verknüpftes Gerät" bei WhatsApp registriert —
            der Server sendet dann Alerts in deinem Namen an eine gewählte Telefonnummer.
          </p>
          <button type="button" disabled={busy} onClick={() => void refresh()}>
            QR-Code anfordern
          </button>
        </>
      )}

      {status.state === 'qr' && status.qrDataUrl && (
        <>
          <ol className="whatsapp-onboarding">
            <li>Öffne WhatsApp auf deinem Handy.</li>
            <li>Gehe zu <strong>Einstellungen</strong> (iOS) / Drei-Punkte-Menü (Android) → <strong>Verknüpfte Geräte</strong>.</li>
            <li>Tippe auf <strong>Gerät verknüpfen</strong>.</li>
            <li>Scanne den QR-Code unten mit der Handy-Kamera.</li>
          </ol>
          <div className="qr-tile">
            <img src={status.qrDataUrl} alt="WhatsApp QR-Code" data-testid="whatsapp-qr" />
          </div>
          <p className="card__hint">
            Der Code wird alle ~20 s aktualisiert. Wenn er abläuft, erscheint automatisch ein neuer.
          </p>
          <button type="button" disabled={busy} onClick={() => void logout()}>Abbrechen</button>
        </>
      )}

      {status.state === 'authenticating' && (
        <p className="card__hint">Wird verbunden … dies kann einige Sekunden dauern.</p>
      )}

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
            <button
              type="button"
              disabled={busy || (status.recipientE164 === recipient.trim() && recipient.trim() !== '')}
              onClick={() => void saveRecipient()}
            >
              {status.recipientE164 === recipient.trim() && recipient.trim() !== ''
                ? 'Gespeichert ✓'
                : 'Speichern'}
            </button>
          </div>
          {status.recipientE164 && (
            <p className="card__hint card__hint--small" data-testid="whatsapp-saved-recipient">
              Aktueller Empfänger: <strong>{status.recipientE164}</strong>
              {recipient.trim() !== '' && recipient.trim() !== status.recipientE164 && (
                <> · <em>Änderungen noch nicht gespeichert</em></>
              )}
            </p>
          )}
          <div className="wa-toggle">
            <label>
              <input
                type="checkbox"
                checked={status.enabled}
                onChange={() => void toggleEnabled()}
                disabled={busy}
                data-testid="whatsapp-enabled"
              />
              Alerts aktiv <strong>{status.enabled ? '(an)' : '(aus)'}</strong>
            </label>
            <button
              type="button"
              disabled={busy || !status.recipientE164}
              onClick={() => void sendTest()}
              data-testid="whatsapp-test"
            >
              Testnachricht senden
            </button>
          </div>
          <div className="wa-reset">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (window.confirm('WhatsApp zurücksetzen? Das aktuelle Telefon wird abgemeldet und ein neuer QR-Code wird angezeigt, den du mit einem beliebigen WhatsApp-Telefon scannen kannst.')) {
                  void logout()
                }
              }}
              className="danger"
              data-testid="whatsapp-reset"
            >
              WhatsApp zurücksetzen & anderes Telefon verbinden
            </button>
            <p className="card__hint card__hint--small">
              Trennt das aktuelle Telefon, löscht die Session und zeigt einen neuen QR-Code an.
            </p>
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
