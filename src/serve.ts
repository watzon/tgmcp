import { AuthController } from './auth/controller'
import { loadConfig } from './config'
import { serveStdio } from './mcp/server'

export async function serve(): Promise<void> {
  const config = loadConfig()
  const auth = new AuthController(config)
  await auth.resume()

  if (auth.ready && auth.runtime) {
    const me = auth.runtime.me
    console.error(`tgmcp is up as ${me.displayName} (id ${me.id})`)
  } else {
    const status = auth.status()
    console.error(`tgmcp is waiting for sign-in (${status.phase}). Prefer the browser login.`)
  }

  const shutdown = async () => {
    await auth.close()
    process.exit(0)
  }
  process.on('SIGINT', () => {
    void shutdown()
  })
  process.on('SIGTERM', () => {
    void shutdown()
  })

  await serveStdio(auth)
}
