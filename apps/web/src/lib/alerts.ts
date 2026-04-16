export type AlertEventDTO = {
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
  llm?: {
    provider: string
    model: string
    shortSummary: string
    threatLevel: 0 | 1 | 2
    suppressed: boolean
    ranAt: string
  }
  suppressed: boolean
}

export type SessionCountersDTO = {
  totalDetections: number
  totalTriggered: number
  totalAlerts: number
  alertsByTarget: Record<string, number>
  llmBudgetSkipped: number
  llmFailed: number
}
