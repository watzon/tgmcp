import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG_PATH, loadConfig } from './config'
import { ensureHome } from './home'

describe('loadConfig proxy', () => {
  test('prefers TGMCP_PROXY over config file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-proxy-env-'))
    ensureHome(dir)
    writeFileSync(
      join(dir, DEFAULT_CONFIG_PATH),
      JSON.stringify({
        telegram: {
          sessionPath: 'storage/session',
          credentialsPath: 'storage/credentials.json',
          proxy: 'socks5://file-proxy.example.com:1080',
        },
      }),
    )

    const prev = process.env.TGMCP_PROXY
    process.env.TGMCP_PROXY = 'socks5://env-proxy.example.com:1080'
    try {
      const config = loadConfig(join(dir, DEFAULT_CONFIG_PATH))
      expect(config.proxy).toEqual({ type: 'socks5', host: 'env-proxy.example.com', port: 1080 })
      expect(config.proxyTransport).toBeDefined()
    } finally {
      if (prev === undefined) delete process.env.TGMCP_PROXY
      else process.env.TGMCP_PROXY = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('loads proxy from config when env is unset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-proxy-file-'))
    ensureHome(dir)
    writeFileSync(
      join(dir, DEFAULT_CONFIG_PATH),
      JSON.stringify({
        telegram: {
          sessionPath: 'storage/session',
          credentialsPath: 'storage/credentials.json',
          proxy: `mtproxy://proxy.example.com:443?secret=dd0123456789abcdef0123456789abcdef`,
        },
      }),
    )

    const prev = process.env.TGMCP_PROXY
    delete process.env.TGMCP_PROXY
    try {
      const config = loadConfig(join(dir, DEFAULT_CONFIG_PATH))
      expect(config.proxy).toEqual({ type: 'mtproxy', host: 'proxy.example.com', port: 443 })
      expect(config.proxyTransport).toBeDefined()
      expect(JSON.stringify(config.proxy)).not.toContain('dd0123456789abcdef0123456789abcdef')
    } finally {
      if (prev === undefined) delete process.env.TGMCP_PROXY
      else process.env.TGMCP_PROXY = prev
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
