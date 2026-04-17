import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { E164_REGEX, type WhatsappConfig } from './types.js'

const CONFIG_FILENAME = 'config.json'

export function configPath(authDir: string): string {
  return path.join(authDir, CONFIG_FILENAME)
}

const DEFAULT_CONFIG: WhatsappConfig = {
  enabled: false,
  recipientE164: null,
  updatedAt: new Date(0).toISOString(),
}

export async function loadConfig(authDir: string): Promise<WhatsappConfig> {
  const filePath = configPath(authDir)
  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<WhatsappConfig>
    return {
      enabled: parsed.enabled === true,
      recipientE164:
        typeof parsed.recipientE164 === 'string' && E164_REGEX.test(parsed.recipientE164)
          ? parsed.recipientE164
          : null,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : DEFAULT_CONFIG.updatedAt,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG }
    throw err
  }
}

export async function saveConfig(authDir: string, next: Omit<WhatsappConfig, 'updatedAt'>): Promise<WhatsappConfig> {
  await mkdir(authDir, { recursive: true })
  if (next.recipientE164 !== null && !E164_REGEX.test(next.recipientE164)) {
    throw new Error('recipientE164 is not a valid E.164 phone number')
  }
  const persisted: WhatsappConfig = {
    enabled: next.enabled,
    recipientE164: next.recipientE164,
    updatedAt: new Date().toISOString(),
  }
  await writeFile(configPath(authDir), JSON.stringify(persisted, null, 2), 'utf8')
  return persisted
}
