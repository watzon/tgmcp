import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { TelegramClient } from '@mtcute/node'
import { TEST_CONFIG } from '../test/context'
import { AuthController } from './controller'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), 'tgmcp-auth-ctrl-'))
}

function configFor(dir: string) {
  return {
    ...TEST_CONFIG,
    telegram: {
      ...TEST_CONFIG.telegram,
      apiId: 4242,
      apiHash: 'abcdef0123456789',
      credentialsPath: join(dir, 'credentials.json'),
      sessionPath: join(dir, 'session'),
    },
  }
}

describe('AuthController remote login', () => {
  test('send_code returns promptly and status moves to pending_code', async () => {
    const dir = makeDir()
    const pending = { resolveSend: null as null | (() => void), sent: false }

    const mockClient = {
      connect: async () => {},
      destroy: async () => {},
      getMe: async () => {
        throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { text: 'AUTH_KEY_UNREGISTERED' })
      },
      sendCode: async () => {
        pending.sent = true
        await new Promise<void>((resolve) => {
          pending.resolveSend = resolve
        })
        return { type: 'sms', phoneCodeHash: 'hash-123' }
      },
    } as unknown as TelegramClient

    const auth = new AuthController(configFor(dir), {
      createClient: () => mockClient,
    })

    const started = Date.now()
    const result = await auth.sendCode('+15551234567')
    const elapsed = Date.now() - started

    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(500)
    expect(auth.status().phase).toBe('sending_code')

    const waitForSend = Date.now() + 2_000
    while (Date.now() < waitForSend && !pending.sent) {
      await sleep(10)
    }
    expect(pending.sent).toBe(true)

    pending.resolveSend?.()
    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && auth.status().phase === 'sending_code') {
      await sleep(10)
    }

    expect(auth.status().phase).toBe('pending_code')
    expect(auth.status().pendingPhone).toBe('+•••4567')
    expect(auth.status().authError).toBeNull()

    await auth.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('start_qr exposes qrUrl via status after mtcute callback', async () => {
    const dir = makeDir()
    let releaseQr: () => void = () => {}

    const mockClient = {
      connect: async () => {},
      destroy: async () => {},
      getMe: async () => {
        throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { text: 'AUTH_KEY_UNREGISTERED' })
      },
      signInQr: async ({ onUrlUpdated }: { onUrlUpdated: (url: string, expires: Date) => void }) => {
        await sleep(20)
        onUrlUpdated('tg://login?token=abc', new Date(Date.now() + 60_000))
        await new Promise<void>((resolve) => {
          releaseQr = resolve
        })
        return { id: 1, displayName: 'Test', username: 'test' }
      },
    } as unknown as TelegramClient

    const auth = new AuthController(configFor(dir), {
      createClient: () => mockClient,
    })

    const started = Date.now()
    const result = await auth.startQr()
    const elapsed = Date.now() - started

    expect(result.ok).toBe(true)
    expect(elapsed).toBeLessThan(500)
    expect(auth.status().phase).toBe('pending_qr')

    await sleep(40)
    expect(auth.status().qrUrl).toBe('tg://login?token=abc')
    expect(auth.status().authError).toBeNull()

    releaseQr()
    await sleep(20)

    await auth.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('status does not include raw apiId', async () => {
    const dir = makeDir()
    const mockClient = {
      connect: async () => {},
      destroy: async () => {},
      getMe: async () => {
        throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { text: 'AUTH_KEY_UNREGISTERED' })
      },
    } as unknown as TelegramClient

    const auth = new AuthController(configFor(dir), {
      createClient: () => mockClient,
    })
    const status = auth.status()
    expect(status.hasCredentials).toBe(true)
    expect('apiId' in status).toBe(false)
    expect(status.apiHash).toBe('abcd…')
    expect(JSON.stringify(status)).not.toContain('abcdef0123456789')

    await auth.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('send_code records a timeout error without hanging status', async () => {
    const dir = makeDir()
    const mockClient = {
      connect: async () => {},
      destroy: async () => {},
      getMe: async () => {
        throw Object.assign(new Error('AUTH_KEY_UNREGISTERED'), { text: 'AUTH_KEY_UNREGISTERED' })
      },
      sendCode: async () => {
        await new Promise(() => {})
      },
    } as unknown as TelegramClient

    const auth = new AuthController(configFor(dir), {
      createClient: () => mockClient,
      timeouts: { sendCodeMs: 50 },
    })

    const result = await auth.sendCode('+15559876543')
    expect(result.ok).toBe(true)

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline) {
      const status = auth.status()
      if (status.authError) {
        expect(status.phase).toBe('need_login')
        expect(status.authError).toContain('did not respond in time')
        await auth.close()
        rmSync(dir, { recursive: true, force: true })
        return
      }
      await sleep(20)
    }

    throw new Error('expected send_code to time out')
  })
})
