import type { TelegramClient } from '@mtcute/bun'
import type { TgmcpConfig } from '../config'
import type { LedgerEntry, RiskTier, ToolContext } from '../types'

export const TEST_CONFIG: TgmcpConfig = {
  ownerId: '9001',
  telegram: {
    apiId: 1,
    apiHash: 'hash',
    sessionPath: 'storage/session',
    credentialsPath: 'storage/credentials.json',
  },
  ledgerPath: 'data/tgmcp.db',
  downloadsDir: 'data/downloads',
  denylist: [],
  rateLimits: { perChatMs: 0, globalPerHour: 1000 },
}

export function makeContext(
  client: Partial<TelegramClient> = {},
  opts: {
    chatId?: string
    isOwner?: boolean
    requireExplicitChatId?: boolean
    denylist?: string[]
    guardCalls?: Array<{ risk: RiskTier; action: string; chatId: string }>
    ledger?: LedgerEntry[]
  } = {},
): ToolContext {
  const guardCalls = opts.guardCalls ?? []
  const ledger = opts.ledger ?? []
  const config: TgmcpConfig = {
    ...TEST_CONFIG,
    denylist: opts.denylist ?? [],
  }
  return {
    chatId: opts.chatId ?? '9001',
    ownerId: '9001',
    isOwner: opts.isOwner ?? true,
    requireExplicitChatId: opts.requireExplicitChatId ?? true,
    config,
    log() {},
    async ledger(entry) {
      ledger.push(entry)
    },
    tg: {
      client,
      async guard(risk, action, chatId, fn) {
        guardCalls.push({ risk, action, chatId })
        return fn()
      },
      async sendText() {
        return { id: 1 }
      },
      async reply() {
        return { id: 2 }
      },
      async react() {},
      async readHistory() {},
      async setTyping() {},
      async getHistory() {
        return []
      },
      async listDialogs() {
        return []
      },
    },
  }
}
