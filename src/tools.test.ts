import { describe, expect, test } from 'bun:test'
import { buildRegistry, PUBLIC_TOOLS } from './tools'

describe('public MCP surface', () => {
  test('exposes only the hot-path tools plus the telegram knife', () => {
    expect(PUBLIC_TOOLS.map((t) => t.name)).toEqual([
      'list_chats',
      'read_messages',
      'send_message',
      'search_messages',
      'telegram',
    ])
  })

  test('registry rejects nothing on the live set', () => {
    const registry = buildRegistry()
    expect(registry.size).toBe(5)
  })
})
