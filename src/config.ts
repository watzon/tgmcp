import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TelegramTransport } from '@mtcute/node'
import { z } from 'zod'
import { loadCredentials } from './auth/credentials'
import { parseProxyUrl, type PublicProxyInfo } from './telegram/proxy'

const rateLimitsSchema = z.object({
  perChatMs: z.number().int().nonnegative().default(2000),
  globalPerHour: z.number().int().positive().default(120),
})

const fileSchema = z.object({
  ownerId: z.string().default(''),
  telegram: z.object({
    sessionPath: z.string().min(1).default('storage/session'),
    credentialsPath: z.string().min(1).default('storage/credentials.json'),
    proxy: z.string().min(1).optional(),
  }),
  ledgerPath: z.string().min(1).default('data/tgmcp.db'),
  downloadsDir: z.string().min(1).default('data/downloads'),
  denylist: z.array(z.string()).default([]),
  rateLimits: rateLimitsSchema.default({ perChatMs: 2000, globalPerHour: 120 }),
})

export interface TgmcpConfig {
  ownerId: string
  telegram: { apiId: number; apiHash: string; sessionPath: string; credentialsPath: string }
  proxy: PublicProxyInfo | null
  /** Resolved mtcute transport. Never log or return in tool results. */
  proxyTransport?: TelegramTransport
  ledgerPath: string
  downloadsDir: string
  denylist: string[]
  rateLimits: { perChatMs: number; globalPerHour: number }
}

export const DEFAULT_CONFIG_PATH = 'tgmcp.config.json'

export const DEFAULT_FILE_CONFIG = {
  ownerId: '',
  telegram: {
    sessionPath: 'storage/session',
    credentialsPath: 'storage/credentials.json',
  },
  ledgerPath: 'data/tgmcp.db',
  downloadsDir: 'data/downloads',
  denylist: [] as string[],
  rateLimits: {
    perChatMs: 2000,
    globalPerHour: 120,
  },
}

function envString(name: string): string | undefined {
  const value = process.env[name]
  return value && value.length > 0 ? value : undefined
}

function loadEnvFile(): void {
  const path = resolve(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export function hasApiCredentials(config: TgmcpConfig): boolean {
  return config.telegram.apiId > 0 && config.telegram.apiHash.length > 0
}

export function loadConfig(path = DEFAULT_CONFIG_PATH): TgmcpConfig {
  loadEnvFile()
  const abs = resolve(process.cwd(), path)
  if (!existsSync(abs)) {
    throw new Error(`Missing config file ${abs}. Run tgmcp once to create a default, or copy tgmcp.config.json.`)
  }
  const file = fileSchema.parse(JSON.parse(readFileSync(abs, 'utf8')))
  const stored = safeCredentials(file.telegram.credentialsPath)
  const envId = envString('TELEGRAM_API_ID')
  const envHash = envString('TELEGRAM_API_HASH')

  let apiId = 0
  let apiHash = ''
  if (envId && envHash) {
    apiId = Number(envId)
    apiHash = envHash
    if (!Number.isInteger(apiId) || apiId <= 0) {
      throw new Error('TELEGRAM_API_ID must be a positive integer.')
    }
  } else if (stored) {
    apiId = stored.apiId
    apiHash = stored.apiHash
  }

  const proxyUrl = envString('TGMCP_PROXY') ?? file.telegram.proxy
  let proxy: PublicProxyInfo | null = null
  let proxyTransport: TelegramTransport | undefined
  if (proxyUrl) {
    const resolved = parseProxyUrl(proxyUrl)
    proxy = resolved.public
    proxyTransport = resolved.transport
  }

  return {
    ownerId: file.ownerId || stored?.ownerId || '',
    telegram: {
      apiId,
      apiHash,
      sessionPath: file.telegram.sessionPath,
      credentialsPath: file.telegram.credentialsPath,
    },
    proxy,
    proxyTransport,
    ledgerPath: file.ledgerPath,
    downloadsDir: file.downloadsDir,
    denylist: file.denylist,
    rateLimits: file.rateLimits,
  }
}

function safeCredentials(path: string) {
  if (!existsSync(resolve(process.cwd(), path))) return null
  return loadCredentials(path)
}
