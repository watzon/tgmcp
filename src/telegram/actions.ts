import { tl, type TelegramClient } from '@mtcute/node'
import type { TgmcpConfig } from '../config'
import type { LedgerEntry, RiskTier, StoredMessage, TelegramActions } from '../types'
import { parseOutbound } from './markdown'
import { messageToStored, toPeer } from './normalize'

export type LedgerFn = (entry: LedgerEntry) => Promise<void>

const CAUTION_SPACING_MULTIPLIER = 3
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class RateLimiter {
  private lastByChat = new Map<string, number>()
  private globalWindow: number[] = []
  private tailByChat = new Map<string, Promise<void>>()

  constructor(private readonly limits: TgmcpConfig['rateLimits']) {}

  async acquire(chatId: string, risk: RiskTier = 'safe'): Promise<void> {
    const prior = this.tailByChat.get(chatId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this.tailByChat.set(chatId, current)
    await prior

    try {
      const { perChatMs, globalPerHour } = this.limits
      const spacing = risk === 'caution' ? perChatMs * CAUTION_SPACING_MULTIPLIER : perChatMs
      const last = this.lastByChat.get(chatId)
      if (last !== undefined) {
        const wait = spacing - (Date.now() - last)
        if (wait > 0) await sleep(wait)
      }

      const stamp = Date.now()
      const cutoff = stamp - 3_600_000
      this.globalWindow = this.globalWindow.filter((t) => t > cutoff)
      if (this.globalWindow.length >= globalPerHour) {
        throw new Error(
          `Global outbound rate limit reached (${globalPerHour}/hour); action refused.`,
        )
      }

      this.lastByChat.set(chatId, stamp)
      this.globalWindow.push(stamp)
    } finally {
      release()
      if (this.tailByChat.get(chatId) === current) this.tailByChat.delete(chatId)
    }
  }
}

function floodWaitSeconds(err: unknown): number | null {
  if (err instanceof tl.RpcError && err.is('FLOOD_WAIT_%d')) {
    return err.seconds
  }
  return null
}

export function createActions(
  client: TelegramClient,
  config: TgmcpConfig,
  ledgerFn: LedgerFn,
): TelegramActions {
  const limiter = new RateLimiter(config.rateLimits)
  let floodBlockedUntil = 0
  let floodWait: Promise<void> | null = null

  function blockForFlood(seconds: number): Promise<void> {
    floodBlockedUntil = Math.max(floodBlockedUntil, Date.now() + Math.max(0, seconds) * 1000)
    if (!floodWait) {
      floodWait = (async () => {
        while (true) {
          const remaining = floodBlockedUntil - Date.now()
          if (remaining <= 0) return
          await sleep(remaining)
        }
      })().finally(() => {
        floodWait = null
      })
    }
    return floodWait
  }

  async function waitForFloodClear(): Promise<void> {
    while (Date.now() < floodBlockedUntil) {
      const pending = floodWait
      if (pending) await pending
      else await sleep(floodBlockedUntil - Date.now())
    }
  }

  async function refuse(
    risk: RiskTier,
    action: string,
    chatId: string,
    detail: string,
    message: string,
  ): Promise<never> {
    await ledgerFn({ chatId, action, risk, ok: false, detail })
    throw new Error(message)
  }

  async function guard<T>(
    risk: RiskTier,
    action: string,
    chatId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (chatId !== 'system' && config.denylist.includes(chatId)) {
      await refuse(
        risk,
        action,
        chatId,
        `chat ${chatId} is on the denylist`,
        `Refused: ${action} targets chat ${chatId}, which is on the hard denylist.`,
      )
    }

    await waitForFloodClear()
    await limiter.acquire(chatId, risk)
    await waitForFloodClear()
    try {
      let result: T
      try {
        result = await fn()
      } catch (err) {
        const secs = floodWaitSeconds(err)
        if (secs === null) throw err
        await blockForFlood(secs)
        try {
          result = await fn()
        } catch (retryError) {
          const retrySecs = floodWaitSeconds(retryError)
          if (retrySecs !== null) void blockForFlood(retrySecs)
          throw retryError
        }
      }
      await ledgerFn({ chatId, action, risk, ok: true })
      return result
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      await ledgerFn({ chatId, action, risk, ok: false, detail })
      throw err
    }
  }

  async function sendOutbound(
    chatId: string,
    text: string,
    opts: {
      action: 'send_message' | 'reply'
      replyToId?: number
      threadId?: number
      quoteText?: string
      quoteOffset?: number
      format?: 'markdown' | 'plain'
    },
  ): Promise<{ id: number }> {
    if (opts.quoteOffset !== undefined && opts.quoteText === undefined) {
      throw new Error('quoteOffset requires quoteText')
    }
    if (opts.quoteText !== undefined && opts.replyToId === undefined) {
      throw new Error('quoteText requires replyToId')
    }

    const outbound = opts.format === 'plain' ? text : parseOutbound(text)
    const risk = opts.format === 'plain' ? 'caution' : 'safe'

    const msg = await guard(risk, opts.action, chatId, () =>
      client.sendText(toPeer(chatId), outbound, {
        ...(opts.replyToId !== undefined ? { replyTo: opts.replyToId } : {}),
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.quoteText !== undefined ? { quote: { text: opts.quoteText } } : {}),
        ...(opts.quoteOffset !== undefined ? { quoteOffset: opts.quoteOffset } : {}),
      }),
    )
    return { id: msg.id }
  }

  return {
    client,
    guard,

    async sendText(chatId, text, opts) {
      return sendOutbound(chatId, text, {
        action: 'send_message',
        replyToId: opts?.replyToId,
        threadId: opts?.threadId,
        quoteText: opts?.quoteText,
        quoteOffset: opts?.quoteOffset,
        format: opts?.format,
      })
    },

    async reply(chatId, replyToId, text, opts) {
      return sendOutbound(chatId, text, {
        action: 'reply',
        replyToId,
        threadId: opts?.threadId,
        quoteText: opts?.quoteText,
        quoteOffset: opts?.quoteOffset,
      })
    },

    async react(chatId, messageId, emoji) {
      await guard('safe', 'react', chatId, () =>
        client.sendReaction({ chatId: toPeer(chatId), message: messageId, emoji }),
      )
    },

    async readHistory(chatId) {
      await guard('safe', 'read_history', chatId, () => client.readHistory(toPeer(chatId)))
    },

    async setTyping(chatId, on) {
      await guard('safe', on ? 'typing_on' : 'typing_off', chatId, () =>
        client.setTyping({ peerId: toPeer(chatId), status: on ? 'typing' : 'cancel' }),
      )
    },

    async getHistory(chatId, opts) {
      const messages =
        opts?.topicId !== undefined
          ? await client.searchMessages({
              chatId: toPeer(chatId),
              threadId: opts.topicId,
              limit: opts?.limit,
            })
          : await client.getHistory(toPeer(chatId), { limit: opts?.limit })
      return messages.map((m): StoredMessage => messageToStored(m))
    },

    async listDialogs(opts) {
      const out: Array<{ chatId: string; title: string; type: string; unread: number }> = []
      let count = 0
      const limit = opts?.limit ?? 100
      for await (const dialog of client.iterDialogs({ limit })) {
        const peer = dialog.peer
        out.push({
          chatId: String(peer.id),
          title: peer.displayName,
          type: peer.type === 'user' ? 'user' : peer.chatType,
          unread: dialog.unreadCount,
        })
        if (++count >= limit) break
      }
      return out
    },
  }
}
