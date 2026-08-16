import { describe, expect, test } from 'bun:test'
import { makeContext } from '../../test/context'
import { invokeAction } from './index'

describe('get_chat_info', () => {
  test('resolves a user dialog through getPeer', async () => {
    const ctx = makeContext({
      getChat: async () => {
        throw new Error('Provided identifier 8560964261 is not a chat or channel')
      },
      getPeer: async () =>
        ({
          type: 'user',
          id: 8560964261,
          displayName: 'Nova',
          username: 'nova',
        }) as never,
    })
    const result = await invokeAction('get_chat_info', { chatId: '8560964261' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('Nova · user · id 8560964261')
    expect(result.data).toEqual({
      id: '8560964261',
      title: 'Nova',
      type: 'user',
      username: 'nova',
    })
  })

  test('resolves a group through getPeer', async () => {
    const ctx = makeContext({
      getPeer: async () =>
        ({
          type: 'chat',
          chatType: 'group',
          id: -4289399041,
          displayName: 'WatzonManor',
          username: null,
        }) as never,
    })
    const result = await invokeAction('get_chat_info', { chatId: '-4289399041' }, ctx)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('WatzonManor · group · id -4289399041')
  })
})
