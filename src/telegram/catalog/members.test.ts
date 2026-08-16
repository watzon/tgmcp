import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tl } from '@mtcute/bun'
import { describe, expect, test } from 'bun:test'
import { makeContext } from '../../test/context'
import { invokeAction } from './index'

describe('ban_member and mute_member', () => {
  test('require an explicit numeric chatId', async () => {
    const ctx = makeContext()
    const ban = await invokeAction('ban_member', { userId: '111' }, ctx)
    expect(ban.ok).toBe(false)
    expect(ban.content).toContain('explicit numeric chatId')

    const mute = await invokeAction('mute_member', { userId: '111' }, ctx)
    expect(mute.ok).toBe(false)
    expect(mute.content).toContain('explicit numeric chatId')
  })

  test('refuse to ban or mute the signed-in account', async () => {
    const ctx = makeContext()
    const ban = await invokeAction('ban_member', { chatId: '-1001', userId: '9001' }, ctx)
    expect(ban.ok).toBe(false)
    expect(ban.content).toContain('signed-in account')

    const mute = await invokeAction('mute_member', { chatId: '-1001', userId: '9001' }, ctx)
    expect(mute.ok).toBe(false)
    expect(mute.content).toContain('signed-in account')
  })

  test('reject a time window shorter than 30 seconds', async () => {
    const result = await invokeAction(
      'ban_member',
      { chatId: '-1001', userId: '111', forSeconds: 10 },
      makeContext(),
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('Invalid params')
  })

  test('bans permanently and with a time window', async () => {
    const calls: unknown[] = []
    const ctx = makeContext({
      banChatMember: async (params) => {
        calls.push(params)
        return null
      },
    })

    const forever = await invokeAction('ban_member', { chatId: '-1001', userId: '111' }, ctx)
    expect(forever.ok).toBe(true)
    expect(forever.content).toContain('permanently')

    const timed = await invokeAction(
      'ban_member',
      { chatId: '-1001', userId: '111', forSeconds: 3600 },
      ctx,
    )
    expect(timed.ok).toBe(true)
    expect(timed.content).toContain('until ')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ chatId: -1001, participantId: 111 })
    expect(calls[1]).toMatchObject({ chatId: -1001, participantId: 111 })
    expect((calls[1] as { untilDate: number }).untilDate).toBeGreaterThan(Date.now())
  })

  test('mutes with sendMessages restricted', async () => {
    const calls: unknown[] = []
    const ctx = makeContext({
      restrictChatMember: async (params) => {
        calls.push(params)
      },
    })
    const result = await invokeAction(
      'mute_member',
      { chatId: '-1001', userId: '222', forSeconds: 120 },
      ctx,
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Muted 222')
    expect(calls[0]).toMatchObject({
      chatId: -1001,
      userId: 222,
      restrictions: { sendMessages: true },
    })
    expect((calls[0] as { until: number }).until).toBeGreaterThan(Date.now())
  })

  test('maps USER_ADMIN_INVALID to a plain message', async () => {
    const ctx = makeContext({
      banChatMember: async () => {
        throw new tl.RpcError(400, 'USER_ADMIN_INVALID')
      },
    })
    const result = await invokeAction('ban_member', { chatId: '-1001', userId: '111' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('is an admin')
    expect(result.content).not.toContain('Telegram API error')
  })
})

describe('inspect_user', () => {
  test('returns bio, saves the profile photo, and attaches an MCP image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-inspect-'))
    const ctx = makeContext({
      getFullUser: async () =>
        ({
          id: 111,
          firstName: 'Ada',
          lastName: null,
          displayName: 'Ada',
          username: 'ada',
          bio: 'hello',
          isBot: false,
          isScam: false,
          isFake: false,
          photo: { small: 'photo-loc' },
        }) as never,
      downloadAsBuffer: async () => Uint8Array.from([0xff, 0xd8, 0xff]),
      getPeerStories: async () => ({ stories: [] }) as never,
    })
    ctx.config.downloadsDir = dir
    const result = await invokeAction('inspect_user', { userId: '111' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('hello')
    expect(result.content).toContain('profile photo attached')
    expect(result.images).toHaveLength(1)
    expect(result.images?.[0]?.mimeType).toBe('image/jpeg')
    expect((result.data as { paths: { profilePhoto: string } }).paths.profilePhoto).toContain('photo.jpg')
    rmSync(dir, { recursive: true, force: true })
  })

  test('still succeeds when the user has no photo or stories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-inspect-'))
    const ctx = makeContext({
      getFullUser: async () =>
        ({
          id: 222,
          firstName: 'Bo',
          lastName: null,
          displayName: 'Bo',
          username: null,
          bio: '',
          isBot: false,
          isScam: false,
          isFake: false,
          photo: null,
        }) as never,
      getPeerStories: async () => {
        throw new Error('no stories')
      },
    })
    ctx.config.downloadsDir = dir
    const result = await invokeAction('inspect_user', { userId: '222' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('(empty)')
    expect(result.content).toContain('no profile photo')
    expect(result.images).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})
