import { describe, expect, test } from 'bun:test'
import { TEST_CONFIG } from '../test/context'
import { buildClientOptions } from './client'
import { parseProxyUrl } from './proxy'

describe('buildClientOptions', () => {
  test('omits transport when no proxy is configured', () => {
    const options = buildClientOptions(TEST_CONFIG)
    expect(options.transport).toBeUndefined()
  })

  test('passes transport when proxy is configured', () => {
    const resolved = parseProxyUrl('socks5://proxy.example.com:1080')
    const options = buildClientOptions({
      ...TEST_CONFIG,
      proxy: resolved.public,
      proxyTransport: resolved.transport,
    })
    expect(options.transport).toBe(resolved.transport)
  })
})
