export type DetectionResult = {
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

export type LlmUsageSummary = {
  enabled: boolean
  usedForMotionDetection: boolean
  requestCount: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  estimatedCostUsd: number
  note: string
}

export type LlmRecommendation = {
  provider: string
  model: string
  note: string
}

export type VisionRuntimeSummary = {
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

export type SessionLinks = {
  sessionId: string
  cameraUrl: string
  viewerUrl: string
  cameraToken: string
  viewerToken: string
}

export type SessionMetadata = {
  role: 'camera' | 'viewer'
  sessionId: string
  createdAt: string
  cameraConnected: boolean
  viewerConnected: boolean
  latestDetection: DetectionResult | null
  llmUsage: LlmUsageSummary
  cameraUrl: string
  viewerUrl: string
}

export type AppConfig = {
  publicWebUrl: string
  publicApiUrl: string
  iceServers: RTCIceServer[]
  defaults: {
    targetLabel: string
    minConfidence: number
    motionThreshold: number
  }
  llmRecommendation: LlmRecommendation
  visionRuntime: VisionRuntimeSummary
  llmUsage: LlmUsageSummary
  targetInputGuidance: {
    instructions: string[]
    examples: string[]
    supportedTargets: string[]
  }
}

export type SignalEnvelope =
  | {
      type: 'session-state'
      payload: {
        sessionId: string
        createdAt: string
        cameraConnected: boolean
        viewerConnected: boolean
        latestDetection: DetectionResult | null
        llmUsage: LlmUsageSummary
      }
    }
  | { type: 'peer-ready'; payload: Record<string, never> }
  | { type: 'offer'; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'answer'; payload: { sdp: RTCSessionDescriptionInit } }
  | { type: 'candidate'; payload: { candidate: RTCIceCandidateInit } }
  | { type: 'detection'; payload: DetectionResult }
  | { type: 'error'; payload: { message: string } }
