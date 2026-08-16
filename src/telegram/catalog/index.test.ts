import { describe, expect, test } from 'bun:test'
import { makeContext } from '../../test/context'
import { CORE_ACTION_NAMES, describeAction, invokeAction, listActions, searchActions } from './index'

describe('action catalog', () => {
  test('lists curated actions and never includes authorize_chat', () => {
    const names = listActions().map((a) => a.name)
    expect(names.length).toBeGreaterThan(30)
    expect(names).not.toContain('authorize_chat')
    expect(names).not.toContain('revoke_chat_authorization')
    expect(names).toContain('pin')
    expect(names).toContain('get_me')
    expect(names).toContain('interact_message')
    expect(names).toContain('join_chat')
    expect(names).toContain('react')
  })

  test('empty search lists core inbox actions and hides account-admin', () => {
    const names = searchActions('').map((a) => a.name)
    expect(names.length).toBe(CORE_ACTION_NAMES.size)
    expect(names).toContain('search_messages')
    expect(names).toContain('get_chat_info')
    expect(names).toContain('react')
    expect(names).not.toContain('join_chat')
    expect(names).not.toContain('leave_chat')
    expect(names).not.toContain('set_bio')
    expect(names).not.toContain('list_folders')
    expect(names).not.toContain('ban_member')
    expect(names).not.toContain('mute_member')
    for (const name of CORE_ACTION_NAMES) {
      expect(listActions().some((a) => a.name === name)).toBe(true)
    }
  })

  test('search ranks name hits and can still find account-admin actions', () => {
    const pins = searchActions('pin topic')
    expect(pins.some((a) => a.name === 'pin' || a.name === 'pin_topic')).toBe(true)
    expect(searchActions('join').some((a) => a.name === 'join_chat')).toBe(true)
    expect(searchActions('ban').some((a) => a.name === 'ban_member')).toBe(true)
    expect(searchActions('mute member').some((a) => a.name === 'mute_member')).toBe(true)
    expect(searchActions('no-such-action-xyz')).toEqual([])
  })

  test('describe returns JSON schema for a known action', () => {
    const info = describeAction('pin')
    expect(info?.name).toBe('pin')
    expect(info?.domain).toBe('messages')
    expect(info?.schema).toBeDefined()
    expect(describeAction('missing')).toBeNull()
  })

  test('invoke requires an explicit numeric chatId on chat-scoped actions', async () => {
    const ctx = makeContext()
    const missing = await invokeAction('pin', { messageId: 1 }, ctx)
    expect(missing.ok).toBe(false)
    expect(missing.content).toContain('explicit numeric chatId')

    const bad = await invokeAction('pin', { messageId: 1, chatId: '@name' }, ctx)
    expect(bad.ok).toBe(false)

    const unknown = await invokeAction('nope', {}, ctx)
    expect(unknown.ok).toBe(false)
    expect(unknown.content).toContain('Unknown action')
  })

  test('invoke rejects invalid params after chatId is present', async () => {
    const ctx = makeContext()
    const result = await invokeAction('pin', { chatId: '-1001' }, ctx)
    expect(result.ok).toBe(false)
    expect(result.content).toContain('Invalid params')
  })

  test('get_me does not require a chatId', async () => {
    const ctx = makeContext({
      getMe: async () => ({ displayName: 'Ada', username: 'ada', id: 9001 }) as never,
    })
    const result = await invokeAction('get_me', {}, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Ada')
  })
})
