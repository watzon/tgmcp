import { describe, expect, test } from 'bun:test'
import { TEST_CONFIG } from '../test/context'
import { startBrowserLogin } from './browser'
import { AuthController } from './controller'

describe('browser login', () => {
  test('serves the sign-in page on 127.0.0.1 and rejects a missing token', async () => {
    const auth = new AuthController({
      ...TEST_CONFIG,
      telegram: { ...TEST_CONFIG.telegram, apiId: 0, apiHash: '' },
    })
    const login = await startBrowserLogin(auth, { open: false })
    expect(login.url.startsWith('http://127.0.0.1:')).toBe(true)
    const page = await fetch(login.url)
    const html = await page.text()
    expect(page.ok).toBe(true)
    expect(html).toContain('tgmcp')
    expect(html).toContain('127.0.0.1')

    const origin = login.url.slice(0, login.url.indexOf('?'))
    const denied = await fetch(`${origin}api/status`)
    expect(denied.status).toBe(401)

    const status = await fetch(`${origin}api/status`, {
      headers: { 'x-tgmcp-token': login.token },
    })
    const body = (await status.json()) as { data: { phase: string } }
    expect(status.ok).toBe(true)
    expect(body.data.phase).toBe('need_credentials')
    login.stop()
  })
})
