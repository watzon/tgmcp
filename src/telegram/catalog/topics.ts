// src/telegram/catalog/topics.ts — catalog actions for Telegram forum topics.
import { z } from 'zod'
import { tl, type ForumTopic, type Message, type TelegramClient } from '@mtcute/node'
import Long from 'long'
import type { RiskTier, ToolContext, ToolResult } from '../../types'
import { mediaSummary, toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

/** Compact, model-safe topic card — never raw TL. */
function shapeTopic(topic: ForumTopic): {
  id: number
  title: string
  isClosed: boolean
  isPinned: boolean
  iconColor: number | null
  iconCustomEmoji: string | null
  unreadCount: number
  date: number
} {
  return {
    id: topic.id,
    title: topic.title,
    isClosed: topic.isClosed,
    isPinned: topic.isPinned,
    iconColor: topic.iconColor,
    iconCustomEmoji: topic.iconCustomEmoji != null ? String(topic.iconCustomEmoji) : null,
    unreadCount: topic.unreadCount,
    date: Math.floor(topic.date.getTime() / 1000),
  }
}

/** Compact message hit for topic history — never raw TL. */
function shapeMessage(msg: Message): {
  chatId: string
  id: number
  senderId: string
  senderName: string
  text: string
  date: number
  replyToId: number | null
  mediaSummary: string | null
} {
  return {
    chatId: String(msg.chat.id),
    id: msg.id,
    senderId: String(msg.sender.id),
    senderName: msg.sender.displayName,
    text: msg.text,
    date: Math.floor(msg.date.getTime() / 1000),
    replyToId: msg.replyToMessage?.id ?? null,
    mediaSummary: mediaSummary(msg),
  }
}

/**
 * Canonical forum topic id from a create service message.
 * Never assume the service message's own id — that is bot-side in threaded PMs
 * and is not what other APIs (or Bot API message_thread_id) expect.
 * Prefer replyToMessage.threadId; fall back to ForumTopic.id when a topic object is available.
 */
function topicIdFromCreateResult(msg: Message, topic?: ForumTopic | null): number | null {
  if (topic && typeof topic.id === 'number' && topic.id > 0) return topic.id
  const fromReply = msg.replyToMessage?.threadId
  if (typeof fromReply === 'number' && fromReply > 0) return fromReply
  return null
}

function parseIconCustomEmoji(value: string): Long {
  return Long.fromString(value, true)
}

/** Map raw forum RPC errors to a model-safe result. Null means rethrow. */
export function mapForumError(chatId: string, err: unknown): ToolResult | null {
  if (!(err instanceof tl.RpcError)) return null
  if (err.is('CHANNEL_FORUM_MISSING')) {
    return {
      ok: false,
      content: `Chat ${chatId} is not a forum. Topic actions only work on forum-enabled supergroups.`,
    }
  }
  if (err.is('CHANNEL_INVALID')) {
    return {
      ok: false,
      content: `Chat ${chatId} cannot host forum topics. Use a forum-enabled supergroup, not a basic group, channel, or DM.`,
    }
  }
  return null
}

async function forumGuard<T>(
  ctx: ToolContext,
  risk: RiskTier,
  action: string,
  chatId: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | ToolResult> {
  try {
    return { ok: true, value: await ctx.tg.guard(risk, action, chatId, fn) }
  } catch (err) {
    const mapped = mapForumError(chatId, err)
    if (mapped) return mapped
    throw err
  }
}

const listTopics = defineAction({
  name: 'list_topics',
  description: 'List forum topics in a group (title, closed/pinned, unread counts).',
  domain: 'topics',
  risk: 'safe',
  schema: z.object({
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
    query: z.string().optional().describe('Optional title search filter.'),
    limit: z.number().int().positive().max(100).optional().describe('Max topics to return (default 100).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const got = await forumGuard(ctx, 'safe', 'list_topics', chatId, () =>
      client(ctx).getForumTopics(toPeer(chatId), {
        query: p.query,
        limit: p.limit ?? 100,
      }),
    )
    if (!('value' in got)) return got
    const rows = got.value.map(shapeTopic)
    const content = rows.length
      ? rows
          .map((t) => {
            const flags = [
              t.isPinned ? 'pinned' : null,
              t.isClosed ? 'closed' : null,
            ].filter(Boolean)
            const flagStr = flags.length ? ` · ${flags.join(',')}` : ''
            const unread = t.unreadCount > 0 ? ` · ${t.unreadCount} unread` : ''
            return `#${t.id} · ${t.title}${flagStr}${unread}`
          })
          .join('\n')
      : '(no topics)'
    return { ok: true, content, data: rows }
  },
})

const readTopicHistory = defineAction({
  name: 'read_topic_history',
  description: 'Read recent messages inside one forum topic (server-side thread search).',
  domain: 'topics',
  risk: 'safe',
  schema: z.object({
    topicId: z.number().int().positive().describe('Forum topic id (top message / thread id).'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
    limit: z.number().int().positive().max(100).optional().describe('Max messages (default 50).'),
    query: z.string().optional().describe('Optional text filter inside the topic.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const got = await forumGuard(ctx, 'safe', 'read_topic_history', chatId, () =>
      client(ctx).searchMessages({
        chatId: toPeer(chatId),
        threadId: p.topicId,
        query: p.query ?? '',
        limit: p.limit ?? 50,
      }),
    )
    if (!('value' in got)) return got
    const rows = got.value.map(shapeMessage)
    const content = rows.length
      ? rows
          .map((m) => {
            const who = m.senderName || m.senderId
            const media = m.mediaSummary ? ` [${m.mediaSummary}]` : ''
            const body = m.text || (m.mediaSummary ? '' : '(no text)')
            return `#${m.id} · ${who}: ${body}${media}`.trimEnd()
          })
          .join('\n')
      : '(no messages in topic)'
    return { ok: true, content, data: rows }
  },
})

const createTopic = defineAction({
  name: 'create_topic',
  description: 'Create a new forum topic in a group (requires manage-topics rights).',
  domain: 'topics',
  risk: 'caution',
  schema: z.object({
    title: z.string().min(1).describe('Topic title.'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
    iconColor: z
      .number()
      .int()
      .optional()
      .describe('Static icon color (RGB int; only settable at creation).'),
    iconCustomEmoji: z
      .string()
      .optional()
      .describe('Custom emoji id for the topic icon (as a decimal string).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const icon =
      p.iconCustomEmoji != null
        ? parseIconCustomEmoji(p.iconCustomEmoji)
        : p.iconColor
    const got = await forumGuard(ctx, 'caution', 'create_topic', chatId, () =>
      client(ctx).createForumTopic({
        chatId: toPeer(chatId),
        title: p.title,
        ...(icon !== undefined ? { icon } : {}),
      }),
    )
    if (!('value' in got)) return got
    const topicId = topicIdFromCreateResult(got.value)
    if (topicId == null) {
      return {
        ok: false,
        content:
          'Created a topic service message but could not derive the canonical topic id from replyToMessage.threadId.',
      }
    }
    return {
      ok: true,
      content: `Created topic #${topicId} · ${p.title}`,
      data: { chatId, topicId, title: p.title },
    }
  },
})

const editTopic = defineAction({
  name: 'edit_topic',
  description: 'Rename a forum topic and/or change its custom emoji icon.',
  domain: 'topics',
  risk: 'caution',
  schema: z.object({
    topicId: z.number().int().positive().describe('Forum topic id (top message / thread id).'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
    title: z.string().min(1).optional().describe('New topic title.'),
    iconCustomEmoji: z
      .string()
      .nullable()
      .optional()
      .describe('New custom emoji id (decimal string), or null to clear icon back to static color.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    if (p.title === undefined && p.iconCustomEmoji === undefined) {
      return { ok: false, content: 'Provide title and/or iconCustomEmoji to edit.' }
    }
    const icon =
      p.iconCustomEmoji === undefined
        ? undefined
        : p.iconCustomEmoji === null
          ? null
          : parseIconCustomEmoji(p.iconCustomEmoji)
    const got = await forumGuard(ctx, 'caution', 'edit_topic', chatId, () =>
      client(ctx).editForumTopic({
        chatId: toPeer(chatId),
        topicId: p.topicId,
        ...(p.title !== undefined ? { title: p.title } : {}),
        ...(icon !== undefined ? { icon } : {}),
      }),
    )
    if (!('value' in got)) return got
    const parts = [
      p.title !== undefined ? `title → ${p.title}` : null,
      p.iconCustomEmoji !== undefined
        ? p.iconCustomEmoji === null
          ? 'icon cleared'
          : `icon → ${p.iconCustomEmoji}`
        : null,
    ].filter(Boolean)
    return {
      ok: true,
      content: `Edited topic #${p.topicId}${parts.length ? ` (${parts.join('; ')})` : ''}.`,
      data: {
        chatId,
        topicId: p.topicId,
        title: p.title ?? null,
        iconCustomEmoji: p.iconCustomEmoji === undefined ? undefined : p.iconCustomEmoji,
      },
    }
  },
})

const closeTopic = defineAction({
  name: 'close_topic',
  description: 'Close a forum topic so members cannot send new messages in it.',
  domain: 'topics',
  risk: 'caution',
  schema: z.object({
    topicId: z.number().int().positive().describe('Forum topic id (top message / thread id).'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const got = await forumGuard(ctx, 'caution', 'close_topic', chatId, () =>
      client(ctx).toggleForumTopicClosed({
        chatId: toPeer(chatId),
        topicId: p.topicId,
        closed: true,
      }),
    )
    if (!('value' in got)) return got
    return {
      ok: true,
      content: `Closed topic #${p.topicId}.`,
      data: { chatId, topicId: p.topicId, closed: true },
    }
  },
})

const openTopic = defineAction({
  name: 'open_topic',
  description: 'Re-open a previously closed forum topic.',
  domain: 'topics',
  risk: 'caution',
  schema: z.object({
    topicId: z.number().int().positive().describe('Forum topic id (top message / thread id).'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const got = await forumGuard(ctx, 'caution', 'open_topic', chatId, () =>
      client(ctx).toggleForumTopicClosed({
        chatId: toPeer(chatId),
        topicId: p.topicId,
        closed: false,
      }),
    )
    if (!('value' in got)) return got
    return {
      ok: true,
      content: `Opened topic #${p.topicId}.`,
      data: { chatId, topicId: p.topicId, closed: false },
    }
  },
})

const pinTopic = defineAction({
  name: 'pin_topic',
  description: 'Pin or unpin a forum topic in the topic list.',
  domain: 'topics',
  risk: 'caution',
  schema: z.object({
    topicId: z.number().int().positive().describe('Forum topic id (top message / thread id).'),
    chatId: z.string().optional().describe('Forum group chat id (defaults to current chat).'),
    pinned: z.boolean().optional().describe('true to pin (default), false to unpin.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const pinned = p.pinned ?? true
    const got = await forumGuard(ctx, 'caution', 'pin_topic', chatId, () =>
      client(ctx).toggleForumTopicPinned({
        chatId: toPeer(chatId),
        topicId: p.topicId,
        pinned,
      }),
    )
    if (!('value' in got)) return got
    return {
      ok: true,
      content: pinned ? `Pinned topic #${p.topicId}.` : `Unpinned topic #${p.topicId}.`,
      data: { chatId, topicId: p.topicId, pinned },
    }
  },
})

export const topicActions = [
  listTopics,
  readTopicHistory,
  createTopic,
  editTopic,
  closeTopic,
  openTopic,
  pinTopic,
]
