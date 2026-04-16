import OpenAI from 'openai'
import type { ProviderNarrateArgs, ProviderResult } from '../index.js'
import { NarrationResponseSchema } from '../prompts.js'

export async function openaiNarrate(
  args: ProviderNarrateArgs,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProviderResult> {
  const client = new OpenAI({ apiKey, timeout: timeoutMs })
  const response = await client.chat.completions.create({
    model,
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
    response_format: { type: 'json_object' },
  })

  const text = response.choices[0]?.message.content ?? '{}'
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(text)
  } catch {
    parsedJson = {}
  }
  const parsed = NarrationResponseSchema.safeParse(parsedJson)
  if (!parsed.success) {
    return {
      response: { shortSummary: '[LLM format error]', threatLevel: 0, suppressAsFalsePositive: false },
      usage: {
        inputTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
      },
      provider: 'openai',
      model,
    }
  }
  return {
    response: parsed.data,
    usage: {
      inputTokens: response.usage?.prompt_tokens,
      outputTokens: response.usage?.completion_tokens,
    },
    provider: 'openai',
    model,
  }
}
