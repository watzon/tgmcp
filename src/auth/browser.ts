import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AuthController } from './controller'
import { loginPageHtml } from './page'

export interface BrowserLogin {
  url: string
  token: string
  stop(): void
}

interface Handle {
  login: BrowserLogin
  server: Server
}

let active: Handle | null = null

export async function startBrowserLogin(
  auth: AuthController,
  opts: { open?: boolean } = {},
): Promise<BrowserLogin> {
  if (active) return active.login

  const token = randomBytes(24).toString('hex')
  const server = createServer((req, res) => {
    void handleRequest(req, res, auth, token)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `http://127.0.0.1:${port}/?token=${token}`
  const login: BrowserLogin = {
    url,
    token,
    stop() {
      server.close()
      if (active?.login === login) active = null
    },
  }
  active = { login, server }

  if (opts.open !== false) openUrl(url)
  return login
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthController,
  token: string,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!checkToken(req, url, token)) {
      sendJson(res, 401, { ok: false, content: 'Unauthorized.' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/') {
      send(res, 200, loginPageHtml(token), 'text/html')
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const status = auth.status()
      const qrDataUrl = status.phase === 'pending_qr' ? await auth.qrImageDataUrl() : null
      sendJson(res, 200, { ok: true, content: status.hint, data: { ...status, qrDataUrl } })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/credentials') {
      const body = await readJson(req)
      sendTool(res, await auth.setCredentials(Number(body.apiId), String(body.apiHash ?? '')))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/send-code') {
      const body = await readJson(req)
      sendTool(res, await auth.sendCode(String(body.phone ?? '')))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/resend') {
      sendTool(res, await auth.resendCode())
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/sign-in') {
      const body = await readJson(req)
      const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined
      sendTool(res, await auth.signIn(String(body.code ?? ''), password))
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/qr') {
      const body = await readJson(req)
      const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined
      sendTool(res, await auth.startQr(password))
      return
    }
    sendJson(res, 404, { ok: false, content: 'Not found.' })
  } catch (err) {
    sendJson(res, 500, { ok: false, content: err instanceof Error ? err.message : String(err) })
  }
}

function checkToken(req: IncomingMessage, url: URL, token: string): boolean {
  const header = req.headers['x-tgmcp-token']
  const headerValue = Array.isArray(header) ? header[0] : header
  const query = url.searchParams.get('token')
  return headerValue === token || query === token
}

function send(res: ServerResponse, status: number, body: string, contentType: string): void {
  res.writeHead(status, { 'content-type': `${contentType}; charset=utf-8` })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), 'application/json')
}

function sendTool(res: ServerResponse, result: { ok: boolean; content: string; data?: unknown }): void {
  sendJson(res, result.ok ? 200 : 400, result)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const raw = await readBody(req)
    if (!raw) return {}
    const body = JSON.parse(raw) as unknown
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
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
