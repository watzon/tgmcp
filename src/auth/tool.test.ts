import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { parseProxyUrl } from '../telegram/proxy'
import { TEST_CONFIG } from '../test/context'
import { containsSecret } from './credentials'
import { AuthController } from './controller'
import { AUTH_TOOL_DESCRIPTION, createAuthTool } from './tool'

describe('auth tool', () => {
  test('description tells the host to check auth once per session', () => {
    const auth = new AuthController({
      ...TEST_CONFIG,
      telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '' },
    })
    const tool = createAuthTool(auth, async () => ({ url: 'http://127.0.0.1:1/' }))
    expect(tool.description).toBe(AUTH_TOOL_DESCRIPTION)
    expect(tool.description).toContain('once per session')
    expect(tool.description).toContain('command status')
  })

  test('status includes proxy without secret', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-auth-proxy-'))
    const config = {
      ...TEST_CONFIG,
      telegram: {
        ...TEST_CONFIG.telegram,
        apiId: 99,
        apiHash: 'super-secret-hash-value',
        credentialsPath: join(dir, 'credentials.json'),
        sessionPath: join(dir, 'session'),
      },
      proxy: { type: 'socks5' as const, host: 'proxy.example.com', port: 1080 },
      proxyTransport: parseProxyUrl('socks5://user:proxy-secret@proxy.example.com:1080').transport,
    }
    const auth = new AuthController(config)
    const tool = createAuthTool(auth, async () => ({ url: 'http://127.0.0.1:1/' }))
    const result = await tool.execute({ command: 'status' }, {} as never)
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.data)).toContain('proxy.example.com')
    expect(containsSecret(JSON.stringify(result.data), ['proxy-secret'])).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('status does not leak a stored hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-auth-'))
    const config = {
      ...TEST_CONFIG,
      telegram: {
        ...TEST_CONFIG.telegram,
        apiId: 99,
        apiHash: 'super-secret-hash-value',
        credentialsPath: join(dir, 'credentials.json'),
        sessionPath: join(dir, 'session'),
      },
    }
    const auth = new AuthController(config)
    const tool = createAuthTool(auth, async () => ({ url: 'http://127.0.0.1:1/?token=x' }))
    const result = await tool.execute({ command: 'status' }, {} as never)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('need_login')
    expect(containsSecret(result.content, ['super-secret-hash-value'])).toBe(false)
    expect(containsSecret(JSON.stringify(result.data), ['super-secret-hash-value'])).toBe(false)
    expect(JSON.stringify(result.data)).toContain('supe…')
    rmSync(dir, { recursive: true, force: true })
  })

  test('set_credentials writes the file and masks the hash in the result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-auth-'))
    const path = join(dir, 'credentials.json')
    const auth = new AuthController({
      ...TEST_CONFIG,
      telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '', credentialsPath: path, sessionPath: join(dir, 'session') },
    })
    const tool = createAuthTool(auth, async () => ({ url: 'http://127.0.0.1:1/' }))
    const secret = 'hash-must-not-echo-123456'
    const result = await tool.execute(
      { command: 'set_credentials', apiId: 4242, apiHash: secret },
      {} as never,
    )
    expect(result.ok).toBe(true)
    expect(containsSecret(result.content, [secret])).toBe(false)
    expect(containsSecret(JSON.stringify(result.data), [secret])).toBe(false)
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { apiId: number; apiHash: string }
    expect(stored).toMatchObject({ apiId: 4242, apiHash: secret })
    await auth.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('browser command returns a localhost url', async () => {
    const auth = new AuthController({
      ...TEST_CONFIG,
      telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '' },
    })
    const tool = createAuthTool(auth, async () => ({ url: 'http://127.0.0.1:9999/?token=abc' }))
    const result = await tool.execute({ command: 'browser' }, {} as never)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('127.0.0.1')
    expect(result.data).toMatchObject({ bind: '127.0.0.1' })
  })
})
