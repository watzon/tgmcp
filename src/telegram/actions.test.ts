import { describe, expect, test } from 'bun:test'
import type { TelegramClient } from '@mtcute/node'
import { TEST_CONFIG } from '../test/context'
import type { LedgerEntry } from '../types'
import { createActions } from './actions'

describe('outbound guard', () => {
  test('refuses denylisted chats and writes a failure ledger row', async () => {
    const ledger: LedgerEntry[] = []
    const tg = createActions(
      {} as TelegramClient,
      { ...TEST_CONFIG, denylist: ['123'] },
      async (entry) => {
        ledger.push(entry)
      },
    )
    await expect(tg.guard('safe', 'send_message', '123', async () => 1)).rejects.toThrow(/denylist/)
    expect(ledger).toEqual([
      { chatId: '123', action: 'send_message', risk: 'safe', ok: false, detail: 'chat 123 is on the denylist' },
    ])
  })

  test('ledgers a successful guarded call', async () => {
    const ledger: LedgerEntry[] = []
    const tg = createActions({} as TelegramClient, TEST_CONFIG, async (entry) => {
      ledger.push(entry)
    })
    const value = await tg.guard('safe', 'get_me', '9001', async () => 42)
    expect(value).toBe(42)
    expect(ledger).toEqual([{ chatId: '9001', action: 'get_me', risk: 'safe', ok: true }])
  })
})
