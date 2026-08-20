import { describe, expect, test } from 'bun:test'
import { normalizeProxyUrl, parseProxyUrl, publicProxyFromUrl } from './proxy'

const FAKE_MTPROXY_SECRET = 'dd0123456789abcdef0123456789abcdef'

describe('normalizeProxyUrl', () => {
  test('accepts socks5 with credentials', () => {
    expect(normalizeProxyUrl('socks5://alice:secret@proxy.example.com:1080')).toBe(
      'socks5://alice:secret@proxy.example.com:1080',
    )
  })

  test('accepts socks4', () => {
    expect(normalizeProxyUrl('socks4://proxy.example.com:1080')).toBe('socks4://proxy.example.com:1080')
  })

  test('accepts http and https', () => {
    expect(normalizeProxyUrl('http://proxy.example.com:8080')).toBe('http://proxy.example.com:8080')
    expect(normalizeProxyUrl('https://proxy.example.com:8443')).toBe('https://proxy.example.com:8443')
  })

  test('normalizes mtproxy query secret to tg deeplink', () => {
    expect(normalizeProxyUrl(`mtproxy://proxy.example.com:443?secret=${FAKE_MTPROXY_SECRET}`)).toBe(
      `tg://proxy?server=proxy.example.com&port=443&secret=${FAKE_MTPROXY_SECRET}`,
    )
  })

  test('normalizes mtproxy fragment secret to tg deeplink', () => {
    expect(normalizeProxyUrl(`mtproxy://proxy.example.com:443#${FAKE_MTPROXY_SECRET}`)).toBe(
      `tg://proxy?server=proxy.example.com&port=443&secret=${FAKE_MTPROXY_SECRET}`,
    )
  })

  test('passes through tg proxy deeplinks', () => {
    const url = `tg://proxy?server=proxy.example.com&port=443&secret=${FAKE_MTPROXY_SECRET}`
    expect(normalizeProxyUrl(url)).toBe(url)
  })

  test('rejects empty input', () => {
    expect(() => normalizeProxyUrl('   ')).toThrow('Proxy URL is empty.')
  })

  test('rejects unsupported protocols', () => {
    expect(() => normalizeProxyUrl('ftp://proxy.example.com:21')).toThrow('Unsupported proxy protocol')
  })

  test('rejects mtproxy without secret', () => {
    expect(() => normalizeProxyUrl('mtproxy://proxy.example.com:443')).toThrow('requires a secret')
  })

  test('rejects mtproxy without port', () => {
    expect(() => normalizeProxyUrl('mtproxy://proxy.example.com#abcd')).toThrow('host:port')
  })
})

describe('publicProxyFromUrl', () => {
  test('returns public fields only', () => {
    expect(publicProxyFromUrl('socks5://user:pass@proxy.example.com:1080')).toEqual({
      type: 'socks5',
      host: 'proxy.example.com',
      port: 1080,
    })
  })

  test('parses tg proxy deeplinks without exposing secret', () => {
    const info = publicProxyFromUrl(
      `tg://proxy?server=proxy.example.com&port=443&secret=${FAKE_MTPROXY_SECRET}`,
    )
    expect(info).toEqual({ type: 'mtproxy', host: 'proxy.example.com', port: 443 })
    expect(JSON.stringify(info)).not.toContain(FAKE_MTPROXY_SECRET)
  })

  test('parses mtproxy fragment form', () => {
    expect(publicProxyFromUrl(`mtproxy://proxy.example.com:8443#${FAKE_MTPROXY_SECRET}`)).toEqual({
      type: 'mtproxy',
      host: 'proxy.example.com',
      port: 8443,
    })
  })
})

describe('parseProxyUrl', () => {
  test('returns a transport for supported proxies', () => {
    const resolved = parseProxyUrl('socks5://proxy.example.com:1080')
    expect(resolved.public).toEqual({ type: 'socks5', host: 'proxy.example.com', port: 1080 })
    expect(resolved.transport).toBeDefined()
    expect(typeof resolved.transport.connect).toBe('function')
  })

  test('returns mtproxy transport', () => {
    const resolved = parseProxyUrl(`mtproxy://proxy.example.com:443?secret=${FAKE_MTPROXY_SECRET}`)
    expect(resolved.public.type).toBe('mtproxy')
    expect(resolved.transport).toBeDefined()
  })
})
