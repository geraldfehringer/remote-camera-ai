import type { NarrationResponse } from '../prompts.js'
import type { ProviderNarrateArgs, ProviderResult } from '../index.js'

export async function stubNarrate(args: ProviderNarrateArgs): Promise<ProviderResult> {
  const target = args.event.target
  const response: NarrationResponse = {
    shortSummary: `[stub: ${target} triggered]`,
    threatLevel: 0,
    suppressAsFalsePositive: false,
  }
  return {
    response,
    usage: { inputTokens: 0, outputTokens: 0, imageTokens: 0 },
    provider: 'stub',
    model: 'stub',
  }
}
