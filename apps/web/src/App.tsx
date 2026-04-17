import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react'
import QRCode from 'qrcode'
import { Link, Route, Routes, useParams, useSearchParams } from 'react-router'
import { useWakeLock } from './hooks/useWakeLock'
import { useSignaling, type SignalingEnvelopeExtras } from './hooks/useSignaling'
import { useAlertSound } from './hooks/useAlertSound'
import {
  createSession,
  getApiBaseUrl,
  getSession,
  readConfig,
} from './lib/api'
import type { AlertEventDTO, SessionCountersDTO } from './lib/alerts'
import type {
  AppConfig,
  DetectionResult,
  LlmRecommendation,
  LlmUsageSummary,
  SessionLinks,
  SessionMetadata,
  VisionRuntimeSummary,
} from './lib/types'
import { WhatsappCard } from './components/WhatsappCard'

type FacingMode = 'environment' | 'user'

type VideoCapabilities = {
  torch: boolean
  zoomMin?: number
  zoomMax?: number
  zoomStep?: number
}

type ZoomPreset = {
  label: string
  value: number
}

type ExtendedMediaTrackCapabilities = MediaTrackCapabilities & {
  torch?: boolean
  zoom?: MediaSettingsRange
}

type ExtendedMediaTrackConstraints = MediaTrackConstraints & {
  advanced?: Array<MediaTrackConstraints & { torch?: boolean; zoom?: number }>
}

type DiagnosticStatus = 'idle' | 'running' | 'ok' | 'warning' | 'error'

type DiagnosticEntry = {
  status: DiagnosticStatus
  detail: string
}

type DiagnosticsState = {
  secureContext: DiagnosticEntry
  api: DiagnosticEntry
  signaling: DiagnosticEntry
  turn: DiagnosticEntry
  lastCheckedAt: string | null
}

const apiBaseUrl = getApiBaseUrl()

// Adaptive-sampling constants. Home-camera birds arrive maybe once every
// 30-60 min; running YOLO at 2.5 FPS all day burns CPU for no gain. After
// IDLE_BACKOFF_FRAMES consecutive quiet frames (no motion, no matches) the
// camera page backs off to IDLE_BACKOFF_MS sampling; the moment anything
// looks interesting it bursts back to the user-selected cadence.
const IDLE_BACKOFF_FRAMES = 10
const IDLE_BACKOFF_MS = 2500

const initialDiagnostics: DiagnosticsState = {
  secureContext: { status: 'idle', detail: 'Noch nicht geprueft.' },
  api: { status: 'idle', detail: 'Noch nicht geprueft.' },
  signaling: { status: 'idle', detail: 'Noch nicht geprueft.' },
  turn: { status: 'idle', detail: 'Noch nicht geprueft.' },
  lastCheckedAt: null,
}

const targetAliasMap: Record<string, string> = {
  human: 'person',
  people: 'person',
  man: 'person',
  woman: 'person',
  boy: 'person',
  girl: 'person',
  child: 'person',
  pedestrian: 'person',
  walker: 'person',
  bike: 'bicycle',
  cycle: 'bicycle',
  motorbike: 'motorcycle',
  scooter: 'motorcycle',
  automobile: 'car',
  sedan: 'car',
  hatchback: 'car',
  taxi: 'car',
  vehicle: 'car',
  pickup: 'truck',
  lorry: 'truck',
  coach: 'bus',
  ship: 'boat',
  pigeon: 'bird',
  dove: 'bird',
  seagull: 'bird',
  crow: 'bird',
  sparrow: 'bird',
  duck: 'bird',
  goose: 'bird',
  puppy: 'dog',
  canine: 'dog',
  kitten: 'cat',
  feline: 'cat',
  plant: 'potted plant',
  sofa: 'couch',
  table: 'dining table',
  'mobile phone': 'cell phone',
  smartphone: 'cell phone',
  phone: 'cell phone',
  television: 'tv',
  'tv monitor': 'tv',
  parcel: 'suitcase',
  luggage: 'suitcase',
  'motion only': 'motion-only',
  'movement only': 'motion-only',
  mensch: 'person',
  menschen: 'person',
  mann: 'person',
  frau: 'person',
  junge: 'person',
  maedchen: 'person',
  mädchen: 'person',
  kind: 'person',
  fussgaenger: 'person',
  fußgänger: 'person',
  fussganger: 'person',
  rad: 'bicycle',
  fahrrad: 'bicycle',
  motorrad: 'motorcycle',
  roller: 'motorcycle',
  auto: 'car',
  wagen: 'car',
  pkw: 'car',
  lieferwagen: 'truck',
  lastwagen: 'truck',
  lkw: 'truck',
  schiff: 'boat',
  taube: 'bird',
  vogel: 'bird',
  moewe: 'bird',
  möwe: 'bird',
  rabe: 'bird',
  spatz: 'bird',
  ente: 'bird',
  gans: 'bird',
  hund: 'dog',
  katze: 'cat',
  pflanze: 'potted plant',
  tisch: 'dining table',
  handy: 'cell phone',
  mobiltelefon: 'cell phone',
  fernseher: 'tv',
  paket: 'suitcase',
  gepaeck: 'suitcase',
  gepäck: 'suitcase',
  'nur bewegung': 'motion-only',
}

function normalizeTargetText(rawValue: string) {
  return rawValue
    .toLowerCase()
    .trim()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .replace(/\s+/g, ' ')
}

function resolveTargetInput(rawValue: string, supportedTargets: string[]) {
  const normalized = normalizeTargetText(rawValue)
  const normalizedTargets = supportedTargets.map((target) => normalizeTargetText(target))
  if (!normalized) {
    return {
      normalized: '',
      resolved: null as string | null,
      confidence: 'empty' as const,
      note: 'Bitte ein konkretes Zielobjekt eingeben.',
    }
  }

  if (targetAliasMap[normalized]) {
    return {
      normalized,
      resolved: targetAliasMap[normalized],
      confidence: 'high' as const,
      note: 'Alias wurde eindeutig auf eine Modellklasse aufgeloest.',
    }
  }

  if (normalizedTargets.includes(normalized)) {
    return {
      normalized,
      resolved: normalized,
      confidence: 'high' as const,
      note: 'Direkter Treffer auf eine unterstuetzte Modellklasse.',
    }
  }

  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const phrase of Object.keys(targetAliasMap).sort((left, right) => right.length - left.length)) {
    if (new RegExp(`(^|[^a-z])${escaped(phrase)}([^a-z]|$)`).test(normalized)) {
      return {
        normalized,
        resolved: targetAliasMap[phrase],
        confidence: 'medium' as const,
        note: `Die Eingabe wird voraussichtlich als "${targetAliasMap[phrase]}" ausgewertet.`,
      }
    }
  }

  for (const label of [...normalizedTargets].sort((left, right) => right.length - left.length)) {
    if (label === 'motion-only') {
      continue
    }
    if (new RegExp(`(^|[^a-z])${escaped(label)}([^a-z]|$)`).test(normalized)) {
      return {
        normalized,
        resolved: label,
        confidence: 'medium' as const,
        note: `Die Eingabe enthaelt die Modellklasse "${label}".`,
      }
    }
  }

  return {
    normalized,
    resolved: normalized,
    confidence: 'low' as const,
    note: 'Keine sichere Modellklasse erkannt. Bitte ein konkreteres Objekt wie "pigeon", "person" oder "white car" verwenden.',
  }
}

function snapZoomValue(value: number, min: number, max: number, step?: number) {
  const clamped = Math.min(max, Math.max(min, value))
  if (!step || step <= 0) {
    return Number(clamped.toFixed(2))
  }

  const snapped = min + Math.round((clamped - min) / step) * step
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(2))
}

function buildZoomPresets(capabilities: VideoCapabilities): ZoomPreset[] {
  if (capabilities.zoomMin === undefined || capabilities.zoomMax === undefined) {
    return []
  }

  const min = capabilities.zoomMin
  const max = capabilities.zoomMax
  const step = capabilities.zoomStep

  const desiredValues =
    min <= 1.05 && max >= 3 ? [1, 2, 3] : [min, min + (max - min) / 2, max]

  const presets = desiredValues.map((value, index) => {
    const snapped = snapZoomValue(value, min, max, step)
    return {
      label: `${index + 1}`,
      value: snapped,
    }
  })

  return presets.filter(
    (preset, index, collection) =>
      collection.findIndex((candidate) => Math.abs(candidate.value - preset.value) < 0.01) === index,
  )
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/camera/:sessionId" element={<CameraPage />} />
      <Route path="/view/:sessionId" element={<ViewerPage />} />
    </Routes>
  )
}

function HomePage() {
  const [config, setConfig] = useState<AppConfig | null>(null)
  const [links, setLinks] = useState<SessionLinks | null>(null)
  const [qrCode, setQrCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>(initialDiagnostics)
  const [diagnosticsRunning, setDiagnosticsRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void readConfig()
      .then(setConfig)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Konfiguration konnte nicht geladen werden.')
      })
  }, [])

  useEffect(() => {
    if (!links) {
      setQrCode(null)
      return
    }

    void QRCode.toDataURL(links.cameraUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 320,
      color: {
        dark: '#ecf3ff',
        light: '#0000',
      },
    }).then(setQrCode)
  }, [links])

  const runDiagnostics = useEffectEvent(async () => {
    setDiagnosticsRunning(true)
    setDiagnostics({
      secureContext: {
        status: 'running',
        detail: 'Pruefe, ob der Browser die Kamera-API in diesem Kontext freischaltet.',
      },
      api: { status: 'running', detail: 'Pruefe den Health-Endpoint ueber den Frontend-Port.' },
      signaling: { status: 'running', detail: 'Pruefe WebSocket-Signaling ueber denselben Browserpfad.' },
      turn: { status: 'running', detail: 'Pruefe, ob der Browser Relay-Kandidaten vom TURN-Server beziehen kann.' },
      lastCheckedAt: null,
    })

    const nextSecureContext = evaluateCameraBrowserSupport()
    let nextApi: DiagnosticEntry = {
      status: 'error',
      detail: 'API-Pruefung wurde nicht abgeschlossen.',
    }
    let nextSignaling: DiagnosticEntry = {
      status: 'error',
      detail: 'WebSocket-Pruefung wurde nicht abgeschlossen.',
    }
    let nextTurn: DiagnosticEntry = {
      status: 'warning',
      detail: 'TURN-Pruefung wurde nicht abgeschlossen.',
    }

    try {
      const healthResponse = await fetch(`${apiBaseUrl}/api/health`, { cache: 'no-store' })
      if (!healthResponse.ok) {
        throw new Error(`Health-Request lieferte HTTP ${healthResponse.status}.`)
      }

      const health = (await healthResponse.json()) as { ok?: boolean }
      nextApi = health.ok
        ? { status: 'ok', detail: 'API antwortet ueber denselben Host und Port wie das Frontend.' }
        : { status: 'error', detail: 'Health-Antwort war erreichbar, aber nicht erfolgreich.' }
    } catch (reason) {
      nextApi = {
        status: 'error',
        detail: reason instanceof Error ? reason.message : 'API ist vom Browser aus nicht erreichbar.',
      }
    }

    const configOk = config !== null
    const healthOk = nextApi.status === 'ok'
    nextSignaling = configOk && healthOk
      ? {
          status: 'ok',
          detail: 'API erreichbar (Config + Health).',
        }
      : {
          status: 'error',
          detail: 'API nicht erreichbar.',
        }

    try {
      nextTurn = await probeTurnRelay(config)
    } catch (reason) {
      nextTurn = {
        status: 'warning',
        detail:
          reason instanceof Error
            ? reason.message
            : 'TURN-Pruefung war nicht eindeutig. STUN/host-Kandidaten koennen im LAN dennoch genuegen.',
      }
    }

    setDiagnostics({
      secureContext: nextSecureContext,
      api: nextApi,
      signaling: nextSignaling,
      turn: nextTurn,
      lastCheckedAt: new Date().toISOString(),
    })
    setDiagnosticsRunning(false)
  })

  useEffect(() => {
    if (!config) {
      return
    }

    void runDiagnostics()
  }, [config])

  async function handleCreateSession() {
    setLoading(true)
    setError(null)

    try {
      const nextLinks = await createSession()
      setLinks(nextLinks)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Session konnte nicht erzeugt werden.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="page-shell" data-testid="home-page">
      <section className="hero-card">
        <div className="hero-copy">
          <span className="eyebrow">Home Camera · Local Network</span>
          <h1>Ein Telefon als Kamera. Jeder Browser als Viewer.</h1>
          <p>
            Ein iOS- oder Android-Telefon streamt seine Kamera per WebRTC an den Mac mini.
            Jeder Browser im gleichen Heimnetz kann live zuschauen und erhaelt KI-gestuetzte
            Alerts mit Artbestimmung und Gemini-Beschreibung.
          </p>
          <div className="hero-actions">
            <button
              className="primary-button"
              data-testid="create-session"
              disabled={loading}
              onClick={() => void handleCreateSession()}
            >
              {loading ? 'Erzeuge Session...' : 'Neue Session starten'}
            </button>
          </div>
        </div>

        <div className="hero-matrix">
          <Metric title="Kamera" value="iOS / Android" detail="Rueckkamera im mobilen Browser" />
          <Metric title="Viewer" value="Jeder Browser" detail="Desktop, Laptop, Tablet im LAN" />
          <Metric title="Stack" value="Mac mini · Docker" detail="YOLO · YOLOE · SAM 3 · BioCLIP 2 · Gemini" />
        </div>
      </section>

      <WhatsappCard />

      <section className="grid-full">
        <article className="glass-card pipeline-card">
          <div className="card-header">
            <div>
              <h2>So erkennt das System Tiere am Fenster</h2>
              <p className="muted-copy">
                Jedes Bild aus dem Kamera-Stream durchlaeuft sechs Stufen.
                Die ersten vier laufen komplett auf dem Mac mini — ohne Cloud.
                Erst fuer die kurze Text-Beschreibung eines Alerts wird ein LLM aufgerufen.
              </p>
            </div>
            <StatusBadge active>6-Stufen-Pipeline</StatusBadge>
          </div>

          <ol className="pipeline-grid">
            <li className="pipeline-step">
              <span className="pipeline-index">1</span>
              <div>
                <h3>Bewegungs-Gate</h3>
                <p className="muted-copy">
                  Vergleicht aufeinander folgende Frames. Bleibt die Szene still, wird alles
                  Weitere uebersprungen — spart Rechenzeit und Akku am Telefon.
                </p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-index">2</span>
              <div>
                <h3>YOLO 26n · Schnelle Objekterkennung</h3>
                <p className="muted-copy">
                  Sucht in wenigen Millisekunden nach 80 COCO-Klassen (Vogel, Katze, Person ...).
                  Ist ein Kandidat im Bild, gibt es Koordinaten + Konfidenz weiter.
                </p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-index">3</span>
              <div>
                <h3>YOLOE 26x · Gezielte Nachpruefung</h3>
                <p className="muted-copy">
                  Schneidet die Kandidaten-Region aus und pruft sie in hoeherer Aufloesung per
                  Text-Prompt ("bird", "cat", "squirrel"). Filtert viele falsche Treffer heraus.
                </p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-index">4</span>
              <div>
                <h3>SAM 3 · Praezise Segmentierung</h3>
                <p className="muted-copy">
                  Metas Segment-Anything-Model zeichnet die tatsaechliche Silhouette des Tieres nach.
                  Das schuetzt vor Blaetter-, Schatten- und Reflexions-Fehlalarmen.
                </p>
              </div>
            </li>
            <li className="pipeline-step">
              <span className="pipeline-index">5</span>
              <div>
                <h3>BioCLIP 2 · Artbestimmung</h3>
                <p className="muted-copy">
                  Fuer Vogel, Katze, Eichhoernchen vergleicht das Modell den Ausschnitt gegen
                  eine kuratierte Mitteleuropa-Liste (172 Arten) und liefert Top-3 Kandidaten
                  mit lateinischem und deutschem Namen.
                </p>
              </div>
            </li>
            <li className="pipeline-step pipeline-step--llm">
              <span className="pipeline-index">6</span>
              <div>
                <h3>Gemini 3.1 Flash Lite · Szenen-Beschreibung</h3>
                <p className="muted-copy">
                  Nur bei einem tatsaechlich ausgeloesten Alert wird ein LLM aufgerufen —
                  es schreibt einen kurzen Satz auf Deutsch und markiert offensichtliche
                  Fehlalarme (Schatten, Lichtwechsel) als unterdrueckt.
                </p>
              </div>
            </li>
          </ol>

          <div className="pipeline-footer muted-copy">
            Zwischen Stufe 2 und 6 liegt je nach Szene ~0.5-15 s. Debounce pro trackId verhindert,
            dass derselbe Vogel innerhalb von 15 s mehrfach einen Alert ausloest.
          </div>
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <h2>Schnellstart</h2>
          <ol className="ordered-list">
            <li>Telefon und Viewer-Geraet ins gleiche WLAN wie den Mac mini bringen.</li>
            <li>Auf <strong>Neue Session starten</strong> tippen — zwei Links werden erzeugt.</li>
            <li>Camera-Link am Telefon oeffnen, Zielobjekt waehlen, Stream starten.</li>
            <li>Viewer-Link auf irgendeinem Geraet oeffnen — Live-View + Alert-Log erscheinen automatisch.</li>
            <li>WhatsApp-Alert an dein Handy, sobald ein Treffer landet.</li>
          </ol>
        </article>

        <article className="glass-card">
          <h2>Erkennungs-Pipeline</h2>
          <p className="muted-copy">
            Jeder Frame durchlaeuft Motion-Gate → YOLO26n → YOLOE-26x → optional SAM 3.
            Bei Treffern auf <em>Vogel/Katze/Eichhoernchen</em> klassifiziert BioCLIP 2 die Art.
            Alert-Minting entpreller per trackId, dann kurze Szenenbeschreibung via {' '}
            <strong>{config?.llmRecommendation.model ?? 'Gemini 3.1 Flash Lite'}</strong>.
          </p>
          <p className="muted-copy">{config?.llmRecommendation.note}</p>
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <h2>LLM-Verbrauch</h2>
          <p className="muted-copy">
            Pro Alert laeuft ein LLM-Call mit Bild und Kontext. Stuendliches und
            Session-Budget schuetzen vor Runaway-Kosten.
          </p>
          <LlmUsagePanel usage={config?.llmUsage} recommendation={config?.llmRecommendation} />
        </article>

        <article className="glass-card">
          <h2>Lokal zuerst</h2>
          <p className="muted-copy">
            Motion, Objekt- und Arterkennung laufen komplett lokal im Vision-Container.
            LLM wird nur fuer die kurze Text-Zusammenfassung ausgeloester Alerts aufgerufen —
            nie fuer jedes Einzelbild.
          </p>
          <p className="muted-copy">
            Fuer <code>LLM_PROVIDER=stub</code> bleiben alle Token-Zaehler auf <strong>0</strong>.
          </p>
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Vision Runtime</h2>
              <p className="muted-copy">
                Zeigt direkt, ob YOLOE und SAM 3 im laufenden Docker-Stack wirklich verfuegbar sind.
              </p>
            </div>
            <StatusBadge active={Boolean(config?.visionRuntime.reachable)}>Vision</StatusBadge>
          </div>
          <VisionRuntimePanel runtime={config?.visionRuntime} />
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>LAN-Diagnose</h2>
              <p className="muted-copy">
                Prueft exakt den Browserpfad, den auch Kamera-Telefon und Viewer-Browser nutzen.
              </p>
            </div>
            <StatusBadge active={!diagnosticsRunning}>Netz</StatusBadge>
          </div>
          <div className="diagnostic-list">
            <DiagnosticRow
              label="Kamera-API"
              entry={diagnostics.secureContext}
              testId="diagnostic-secure-context"
            />
            <DiagnosticRow
              label="API"
              entry={diagnostics.api}
              testId="diagnostic-api"
            />
            <DiagnosticRow
              label="WebSocket"
              entry={diagnostics.signaling}
              testId="diagnostic-signaling"
            />
            <DiagnosticRow
              label="TURN"
              entry={diagnostics.turn}
              testId="diagnostic-turn"
            />
          </div>
          <div className="inline-actions">
            <button
              className="secondary-button"
              data-testid="rerun-diagnostics"
              disabled={diagnosticsRunning}
              onClick={() => void runDiagnostics()}
            >
              {diagnosticsRunning ? 'Diagnose laeuft...' : 'Diagnose erneut starten'}
            </button>
          </div>
          <p className="muted-copy">
            Ziel im gleichen WLAN: <code>{describeNetworkTarget(config?.publicWebUrl)}</code>
          </p>
          {diagnostics.lastCheckedAt ? (
            <p className="muted-copy">Letzter Check: {formatTimestamp(diagnostics.lastCheckedAt)}</p>
          ) : null}
        </article>

        <article className="glass-card">
          <h2>Browser-Ziel</h2>
          <p className="muted-copy">
            Oeffne diesen Host sowohl auf dem Kamera-Telefon als auch auf dem Viewer-Geraet —
            API und Signaling laufen danach intern ueber denselben Mac mini.
          </p>
          <p className="session-link" data-testid="lan-target">
            {config?.publicWebUrl ?? 'PUBLIC_WEB_URL fehlt'}
          </p>
          <p className="muted-copy">
            Falls <code>macmini.local</code> auf dem Telefon nicht aufgeloest wird, verwende die
            LAN-IP des Mac mini auf demselben Port.
          </p>
        </article>
      </section>

      {error ? <p className="status-error">{error}</p> : null}

      {links ? (
        <section className="session-layout">
          <article className="glass-card">
            <h2>Camera Link</h2>
            <p className="muted-copy">
              Diesen Link auf dem iOS- oder Android-Telefon oeffnen, das als Kamera dienen soll.
            </p>
            <a
              className="session-link"
              data-testid="camera-link"
              href={links.cameraUrl}
              target="_blank"
              rel="noreferrer"
            >
              {links.cameraUrl}
            </a>
            {qrCode ? <img className="qr-code" src={qrCode} alt="QR-Code fuer den Camera-Link" /> : null}
          </article>

          <article className="glass-card">
            <h2>Viewer Link</h2>
            <p className="muted-copy">
              In jedem Browser im Heimnetz oeffnen — Laptop, Desktop, Tablet oder zweitem Telefon.
            </p>
            <a
              className="session-link"
              data-testid="viewer-link"
              href={links.viewerUrl}
              target="_blank"
              rel="noreferrer"
            >
              {links.viewerUrl}
            </a>
            <div className="inline-actions">
              <Link className="secondary-button" to={toLocalRoute(links.viewerUrl)}>
                Im aktuellen Tab oeffnen
              </Link>
            </div>
          </article>
        </section>
      ) : null}
    </main>
  )
}

function ViewerPage() {
  const { sessionId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [metadata, setMetadata] = useState<SessionMetadata | null>(null)
  const [detection, setDetection] = useState<DetectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [alertEvents, setAlertEvents] = useState<AlertEventDTO[]>([])
  const [counters, setCounters] = useState<SessionCountersDTO | null>(null)

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null)
  const seenEventIdsRef = useRef<Set<string>>(new Set())
  const { muted: alertsMuted, ready: alertsReady, toggleMute: toggleAlertsMute, play: playAlertSound } = useAlertSound()

  useEffect(() => {
    if (!sessionId || !token) {
      setError('Viewer-Token oder Session-ID fehlen.')
      return
    }

    void Promise.all([readConfig(), getSession(sessionId, token)])
      .then(([loadedConfig, loadedSession]) => {
        setConfig(loadedConfig)
        setMetadata(loadedSession)
        setDetection(loadedSession.latestDetection)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Viewer konnte nicht initialisiert werden.')
      })
  }, [sessionId, token])

  const handleEnvelope = useCallback((envelope: SignalingEnvelopeExtras) => {
    if (envelope.type === 'session-state') {
      const nextState = envelope.payload as Partial<SessionMetadata> & {
        latestDetection?: DetectionResult | null
        counters?: SessionCountersDTO
        events?: AlertEventDTO[]
      }
      setMetadata((current) => {
        if (!current) return current
        return {
          ...current,
          ...nextState,
          latestDetection: nextState.latestDetection ?? current.latestDetection,
        }
      })
      if (nextState.latestDetection !== undefined) {
        setDetection(nextState.latestDetection ?? null)
      }
      if (nextState.counters) {
        setCounters(nextState.counters)
      }
      if (Array.isArray(nextState.events)) {
        // Pre-populate seen-ids so the Alert Log backfill doesn't blast
        // the speakers on reconnect.
        for (const ev of nextState.events) seenEventIdsRef.current.add(ev.id)
        setAlertEvents(nextState.events.slice(-50).reverse())
      }
    } else if (envelope.type === 'detection') {
      setDetection(envelope.payload as DetectionResult)
    } else if (envelope.type === 'alert') {
      const dto = envelope.payload as AlertEventDTO
      const isNew = !seenEventIdsRef.current.has(dto.id)
      if (isNew) {
        seenEventIdsRef.current.add(dto.id)
        // Fire audio once per event (initial mint broadcast). Subsequent
        // LLM patch broadcasts carry the same id → skip.
        if (!dto.suppressed) {
          playAlertSound(dto.target)
        }
      }
      setAlertEvents((prev) => {
        const idx = prev.findIndex((e) => e.id === dto.id)
        if (idx >= 0) {
          const next = prev.slice()
          next[idx] = dto
          return next
        }
        return [dto, ...prev].slice(0, 50)
      })
    } else if (envelope.type === 'error') {
      setError(envelope.payload.message)
    }
  }, [playAlertSound])

  const { remoteStream, lastError } = useSignaling({
    sessionId: sessionId ?? null,
    role: 'viewer',
    token,
    iceServers: config?.iceServers ?? null,
    localStream: null,
    polite: true,
    onEnvelope: handleEnvelope,
  })

  useEffect(() => {
    const video = remoteVideoRef.current
    if (!video) return
    video.srcObject = remoteStream
    if (remoteStream) {
      video.play().catch(() => {
        /* autoplay blocked is fine for muted video */
      })
    }
  }, [remoteStream])

  const displayedError = error ?? lastError

  return (
    <PageLayout
      title="Viewer"
      subtitle="Live-Stream und Alerts in jedem Browser im Heimnetz. Pro Session ist genau ein Viewer aktiv — ein zweiter Tab uebernimmt und schliesst den aelteren."
      backLink
    >
      <section className="grid-two">
        <article className="glass-card video-card">
          <div className="card-header">
            <div>
              <h2>Live View</h2>
              <p className="muted-copy">
                {metadata?.cameraConnected ? 'Kamera verbunden' : 'Warte auf Kamera-Sender'}
              </p>
            </div>
            <StatusBadge active={Boolean(metadata?.cameraConnected)}>Stream</StatusBadge>
          </div>
          <video
            ref={remoteVideoRef}
            data-testid="viewer-video"
            className="video-frame"
            autoPlay
            playsInline
            muted
          />
        </article>

        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Alert Feed</h2>
              <p className="muted-copy">Alarm bei Bewegung und passendem Zielobjekt.</p>
            </div>
            <StatusBadge active={Boolean(detection?.triggered)}>Alarm</StatusBadge>
          </div>
          {detection ? (
            <AlertCard detection={detection} />
          ) : (
            <p className="muted-copy">Noch kein Detection-Ereignis vorhanden.</p>
          )}
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card alert-log" data-testid="alert-log">
          <div className="card-header">
            <div>
              <h2>Alerts{counters ? ` (${counters.totalAlerts})` : ''}</h2>
              <p className="muted-copy">
                {counters
                  ? `Erfasst: ${counters.totalDetections} · Ausgeloest: ${counters.totalTriggered}${
                      counters.llmBudgetSkipped ? ` · LLM uebersprungen: ${counters.llmBudgetSkipped}` : ''
                    }${counters.llmFailed ? ` · LLM fehlgeschlagen: ${counters.llmFailed}` : ''}`
                  : 'Noch keine Zaehlerdaten.'}
              </p>
            </div>
            <div className="alert-log-controls">
              <button
                type="button"
                className={`sound-toggle${alertsMuted ? ' muted' : ''}`}
                onClick={toggleAlertsMute}
                aria-pressed={!alertsMuted}
                title={alertsMuted ? 'Ton einschalten' : 'Ton ausschalten'}
                data-testid="alert-sound-toggle"
              >
                <span className="sound-toggle__icon" aria-hidden="true">
                  {alertsMuted ? (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 5 6 9H2v6h4l5 4V5z" />
                      <line x1="22" y1="9" x2="16" y2="15" />
                      <line x1="16" y1="9" x2="22" y2="15" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 5 6 9H2v6h4l5 4V5z" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  )}
                </span>
                <span className="sound-toggle__label">
                  {alertsMuted ? 'Ton aus' : alertsReady ? 'Ton an' : 'Ton – klick zum Aktivieren'}
                </span>
              </button>
              <StatusBadge active={alertEvents.length > 0}>
                {alertEvents.length > 0 ? `${alertEvents.length}` : 'Leer'}
              </StatusBadge>
            </div>
          </div>
          {alertEvents.length === 0 ? (
            <p className="muted-copy">Noch keine Alerts.</p>
          ) : (
            <ul className="alert-log-list" data-testid="alert-log-list">
              {alertEvents.map((ev) => (
                <li
                  key={ev.id}
                  className={ev.suppressed ? 'alert-log-item suppressed' : 'alert-log-item'}
                  data-testid="alert-log-item"
                >
                  {ev.snapshotUrl ? (
                    <img
                      className="alert-log-thumb"
                      src={ev.snapshotUrl}
                      alt={ev.target}
                      loading="lazy"
                    />
                  ) : null}
                  <div className="alert-log-body">
                    <div className="alert-log-title">
                      <strong>{ev.target}</strong>
                      {ev.speciesCommonName ? <span> · {ev.speciesCommonName}</span> : null}
                      <time className="muted-copy"> · {new Date(ev.createdAt).toLocaleTimeString()}</time>
                    </div>
                    <p className="muted-copy alert-log-summary">
                      {ev.llm?.shortSummary ?? 'LLM laeuft...'}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>LLM-Tokenverbrauch</h2>
              <p className="muted-copy">Kostenkontrolle fuer den aktuellen Viewer-Run.</p>
            </div>
            <StatusBadge active={!metadata?.llmUsage.usedForMotionDetection}>Kosten</StatusBadge>
          </div>
          <LlmUsagePanel usage={metadata?.llmUsage} recommendation={config?.llmRecommendation} />
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Vision Runtime</h2>
              <p className="muted-copy">Laufzeitstatus des lokalen Vision-Stacks fuer den Viewer.</p>
            </div>
            <StatusBadge active={Boolean(config?.visionRuntime.reachable)}>Vision</StatusBadge>
          </div>
          <VisionRuntimePanel runtime={config?.visionRuntime} lastDetection={detection} />
        </article>
      </section>

      {displayedError ? <p className="status-error">{displayedError}</p> : null}
    </PageLayout>
  )
}

function CameraPage() {
  const { sessionId } = useParams()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token')

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [metadata, setMetadata] = useState<SessionMetadata | null>(null)
  const [detection, setDetection] = useState<DetectionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [running, setRunning] = useState(false)
  const [facingMode, setFacingMode] = useState<FacingMode>('environment')
  const [capabilities, setCapabilities] = useState<VideoCapabilities>({ torch: false })
  const [torchEnabled, setTorchEnabled] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [detectionEnabled, setDetectionEnabled] = useState(true)
  const [targetLabel, setTargetLabel] = useState('bird')
  const [minConfidence, setMinConfidence] = useState(0.4)
  const [motionThreshold, setMotionThreshold] = useState(0.075)
  // Birds often stay <1 s in frame — 1 FPS analysis is below Nyquist.
  // Defaulting to 400 ms (~2.5 FPS). Vision's motion-gate filters most
  // frames, so CPU cost stays proportional to real events.
  const [sampleRateMs, setSampleRateMs] = useState(400)
  const idleFramesRef = useRef(0)

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const detectionBusyRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const wakeLock = useWakeLock(running)
  const cameraSupport = useMemo(() => evaluateCameraBrowserSupport(), [])
  const supportedTargets = config?.targetInputGuidance.supportedTargets ?? [
    'person',
    'bird',
    'car',
    'truck',
    'bus',
    'bicycle',
    'motorcycle',
    'dog',
    'cat',
    'cell phone',
    'chair',
    'couch',
    'potted plant',
    'motion-only',
  ]
  const targetResolution = useMemo(
    () => resolveTargetInput(targetLabel, supportedTargets),
    [supportedTargets, targetLabel],
  )
  const zoomPresets = useMemo(() => buildZoomPresets(capabilities), [capabilities])

  useEffect(() => {
    if (!sessionId || !token) {
      setError('Camera-Token oder Session-ID fehlen.')
      return
    }

    void Promise.all([readConfig(), getSession(sessionId, token)])
      .then(([loadedConfig, loadedSession]) => {
        setConfig(loadedConfig)
        setMetadata(loadedSession)
        setDetection(loadedSession.latestDetection)
        setTargetLabel(loadedConfig.defaults.targetLabel)
        setMinConfidence(loadedConfig.defaults.minConfidence)
        setMotionThreshold(loadedConfig.defaults.motionThreshold)
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : 'Camera-Ansicht konnte nicht initialisiert werden.')
      })
  }, [sessionId, token])

  const stopStream = useEffectEvent(() => {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
      setStream(null)
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
  })

  const readCapabilities = useEffectEvent((nextStream: MediaStream) => {
    const track = nextStream.getVideoTracks()[0]
    const mediaCapabilities = track.getCapabilities?.() as ExtendedMediaTrackCapabilities | undefined
    const mediaSettings = track.getSettings()
    const zoomCapabilities = mediaCapabilities?.zoom

    // Expose the raw capability snapshot in the console so we can verify
    // optical-vs-digital zoom ranges on each physical Android device
    // (Pixel / Samsung / OnePlus advertise different zoom curves).
    if (typeof console !== 'undefined') {
      console.info('[camera] settings', mediaSettings)
      console.info('[camera] capabilities', mediaCapabilities)
    }

    setCapabilities({
      torch: Boolean(mediaCapabilities?.torch),
      zoomMin: zoomCapabilities?.min,
      zoomMax: zoomCapabilities?.max,
      zoomStep: zoomCapabilities?.step,
    })
    setZoom(typeof mediaSettings.zoom === 'number' ? mediaSettings.zoom : (zoomCapabilities?.min ?? 1))
  })

  const startCamera = useEffectEvent(async (preferredFacing: FacingMode) => {
    if (cameraSupport.status !== 'ok') {
      setError(cameraSupport.detail)
      return
    }

    try {
      stopStream()
      setError(null)

      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: preferredFacing },
          // 1080p captures ~2.25x more pixels than 720p per the 2026-04-17
          // research (single biggest impact per pixel for small-bird recall
          // per MDN MediaTrackConstraints + real-device tests on Pixel 9 /
          // Galaxy S24).
          width: { ideal: 1920, max: 1920 },
          height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 30, max: 30 },
        },
      })

      // Stabilise the scene so the motion-gate doesn't fire on
      // auto-exposure / white-balance drift. Each `advanced` entry is
      // applied best-effort — platforms that don't support a given field
      // silently ignore it.
      const stabilise = nextStream.getVideoTracks()[0]
      if (stabilise) {
        try {
          await stabilise.applyConstraints({
            advanced: [
              { focusMode: 'continuous' } as MediaTrackConstraintSet,
              { exposureMode: 'continuous' } as MediaTrackConstraintSet,
              { whiteBalanceMode: 'continuous' } as MediaTrackConstraintSet,
            ],
          })
        } catch {
          /* best-effort; safe to ignore */
        }
      }

      setStream(nextStream)
      setRunning(true)
      readCapabilities(nextStream)

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = nextStream
      }
    } catch (reason) {
      setRunning(false)
      setError(describeCameraAccessIssue(reason))
    }
  })

  const handleEnvelope = useCallback((envelope: SignalingEnvelopeExtras) => {
    if (envelope.type === 'session-state') {
      const nextState = envelope.payload as Partial<SessionMetadata> & {
        latestDetection?: DetectionResult | null
      }
      setMetadata((current) => {
        if (!current) return current
        return {
          ...current,
          ...nextState,
          latestDetection: nextState.latestDetection ?? current.latestDetection,
        }
      })
      if (nextState.latestDetection !== undefined) {
        setDetection(nextState.latestDetection ?? null)
      }
    } else if (envelope.type === 'detection') {
      setDetection(envelope.payload as DetectionResult)
    } else if (envelope.type === 'error') {
      setError(envelope.payload.message)
    }
  }, [])

  const { lastError: signalingError } = useSignaling({
    sessionId: sessionId ?? null,
    role: 'camera',
    token,
    iceServers: config?.iceServers ?? null,
    localStream: stream,
    polite: false,
    onEnvelope: handleEnvelope,
  })

  useEffect(() => {
    return () => {
      stopStream()
      setRunning(false)
    }
  }, [])

  useEffect(() => {
    if (!running || !stream || !detectionEnabled || !sessionId || !token) {
      return
    }

    let cancelled = false

    const tick = async () => {
      if (
        cancelled ||
        detectionBusyRef.current ||
        !localVideoRef.current ||
        localVideoRef.current.readyState < HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return
      }

      detectionBusyRef.current = true

      try {
        const video = localVideoRef.current
        const canvas = canvasRef.current ?? document.createElement('canvas')
        canvasRef.current = canvas
        canvas.width = 640
        canvas.height = Math.max(360, Math.round((video.videoHeight / Math.max(video.videoWidth, 1)) * 640))
        const context = canvas.getContext('2d')
        if (!context) {
          return
        }

        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob(resolve, 'image/jpeg', 0.82)
        })

        if (!blob) {
          return
        }

        const formData = new FormData()
        formData.set('target_label', targetLabel)
        formData.set('min_confidence', String(minConfidence))
        formData.set('motion_threshold', String(motionThreshold))
        formData.set('file', blob, `frame-${Date.now()}.jpg`)

        const response = await fetch(`${apiBaseUrl}/api/sessions/${sessionId}/detect`, {
          method: 'POST',
          headers: {
            'x-session-token': token,
          },
          body: formData,
        })

        if (!response.ok) {
          throw new Error('Detection-Request fehlgeschlagen.')
        }

        const nextDetection = (await response.json()) as DetectionResult
        setDetection(nextDetection)

        // Adaptive sampling: back off when the scene has been quiet for a
        // while; burst back to the user-selected cadence the moment
        // anything looks interesting. Birds in a garden often appear once
        // every 30-60 min, so running YOLO at 2.5 FPS all day just heats
        // the Mac mini without adding detection value.
        const motionish =
          nextDetection.motionDetected ||
          nextDetection.motionScore > 0.015 ||
          (nextDetection.matchedObjects?.length ?? 0) > 0
        if (motionish) {
          idleFramesRef.current = 0
        } else {
          idleFramesRef.current += 1
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Detection konnte nicht ausgefuehrt werden.')
      } finally {
        detectionBusyRef.current = false
      }
    }

    let cancelledTimer = false
    let nextTimeout: number | null = null

    const scheduleNext = () => {
      if (cancelled || cancelledTimer) return
      // After ~10 idle frames back off; when busy, honour the user setting.
      const delay =
        idleFramesRef.current >= IDLE_BACKOFF_FRAMES
          ? Math.max(sampleRateMs, IDLE_BACKOFF_MS)
          : sampleRateMs
      nextTimeout = window.setTimeout(async () => {
        await tick()
        scheduleNext()
      }, delay)
    }

    void tick().then(() => scheduleNext())

    return () => {
      cancelled = true
      cancelledTimer = true
      if (nextTimeout !== null) window.clearTimeout(nextTimeout)
    }
  }, [detectionEnabled, minConfidence, motionThreshold, running, sampleRateMs, sessionId, stream, targetLabel, token])

  async function applyTorch(enabled: boolean) {
    if (!stream) {
      return
    }

    const track = stream.getVideoTracks()[0]
    const constraints: ExtendedMediaTrackConstraints = {
      advanced: [{ torch: enabled }],
    }
    await track.applyConstraints(constraints)
    setTorchEnabled(enabled)
  }

  async function applyZoomLevel(nextZoom: number) {
    if (!stream) {
      return
    }

    const track = stream.getVideoTracks()[0]
    const constraints: ExtendedMediaTrackConstraints = {
      advanced: [{ zoom: nextZoom }],
    }
    await track.applyConstraints(constraints)
    setZoom(nextZoom)
  }

  async function handleFlipCamera() {
    const nextFacing: FacingMode = facingMode === 'environment' ? 'user' : 'environment'
    setFacingMode(nextFacing)
    if (running) {
      await startCamera(nextFacing)
    }
  }

  function handleConfidenceChange(event: ChangeEvent<HTMLInputElement>) {
    setMinConfidence(Number(event.target.value))
  }

  function handleMotionThresholdChange(event: ChangeEvent<HTMLInputElement>) {
    setMotionThreshold(Number(event.target.value))
  }

  return (
    <PageLayout
      title="Camera"
      subtitle="Android-Smartphone als Kamera-Sender mit Rueckkamera, Wake Lock und lokaler Detection."
      backLink
    >
      {cameraSupport.status !== 'ok' ? (
        <section className="grid-two">
          <article className="glass-card">
            <div className="card-header">
              <div>
                <h2>Kamera gesperrt</h2>
                <p className="muted-copy">
                  Der Browser blockiert die Kamera bereits vor dem Startversuch.
                </p>
              </div>
              <StatusBadge active={false}>Blockiert</StatusBadge>
            </div>
            <p className="status-error camera-warning" data-testid="camera-warning">
              {cameraSupport.detail}
            </p>
            <p className="muted-copy">
              Aktueller Aufruf: <code>{currentPageOrigin()}</code>
            </p>
          </article>

          <article className="glass-card">
            <div className="card-header">
              <div>
                <h2>Viewer und API</h2>
                <p className="muted-copy">
                  Live-View, API und Signaling koennen trotzdem bereits erreichbar sein.
                </p>
              </div>
              <StatusBadge active={Boolean(metadata)}>Pfad</StatusBadge>
            </div>
            <p className="muted-copy">
              Der Fehler betrifft nur den Browser-Kamerazugriff. Viewer, Session-API und
              Signaling koennen parallel bereits korrekt funktionieren.
            </p>
          </article>
        </section>
      ) : null}

      <section className="grid-two">
        <article className="glass-card video-card">
          <div className="card-header">
            <div>
              <h2>Kamera</h2>
              <p className="muted-copy">{running ? 'Stream aktiv' : 'Kamera noch nicht gestartet'}</p>
            </div>
            <StatusBadge active={running}>{wakeLock.isActive ? 'Wake Lock an' : 'Wake Lock aus'}</StatusBadge>
          </div>
          <video
            ref={localVideoRef}
            data-testid="camera-video"
            className="video-frame"
            autoPlay
            playsInline
            muted
          />

          <div className="control-row">
            <button
              className="primary-button"
              data-testid="start-camera"
              onClick={() => void startCamera(facingMode)}
            >
              {running ? 'Neu starten' : 'Kamera starten'}
            </button>
            <button className="secondary-button" onClick={() => void handleFlipCamera()}>
              Kamera wechseln
            </button>
            <button
              className="secondary-button"
              onClick={() => {
                stopStream()
                setRunning(false)
              }}
            >
              Stoppen
            </button>
          </div>
        </article>

        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Detection</h2>
              <p className="muted-copy">Bewegung + Objektalarm direkt im lokalen Stack.</p>
            </div>
            <StatusBadge active={detectionEnabled}>Analyser</StatusBadge>
          </div>

          <label className="field">
            <span>Detection aktiv</span>
            <input
              type="checkbox"
              data-testid="detection-enabled"
              checked={detectionEnabled}
              onChange={(event) => setDetectionEnabled(event.target.checked)}
            />
          </label>

          <label className="field">
            <span>Zielobjekt</span>
            <select
              data-testid="target-label"
              value={targetLabel}
              onChange={(event) => setTargetLabel(event.target.value)}
            >
              <option value="bird">Vogel (bird)</option>
              <option value="cat">Katze (cat)</option>
              <option value="squirrel">Eichhörnchen (squirrel)</option>
              <option value="person">Person (human)</option>
              <option value="motion-only">Bewegung (motion-only)</option>
            </select>
          </label>

          <div className="target-guidance-card">
            <div className="target-guidance-header">
              <strong>Praezise Zielbeschreibung</strong>
              <span className={`target-resolution ${targetResolution.confidence}`}>
                {targetResolution.resolved ? `AI-Ziel: ${targetResolution.resolved}` : 'Bitte Ziel setzen'}
              </span>
            </div>
            <p className="muted-copy">{targetResolution.note}</p>
            <ul className="guidance-list">
              {(config?.targetInputGuidance.instructions ?? []).map((instruction) => (
                <li key={instruction}>{instruction}</li>
              ))}
            </ul>
            <p className="muted-copy">
              Gute Beispiele: {(config?.targetInputGuidance.examples ?? []).join(', ')}
            </p>
          </div>

          {zoomPresets.length > 0 ? (
            <div className="zoom-preset-card">
              <div className="target-guidance-header">
                <strong>Kamera-Zoom in 3 Stufen</strong>
                <span className="target-resolution high">{zoom.toFixed(1)}x aktiv</span>
              </div>
              <p className="muted-copy">
                Wenn der Android-Browser Zoom-Capabilities freigibt, koennen wir direkt im
                Kamerastream zwischen drei Fokus-Stufen umschalten.
              </p>
              <div className="zoom-preset-row" data-testid="zoom-presets">
                {zoomPresets.map((preset) => (
                  <button
                    key={`${preset.label}-${preset.value}`}
                    className={
                      Math.abs(zoom - preset.value) < 0.05 ? 'secondary-button zoom-preset active' : 'secondary-button zoom-preset'
                    }
                    disabled={!running}
                    onClick={() => void applyZoomLevel(preset.value)}
                  >
                    Stufe {preset.label} · {preset.value.toFixed(1)}x
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <label className="field">
            <span>Confidence: {minConfidence.toFixed(2)}</span>
            <input
              data-testid="min-confidence"
              type="range"
              min="0.2"
              max="0.95"
              step="0.05"
              value={minConfidence}
              onChange={handleConfidenceChange}
            />
          </label>

          <label className="field">
            <span>Motion Threshold: {motionThreshold.toFixed(3)}</span>
            <input
              data-testid="motion-threshold"
              type="range"
              min="0.02"
              max="0.2"
              step="0.005"
              value={motionThreshold}
              onChange={handleMotionThresholdChange}
            />
          </label>

          <label className="field">
            <span>Analyse-Intervall</span>
            <select
              data-testid="sample-rate"
              value={sampleRateMs}
              onChange={(event) => setSampleRateMs(Number(event.target.value))}
            >
              <option value={250}>0.25s (~4 FPS, Voegel/Eichhoernchen)</option>
              <option value={400}>0.4s (~2.5 FPS, empfohlen)</option>
              <option value={800}>0.8s (Katze/Person)</option>
              <option value={1200}>1.2s (Spar-Modus)</option>
              <option value={2000}>2.0s (Test)</option>
            </select>
          </label>

          {capabilities.torch ? (
            <button className="secondary-button" onClick={() => void applyTorch(!torchEnabled)}>
              {torchEnabled ? 'Taschenlampe aus' : 'Taschenlampe an'}
            </button>
          ) : (
            <p className="muted-copy">Torch ist auf diesem Android-Browser/Geraet nicht freigeschaltet.</p>
          )}

          {capabilities.zoomMin !== undefined && capabilities.zoomMax !== undefined ? (
            <label className="field">
              <span>Zoom: {zoom.toFixed(1)}x</span>
              <input
                type="range"
                min={capabilities.zoomMin}
                max={capabilities.zoomMax}
                step={capabilities.zoomStep ?? 0.1}
                value={zoom}
                onChange={(event) => void applyZoomLevel(Number(event.target.value))}
              />
            </label>
          ) : null}
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Session</h2>
              <p className="muted-copy">Der Viewer kann jederzeit aus dem gleichen LAN beitreten.</p>
            </div>
            <StatusBadge active={Boolean(metadata?.viewerConnected)}>Viewer</StatusBadge>
          </div>
          <p className="muted-copy">
            Session-ID: <code>{sessionId}</code>
          </p>
          <p className="muted-copy">
            Auf Android fuer laengere Nutzung den Bildschirm aktiv lassen und Akku-Sparmodus nach
            Moeglichkeit deaktivieren.
          </p>
        </article>

        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Letztes Ergebnis</h2>
              <p className="muted-copy">Objekt- und Bewegungsstatus in nahezu Echtzeit.</p>
            </div>
            <StatusBadge active={Boolean(detection?.triggered)}>Alert</StatusBadge>
          </div>

          {detection ? (
            <AlertCard detection={detection} />
          ) : (
            <p className="muted-copy">Noch keine Analyse vorhanden.</p>
          )}
        </article>
      </section>

      <section className="grid-two">
        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>LLM-Tokenverbrauch</h2>
              <p className="muted-copy">
                Diese Werte zeigen, ob der Detection-Pfad aktuell LLM-Tokens verbraucht.
              </p>
            </div>
            <StatusBadge active={!metadata?.llmUsage.usedForMotionDetection}>Kosten</StatusBadge>
          </div>
          <LlmUsagePanel usage={metadata?.llmUsage} recommendation={config?.llmRecommendation} />
        </article>

        <article className="glass-card">
          <div className="card-header">
            <div>
              <h2>Vision Runtime</h2>
              <p className="muted-copy">
                Zeigt, ob der groessere Verifier und optional SAM 3 auf diesem Stack aktiv sein koennen.
              </p>
            </div>
            <StatusBadge active={Boolean(config?.visionRuntime.reachable)}>Vision</StatusBadge>
          </div>
          <VisionRuntimePanel runtime={config?.visionRuntime} lastDetection={detection} />
        </article>
      </section>

      {error || signalingError ? (
        <p className="status-error">{error ?? signalingError}</p>
      ) : null}
    </PageLayout>
  )
}

function PageLayout(props: { title: string; subtitle: string; backLink?: boolean; children: ReactNode }) {
  return (
    <main className="page-shell">
      <header className="page-header">
        <div>
          <span className="eyebrow">Remote Camera AI</span>
          <h1>{props.title}</h1>
          <p>{props.subtitle}</p>
        </div>
        {props.backLink ? (
          <Link className="secondary-button" to="/">
            Zur Startseite
          </Link>
        ) : null}
      </header>
      {props.children}
    </main>
  )
}

function Metric(props: { title: string; value: string; detail: string }) {
  return (
    <div className="metric-card">
      <p className="metric-title">{props.title}</p>
      <p className="metric-value">{props.value}</p>
      <p className="metric-detail">{props.detail}</p>
    </div>
  )
}

function AlertCard({ detection }: { detection: DetectionResult }) {
  const matches = useMemo(() => {
    if (detection.matchedObjects.length === 0) {
      return 'Kein passendes Zielobjekt gefunden'
    }

    return detection.matchedObjects
      .map((item) => {
        const trackBits = item.trackId
          ? ` · Track ${item.trackId} · Streak ${item.trackStreak ?? 0}${item.confirmed ? ' · bestaetigt' : ''}`
          : ''
        return `${item.label} ${(item.confidence * 100).toFixed(0)}%${trackBits}`
      })
      .join(', ')
  }, [detection.matchedObjects])

  const motionTriggered = detection.motionDetected
  const yoloRan = detection.objectDetectionRan
  const precisionRan = detection.precisionVerifierRan
  const precisionMatched = precisionRan && detection.precisionVerifierMatched
  const sam3Ran = Boolean(detection.sam3VerifierAvailable && detection.sam3VerifierRan)
  const sam3Matched = sam3Ran && detection.sam3VerifierMatched
  const speciesMode = detection.speciesMode
  const speciesCandidates = detection.speciesCandidates ?? []
  const speciesRan = speciesMode === 'top3' && speciesCandidates.length > 0
  const mdHits = detection.megadetectorHits ?? []
  const mdRan = Boolean(detection.megadetectorRan)
  const mdAvailable = Boolean(detection.megadetectorAvailable)
  const mdExtra = detection.megadetectorExtraCount ?? 0

  const stageFlow: StageChipProps[] = [
    { name: 'Bewegung', state: motionTriggered ? 'hit' : 'skipped' },
    { name: 'YOLO', state: yoloRan ? (detection.matchedObjects.length > 0 ? 'hit' : 'miss') : 'skipped' },
    {
      name: 'YOLOE',
      state: precisionRan ? (precisionMatched ? 'hit' : 'miss') : 'skipped',
    },
    {
      name: 'SAM 3',
      state: detection.sam3VerifierAvailable
        ? sam3Ran
          ? sam3Matched
            ? 'hit'
            : 'miss'
          : 'skipped'
        : 'disabled',
    },
    { name: 'BioCLIP', state: speciesRan ? 'hit' : 'skipped' },
    {
      name: 'MegaDet',
      state: !mdAvailable
        ? 'disabled'
        : mdRan
        ? mdHits.length > 0
          ? 'hit'
          : 'miss'
        : 'skipped',
    },
  ]

  return (
    <div className="alert-card" data-testid="alert-card">
      <div className="alert-pills">
        <AlertPill
          label="Motion"
          value={detection.motionScore.toFixed(3)}
          tone={motionTriggered ? 'hit' : 'idle'}
        />
        <AlertPill
          label="Ziel"
          value={detection.targetLabel}
          tone="neutral"
        />
        <AlertPill
          label="Bestaetigt"
          value={String(detection.confirmedMatchCount)}
          tone={detection.confirmedMatchCount > 0 ? 'hit' : 'idle'}
        />
        <AlertPill
          label="Zeit"
          value={formatTimestamp(detection.createdAt)}
          tone="neutral"
        />
      </div>

      <div className="stage-flow" aria-label="Erkennungs-Pipeline">
        {stageFlow.map((stage, idx) => (
          <StageChip key={stage.name} {...stage} isLast={idx === stageFlow.length - 1} />
        ))}
      </div>

      {speciesRan ? (
        <div className="species-panel">
          <header>
            <strong>Artbestimmung</strong>
            <span className="muted-copy">BioCLIP 2 · Top 3</span>
          </header>
          <ul>
            {speciesCandidates.slice(0, 3).map((c, idx) => (
              <li key={c.scientificName} className={idx === 0 ? 'species-row top' : 'species-row'}>
                <div className="species-row__meta">
                  <strong>{c.commonName}</strong>
                  <span className="muted-copy">{c.scientificName}</span>
                </div>
                <div className="species-row__bar">
                  <div
                    className="species-row__fill"
                    style={{ width: `${Math.min(100, Math.max(4, c.confidence * 100)).toFixed(1)}%` }}
                  />
                </div>
                <span className="species-row__pct">{(c.confidence * 100).toFixed(0)}%</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {matches ? <p className="muted-copy alert-matches">Treffer: {matches}</p> : null}

      {mdRan && mdHits.length > 0 ? (
        <p className="muted-copy alert-matches">
          <strong>MegaDetector:</strong>{' '}
          {mdHits
            .map((h) => `${h.label} ${(h.confidence * 100).toFixed(0)}%`)
            .join(', ')}
          {mdExtra > 0 ? ` · ${mdExtra} ohne YOLO-Ueberlapp` : ''}
        </p>
      ) : null}

      {detection.snapshotUrl ? (
        <img
          className="snapshot-image"
          data-testid="snapshot-image"
          src={detection.snapshotUrl}
          alt="Snapshot beim Detection-Trigger"
        />
      ) : null}
    </div>
  )
}

function Stat(props: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  )
}

type AlertPillTone = 'hit' | 'idle' | 'neutral'
function AlertPill(props: { label: string; value: string; tone: AlertPillTone }) {
  return (
    <div className={`alert-pill alert-pill--${props.tone}`}>
      <span className="alert-pill__label">{props.label}</span>
      <strong className="alert-pill__value">{props.value}</strong>
    </div>
  )
}

type StageState = 'hit' | 'miss' | 'skipped' | 'disabled'
type StageChipProps = { name: string; state: StageState; isLast?: boolean }

function StageChip({ name, state, isLast }: StageChipProps) {
  const labelFor: Record<StageState, string> = {
    hit: 'Treffer',
    miss: 'Kein Treffer',
    skipped: 'nicht gelaufen',
    disabled: 'aus',
  }
  return (
    <>
      <div className={`stage-chip stage-chip--${state}`} title={`${name}: ${labelFor[state]}`}>
        <span className="stage-chip__name">{name}</span>
        <span className="stage-chip__state">{labelFor[state]}</span>
      </div>
      {!isLast ? <span className="stage-chip__arrow" aria-hidden="true">›</span> : null}
    </>
  )
}

function StatusBadge(props: { active: boolean; children: string }) {
  return (
    <span className={props.active ? 'status-pill active' : 'status-pill'}>{props.children}</span>
  )
}

function DiagnosticRow(props: { label: string; entry: DiagnosticEntry; testId?: string }) {
  return (
    <div className="diagnostic-row" data-testid={props.testId}>
      <div>
        <strong>{props.label}</strong>
        <p className="muted-copy">{props.entry.detail}</p>
      </div>
      <span className={`diagnostic-badge ${props.entry.status}`}>
        {formatDiagnosticStatus(props.entry.status)}
      </span>
    </div>
  )
}

function LlmUsagePanel(props: {
  usage?: LlmUsageSummary | null
  recommendation?: LlmRecommendation | null
}) {
  const usage = props.usage
  const recommendation = props.recommendation

  if (!usage) {
    return <p className="muted-copy">Noch keine LLM-Usage-Daten vorhanden.</p>
  }

  return (
    <div className="alert-card" data-testid="llm-usage-panel">
      <div className="stat-grid">
        <Stat label="LLM Provider" value={recommendation?.provider ?? 'n/a'} />
        <Stat label="LLM Modell" value={recommendation?.model ?? 'n/a'} />
        <Stat label="Requests" value={String(usage.requestCount)} />
        <Stat label="Prompt Tokens" value={String(usage.promptTokens)} />
        <Stat label="Completion Tokens" value={String(usage.completionTokens)} />
        <Stat label="Total Tokens" value={String(usage.totalTokens)} />
      </div>
      <div className="stat-grid">
        <Stat label="Motion via LLM" value={usage.usedForMotionDetection ? 'Ja' : 'Nein'} />
        <Stat label="Geschaetzte Kosten" value={`$${usage.estimatedCostUsd.toFixed(4)}`} />
      </div>
      <p className="muted-copy">{usage.note}</p>
    </div>
  )
}

function VisionRuntimePanel(props: {
  runtime?: VisionRuntimeSummary | null
  lastDetection?: DetectionResult | null
}) {
  const runtime = props.runtime
  const lastDetection = props.lastDetection

  if (!runtime) {
    return <p className="muted-copy">Noch keine Vision-Runtime-Daten vorhanden.</p>
  }

  const lastSam3Status = !runtime.sam3VerifierEnabled
    ? 'Deaktiviert'
    : !runtime.sam3VerifierAvailable
      ? 'Nicht aktiv'
      : lastDetection?.sam3VerifierRan
        ? lastDetection.sam3VerifierMatched
          ? 'Treffer'
          : 'Kein Treffer'
        : 'Bereit'

  return (
    <div className="alert-card" data-testid="vision-runtime-panel">
      <div className="stat-grid">
        <Stat label="Vision API" value={runtime.reachable ? 'Erreichbar' : 'Nicht erreichbar'} />
        <Stat label="Detektor" value={runtime.visionModel} />
        <Stat label="YOLOE" value={runtime.precisionVerifierEnabled ? runtime.precisionVerifierModel : 'Aus'} />
        <Stat label="SAM 3 Config" value={runtime.sam3VerifierEnabled ? runtime.sam3VerifierConfiguredModel : 'Aus'} />
        <Stat label="SAM 3 Datei" value={runtime.sam3VerifierModelPresent ? 'Vorhanden' : 'Fehlt'} />
        <Stat label="SAM 3 Runtime" value={runtime.sam3VerifierAvailable ? 'Aktiv moeglich' : 'Noch nicht aktiv'} />
      </div>
      <div className="stat-grid">
        <Stat label="Letzter SAM 3 Lauf" value={lastSam3Status} />
        <Stat label="Letzter SAM 3 Prompt" value={lastDetection?.sam3VerifierPrompt ?? 'n/a'} />
      </div>
      <p className="muted-copy">{runtime.note}</p>
    </div>
  )
}

function evaluateCameraBrowserSupport(): DiagnosticEntry {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      status: 'warning',
      detail: 'Browser-Kontext ist noch nicht verfuegbar.',
    }
  }

  if (!window.isSecureContext) {
    return {
      status: 'error',
      detail:
        'Auf Android blockiert der Browser die Kamera hier, weil die Seite nicht in einem sicheren Kontext laeuft. Oeffnet die Kamera-Seite per HTTPS statt ueber http://192.168.178.39:3000.',
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      status: 'error',
      detail: 'Dieser Browser stellt keine MediaDevices-Kamera-API bereit.',
    }
  }

  return {
    status: 'ok',
    detail: 'Sicherer Kontext vorhanden, Kamera-API ist verfuegbar.',
  }
}

async function probeTurnRelay(config: AppConfig | null): Promise<DiagnosticEntry> {
  const turnUrls = config?.iceServers.flatMap((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls]
    return urls.filter((url): url is string => typeof url === 'string' && url.startsWith('turn'))
  }) ?? []

  if (turnUrls.length === 0) {
    return {
      status: 'ok',
      detail: 'Kein TURN konfiguriert. Im Heimnetz genuegt STUN — TURN ist nur fuer Extern-Zugriff noetig.',
    }
  }

  return await new Promise<DiagnosticEntry>(async (resolve) => {
    const peer = new RTCPeerConnection({
      iceServers: config?.iceServers,
      iceCandidatePoolSize: 1,
    })
    const relayCandidates = new Set<string>()
    let settled = false

    const finish = (result: DiagnosticEntry) => {
      if (settled) {
        return
      }
      settled = true
      window.clearTimeout(timer)
      peer.close()
      resolve(result)
    }

    peer.onicecandidate = (event) => {
      const candidate = event.candidate?.candidate ?? ''
      if (candidate.includes(' typ relay ')) {
        relayCandidates.add(candidate)
      }
    }

    peer.onicegatheringstatechange = () => {
      if (peer.iceGatheringState !== 'complete') {
        return
      }

      if (relayCandidates.size > 0) {
        finish({
          status: 'ok',
          detail: 'TURN liefert Relay-Kandidaten. Fallback fuer schwierigere Netzpfade ist bereit.',
        })
        return
      }

      finish({
        status: 'warning',
        detail:
          'TURN ist konfiguriert, aber dieser Browser hat gerade keine Relay-Kandidaten erhalten.',
      })
    }

    const timer = window.setTimeout(() => {
      if (relayCandidates.size > 0) {
        finish({
          status: 'ok',
          detail: 'TURN liefert Relay-Kandidaten. Fallback fuer schwierigere Netzpfade ist bereit.',
        })
        return
      }

      finish({
        status: 'warning',
        detail:
          'TURN ist konfiguriert, aber der Relay-Test lief in ein Timeout. Im gleichen WLAN ist das oft unkritisch.',
      })
    }, 5000)

    try {
      peer.createDataChannel('turn-probe')
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
    } catch {
      finish({
        status: 'warning',
        detail: 'TURN-Test konnte im Browser nicht initialisiert werden.',
      })
    }
  })
}

function formatDiagnosticStatus(status: DiagnosticStatus) {
  switch (status) {
    case 'idle':
      return 'Offen'
    case 'running':
      return 'Prueft'
    case 'ok':
      return 'OK'
    case 'warning':
      return 'Hinweis'
    case 'error':
      return 'Fehler'
    default:
      return status
  }
}

function describeCameraAccessIssue(reason: unknown) {
  if (!(reason instanceof DOMException)) {
    return reason instanceof Error ? reason.message : 'Kamera konnte nicht gestartet werden.'
  }

  switch (reason.name) {
    case 'NotAllowedError':
      return 'Kamera-Zugriff verweigert. Bitte Browser-Kamerarechte freigeben und auf Android die Seite ueber HTTPS oeffnen.'
    case 'NotFoundError':
      return 'Keine passende Kamera gefunden.'
    case 'NotReadableError':
      return 'Die Kamera ist bereits durch eine andere App oder Browser-Instanz belegt.'
    case 'OverconstrainedError':
      return 'Die angeforderten Kamera-Einstellungen werden von diesem Geraet nicht unterstuetzt.'
    case 'SecurityError':
      return 'Der Browser blockiert den Kamera-Zugriff aus Sicherheitsgruenden. Im LAN ist dafuer in der Regel HTTPS erforderlich.'
    default:
      return reason.message || 'Kamera konnte nicht gestartet werden.'
  }
}

function describeNetworkTarget(value?: string) {
  if (!value) {
    return 'PUBLIC_WEB_URL setzen'
  }

  try {
    const url = new URL(value)
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return value
  }
}

function currentPageOrigin() {
  if (typeof window === 'undefined') {
    return apiBaseUrl
  }

  return window.location.origin
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString()
}

function toLocalRoute(absoluteUrl: string) {
  const url = new URL(absoluteUrl)
  return `${url.pathname}${url.search}`
}

export default App
