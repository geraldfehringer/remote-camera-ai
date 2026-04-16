import { readFile } from 'node:fs/promises'
import { stubNarrate } from './providers/stub.js'
import { NarrationResponseSchema, systemPrompt, userPrompt, type NarrationResponse } from './prompts.js'

export type LlmProvider = 'gemini' | 'claude' | 'openai' | 'together' | 'stub'

export type LlmNarrationInput = {
  event: {
    id: string
    target: string
    species?: string
    speciesCommonName?: string
    confidence: number
    motionScore: number
    trackId?: string
  }
  snapshotPath: string
  locale: 'de' | 'en'
}

export type ProviderNarrateArgs = LlmNarrationInput & {
  imageBytes: Buffer
  prompts: { system: string; user: string }
}

export type ProviderResult = {
  response: NarrationResponse
  usage: { inputTokens?: number; outputTokens?: number; imageTokens?: number }
  provider: string
  model: string
}

export type LlmNarrationOutput = ProviderResult

export type LlmConfig = {
  provider: LlmProvider
  model: string
  timeoutMs: number
  apiKeys: {
    google?: string
    anthropic?: string
    openai?: string
    together?: string
  }
}

let config: LlmConfig | null = null

export function configureLlm(next: LlmConfig): void {
  config = next
}

export async function narrateAlert(input: LlmNarrationInput): Promise<LlmNarrationOutput> {
  if (!config) throw new Error('LLM not configured')

  const imageBytes = await readFile(input.snapshotPath)
  const prompts = {
    system: systemPrompt(input.locale),
    user: userPrompt({
      target: input.event.target,
      species: input.event.species,
      speciesCommonName: input.event.speciesCommonName,
      confidence: input.event.confidence,
      motionScore: input.event.motionScore,
      locale: input.locale,
      localTime: new Date().toLocaleString(input.locale === 'de' ? 'de-DE' : 'en-US'),
    }),
  }
  const args: ProviderNarrateArgs = { ...input, imageBytes, prompts }

  switch (config.provider) {
    case 'stub':
      return stubNarrate(args)
    default:
      throw new Error(`Provider ${config.provider} not implemented yet`)
  }
}

export { NarrationResponseSchema }
export type { NarrationResponse }
