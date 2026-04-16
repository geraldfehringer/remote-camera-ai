import type { ProviderNarrateArgs, ProviderResult } from '../index.js'
import { NarrationResponseSchema } from '../prompts.js'

export async function togetherNarrate(
  args: ProviderNarrateArgs,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProviderResult> {
  const res = await fetch('https://api.together.xyz/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: args.prompts.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: args.prompts.user },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${args.imageBytes.toString('base64')}` },
            },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number }
  }
  const text = json.choices?.[0]?.message?.content ?? '{}'
  const parsed = NarrationResponseSchema.safeParse(safeParseJson(text))
  if (!parsed.success) {
    return {
      response: { shortSummary: '[LLM format error]', threatLevel: 0, suppressAsFalsePositive: false },
      usage: {
        inputTokens: json.usage?.prompt_tokens,
        outputTokens: json.usage?.completion_tokens,
      },
      provider: 'together',
      model,
    }
  }
  return {
    response: parsed.data,
    usage: {
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
    },
    provider: 'together',
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
