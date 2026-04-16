import { GoogleGenAI } from '@google/genai'
import type { ProviderNarrateArgs, ProviderResult } from '../index.js'
import { NarrationResponseSchema } from '../prompts.js'

export async function geminiNarrate(
  args: ProviderNarrateArgs,
  apiKey: string,
  model: string,
  timeoutMs: number,
): Promise<ProviderResult> {
  const client = new GoogleGenAI({ apiKey })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const result = await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { text: args.prompts.system + '\n\n' + args.prompts.user },
            { inlineData: { mimeType: 'image/jpeg', data: args.imageBytes.toString('base64') } },
          ],
        },
      ],
      config: {
        responseMimeType: 'application/json',
        abortSignal: controller.signal,
      },
    })

    const text = result.text ?? ''
    let jsonValue: unknown
    try {
      jsonValue = JSON.parse(text)
    } catch {
      return {
        response: { shortSummary: '[LLM format error]', threatLevel: 0, suppressAsFalsePositive: false },
        usage: {
          inputTokens: result.usageMetadata?.promptTokenCount,
          outputTokens: result.usageMetadata?.candidatesTokenCount,
        },
        provider: 'gemini',
        model,
      }
    }

    const parsed = NarrationResponseSchema.safeParse(jsonValue)
    if (!parsed.success) {
      return {
        response: { shortSummary: '[LLM format error]', threatLevel: 0, suppressAsFalsePositive: false },
        usage: {
          inputTokens: result.usageMetadata?.promptTokenCount,
          outputTokens: result.usageMetadata?.candidatesTokenCount,
        },
        provider: 'gemini',
        model,
      }
    }
    return {
      response: parsed.data,
      usage: {
        inputTokens: result.usageMetadata?.promptTokenCount,
        outputTokens: result.usageMetadata?.candidatesTokenCount,
      },
      provider: 'gemini',
      model,
    }
  } finally {
    clearTimeout(timer)
  }
}
