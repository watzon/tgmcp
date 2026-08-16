import { describe, expect, test } from 'bun:test'
import { makeContext } from '../test/context'
import { tier1Tools } from './tier1'

function tool(name: string) {
  const found = tier1Tools.find((t) => t.name === name)
  if (!found) throw new Error(name)
  return found
}

describe('hot-path tools', () => {
  test('send_message schema requires a numeric chatId', () => {
    const parsed = tool('send_message').schema.safeParse({ text: 'hi' })
    expect(parsed.success).toBe(false)
  })

  test('send_message rejects a non-numeric chatId', async () => {
    const result = await tool('send_message').execute({ chatId: '@ada', text: 'hi' }, makeContext())
    expect(result.ok).toBe(false)
    expect(result.content).toContain('explicit numeric chatId')
  })

  test('send_message sends when chatId is present', async () => {
    const ctx = makeContext()
    const result = await tool('send_message').execute({ chatId: '123', text: 'hi' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Sent')
  })

  test('read_messages returns an empty transcript', async () => {
    const result = await tool('read_messages').execute({ chatId: '123' }, makeContext())
    expect(result.ok).toBe(true)
    expect(result.content).toBe('(no messages)')
  })

  test('search_messages schema requires a numeric chatId', () => {
    const parsed = tool('search_messages').schema.safeParse({ query: 'hello' })
    expect(parsed.success).toBe(false)
  })

  test('list_chats filters by query', async () => {
    const ctx = makeContext()
    ctx.tg.listDialogs = async () => [
      { chatId: '1', title: 'Ada', type: 'user', unread: 0 },
      { chatId: '2', title: 'Work', type: 'group', unread: 3 },
    ]
    const result = await tool('list_chats').execute({ query: 'work' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Work')
    expect(result.content).not.toContain('Ada')
  })
})
