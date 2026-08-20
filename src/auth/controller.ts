import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import QRCode from 'qrcode'
import type { TelegramClient, User } from '@mtcute/node'
import type { TgmcpConfig } from '../config'
import { createRuntime, type Runtime } from '../runtime'
import { createClient } from '../telegram/client'
import type { ToolResult } from '../types'
import { loadCredentials, maskHash, maskPhone, saveCredentials } from './credentials'
import {
  CONNECT_TIMEOUT_MS,
  formatAuthError,
  isPasswordNeeded,
  isRecoverableResumeError,
  QR_URL_TIMEOUT_MS,
  SEND_CODE_TIMEOUT_MS,
  withTimeout,
} from './errors'
import type { AuthPhase, PendingLogin, PublicAuthStatus } from './types'

type ClientFactory = (config: TgmcpConfig) => TelegramClient

export interface AuthTimeouts {
  connectMs: number
  sendCodeMs: number
  qrUrlMs: number
}

const DEFAULT_TIMEOUTS: AuthTimeouts = {
  connectMs: CONNECT_TIMEOUT_MS,
  sendCodeMs: SEND_CODE_TIMEOUT_MS,
  qrUrlMs: QR_URL_TIMEOUT_MS,
}

export interface AuthControllerDeps {
  createClient?: ClientFactory
  timeouts?: Partial<AuthTimeouts>
}

export class AuthController {
  runtime: Runtime | null = null
  private client: TelegramClient | null = null
  private me: User | null = null
  private qrUrl: string | null = null
  private qrExpires: Date | null = null
  private qrTask: Promise<void> | null = null
  private qrAbort: AbortController | null = null
  private qrUrlTimer: ReturnType<typeof setTimeout> | null = null
  private sendCodeTask: Promise<void> | null = null
  private sendCodeAbort: AbortController | null = null
  private sendingCode = false
  private authError: string | null = null
  private readonly readyListeners = new Set<() => void>()
  private readonly createClientFn: ClientFactory
  private readonly timeouts: AuthTimeouts

  constructor(
    public config: TgmcpConfig,
    deps: AuthControllerDeps = {},
  ) {
    this.createClientFn = deps.createClient ?? createClient
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...deps.timeouts }
  }

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
    if (this.sendingCode) return 'sending_code'
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
      apiHash: this.hasCredentials ? maskHash(this.config.telegram.apiHash) : null,
      ownerId: this.config.ownerId,
      account: this.me
        ? {
            id: String(this.me.id),
            name: this.me.displayName,
            username: this.me.username ?? null,
          }
        : null,
      proxy: this.config.proxy,
      pendingPhone: maskMaybePhone(this.readPending()?.phone),
      qrUrl: this.qrUrl,
      qrExpires: this.qrExpires?.toISOString() ?? null,
      authError: this.authError,
      preferred: 'browser',
      hint: hintFor(phase),
    }
  }

  async resume(): Promise<void> {
    if (!this.hasCredentials) return
    try {
      const client = await this.ensureClient()
      const me = await withTimeout(client.getMe(), this.timeouts.connectMs, 'Session check timed out')
      await this.complete(me)
    } catch (err) {
      if (!isRecoverableResumeError(err)) {
        await this.resetLoginClient()
      } else {
        await this.handleUnauthenticatedClient(err)
      }
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
      data: { apiHash: maskHash(this.config.telegram.apiHash) },
    }
  }

  async sendCode(phone: string): Promise<ToolResult> {
    const creds = this.requireCredentials()
    if (creds) return creds
    if (this.ready) return this.readyResult('Already signed in.')
    if (this.sendingCode) {
      return {
        ok: false,
        content: 'A login code request is already in progress. Poll auth status until phase changes.',
      }
    }

    this.cancelQr()
    this.authError = null
    const cleaned = phone.trim()
    if (!/^\+\d{7,15}$/.test(cleaned)) {
      return { ok: false, content: 'phone must be E.164, for example +15551234567.' }
    }

    this.sendingCode = true
    this.sendCodeTask = this.executeSendCode(cleaned)

    return {
      ok: true,
      content: `Sending login code to ${maskPhone(cleaned)}. Poll auth status until phase is pending_code or authError is set.`,
      data: { phase: 'sending_code', phone: maskPhone(cleaned) },
    }
  }

  async resendCode(): Promise<ToolResult> {
    const pending = this.readPending()
    if (!pending) return { ok: false, content: 'No pending phone login. Call send_code first.' }
    const client = await this.prepareLoginClient()
    const abort = new AbortController()
    this.sendCodeAbort = abort
    try {
      const sent = await withTimeout(
        client.resendCode({
          phone: pending.phone,
          phoneCodeHash: pending.phoneCodeHash,
          abortSignal: abort.signal,
        }),
        this.timeouts.sendCodeMs,
        'Telegram did not respond in time',
      )
      this.writePending({ phone: pending.phone, phoneCodeHash: sent.phoneCodeHash })
      this.authError = null
      return {
        ok: true,
        content: `Code re-sent to ${maskPhone(pending.phone)} via ${sent.type}.`,
        data: { via: sent.type },
      }
    } catch (err) {
      abort.abort()
      this.authError = formatAuthError(err)
      return { ok: false, content: `Resend failed: ${this.authError}` }
    } finally {
      this.sendCodeAbort = null
    }
  }

  async signIn(code: string, password?: string): Promise<ToolResult> {
    const pending = this.readPending()
    if (!pending) return { ok: false, content: 'No pending phone login. Call send_code first.' }
    const client = await this.prepareLoginClient()
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
            content:
              'Two-factor password required. Call sign_in again with password. Prefer the browser path so the password never enters the model.',
          }
        }
        user = await client.checkPassword(password)
      }
      this.clearPending()
      this.authError = null
      await this.complete(user)
      return this.readyResult('Signed in.')
    } catch (err) {
      this.authError = formatAuthError(err)
      return { ok: false, content: `Sign-in failed: ${this.authError}` }
    }
  }

  async startQr(password?: string): Promise<ToolResult> {
    const creds = this.requireCredentials()
    if (creds) return creds
    if (this.ready) return this.readyResult('Already signed in.')

    this.cancelSendCode()
    this.authError = null

    if (!this.qrTask) {
      const client = await this.prepareLoginClient()
      if (this.ready) return this.readyResult('Already signed in.')

      this.qrAbort = new AbortController()
      this.qrUrl = null
      this.qrExpires = null
      this.qrUrlTimer = setTimeout(() => {
        if (!this.qrUrl) {
          this.authError =
            'QR URL did not arrive from Telegram in time. Retry start_qr or use send_code.'
          this.cancelQr()
        }
      }, this.timeouts.qrUrlMs)

      this.qrTask = this.runQrLogin(client, password, this.qrAbort.signal)
        .catch((err) => {
          if (this.qrAbort?.signal.aborted) return
          if (!this.authError) this.authError = formatAuthError(err)
        })
        .finally(() => {
          if (this.qrUrlTimer) {
            clearTimeout(this.qrUrlTimer)
            this.qrUrlTimer = null
          }
          this.qrTask = null
          this.qrAbort = null
        })
    }

    const ascii = this.qrUrl ? await QRCode.toString(this.qrUrl, { type: 'terminal', small: true }) : null
    return {
      ok: true,
      content:
        'QR login started. Scan from Telegram mobile: Settings → Devices → Link Desktop Device.\n' +
        (ascii ?? 'Poll auth status for qrUrl.'),
      data: {
        qrUrl: this.qrUrl,
        qrExpires: this.qrExpires?.toISOString() ?? null,
        phase: 'pending_qr',
      },
    }
  }

  async qrImageDataUrl(): Promise<string | null> {
    if (!this.qrUrl) return null
    return QRCode.toDataURL(this.qrUrl, { width: 280, margin: 1 })
  }

  async close(): Promise<void> {
    this.cancelQr()
    this.cancelSendCode()
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

  private async executeSendCode(phone: string): Promise<void> {
    const abort = new AbortController()
    this.sendCodeAbort = abort
    try {
      const client = await this.prepareLoginClient()
      if (this.ready) return
      const sent = await withTimeout(
        client.sendCode({ phone, abortSignal: abort.signal }),
        this.timeouts.sendCodeMs,
        'Telegram did not respond in time',
      )
      if (!('phoneCodeHash' in sent)) {
        await this.complete(sent)
        return
      }
      this.writePending({ phone, phoneCodeHash: sent.phoneCodeHash })
      this.authError = null
    } catch (err) {
      abort.abort()
      this.authError = formatAuthError(err)
    } finally {
      this.sendingCode = false
      this.sendCodeTask = null
      this.sendCodeAbort = null
    }
  }

  private async runQrLogin(
    client: TelegramClient,
    password: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const user = await client.signInQr({
        onUrlUpdated: (url, expires) => {
          this.qrUrl = url
          this.qrExpires = expires
          this.authError = null
        },
        onQrScanned: () => {},
        password,
        abortSignal: signal,
      })
      this.clearPending()
      this.authError = null
      await this.complete(user)
    } catch (err) {
      if (signal.aborted) return
      if (isPasswordNeeded(err) && !password) {
        throw new Error(
          'Two-factor password required. Retry start_qr with password, or use the browser path.',
        )
      }
      throw err
    }
  }

  private async prepareLoginClient(): Promise<TelegramClient> {
    if (!this.hasCredentials) {
      throw new Error('API credentials are not set.')
    }
    if (this.client && !this.runtime) {
      try {
        const me = await withTimeout(this.client.getMe(), this.timeouts.connectMs, 'Session check timed out')
        await this.complete(me)
        return this.client
      } catch (err) {
        await this.handleUnauthenticatedClient(err)
      }
    }
    return this.ensureClient()
  }

  private async handleUnauthenticatedClient(err: unknown): Promise<void> {
    const text = typeof err === 'object' && err !== null ? (err as { text?: string }).text : null
    if (
      text === 'SESSION_REVOKED' ||
      text === 'USER_DEACTIVATED' ||
      text === 'USER_DEACTIVATED_BAN'
    ) {
      if (this.client) {
        try {
          await this.client.logOut()
        } catch {
          // Best effort.
        }
      }
    }
    await this.resetLoginClient()
  }

  private async resetLoginClient(): Promise<void> {
    if (this.client && !this.runtime) {
      await this.client.destroy().catch(() => {})
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
      this.client = this.createClientFn(this.config)
      await withTimeout(this.client.connect(), this.timeouts.connectMs, 'Telegram connection timed out')
    }
    return this.client
  }

  private async resetClient(): Promise<void> {
    this.cancelQr()
    this.cancelSendCode()
    if (this.client && !this.runtime) {
      await this.client.destroy()
    }
    if (this.runtime) {
      await this.runtime.close()
      this.runtime = null
    }
    this.client = null
    this.me = null
    this.authError = null
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
    this.cancelQr()
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
    if (this.qrUrlTimer) {
      clearTimeout(this.qrUrlTimer)
      this.qrUrlTimer = null
    }
    this.qrAbort?.abort()
    this.qrAbort = null
    this.qrTask = null
    this.qrUrl = null
    this.qrExpires = null
  }

  private cancelSendCode(): void {
    this.sendCodeAbort?.abort()
    this.sendCodeAbort = null
    this.sendingCode = false
    this.sendCodeTask = null
  }
}

function hintFor(phase: AuthPhase): string {
  switch (phase) {
    case 'need_credentials':
      return 'On this machine, open the browser login. On a remote host, set_credentials then send_code or start_qr.'
    case 'need_login':
      return 'Use the browser login if you can reach this machine. Otherwise send_code or start_qr.'
    case 'sending_code':
      return 'Waiting for Telegram to send the login code. Poll status; do not call send_code again.'
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
