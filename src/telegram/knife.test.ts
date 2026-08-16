import { describe, expect, test } from 'bun:test'
import { makeContext } from '../test/context'
import { knifeTool } from './knife'

describe('telegram knife', () => {
  test('empty search lists core actions and omits join_chat', async () => {
    const result = await knifeTool.execute({ command: 'search', query: '' }, makeContext())
    expect(result.ok).toBe(true)
    expect(result.content).toContain('search_messages')
    expect(result.content).not.toContain('join_chat')
  })

  test('search returns compact action cards including extended matches', async () => {
    const result = await knifeTool.execute({ command: 'search', query: 'draft' }, makeContext())
    expect(result.ok).toBe(true)
    expect(result.content).toContain('get_draft')
    expect(Array.isArray(result.data)).toBe(true)
  })

  test('describe returns a schema', async () => {
    const result = await knifeTool.execute({ command: 'describe', name: 'edit_message' }, makeContext())
    expect(result.ok).toBe(true)
    expect(result.content).toContain('params:')
  })

  test('invoke runs a catalog action', async () => {
    const result = await knifeTool.execute(
      { command: 'invoke', name: 'get_me', params: {} },
      makeContext({
        getMe: async () => ({ displayName: 'Ada', username: null, id: 9001 }) as never,
      }),
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('Ada')
  })

  test('unknown describe name fails closed', async () => {
    const result = await knifeTool.execute({ command: 'describe', name: 'nope' }, makeContext())
    expect(result.ok).toBe(false)
  })
})
