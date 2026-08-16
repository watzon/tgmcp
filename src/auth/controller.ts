import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import QRCode from 'qrcode'
import type { TelegramClient, User } from '@mtcute/bun'
import type { TgmcpConfig } from '../config'
import { createRuntime, type Runtime } from '../runtime'
import { createClient } from '../telegram/client'
import type { ToolResult } from '../types'
import { loadCredentials, maskHash, maskPhone, saveCredentials } from './credentials'
import type { AuthPhase, PendingLogin, PublicAuthStatus } from './types'

function isPasswordNeeded(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const text = (err as { text?: unknown }).text
  if (text === 'SESSION_PASSWORD_NEEDED') return true
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && message.includes('SESSION_PASSWORD_NEEDED')
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class AuthController {
  runtime: Runtime | null = null
  private client: TelegramClient | null = null
  private me: User | null = null
  private qrUrl: string | null = null
  private qrExpires: Date | null = null
  private qrTask: Promise<void> | null = null
  private readonly readyListeners = new Set<() => void>()

  constructor(public config: TgmcpConfig) {}

  onReady(listener: () => void): void {
    this.readyListeners.add(listener)
  }

  get ready(): boolean {
    return this.runtime !== null && this.me !== null
  }

  get hasCredentials(): boolean {
    return this.config.telegram.apiId > 0 && this.config.telegram.apiHash.length > 0
  }

  get phase(): AuthPhase {
    if (this.ready) return 'ready'
    if (!this.hasCredentials) return 'need_credentials'
    if (this.me && this.config.ownerId && String(this.me.id) !== this.config.ownerId) {
      return 'owner_mismatch'
    }
    if (this.qrTask) return 'pending_qr'
    if (this.readPending()) return 'pending_code'
    return 'need_login'
  }

  status(): PublicAuthStatus {
    const phase = this.phase
    return {
      phase,
      ready: this.ready,
      hasCredentials: this.hasCredentials,
      apiId: this.hasCredentials ? this.config.telegram.apiId : null,
      apiHash: this.hasCredentials ? maskHash(this.config.telegram.apiHash) : null,
      ownerId: this.config.ownerId,
      account: this.me
        ? {
            id: String(this.me.id),
            name: this.me.displayName,
            username: this.me.username ?? null,
          }
        : null,
      pendingPhone: maskMaybePhone(this.readPending()?.phone),
      qrUrl: this.qrUrl,
      qrExpires: this.qrExpires?.toISOString() ?? null,
      preferred: 'browser',
      hint: hintFor(phase),
    }
  }

  async resume(): Promise<void> {
    if (!this.hasCredentials) return
    try {
      const client = await this.ensureClient()
      const me = await client.getMe()
      await this.complete(me)
    } catch {
      // Session missing or dead. Keep the client connected for login.
    }
  }

  async setCredentials(apiId: number, apiHash: string): Promise<ToolResult> {
    if (!Number.isInteger(apiId) || apiId <= 0) {
      return { ok: false, content: 'apiId must be a positive integer from my.telegram.org.' }
    }
    if (apiHash.trim().length < 8) {
      return { ok: false, content: 'apiHash is too short. Copy it from my.telegram.org.' }
    }
    const existing = safeLoad(this.config.telegram.credentialsPath)
    this.config.telegram.apiId = apiId
    this.config.telegram.apiHash = apiHash.trim()
    saveCredentials(this.config.telegram.credentialsPath, {
      apiId,
      apiHash: this.config.telegram.apiHash,
      ownerId: existing?.ownerId ?? (this.config.ownerId || undefined),
    })
    await this.resetClient()
    return {
      ok: true,
      content: `Saved API credentials (apiId ${apiId}, hash ${maskHash(this.config.telegram.apiHash)}). Hash is not shown again.`,
      data: { apiId, apiHash: maskHash(this.config.telegram.apiHash) },
    }
  }

  async sendCode(phone: string): Promise<ToolResult> {
    const creds = this.requireCredentials()
    if (creds) return creds
    this.cancelQr()
    const cleaned = phone.trim()
    if (!/^\+\d{7,15}$/.test(cleaned)) {
      return { ok: false, content: 'phone must be E.164, for example +15551234567.' }
    }
    const client = await this.ensureClient()
    const sent = await client.sendCode({ phone: cleaned })
    if (!('phoneCodeHash' in sent)) {
      await this.complete(sent)
      return this.readyResult('Already signed in.')
    }
    this.writePending({ phone: cleaned, phoneCodeHash: sent.phoneCodeHash })
    return {
      ok: true,
      content: `Login code sent to ${maskPhone(cleaned)} via ${sent.type}. Call auth sign_in with the code.`,
      data: { via: sent.type, phone: maskPhone(cleaned) },
    }
  }

  async resendCode(): Promise<ToolResult> {
    const pending = this.readPending()
    if (!pending) return { ok: false, content: 'No pending phone login. Call send_code first.' }
    const client = await this.ensureClient()
    const sent = await client.resendCode({
      phone: pending.phone,
      phoneCodeHash: pending.phoneCodeHash,
    })
    this.writePending({ phone: pending.phone, phoneCodeHash: sent.phoneCodeHash })
    return {
      ok: true,
      content: `Code re-sent to ${maskPhone(pending.phone)} via ${sent.type}.`,
      data: { via: sent.type },
    }
  }

  async signIn(code: string, password?: string): Promise<ToolResult> {
    const pending = this.readPending()
    if (!pending) return { ok: false, content: 'No pending phone login. Call send_code first.' }
    const client = await this.ensureClient()
    try {
      let user: User
      try {
        user = await client.signIn({
          phone: pending.phone,
          phoneCodeHash: pending.phoneCodeHash,
          phoneCode: code.trim(),
        })
      } catch (err) {
        if (!isPasswordNeeded(err)) throw err
        if (!password) {
          return {
            ok: false,
            content: 'Two-factor password required. Call sign_in again with password. Prefer the browser path so the password never enters the model.',
          }
        }
        user = await client.checkPassword(password)
      }
      this.clearPending()
      await this.complete(user)
      return this.readyResult('Signed in.')
    } catch (err) {
      return { ok: false, content: `Sign-in failed: ${errorText(err)}` }
    }
  }

  async startQr(password?: string): Promise<ToolResult> {
    const creds = this.requireCredentials()
    if (creds) return creds
    if (this.ready) return this.readyResult('Already signed in.')
    const client = await this.ensureClient()
    if (!this.qrTask) {
      this.qrTask = client
        .signInQr({
          onUrlUpdated: (url, expires) => {
            this.qrUrl = url
            this.qrExpires = expires
          },
          onQrScanned: () => {
            this.qrUrl = this.qrUrl
          },
          password,
        })
        .then(async (user) => {
          this.clearPending()
          await this.complete(user)
        })
        .catch((err) => {
          this.qrTask = null
          this.qrUrl = null
          this.qrExpires = null
          if (isPasswordNeeded(err) && !password) {
            throw new Error(
              'Two-factor password required. Retry start_qr with password, or use the browser path.',
            )
          }
          throw err
        })
    }
    // Give mtcute a moment to emit the first URL.
    for (let i = 0; i < 20 && !this.qrUrl; i++) {
      await sleep(100)
    }
    const ascii = this.qrUrl ? await QRCode.toString(this.qrUrl, { type: 'terminal', small: true }) : null
    return {
      ok: true,
      content:
        'QR login started. Scan from Telegram mobile: Settings → Devices → Link Desktop Device.\n' +
        (ascii ?? 'QR URL is not ready yet; call status again.'),
      data: {
        qrUrl: this.qrUrl,
        qrExpires: this.qrExpires?.toISOString() ?? null,
      },
    }
  }

  async qrImageDataUrl(): Promise<string | null> {
    if (!this.qrUrl) return null
    return QRCode.toDataURL(this.qrUrl, { width: 280, margin: 1 })
  }

  async close(): Promise<void> {
    this.cancelQr()
    if (this.runtime) {
      await this.runtime.close()
      this.runtime = null
      this.client = null
      this.me = null
      return
    }
    if (this.client) {
      await this.client.destroy()
      this.client = null
    }
  }

  private requireCredentials(): ToolResult | null {
    if (this.hasCredentials) return null
    return {
      ok: false,
      content:
        'No API credentials. Prefer auth command browser on this machine. On a remote host, call set_credentials with apiId and apiHash from my.telegram.org.',
    }
  }

  private async ensureClient(): Promise<TelegramClient> {
    if (!this.hasCredentials) {
      throw new Error('API credentials are not set.')
    }
    if (!this.client) {
      this.client = createClient(this.config)
      await this.client.connect()
    }
    return this.client
  }

  private async resetClient(): Promise<void> {
    this.cancelQr()
    if (this.client && !this.runtime) {
      await this.client.destroy()
    }
    if (this.runtime) {
      await this.runtime.close()
      this.runtime = null
    }
    this.client = null
    this.me = null
  }

  private async complete(user: User): Promise<void> {
    this.me = user
    if (this.config.ownerId !== '' && String(user.id) !== this.config.ownerId) {
      throw new Error(
        `Session account ${user.id} does not match configured ownerId ${this.config.ownerId}.`,
      )
    }
    this.config.ownerId = String(user.id)
    if (this.hasCredentials) {
      saveCredentials(this.config.telegram.credentialsPath, {
        apiId: this.config.telegram.apiId,
        apiHash: this.config.telegram.apiHash,
        ownerId: this.config.ownerId,
      })
    }
    if (!this.client) this.client = await this.ensureClient()
    if (!this.runtime) {
      this.runtime = await createRuntime(this.config, this.client, user)
    }
    this.qrTask = null
    this.qrUrl = null
    this.qrExpires = null
    for (const listener of this.readyListeners) listener()
  }

  private readyResult(prefix: string): ToolResult {
    const name = this.me?.displayName ?? 'account'
    const id = this.me ? String(this.me.id) : ''
    return {
      ok: true,
      content: `${prefix} Ready as ${name} (id ${id}). Credentials saved to ${this.config.telegram.credentialsPath}.`,
      data: { id, name },
    }
  }

  private pendingPath(): string {
    return join(resolve(process.cwd(), dirname(this.config.telegram.sessionPath)), '.login-pending.json')
  }

  private readPending(): PendingLogin | null {
    const path = this.pendingPath()
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as PendingLogin
      if (typeof raw.phone === 'string' && typeof raw.phoneCodeHash === 'string') return raw
      return null
    } catch {
      return null
    }
  }

  private writePending(pending: PendingLogin): void {
    const path = this.pendingPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(pending, null, 2)}\n`)
  }

  private clearPending(): void {
    rmSync(this.pendingPath(), { force: true })
  }

  private cancelQr(): void {
    this.qrTask = null
    this.qrUrl = null
    this.qrExpires = null
  }
}

function hintFor(phase: AuthPhase): string {
  switch (phase) {
    case 'need_credentials':
      return 'On this machine, open the browser login. On a remote host, set_credentials then send_code or start_qr.'
    case 'need_login':
      return 'Use the browser login if you can reach this machine. Otherwise send_code or start_qr.'
    case 'pending_code':
      return 'Enter the login code (and 2FA password if asked). Prefer the browser so the code stays off the model.'
    case 'pending_qr':
      return 'Scan the QR from a phone already signed into this Telegram account.'
    case 'owner_mismatch':
      return 'The session account does not match ownerId. Sign in as the configured account.'
    case 'ready':
      return 'Signed in. Inbox tools are available.'
  }
}

function maskMaybePhone(phone: string | undefined): string | null {
  return phone ? maskPhone(phone) : null
}

function safeLoad(path: string): ReturnType<typeof loadCredentials> {
  try {
    return loadCredentials(path)
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
