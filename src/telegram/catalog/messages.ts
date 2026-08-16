// src/telegram/catalog/messages.ts — catalog actions for sending and managing messages.
import { z } from 'zod'
import type { TelegramClient } from '@mtcute/bun'
import type { ToolContext } from '../../types'
import { parseOutbound } from '../markdown'
import { toPeer } from '../normalize'
import {
  MESSAGE_SEARCH_FILTERS,
  renderCompactMessageHits,
  toCompactMessageHit,
  toTlMessagesFilter,
} from '../search'
import { confineToChat, defineAction } from './action'

/** The raw client, typed for the concrete methods catalog actions call (always via guard). */
function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

/** Resolve an optional chatId param to the engaged chat when omitted. */
function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

/** Telegram TL `int` upper bound (signed 32-bit). */
const TL_INT_MAX = 2_147_483_647

/** Nonnegative Unix seconds that fit in a Telegram `int`. */
const tlUnixSeconds = z
  .number()
  .int()
  .nonnegative()
  .max(TL_INT_MAX)

/** Positive Telegram `int` (topic / thread ids). */
const tlPositiveInt = z.number().int().positive().max(TL_INT_MAX)

/** Nonnegative Telegram `int` (message offset_id). */
const tlNonnegInt = z.number().int().nonnegative().max(TL_INT_MAX)

/** Reject inverted date windows before any guard / client work. */
function withOrderedDateRange<T extends { minDate?: number; maxDate?: number }>(
  schema: z.ZodType<T>,
): z.ZodType<T> {
  return schema.refine(
    (value) =>
      value.minDate === undefined ||
      value.maxDate === undefined ||
      value.minDate <= value.maxDate,
    { message: 'minDate must be less than or equal to maxDate', path: ['minDate'] },
  )
}



const react = defineAction({
  name: 'react',
  description: 'Add an emoji reaction to a message.',
  domain: 'messages',
  risk: 'safe',
  schema: z.object({
    messageId: z.number().int(),
    emoji: z.string().min(1).describe('A single unicode emoji, e.g. "👀".'),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.react(chatId, p.messageId, p.emoji)
    return { ok: true, content: `Reacted ${p.emoji} to message #${p.messageId}.` }
  },
})

const pin = defineAction({
  name: 'pin',
  description: 'Pin a message in a chat.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    messageId: z.number().int(),
    chatId: z.string().optional(),
    notify: z.boolean().optional(),
    bothSides: z.boolean().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('caution', 'pin', chatId, () =>
      client(ctx).pinMessage({
        chatId: toPeer(chatId),
        message: p.messageId,
        notify: p.notify,
        bothSides: p.bothSides,
      }),
    )
    return { ok: true, content: `Pinned message #${p.messageId}.` }
  },
})

const unpin = defineAction({
  name: 'unpin',
  description: 'Unpin a previously pinned message in a chat.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({ messageId: z.number().int(), chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('caution', 'unpin', chatId, () =>
      client(ctx).unpinMessage({ chatId: toPeer(chatId), message: p.messageId }),
    )
    return { ok: true, content: `Unpinned message #${p.messageId}.` }
  },
})

const forward = defineAction({
  name: 'forward',
  description: 'Forward one or more messages from one chat to another.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    fromChatId: z.string(),
    toChatId: z.string(),
    messageIds: z.array(z.number().int()).min(1),
  }),
  async run(p, ctx) {
    // Both endpoints must be the current chat unless the owner asked: forwarding
    // OUT of another chat or INTO another chat is a cross-chat exfiltration.
    const deniedTo = confineToChat(ctx, p.toChatId)
    if (deniedTo) return deniedTo
    const deniedFrom = confineToChat(ctx, p.fromChatId)
    if (deniedFrom) return deniedFrom
    // shouldDispatch routes the forwarded copy back through ingest for persistence + FTS.
    const sent = await ctx.tg.guard('caution', 'forward', p.toChatId, () =>
      client(ctx).forwardMessagesById({
        toChatId: toPeer(p.toChatId),
        fromChatId: toPeer(p.fromChatId),
        messages: p.messageIds,
        shouldDispatch: true,
      }),
    )
    return {
      ok: true,
      content: `Forwarded ${p.messageIds.length} message(s) to ${p.toChatId}.`,
      data: { count: sent.length },
    }
  },
})

const editMessage = defineAction({
  name: 'edit_message',
  description: 'Edit the text of one of your own messages.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    messageId: z.number().int(),
    text: z.string().min(1),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('caution', 'edit_message', chatId, () =>
      client(ctx).editMessage({
        chatId: toPeer(chatId),
        message: p.messageId,
        text: parseOutbound(p.text),
      }),
    )
    return { ok: true, content: `Edited message #${p.messageId}.` }
  },
})

const deleteMessage = defineAction({
  name: 'delete_message',
  description: 'Delete one or more messages in a chat.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    messageIds: z.array(z.number().int()).min(1),
    chatId: z.string().optional(),
    revoke: z.boolean().optional().describe('Delete for everyone (default true).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('caution', 'delete_message', chatId, () =>
      client(ctx).deleteMessagesById(toPeer(chatId), p.messageIds, { revoke: p.revoke }),
    )
    return { ok: true, content: `Deleted ${p.messageIds.length} message(s).` }
  },
})


const sendPoll = defineAction({
  name: 'send_poll',
  description: 'Send a poll with two or more answer choices to a chat.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    question: z.string().min(1).max(255),
    answers: z.array(z.string().min(1).max(100)).min(2).max(10),
    chatId: z.string().optional(),
    public: z.boolean().optional().describe('Show which users chose each answer.'),
    multiple: z.boolean().optional().describe('Allow voters to choose multiple answers.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const msg = await ctx.tg.guard('caution', 'send_poll', chatId, () =>
      client(ctx).sendMedia(
        toPeer(chatId),
        {
          type: 'poll',
          question: p.question,
          answers: p.answers,
          public: p.public,
          multiple: p.multiple,
        },
        { shouldDispatch: true },
      ),
    )
    return { ok: true, content: `Sent poll (message #${msg.id}).`, data: { id: msg.id } }
  },
})

const sendScheduled = defineAction({
  name: 'send_scheduled',
  description: 'Schedule a text message to be sent at a future time.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    text: z.string().min(1),
    scheduleAt: z
      .number()
      .int()
      .positive()
      .describe('Scheduled send time as a Unix timestamp in milliseconds.'),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const msg = await ctx.tg.guard('caution', 'send_scheduled', chatId, () =>
      client(ctx).sendText(toPeer(chatId), parseOutbound(p.text), {
        schedule: p.scheduleAt,
        shouldDispatch: true,
      }),
    )
    return {
      ok: true,
      content: `Scheduled message #${msg.id} for ${new Date(p.scheduleAt).toISOString()}.`,
      data: { id: msg.id, scheduleAt: p.scheduleAt },
    }
  },
})

const listScheduled = defineAction({
  name: 'list_scheduled',
  description: 'List pending scheduled messages in a chat.',
  domain: 'messages',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const messages = await ctx.tg.guard('safe', 'list_scheduled', chatId, () =>
      client(ctx).getAllScheduledMessages(toPeer(chatId)),
    )
    const rows = messages.map((message) => ({
      id: message.id,
      text: message.text,
      scheduleAt: message.date.toISOString(),
    }))
    const content = rows.length
      ? rows.map((row) => `#${row.id} · ${row.scheduleAt} · ${row.text}`).join('\n')
      : '(no scheduled messages)'
    return { ok: true, content, data: rows }
  },
})

const deleteScheduled = defineAction({
  name: 'delete_scheduled',
  description: 'Delete one or more pending scheduled messages from a chat.',
  domain: 'messages',
  risk: 'caution',
  schema: z.object({
    messageIds: z.array(z.number().int()).min(1),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.guard('caution', 'delete_scheduled', chatId, () =>
      client(ctx).deleteScheduledMessages(toPeer(chatId), p.messageIds),
    )
    return { ok: true, content: `Deleted ${p.messageIds.length} scheduled message(s).` }
  },
})

const searchFilterSchema = z
  .enum(MESSAGE_SEARCH_FILTERS)
  .describe(
    'Optional Telegram messages filter (photo, video, document, url, voice, pinned, poll, …).',
  )

const searchMessages = defineAction({
  name: 'search_messages',
  description:
    'Search Telegram server-side history inside one chat. Requires a numeric chatId. Supports optional sender, date range, media filter, and forum topic.',
  domain: 'messages',
  risk: 'safe',
  schema: withOrderedDateRange(
    z.object({
      query: z.string().describe('Text query. Empty string is allowed when filtering by media type only.'),
      chatId: z.string().optional().describe('Chat to search. Required when called from MCP.'),
      fromUserId: z
        .string()
        .optional()
        .describe('Only messages sent by this user id (numeric peer id string).'),
      minDate: tlUnixSeconds
        .optional()
        .describe('Only messages at or after this Unix timestamp (seconds).'),
      maxDate: tlUnixSeconds
        .optional()
        .describe('Only messages at or before this Unix timestamp (seconds).'),
      filter: searchFilterSchema.optional(),
      topicId: tlPositiveInt
        .optional()
        .describe('Forum topic id; mapped to Telegram threadId server-side.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Max hits (default 20, max 100).'),
      offset: tlNonnegInt
        .optional()
        .describe('Only return messages earlier than this message id (Telegram offset_id).'),
    }),
  ),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    // Deny foreign-chat reads before any network / peer resolution work.
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied

    const limit = p.limit ?? 20
    // Ledger/rate-limit against the engaged chat so owner foreign reads of
    // unadmitted groups are not blocked by outbound admission on the target.
    // The authorized target is passed only to the client search call.
    const messages = await ctx.tg.guard('safe', 'search_messages', ctx.chatId, () =>
      client(ctx).searchMessages({
        chatId: toPeer(chatId),
        query: p.query,
        fromUser: p.fromUserId !== undefined ? toPeer(p.fromUserId) : undefined,
        minDate: p.minDate,
        maxDate: p.maxDate,
        filter: p.filter !== undefined ? toTlMessagesFilter(p.filter) : undefined,
        threadId: p.topicId,
        limit,
        offset: p.offset,
      }),
    )

    const hits = messages.map(toCompactMessageHit)
    const content =
      hits.length === 0
        ? `No messages in chat ${chatId} matched "${p.query}".`
        : renderCompactMessageHits(hits)
    return {
      ok: true,
      content,
      data: { count: hits.length, hits },
    }
  },
})

const searchGlobal = defineAction({
  name: 'search_global',
  description:
    'Owner-only. Search Telegram server-side history across all chats (messages.searchGlobal).',
  domain: 'messages',
  risk: 'owner',
  schema: withOrderedDateRange(
    z.object({
      query: z.string().describe('Text query. Use "@" to search for mentions of yourself.'),
      minDate: tlUnixSeconds
        .optional()
        .describe('Only messages at or after this Unix timestamp (seconds).'),
      maxDate: tlUnixSeconds
        .optional()
        .describe('Only messages at or before this Unix timestamp (seconds).'),
      filter: searchFilterSchema.optional(),
      onlyChannels: z
        .boolean()
        .optional()
        .describe('When true, only search broadcast channels.'),
      limit: z
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe('Max hits (default 20, max 100).'),
    }),
  ),
  async run(p, ctx) {
    // Owner gate is also enforced by invokeAction for risk:'owner'; guard still
    // ledgers the call against the engaged chat for rate-limit accounting.
    const limit = p.limit ?? 20
    const messages = await ctx.tg.guard('owner', 'search_global', ctx.chatId, () =>
      client(ctx).searchGlobal({
        query: p.query,
        minDate: p.minDate,
        maxDate: p.maxDate,
        filter: p.filter !== undefined ? toTlMessagesFilter(p.filter) : undefined,
        onlyChannels: p.onlyChannels,
        limit,
      }),
    )

    const hits = messages.map(toCompactMessageHit)
    const content =
      hits.length === 0
        ? `No messages matched "${p.query}" across chats.`
        : renderCompactMessageHits(hits, { includeChatId: true })
    return {
      ok: true,
      content,
      data: { count: hits.length, hits },
    }
  },
})


export const messageActions = [
  react,
  pin,
  unpin,
  forward,
  editMessage,
  deleteMessage,
  sendPoll,
  sendScheduled,
  listScheduled,
  deleteScheduled,
  searchMessages,
  searchGlobal,
]
