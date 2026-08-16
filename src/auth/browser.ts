import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { AuthController } from './controller'
import { loginPageHtml } from './page'

export interface BrowserLogin {
  url: string
  token: string
  stop(): void
}

interface Handle {
  login: BrowserLogin
  server: ReturnType<typeof Bun.serve>
}

let active: Handle | null = null

export async function startBrowserLogin(
  auth: AuthController,
  opts: { open?: boolean } = {},
): Promise<BrowserLogin> {
  if (active) return active.login

  const token = randomBytes(24).toString('hex')
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!checkToken(req, url, token)) {
        return json({ ok: false, content: 'Unauthorized.' }, 401)
      }
      if (req.method === 'GET' && url.pathname === '/') {
        return new Response(loginPageHtml(token), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const status = auth.status()
        const qrDataUrl = status.phase === 'pending_qr' ? await auth.qrImageDataUrl() : null
        return json({ ok: true, content: status.hint, data: { ...status, qrDataUrl } })
      }
      if (req.method === 'POST' && url.pathname === '/api/credentials') {
        const body = await readJson(req)
        return toolJson(await auth.setCredentials(Number(body.apiId), String(body.apiHash ?? '')))
      }
      if (req.method === 'POST' && url.pathname === '/api/send-code') {
        const body = await readJson(req)
        return toolJson(await auth.sendCode(String(body.phone ?? '')))
      }
      if (req.method === 'POST' && url.pathname === '/api/resend') {
        return toolJson(await auth.resendCode())
      }
      if (req.method === 'POST' && url.pathname === '/api/sign-in') {
        const body = await readJson(req)
        const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined
        return toolJson(await auth.signIn(String(body.code ?? ''), password))
      }
      if (req.method === 'POST' && url.pathname === '/api/qr') {
        const body = await readJson(req)
        const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined
        return toolJson(await auth.startQr(password))
      }
      return json({ ok: false, content: 'Not found.' }, 404)
    },
  })

  const url = `http://127.0.0.1:${server.port}/?token=${token}`
  const login: BrowserLogin = {
    url,
    token,
    stop() {
      server.stop(true)
      if (active?.login === login) active = null
    },
  }
  active = { login, server }

  if (opts.open !== false) openUrl(url)
  return login
}

function checkToken(req: Request, url: URL, token: string): boolean {
  const header = req.headers.get('x-tgmcp-token')
  const query = url.searchParams.get('token')
  return header === token || query === token
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function toolJson(result: { ok: boolean; content: string; data?: unknown }): Response {
  return json(result, result.ok ? 200 : 400)
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await req.json()) as unknown
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(cmd, process.platform === 'win32' ? ['/c', 'start', url] : [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    }).unref()
  } catch {
    // Caller still has the URL.
  }
}
