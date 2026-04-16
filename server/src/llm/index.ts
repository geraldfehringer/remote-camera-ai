import { readFile } from 'node:fs/promises'
import { stubNarrate } from './providers/stub.js'
import { geminiNarrate } from './providers/gemini.js'
import { claudeNarrate } from './providers/claude.js'
import { openaiNarrate } from './providers/openai.js'
import { togetherNarrate } from './providers/together.js'
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
    case 'gemini': {
      if (!config.apiKeys.google) throw new Error('GOOGLE_API_KEY missing')
      return geminiNarrate(args, config.apiKeys.google, config.model, config.timeoutMs)
    }
    case 'claude': {
      if (!config.apiKeys.anthropic) throw new Error('ANTHROPIC_API_KEY missing')
      return claudeNarrate(args, config.apiKeys.anthropic, config.model, config.timeoutMs)
    }
    case 'openai': {
      if (!config.apiKeys.openai) throw new Error('OPENAI_API_KEY missing')
      return openaiNarrate(args, config.apiKeys.openai, config.model, config.timeoutMs)
    }
    case 'together': {
      if (!config.apiKeys.together) throw new Error('TOGETHER_API_KEY missing')
      return togetherNarrate(args, config.apiKeys.together, config.model, config.timeoutMs)
    }
    default:
      throw new Error(`Provider ${config.provider} not implemented yet`)
  }
}

export { NarrationResponseSchema }
export type { NarrationResponse }
