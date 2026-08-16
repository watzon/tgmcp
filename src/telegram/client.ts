import { BunPlatform, TelegramClient } from '@mtcute/bun'
import type { User } from '@mtcute/bun'
import type { TgmcpConfig } from '../config'

function managedPlatform(): BunPlatform {
  const platform = new BunPlatform()
  // The MCP process owns SIGINT/SIGTERM. mtcute's default exit hook closes
  // the session SQLite driver too early during graceful shutdown.
  platform.beforeExit = () => () => {}
  return platform
}

export function createClient(config: TgmcpConfig): TelegramClient {
  return new TelegramClient({
    apiId: config.telegram.apiId,
    apiHash: config.telegram.apiHash,
    storage: config.telegram.sessionPath,
    platform: managedPlatform(),
    updates: { catchUp: false },
  })
}

export async function startClient(client: TelegramClient): Promise<User> {
  return client.start({})
}

export async function stopClient(client: TelegramClient): Promise<void> {
  await client.destroy()
}
