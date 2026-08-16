import type { TelegramClient, User } from '@mtcute/node'
import type { TgmcpConfig } from './config'
import { createLedger, type LedgerStore } from './ledger'
import { createActions } from './telegram/actions'
import type { ToolContext } from './types'

export interface Runtime {
  config: TgmcpConfig
  client: TelegramClient
  me: User
  ctx: ToolContext
  close(): Promise<void>
}

export async function createRuntime(
  config: TgmcpConfig,
  client: TelegramClient,
  me: User,
): Promise<Runtime> {
  if (config.ownerId !== '' && String(me.id) !== config.ownerId) {
    throw new Error(
      `Session account ${me.id} does not match configured ownerId ${config.ownerId}. Run \`bun run login\` as that account.`,
    )
  }

  const ledger: LedgerStore = createLedger(config.ledgerPath)
  const tg = createActions(client, config, (entry) => ledger.write(entry))
  const ownerId = String(me.id)

  const ctx: ToolContext = {
    chatId: ownerId,
    ownerId,
    isOwner: true,
    requireExplicitChatId: true,
    tg,
    config,
    log(msg) {
      console.error(msg)
    },
    ledger(entry) {
      return ledger.write(entry)
    },
  }

  return {
    config,
    client,
    me,
    ctx,
    async close() {
      ledger.close()
      await client.destroy()
    },
  }
}
