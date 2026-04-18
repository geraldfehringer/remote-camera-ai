import { z } from 'zod'

export const NarrationResponseSchema = z.object({
  shortSummary: z.string().max(240),
  threatLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  suppressAsFalsePositive: z.boolean(),
})

export type NarrationResponse = z.infer<typeof NarrationResponseSchema>

export function systemPrompt(locale: 'de' | 'en'): string {
  if (locale === 'de') {
    return [
      'Du schreibst Kurzmeldungen für eine Heim-Überwachungskamera.',
      'Antworte AUSSCHLIESSLICH als JSON, Schema:',
      '{"shortSummary": string (<=120 Zeichen),',
      ' "threatLevel": 0|1|2,',
      ' "suppressAsFalsePositive": boolean}.',
      'Der Text in "shortSummary" ist IMMER auf Deutsch, mit korrekten Umlauten (ä, ö, ü, ß) und sauberer Grammatik.',
      'threatLevel: 0=alltäglich, 1=bemerkenswert, 2=dringend.',
      'suppressAsFalsePositive=true nur wenn das Objekt klar kein echtes Zielobjekt ist (Schatten, Blatt, Spiegelung).',
    ].join('\n')
  }
  return [
    'You write short alerts for a home surveillance camera.',
    'Respond ONLY as JSON, schema:',
    '{"shortSummary": string (<=120 chars),',
    ' "threatLevel": 0|1|2,',
    ' "suppressAsFalsePositive": boolean}.',
    'threatLevel: 0=routine, 1=noteworthy, 2=urgent.',
    'suppressAsFalsePositive=true only when the object clearly is not a real target (shadow, leaf, reflection).',
  ].join('\n')
}

export function userPrompt(args: {
  target: string
  species?: string
  speciesCommonName?: string
  confidence: number
  motionScore: number
  locale: 'de' | 'en'
  localTime: string
}): string {
  const speciesLine = args.species
    ? `${args.species} (${args.speciesCommonName ?? 'n/a'})`
    : args.locale === 'de' ? 'unbekannt' : 'unknown'
  if (args.locale === 'de') {
    return [
      `- Zielobjekt: ${args.target} (Art: ${speciesLine})`,
      `- Konfidenz: ${args.confidence.toFixed(2)}, Bewegung: ${args.motionScore.toFixed(2)}`,
      `- Uhrzeit (lokal): ${args.localTime}`,
      '- Ort: Zuhause',
      '- Bild: im Anhang.',
    ].join('\n')
  }
  return [
    `- Target: ${args.target} (species: ${speciesLine})`,
    `- Confidence: ${args.confidence.toFixed(2)}, motion: ${args.motionScore.toFixed(2)}`,
    `- Local time: ${args.localTime}`,
    '- Location: home',
    '- Image: attached.',
  ].join('\n')
}
