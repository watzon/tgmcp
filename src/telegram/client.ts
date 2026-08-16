import { NodePlatform, TelegramClient } from '@mtcute/node'
import type { User } from '@mtcute/node'
import type { TgmcpConfig } from '../config'

function managedPlatform(): NodePlatform {
  const platform = new NodePlatform()
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
