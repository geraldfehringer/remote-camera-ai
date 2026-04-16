import Anthropic from '@anthropic-ai/sdk'
import type { ProviderNarrateArgs, ProviderResult } from '../index.js'
import { NarrationResponseSchema } from '../prompts.js'

export async function claudeNarrate(
  args: ProviderNarrateArgs,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProviderResult> {
  const client = new Anthropic({ apiKey, timeout: timeoutMs })
  const msg = await client.messages.create({
    model,
    max_tokens: 400,
    system: args.prompts.system,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: args.imageBytes.toString('base64'),
            },
          },
          { type: 'text', text: args.prompts.user + '\n\nReturn JSON only.' },
        ],
      },
    ],
  })

  const text = msg.content
    .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
    .map((c) => c.text)
    .join('')

  const parsed = NarrationResponseSchema.safeParse(safeParseJson(text))
  if (!parsed.success) {
    return {
      response: { shortSummary: '[LLM format error]', threatLevel: 0, suppressAsFalsePositive: false },
      usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
      provider: 'claude',
      model,
    }
  }
  return {
    response: parsed.data,
    usage: { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens },
    provider: 'claude',
    model,
  }
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    return match ? JSON.parse(match[0]) : {}
  }
}
