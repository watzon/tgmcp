import { tl } from '@mtcute/bun'
import { describe, expect, test } from 'bun:test'
import { makeContext } from '../../test/context'
import { invokeAction } from './index'

describe('list_topics errors', () => {
  test('maps CHANNEL_FORUM_MISSING to a plain not-a-forum message', async () => {
    const ctx = makeContext({
      getForumTopics: async () => {
        throw new tl.RpcError(400, 'CHANNEL_FORUM_MISSING')
      },
    })
    const result = await invokeAction('list_topics', { chatId: '-1001' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('not a forum')
    expect(result.content).toContain('-1001')
    expect(result.content).not.toContain('Telegram API error')
  })

  test('maps CHANNEL_INVALID to a plain cannot-host-topics message', async () => {
    const ctx = makeContext({
      getForumTopics: async () => {
        throw new tl.RpcError(400, 'CHANNEL_INVALID')
      },
    })
    const result = await invokeAction('list_topics', { chatId: '-4289399041' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('cannot host forum topics')
    expect(result.content).not.toContain('CHANNEL_INVALID')
  })

  test('still lists topics when the client returns rows', async () => {
    const ctx = makeContext({
      getForumTopics: async () =>
        [
          {
            id: 12,
            title: 'General',
            isClosed: false,
            isPinned: true,
            iconColor: null,
            iconCustomEmoji: null,
            unreadCount: 3,
            date: new Date('2026-01-01T00:00:00Z'),
          },
        ] as never,
    })
    const result = await invokeAction('list_topics', { chatId: '-1002227055969' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('#12 · General · pinned · 3 unread')
  })
})
