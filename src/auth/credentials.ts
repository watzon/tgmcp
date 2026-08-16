import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

const storedSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().min(8),
  ownerId: z.string().optional(),
})

export interface StoredCredentials {
  apiId: number
  apiHash: string
  ownerId?: string
}

export function resolveCredentialsPath(relative: string): string {
  return resolve(process.cwd(), relative)
}

export function loadCredentials(path: string): StoredCredentials | null {
  const abs = resolveCredentialsPath(path)
  if (!existsSync(abs)) return null
  try {
    return storedSchema.parse(JSON.parse(readFileSync(abs, 'utf8')))
  } catch {
    throw new Error(`Credentials file ${abs} is not valid. Delete it and sign in again.`)
  }
}

export function saveCredentials(path: string, creds: StoredCredentials): void {
  const parsed = storedSchema.parse(creds)
  const abs = resolveCredentialsPath(path)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(abs, 0o600)
  } catch {
    // Windows and some FS ignore chmod. The file still exists.
  }
}

export function maskHash(hash: string): string {
  if (hash.length <= 4) return '••••'
  return `${hash.slice(0, 4)}…`
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '•••'
  return `+•••${digits.slice(-4)}`
}

export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && text.includes(secret))
}
