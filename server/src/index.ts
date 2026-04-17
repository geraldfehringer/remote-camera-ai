import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import sensible from '@fastify/sensible'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { z } from 'zod'
import { configureLlm, narrateAlert, type LlmNarrationInput } from './llm/index.js'

type Role = 'camera' | 'viewer'

type DetectionResult = {
  targetLabel: string
  motionScore: number
  motionDetected: boolean
  triggered: boolean
  objectDetectionRan: boolean
  objectDetectionReason: string
  visionModel: string
  detectionMode: string
  trackingMode: string
  trackConfirmationFrames: number
  confirmedMatchCount: number
  regionRefinementUsed: boolean
  precisionVerifierRan: boolean
  precisionVerifierMatched: boolean
  precisionVerifierModel?: string | null
  precisionVerifierPrompt?: string | null
  precisionVerifierMode?: string | null
  sam3VerifierAvailable?: boolean
  sam3VerifierRan?: boolean
  sam3VerifierMatched?: boolean
  sam3VerifierModel?: string | null
  sam3VerifierPrompt?: string | null
  sam3VerifierMode?: string | null
  matchedObjects: Array<{
    label: string
    confidence: number
    bbox: { x1: number; y1: number; x2: number; y2: number }
    trackId?: number | null
    trackStreak?: number | null
    confirmed?: boolean
  }>
  speciesCandidates?: Array<{
    scientificName: string
    commonName: string
    confidence: number
    taxonomyPath: string
  }>
  speciesMode?: 'unavailable' | 'disabled' | 'skipped' | 'error' | 'top3'
  speciesModel?: string | null
  snapshotUrl?: string
  createdAt: string
}

function withDetectionDefaults(
  result: Omit<
    DetectionResult,
    | 'objectDetectionRan'
    | 'objectDetectionReason'
    | 'visionModel'
    | 'detectionMode'
    | 'trackingMode'
    | 'trackConfirmationFrames'
    | 'confirmedMatchCount'
    | 'regionRefinementUsed'
    | 'precisionVerifierRan'
    | 'precisionVerifierMatched'
    | 'precisionVerifierModel'
    | 'precisionVerifierPrompt'
    | 'precisionVerifierMode'
    | 'sam3VerifierAvailable'
    | 'sam3VerifierRan'
    | 'sam3VerifierMatched'
    | 'sam3VerifierModel'
    | 'sam3VerifierPrompt'
    | 'sam3VerifierMode'
  > &
    Partial<
      Pick<
        DetectionResult,
        | 'objectDetectionRan'
        | 'objectDetectionReason'
        | 'visionModel'
        | 'detectionMode'
        | 'trackingMode'
        | 'trackConfirmationFrames'
        | 'confirmedMatchCount'
        | 'regionRefinementUsed'
        | 'precisionVerifierRan'
        | 'precisionVerifierMatched'
        | 'precisionVerifierModel'
        | 'precisionVerifierPrompt'
        | 'precisionVerifierMode'
        | 'sam3VerifierAvailable'
        | 'sam3VerifierRan'
        | 'sam3VerifierMatched'
        | 'sam3VerifierModel'
        | 'sam3VerifierPrompt'
        | 'sam3VerifierMode'
      >
    >
): DetectionResult {
  return {
    ...result,
    objectDetectionRan: result.objectDetectionRan ?? true,
    objectDetectionReason: result.objectDetectionReason ?? 'legacy-result',
    visionModel: result.visionModel ?? 'unknown',
    detectionMode: result.detectionMode ?? 'legacy-object-detection',
    trackingMode: result.trackingMode ?? 'legacy-no-tracking',
    trackConfirmationFrames: result.trackConfirmationFrames ?? 1,
    confirmedMatchCount:
      result.confirmedMatchCount ?? result.matchedObjects.filter((item) => item.confirmed ?? true).length,
    regionRefinementUsed: result.regionRefinementUsed ?? false,
    precisionVerifierRan: result.precisionVerifierRan ?? false,
    precisionVerifierMatched: result.precisionVerifierMatched ?? false,
    precisionVerifierModel: result.precisionVerifierModel ?? null,
    precisionVerifierPrompt: result.precisionVerifierPrompt ?? null,
    precisionVerifierMode: result.precisionVerifierMode ?? null,
    sam3VerifierAvailable: result.sam3VerifierAvailable ?? false,
    sam3VerifierRan: result.sam3VerifierRan ?? false,
    sam3VerifierMatched: result.sam3VerifierMatched ?? false,
    sam3VerifierModel: result.sam3VerifierModel ?? null,
    sam3VerifierPrompt: result.sam3VerifierPrompt ?? null,
    sam3VerifierMode: result.sam3VerifierMode ?? null,
    matchedObjects: result.matchedObjects.map((item) => ({
      ...item,
      trackId: item.trackId ?? null,
      trackStreak: item.trackStreak ?? null,
      confirmed: item.confirmed ?? true
    }))
  }
}

type LlmUsageSummary = {
  enabled: boolean
  usedForMotionDetection: boolean
  requestCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCostUsd: number
  note: string
  inputTokens: number
  outputTokens: number
  imageTokens: number
}

type VisionRuntimeSummary = {
  reachable: boolean
  visionModel: string
  precisionVerifierEnabled: boolean
  precisionVerifierModel: string
  sam3VerifierEnabled: boolean
  sam3VerifierConfiguredModel: string
  sam3VerifierModelPresent: boolean
  sam3VerifierAvailable: boolean
  note: string
}

const targetInputGuidance = {
  instructions: [
    'Beschreibe genau ein sichtbares Objekt, nicht eine ganze Szene.',
    'Deutsch und Englisch werden akzeptiert, zum Beispiel "Taube auf dem Gelaender", "pigeon on railing", "Person mit gelber Jacke" oder "white car".',
    'Nutze ein konkretes Nomen oder eine kurze Objektphrase statt einer vagen Situationsbeschreibung.',
    'Vermeide unscharfe Formulierungen wie "something suspicious", "irgendwas dort" oder "maybe a bird".',
    'Wenn nur Bewegung relevant ist, nutze "motion-only".'
  ],
  examples: [
    'pigeon on railing',
    'Taube auf dem Gelaender',
    'person in yellow jacket',
    'Person mit gelber Jacke',
    'white car',
    'weisses Auto',
    'delivery truck',
    'schwarzer Hund',
    'black dog',
    'motion-only'
  ],
  supportedTargets: [
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
    'motion-only'
  ]
} as const

function createZeroLlmUsageSummary(): LlmUsageSummary {
  return {
    enabled: false,
    usedForMotionDetection: false,
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    note:
      'Motion Detection laeuft aktuell vollstaendig lokal im Vision-Service. Dafuer werden keine LLM-Tokens verbraucht.',
    inputTokens: 0,
    outputTokens: 0,
    imageTokens: 0
  }
}

function createFallbackVisionRuntimeSummary(): VisionRuntimeSummary {
  return {
    reachable: false,
    visionModel: env.VISION_TARGET_LABEL ? 'unknown' : 'unknown',
    precisionVerifierEnabled: true,
    precisionVerifierModel: 'unknown',
    sam3VerifierEnabled: true,
    sam3VerifierConfiguredModel: path.basename('/app/extra-models/sam3.pt'),
    sam3VerifierModelPresent: false,
    sam3VerifierAvailable: false,
    note:
      'Vision-Runtime konnte nicht direkt abgefragt werden. Detection kann dennoch laufen; pruefe den Vision-Service oder das Docker-Netzwerk.'
  }
}

async function readVisionRuntimeSummary(): Promise<VisionRuntimeSummary> {
  try {
    const response = await fetch(`${env.VISION_SERVICE_URL}/runtime`, {
      signal: AbortSignal.timeout(2_500)
    })
    if (!response.ok) {
      throw new Error(`runtime HTTP ${response.status}`)
    }

    const runtime = (await response.json()) as Omit<VisionRuntimeSummary, 'reachable' | 'note'>
    return {
      reachable: true,
      ...runtime,
      note: runtime.sam3VerifierAvailable
        ? 'SAM 3 ist lokal verfuegbar und kann nach YOLOE fuer die feinere Trigger-Bestaetigung genutzt werden.'
        : runtime.sam3VerifierEnabled
          ? 'SAM 3 ist vorbereitet, aber noch nicht aktiv. Lege dafuer lokal vision/models/sam3.pt ab.'
          : 'SAM 3 ist in dieser Runtime deaktiviert.'
    }
  } catch {
    return createFallbackVisionRuntimeSummary()
  }
}

const MAX_EVENTS_PER_SESSION = 200
const SESSION_TTL_HOURS_DEFAULT = 72
const SWEEP_INTERVAL_MS = 10 * 60 * 1000
const VISION_ALERT_COOLDOWN_MS = Number(process.env.VISION_ALERT_COOLDOWN_MS ?? 15_000)
const VISION_ALERT_NOTRACK_COOLDOWN_MS = Number(process.env.VISION_ALERT_NOTRACK_COOLDOWN_MS ?? 60_000)

type AlertEventLlm = {
  provider: string
  model: string
  shortSummary: string
  threatLevel: 0 | 1 | 2
  suppressed: boolean
  ranAt: string
}

type AlertEvent = {
  id: string
  createdAt: string
  triggeredAt: string
  target: string
  species?: string
  speciesCommonName?: string
  speciesConfidence?: number
  confidence: number
  trackId?: string
  snapshotUrl: string
  motionScore: number
  llm?: AlertEventLlm
  suppressed: boolean
}

type SessionCounters = {
  totalDetections: number
  totalTriggered: number
  totalAlerts: number
  alertsByTarget: Record<string, number>
  llmBudgetSkipped: number
  llmFailed: number
}

function createEmptyCounters(): SessionCounters {
  return {
    totalDetections: 0,
    totalTriggered: 0,
    totalAlerts: 0,
    alertsByTarget: {},
    llmBudgetSkipped: 0,
    llmFailed: 0,
  }
}

function shouldMintAlert(
  session: Session,
  detection: { triggered: boolean; target: string; trackId?: string }
): boolean {
  if (!detection.triggered) return false
  if (detection.target === 'motion-only') return true

  const now = Date.now()
  const events = session.events

  if (detection.trackId) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.trackId === detection.trackId) {
        if (now - new Date(ev.createdAt).getTime() < VISION_ALERT_COOLDOWN_MS) {
          return false
        }
        break
      }
    }
  } else {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.target === detection.target && !ev.trackId) {
        if (now - new Date(ev.createdAt).getTime() < VISION_ALERT_NOTRACK_COOLDOWN_MS) {
          return false
        }
        break
      }
    }
  }

  return true
}

function appendEvent(session: Session, event: AlertEvent): void {
  session.events.push(event)
  if (session.events.length > MAX_EVENTS_PER_SESSION) {
    session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION)
  }
}

type Session = {
  id: string
  createdAt: string
  cameraToken: string
  viewerToken: string
  sockets: Partial<Record<Role, WebSocket>>
  latestDetection?: DetectionResult
  llmUsage: LlmUsageSummary
  events: AlertEvent[]
  counters: SessionCounters
  llmCallTimestamps: number[]
  llmCallsTotal: number
}

type StoredSession = Omit<Session, 'sockets'>

type SignalMessage =
  | { type: 'session-state'; payload: Record<string, unknown> }
  | { type: 'peer-ready'; payload: Record<string, never> }
  | { type: 'description'; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'candidate'; payload: { candidate: RTCIceCandidateInit } }
  | { type: 'detection'; payload: DetectionResult }
  | { type: 'error'; payload: { message: string } }

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().default(8080),
  PUBLIC_WEB_URL: z.string().url(),
  PUBLIC_API_URL: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  ICE_STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  ICE_TURN_URLS: z.string().default(''),
  TURN_USERNAME: z.string().default('remotecam'),
  TURN_PASSWORD: z.string().default('change-me-now'),
  VISION_SERVICE_URL: z.string().url().default('http://vision:8090'),
  VISION_TARGET_LABEL: z.string().default('bird'),
  VISION_MIN_CONFIDENCE: z.coerce.number().default(0.4),
  VISION_MOTION_THRESHOLD: z.coerce.number().default(0.075),
  LLM_PROVIDER: z.enum(['gemini', 'claude', 'openai', 'together', 'stub']).default('gemini'),
  LLM_MODEL: z.string().default('gemini-3.1-flash-lite-preview'),
  LLM_MAX_CALLS_PER_HOUR: z.coerce.number().default(60),
  LLM_MAX_CALLS_TOTAL_PER_SESSION: z.coerce.number().default(400),
  LLM_TIMEOUT_MS: z.coerce.number().default(8_000),
  GOOGLE_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  TOGETHER_API_KEY: z.string().default(''),
  SESSION_TTL_HOURS: z.coerce.number().default(SESSION_TTL_HOURS_DEFAULT),
})

const env = envSchema.parse(process.env)
const snapshotsRoot = path.resolve('/app/data/snapshots')
const sessionsFile = path.resolve('/app/data/sessions.json')
const sessions = new Map<string, Session>()

configureLlm({
  provider: env.LLM_PROVIDER,
  model: env.LLM_MODEL,
  timeoutMs: env.LLM_TIMEOUT_MS,
  apiKeys: {
    google: env.GOOGLE_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
    openai: env.OPENAI_API_KEY || undefined,
    together: env.TOGETHER_API_KEY || undefined,
  },
})

const app = Fastify({
  logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' },
  bodyLimit: 6 * 1024 * 1024
})

{
  const providerKeyMap: Record<string, string | undefined> = {
    gemini: env.GOOGLE_API_KEY,
    claude: env.ANTHROPIC_API_KEY,
    openai: env.OPENAI_API_KEY,
    together: env.TOGETHER_API_KEY
  }
  const needed = providerKeyMap[env.LLM_PROVIDER]
  if (env.LLM_PROVIDER !== 'stub' && (!needed || needed.length === 0)) {
    app.log.warn(
      { provider: env.LLM_PROVIDER },
      'LLM provider configured but API key missing — every alert will fail narration (counters.llmFailed++). Set LLM_PROVIDER=stub for tests.'
    )
  }
}

await mkdir(snapshotsRoot, { recursive: true })
await mkdir(path.dirname(sessionsFile), { recursive: true })

await app.register(sensible)
await app.register(rateLimit, {
  max: 150,
  timeWindow: '1 minute'
})
await app.register(cors, {
  origin: [env.WEB_ORIGIN, env.PUBLIC_WEB_URL],
  methods: ['GET', 'POST']
})
await app.register(helmet, {
  global: true
})
await app.register(multipart, {
  limits: {
    fileSize: 5 * 1024 * 1024,
    files: 1
  }
})
await app.register(websocket)
await loadSessions()

function randomToken() {
  return randomBytes(24).toString('hex')
}

function safeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) {
    return false
  }
  return timingSafeEqual(leftBuffer, rightBuffer)
}

function sessionState(session: Session) {
  return {
    sessionId: session.id,
    createdAt: session.createdAt,
    cameraConnected: Boolean(session.sockets.camera),
    viewerConnected: Boolean(session.sockets.viewer),
    latestDetection: session.latestDetection ?? null,
    llmUsage: session.llmUsage,
    counters: session.counters,
    events: session.events.slice(-50)
  }
}

function send(socket: WebSocket, message: SignalMessage) {
  try {
    socket.send(JSON.stringify(message))
  } catch (err) {
    app.log.warn({ err }, 'ws send failed')
    try {
      socket.close(1011, 'send failed')
    } catch {
      // already closed
    }
  }
}

async function persistSessions() {
  const nextFile = `${sessionsFile}.tmp`
  const serialized = JSON.stringify(
    Array.from(sessions.values()).map<StoredSession>((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      cameraToken: session.cameraToken,
      viewerToken: session.viewerToken,
      latestDetection: session.latestDetection,
      llmUsage: session.llmUsage,
      events: session.events,
      counters: session.counters,
      llmCallTimestamps: session.llmCallTimestamps,
      llmCallsTotal: session.llmCallsTotal
    })),
    null,
    2
  )

  await writeFile(nextFile, serialized)
  await rename(nextFile, sessionsFile)
}

async function loadSessions() {
  try {
    const content = await readFile(sessionsFile, 'utf8')
    const parsed = z
      .array(
        z.object({
          id: z.string().uuid(),
          createdAt: z.string(),
          cameraToken: z.string(),
          viewerToken: z.string(),
          llmUsage: z
            .object({
              enabled: z.boolean(),
              usedForMotionDetection: z.boolean(),
              requestCount: z.number(),
              promptTokens: z.number(),
              completionTokens: z.number(),
              totalTokens: z.number(),
              estimatedCostUsd: z.number(),
              note: z.string(),
              inputTokens: z.number().optional(),
              outputTokens: z.number().optional(),
              imageTokens: z.number().optional()
            })
            .optional(),
          events: z.array(z.any()).optional(),
          counters: z.any().optional(),
          llmCallTimestamps: z.array(z.number()).optional(),
          llmCallsTotal: z.number().optional(),
          latestDetection: z
            .object({
              targetLabel: z.string(),
              motionScore: z.number(),
              motionDetected: z.boolean(),
              triggered: z.boolean(),
              objectDetectionRan: z.boolean().optional(),
              objectDetectionReason: z.string().optional(),
              visionModel: z.string().optional(),
              detectionMode: z.string().optional(),
              trackingMode: z.string().optional(),
              trackConfirmationFrames: z.number().optional(),
              confirmedMatchCount: z.number().optional(),
              regionRefinementUsed: z.boolean().optional(),
              precisionVerifierRan: z.boolean().optional(),
              precisionVerifierMatched: z.boolean().optional(),
              precisionVerifierModel: z.string().nullable().optional(),
              precisionVerifierPrompt: z.string().nullable().optional(),
              precisionVerifierMode: z.string().nullable().optional(),
              sam3VerifierAvailable: z.boolean().optional(),
              sam3VerifierRan: z.boolean().optional(),
              sam3VerifierMatched: z.boolean().optional(),
              sam3VerifierModel: z.string().nullable().optional(),
              sam3VerifierPrompt: z.string().nullable().optional(),
              sam3VerifierMode: z.string().nullable().optional(),
              matchedObjects: z.array(
                z.object({
                  label: z.string(),
                  confidence: z.number(),
                  trackId: z.number().nullable().optional(),
                  trackStreak: z.number().nullable().optional(),
                  confirmed: z.boolean().optional(),
                  bbox: z.object({
                    x1: z.number(),
                    y1: z.number(),
                    x2: z.number(),
                    y2: z.number()
                  })
                })
              ),
              speciesCandidates: z
                .array(
                  z.object({
                    scientificName: z.string(),
                    commonName: z.string(),
                    confidence: z.number(),
                    taxonomyPath: z.string()
                  })
                )
                .optional(),
              speciesMode: z
                .enum(['unavailable', 'disabled', 'skipped', 'error', 'top3'])
                .optional(),
              speciesModel: z.string().nullable().optional(),
              snapshotUrl: z.string().optional(),
              createdAt: z.string()
            })
            .optional()
        })
      )
      .parse(JSON.parse(content))

    for (const raw of parsed) {
      const latestDetection = raw.latestDetection
        ? withDetectionDefaults(raw.latestDetection)
        : undefined
      sessions.set(raw.id, {
        id: raw.id,
        createdAt: raw.createdAt,
        cameraToken: raw.cameraToken,
        viewerToken: raw.viewerToken,
        llmUsage: raw.llmUsage
          ? {
              ...raw.llmUsage,
              inputTokens: raw.llmUsage.inputTokens ?? 0,
              outputTokens: raw.llmUsage.outputTokens ?? 0,
              imageTokens: raw.llmUsage.imageTokens ?? 0
            }
          : createZeroLlmUsageSummary(),
        latestDetection,
        events: Array.isArray(raw.events) ? (raw.events as AlertEvent[]) : [],
        counters: (raw.counters as SessionCounters | undefined) ?? createEmptyCounters(),
        llmCallTimestamps: Array.isArray(raw.llmCallTimestamps) ? raw.llmCallTimestamps : [],
        llmCallsTotal: typeof raw.llmCallsTotal === 'number' ? raw.llmCallsTotal : 0,
        sockets: {}
      })
    }
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException
    if (nodeError?.code !== 'ENOENT') {
      app.log.error({ err: error }, 'Failed to load persisted sessions')
    }
  }
}

async function expireSession(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId)
  if (!session) return

  for (const socket of Object.values(session.sockets)) {
    try {
      ;(socket as WebSocket).close(1012, 'session expired')
    } catch {
      /* ignore */
    }
  }
  sessions.delete(sessionId)

  const snapshotDir = path.join(snapshotsRoot, sessionId)
  try {
    await rm(snapshotDir, { recursive: true, force: true })
  } catch (err) {
    app.log.warn({ err, sessionId }, 'failed to remove snapshot dir during expire')
  }

  try {
    const res = await fetch(`${env.VISION_SERVICE_URL}/sessions/${sessionId}`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(3_000),
    })
    if (!res.ok) {
      app.log.warn({ status: res.status, sessionId }, 'vision DELETE returned non-2xx')
    }
  } catch (err) {
    app.log.warn({ err, sessionId }, 'vision DELETE call failed')
  }

  await persistSessions()
}

function broadcastState(session: Session) {
  const payload: SignalMessage = {
    type: 'session-state',
    payload: sessionState(session)
  }

  if (session.sockets.camera) {
    send(session.sockets.camera, payload)
  }
  if (session.sockets.viewer) {
    send(session.sockets.viewer, payload)
  }

  if (session.sockets.camera && session.sockets.viewer) {
    const readyPayload: SignalMessage = { type: 'peer-ready', payload: {} }
    send(session.sockets.camera, readyPayload)
    send(session.sockets.viewer, readyPayload)
  }
}

function broadcastError(session: Session, message: string) {
  const payload: SignalMessage = { type: 'error', payload: { message } }
  if (session.sockets.camera) {
    send(session.sockets.camera, payload)
  }
  if (session.sockets.viewer) {
    send(session.sockets.viewer, payload)
  }
}

function snapshotFileName(snapshotUrl: string): string {
  const withoutQuery = snapshotUrl.split('?', 1)[0] ?? snapshotUrl
  return path.basename(withoutQuery)
}

function broadcastAlert(session: Session, event: AlertEvent): void {
  for (const socket of Object.values(session.sockets)) {
    if (!socket) continue
    if ((socket as WebSocket).readyState !== WebSocket.OPEN) continue
    try {
      ;(socket as WebSocket).send(JSON.stringify({ type: 'alert', payload: event }))
    } catch (err) {
      app.log.warn({ err, sessionId: session.id }, 'alert broadcast send failed')
    }
  }
}

function localeFromTarget(rawTarget: string, normalized: string): 'de' | 'en' {
  return rawTarget.toLowerCase() !== normalized.toLowerCase() ? 'de' : 'en'
}

async function maybeNarrate(session: Session, event: AlertEvent, rawTarget: string): Promise<void> {
  const now = Date.now()
  session.llmCallTimestamps = session.llmCallTimestamps.filter((t) => now - t < 3_600_000)
  if (
    session.llmCallTimestamps.length >= env.LLM_MAX_CALLS_PER_HOUR ||
    session.llmCallsTotal >= env.LLM_MAX_CALLS_TOTAL_PER_SESSION
  ) {
    session.counters.llmBudgetSkipped += 1
    await persistSessions()
    return
  }
  session.llmCallTimestamps.push(now)
  session.llmCallsTotal += 1

  const snapshotPath = path.join(snapshotsRoot, session.id, snapshotFileName(event.snapshotUrl))
  const input: LlmNarrationInput = {
    event: {
      id: event.id,
      target: event.target,
      species: event.species,
      speciesCommonName: event.speciesCommonName,
      confidence: event.confidence,
      motionScore: event.motionScore,
      trackId: event.trackId,
    },
    snapshotPath,
    locale: localeFromTarget(rawTarget, event.target),
  }

  try {
    const result = await narrateAlert(input)
    event.llm = {
      provider: result.provider,
      model: result.model,
      shortSummary: result.response.shortSummary,
      threatLevel: result.response.threatLevel,
      suppressed: result.response.suppressAsFalsePositive,
      ranAt: new Date().toISOString(),
    }
    event.suppressed = result.response.suppressAsFalsePositive
    session.llmUsage.inputTokens += result.usage.inputTokens ?? 0
    session.llmUsage.outputTokens += result.usage.outputTokens ?? 0
    session.llmUsage.imageTokens += result.usage.imageTokens ?? 0
    if (event.suppressed) {
      session.counters.totalAlerts = Math.max(0, session.counters.totalAlerts - 1)
    }
  } catch (err) {
    session.counters.llmFailed += 1
    app.log.warn({ err, sessionId: session.id, eventId: event.id }, 'LLM narration failed')
  }

  broadcastAlert(session, event)
  await persistSessions()
}

function parseCsv(value: string) {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function replaceLocalIceHost(url: string, requestHost?: string) {
  if (!requestHost) {
    return url
  }

  return url.replace(/^(turns?:)(localhost|127\.0\.0\.1)(?=[:?]|$)/, `$1${requestHost}`)
}

function buildIceServers(request?: FastifyRequest) {
  const iceServers: RTCIceServer[] = []
  const requestHost = request
    ? new URL(requestOrigin(request, env.PUBLIC_WEB_URL)).hostname
    : undefined

  const stunUrls = parseCsv(env.ICE_STUN_URLS)
  if (stunUrls.length > 0) {
    iceServers.push({ urls: stunUrls })
  }

  const turnUrls = parseCsv(env.ICE_TURN_URLS).map((url) =>
    replaceLocalIceHost(url, requestHost)
  )
  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: env.TURN_USERNAME,
      credential: env.TURN_PASSWORD
    })
  }

  return iceServers
}

function requestOrigin(request: FastifyRequest, fallback: string) {
  const forwardedProto = request.headers['x-forwarded-proto']
  const forwardedHost = request.headers['x-forwarded-host']
  const proto =
    typeof forwardedProto === 'string' && forwardedProto
      ? forwardedProto
      : new URL(fallback).protocol.replace(':', '')
  const host =
    typeof forwardedHost === 'string' && forwardedHost
      ? forwardedHost
      : typeof request.headers.host === 'string' && request.headers.host
        ? request.headers.host
        : null

  if (!host) {
    return fallback
  }

  return `${proto}://${host}`
}

function buildSessionLinks(session: Session, publicWebUrl: string) {
  return {
    cameraUrl: `${publicWebUrl}/camera/${session.id}?token=${session.cameraToken}`,
    viewerUrl: `${publicWebUrl}/view/${session.id}?token=${session.viewerToken}`
  }
}

function getSessionOrThrow(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw app.httpErrors.notFound('Session not found')
  }
  return session
}

function assertToken(session: Session, role: Role, token?: string | null) {
  const expected = role === 'camera' ? session.cameraToken : session.viewerToken
  if (!token || !safeEquals(expected, token)) {
    throw app.httpErrors.unauthorized('Invalid session token')
  }
}

function inferMimeType(fileName: string) {
  const ext = path.extname(fileName).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.webp') return 'image/webp'
  return 'image/jpeg'
}

function multipartValue(fields: Record<string, unknown>, key: string, fallback: string) {
  const candidate = (fields as Record<string, unknown>)[key]
  const entry = Array.isArray(candidate) ? candidate[0] : candidate

  if (
    entry &&
    typeof entry === 'object' &&
    'value' in entry &&
    typeof entry.value !== 'undefined'
  ) {
    return String(entry.value)
  }

  return fallback
}

app.get('/api/health', async () => ({ ok: true }))

app.get('/api/config', async (request) => {
  const publicWebUrl = requestOrigin(request, env.PUBLIC_WEB_URL)
  const visionRuntime = await readVisionRuntimeSummary()

  return {
    publicWebUrl,
    publicApiUrl: requestOrigin(request, env.PUBLIC_API_URL),
    iceServers: buildIceServers(request),
    defaults: {
      targetLabel: env.VISION_TARGET_LABEL,
      minConfidence: env.VISION_MIN_CONFIDENCE,
      motionThreshold: env.VISION_MOTION_THRESHOLD
    },
    llmRecommendation: {
      provider: env.LLM_PROVIDER,
      model: env.LLM_MODEL,
      note:
        'Fuer Realtime-Erkennung lokal bleiben; LLM nur fuer eventbasierte Bildbeschreibung oder Zusammenfassung nutzen.'
    },
    visionRuntime,
    targetInputGuidance,
    llmUsage: createZeroLlmUsageSummary()
  }
})

app.post('/api/sessions', async (request) => {
  const session: Session = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    cameraToken: randomToken(),
    viewerToken: randomToken(),
    sockets: {},
    llmUsage: createZeroLlmUsageSummary(),
    events: [],
    counters: createEmptyCounters(),
    llmCallTimestamps: [],
    llmCallsTotal: 0
  }

  sessions.set(session.id, session)
  await persistSessions()
  const publicWebUrl = requestOrigin(request, env.PUBLIC_WEB_URL)

  return {
    sessionId: session.id,
    ...buildSessionLinks(session, publicWebUrl),
    cameraToken: session.cameraToken,
    viewerToken: session.viewerToken
  }
})

app.get('/api/sessions/:sessionId', async (request) => {
  const params = z.object({ sessionId: z.string().uuid() }).parse(request.params)
  const query = z.object({ token: z.string() }).parse(request.query)
  const session = getSessionOrThrow(params.sessionId)

  const token = query.token
  const role: Role =
    safeEquals(session.cameraToken, token) ? 'camera' : 'viewer'

  assertToken(session, role, token)

  return {
    role,
    ...sessionState(session),
    ...buildSessionLinks(session, requestOrigin(request, env.PUBLIC_WEB_URL))
  }
})

app.get('/api/sessions/:sessionId/snapshots/:fileName', async (request, reply) => {
  const params = z
    .object({
      sessionId: z.string().uuid(),
      fileName: z.string().min(1)
    })
    .parse(request.params)
  const query = z.object({ token: z.string() }).parse(request.query)
  const session = getSessionOrThrow(params.sessionId)

  if (
    !safeEquals(session.viewerToken, query.token) &&
    !safeEquals(session.cameraToken, query.token)
  ) {
    throw app.httpErrors.unauthorized('Invalid snapshot token')
  }

  const filePath = path.join(snapshotsRoot, params.sessionId, params.fileName)
  const buffer = await readFile(filePath)
  reply.type(inferMimeType(params.fileName))
  return reply.send(buffer)
})

app.post('/api/sessions/:sessionId/detect', async (request) => {
  const params = z.object({ sessionId: z.string().uuid() }).parse(request.params)
  const session = getSessionOrThrow(params.sessionId)
  const sessionToken = request.headers['x-session-token']

  assertToken(
    session,
    'camera',
    Array.isArray(sessionToken) ? sessionToken[0] : sessionToken
  )

  const file = await request.file()
  if (!file) {
    throw app.httpErrors.badRequest('Missing snapshot file')
  }

  const buffer = await file.toBuffer()
  const fileName = file.filename || `snapshot-${Date.now()}.jpg`
  const rawTarget = multipartValue(file.fields, 'target_label', env.VISION_TARGET_LABEL)
  const formData = new FormData()
  formData.set('session_id', params.sessionId)
  formData.set('target_label', rawTarget)
  formData.set(
    'min_confidence',
    multipartValue(file.fields, 'min_confidence', String(env.VISION_MIN_CONFIDENCE))
  )
  formData.set(
    'motion_threshold',
    multipartValue(file.fields, 'motion_threshold', String(env.VISION_MOTION_THRESHOLD))
  )
  formData.set('file', new Blob([new Uint8Array(buffer)], { type: file.mimetype }), fileName)

  let analysisResponse: Response
  try {
    analysisResponse = await fetch(`${env.VISION_SERVICE_URL}/analyze`, {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(30_000)
    })
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    const message = isAbort ? 'Vision service timed out' : 'Vision service unreachable'
    app.log.warn({ err }, 'vision /analyze request failed')
    broadcastError(session, message)
    throw isAbort
      ? app.httpErrors.gatewayTimeout(message)
      : app.httpErrors.badGateway(message)
  }

  if (!analysisResponse.ok) {
    const detail = await analysisResponse.text()
    broadcastError(session, 'Vision service failed')
    throw app.httpErrors.badGateway(`Vision service failed: ${detail}`)
  }

  const analysis = withDetectionDefaults(
    (await analysisResponse.json()) as Omit<DetectionResult, 'snapshotUrl'>
  )
  let snapshotUrl: string | undefined

  if (analysis.triggered) {
    const sessionDir = path.join(snapshotsRoot, params.sessionId)
    await mkdir(sessionDir, { recursive: true })

    const snapshotName = `${Date.now()}-${randomUUID()}.jpg`
    await writeFile(path.join(sessionDir, snapshotName), buffer)
    snapshotUrl = `/api/sessions/${params.sessionId}/snapshots/${snapshotName}?token=${session.viewerToken}`
  }

  const result: DetectionResult = {
    ...analysis,
    snapshotUrl
  }

  session.latestDetection = result

  session.counters.totalDetections += 1
  if (analysis.triggered) session.counters.totalTriggered += 1

  const topMatch = analysis.matchedObjects?.[0]
  const trackIdStr =
    topMatch && typeof topMatch.trackId === 'number' ? String(topMatch.trackId) : undefined
  const normalizedTarget = analysis.targetLabel ?? rawTarget

  const mintDecision = shouldMintAlert(session, {
    triggered: !!analysis.triggered,
    target: normalizedTarget,
    trackId: trackIdStr,
  })

  if (mintDecision) {
    const topSpecies = analysis.speciesCandidates?.[0]
    const event: AlertEvent = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      triggeredAt: analysis.createdAt ?? new Date().toISOString(),
      target: normalizedTarget,
      species: topSpecies?.scientificName,
      speciesCommonName: topSpecies?.commonName,
      speciesConfidence: topSpecies?.confidence,
      confidence: topMatch?.confidence ?? 0,
      trackId: trackIdStr,
      snapshotUrl: snapshotUrl ?? '',
      motionScore: analysis.motionScore ?? 0,
      suppressed: false,
    }
    appendEvent(session, event)
    session.counters.totalAlerts += 1
    session.counters.alertsByTarget[event.target] =
      (session.counters.alertsByTarget[event.target] ?? 0) + 1

    broadcastAlert(session, event)
    await persistSessions()
    void maybeNarrate(session, event, rawTarget)
  } else {
    await persistSessions()
  }

  broadcastState(session)

  if (session.sockets.camera) {
    send(session.sockets.camera, { type: 'detection', payload: result })
  }
  if (session.sockets.viewer) {
    send(session.sockets.viewer, { type: 'detection', payload: result })
  }

  return result
})

app.get('/ws', { websocket: true }, (socket, request) => {
  const query = z
    .object({
      sessionId: z.string().uuid(),
      role: z.enum(['camera', 'viewer']),
      token: z.string()
    })
    .parse(request.query)

  const session = getSessionOrThrow(query.sessionId)
  assertToken(session, query.role, query.token)

  const previousSocket = session.sockets[query.role]
  if (previousSocket && previousSocket !== socket) {
    try {
      previousSocket.close(4409, 'replaced by newer connection')
    } catch {
      // already closed
    }
  }

  session.sockets[query.role] = socket
  broadcastState(session)

  socket.on('message', (rawMessage) => {
    try {
      const parsed = JSON.parse(rawMessage.toString()) as SignalMessage
      const targetRole: Role = query.role === 'camera' ? 'viewer' : 'camera'
      const targetSocket = session.sockets[targetRole]

      if (!targetSocket) {
        return
      }

      if (parsed.type === 'description' || parsed.type === 'candidate') {
        send(targetSocket, parsed)
      }
    } catch {
      send(socket, {
        type: 'error',
        payload: { message: 'Invalid signaling payload' }
      })
    }
  })

  socket.on('close', () => {
    if (session.sockets[query.role] === socket) {
      delete session.sockets[query.role]
      broadcastState(session)
    }
  })
})

const sessionTtlMs = env.SESSION_TTL_HOURS * 3_600_000
const sweepInterval = setInterval(async () => {
  const now = Date.now()
  const expired: string[] = []
  for (const [id, session] of sessions) {
    if (now - new Date(session.createdAt).getTime() > sessionTtlMs) expired.push(id)
  }
  for (const id of expired) {
    app.log.info({ sessionId: id }, 'expiring session (TTL)')
    await expireSession(id)
  }
}, SWEEP_INTERVAL_MS)

process.on('SIGTERM', () => clearInterval(sweepInterval))
process.on('SIGINT', () => clearInterval(sweepInterval))

await app.listen({ host: env.HOST, port: env.PORT })
