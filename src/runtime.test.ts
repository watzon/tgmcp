import { describe, expect, test } from 'bun:test'
import type { TelegramClient, User } from '@mtcute/bun'
import { createRuntime } from './runtime'
import { TEST_CONFIG } from './test/context'

describe('runtime', () => {
  test('fails closed when the live session does not match ownerId', async () => {
    await expect(
      createRuntime(
        { ...TEST_CONFIG, ownerId: '1' },
        {} as TelegramClient,
        { id: 2, displayName: 'Ada' } as User,
      ),
    ).rejects.toThrow(/does not match configured ownerId/)
  })
})
