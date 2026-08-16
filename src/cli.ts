import { startBrowserLogin } from './auth/browser'
import { AuthController } from './auth/controller'
import { loadConfig, type TgmcpConfig } from './config'
import { applyHome } from './home'
import { serve } from './serve'

interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key]
  return typeof value === 'string' ? value : undefined
}

function fail(message: string): never {
  console.error(`error: ${message}`)
  process.exit(1)
}

function printResult(result: { ok: boolean; content: string }): void {
  if (result.ok) console.log(result.content)
  else fail(result.content)
}

async function withAuth(config: TgmcpConfig, fn: (auth: AuthController) => Promise<void>): Promise<void> {
  const auth = new AuthController(config)
  try {
    await auth.resume()
    await fn(auth)
  } finally {
    await auth.close()
  }
}

async function loginBrowser(config: TgmcpConfig): Promise<void> {
  const auth = new AuthController(config)
  try {
    await auth.resume()
    if (auth.ready) {
      console.log(auth.status().hint)
      const account = auth.status().account
      if (account) console.log(`already signed in as ${account.name} (id ${account.id})`)
      return
    }
    const login = await startBrowserLogin(auth, { open: true })
    console.log(`browser login: ${login.url}`)
    console.log('this page is bound to 127.0.0.1. leave this process running until you finish.')
    await new Promise<void>((resolve, reject) => {
      const timer = setInterval(() => {
        if (auth.ready) {
          clearInterval(timer)
          resolve()
        }
      }, 300)
      const onInt = () => {
        clearInterval(timer)
        reject(new Error('interrupted'))
      }
      process.once('SIGINT', onInt)
    })
    login.stop()
    const account = auth.status().account
    if (account) console.log(`signed in as ${account.name} (id ${account.id})`)
    console.log(`credentials saved to ${config.telegram.credentialsPath}`)
  } finally {
    await auth.close()
  }
}

function usage(): void {
  console.log(`tgmcp - Telegram user-account MCP server

Usage:
  tgmcp                                 start MCP on stdio
  tgmcp serve                           same as above
  tgmcp login                           browser login (preferred, local)
  tgmcp login send-code --phone +15551234567
  tgmcp login sign-in --code <CODE> [--password <2FA>]
  tgmcp login resend-code
  tgmcp login qr [--password <2FA>]
  tgmcp login status
  tgmcp status
  tgmcp help
`)
}

function wantsHelp(cmd: string | undefined, flags: Record<string, string | boolean>): boolean {
  return cmd === 'help' || cmd === '-h' || cmd === '--help' || flags.help === true || flags.h === true
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const cmd = args.positionals[0]
  if (wantsHelp(cmd, args.flags)) {
    usage()
    return
  }
  const home = applyHome()
  if (cmd === undefined || cmd === 'serve') {
    await serve()
    return
  }
  const config = loadConfig()
  switch (cmd) {
    case 'login': {
      const rest: ParsedArgs = { positionals: args.positionals.slice(1), flags: args.flags }
      const sub = rest.positionals[0]
      switch (sub) {
        case 'send-code': {
          const phone = stringFlag(rest.flags, 'phone')
          if (!phone) fail('send-code requires --phone <E164>.')
          await withAuth(config, async (auth) => printResult(await auth.sendCode(phone)))
          return
        }
        case 'sign-in': {
          const code = stringFlag(rest.flags, 'code')
          if (!code) fail('sign-in requires --code <CODE>.')
          await withAuth(config, async (auth) =>
            printResult(await auth.signIn(code, stringFlag(rest.flags, 'password'))),
          )
          return
        }
        case 'resend-code':
          await withAuth(config, async (auth) => printResult(await auth.resendCode()))
          return
        case 'qr':
          await withAuth(config, async (auth) => {
            printResult(await auth.startQr(stringFlag(rest.flags, 'password')))
            while (!auth.ready) {
              await new Promise((r) => setTimeout(r, 400))
            }
            const account = auth.status().account
            if (account) console.log(`signed in as ${account.name} (id ${account.id})`)
          })
          return
        case 'status':
          await withAuth(config, async (auth) => {
            const status = auth.status()
            console.log(`${status.phase}. ${status.hint}`)
            console.log(`home: ${home}`)
            if (status.account) {
              console.log(`account: ${status.account.name} (id ${status.account.id})`)
            }
          })
          return
        case 'browser':
        case undefined:
          await loginBrowser(config)
          return
        default:
          fail(`unknown login subcommand "${sub}"`)
      }
    }
    case 'status':
      await withAuth(config, async (auth) => {
        const status = auth.status()
        console.log(`${status.phase}. ${status.hint}`)
        console.log(`home: ${home}`)
        if (status.account) console.log(`account: ${status.account.name} (id ${status.account.id})`)
        if (status.hasCredentials) console.log(`apiId: ${status.apiId} hash ${status.apiHash}`)
      })
      return
    default:
      fail(`unknown command "${cmd}"`)
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
