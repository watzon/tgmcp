import { z } from 'zod'
import type { StoredMessage, Tool, ToolContext } from '../types'
import { invokeAction } from './catalog'
import { lintOutboundMarkdown } from './markdown'
import { explicitChatIdGuard } from './targeting'

function renderTranscript(msgs: StoredMessage[]): string {
  if (msgs.length === 0) return '(no messages)'
  return msgs
    .map((m) => {
      const media = m.mediaSummary ? ` [${m.mediaSummary}]` : ''
      const body = m.text || (m.mediaSummary ? '' : '(no text)')
      return `[#${m.id}] ${m.senderName}: ${body}${media}`.trimEnd()
    })
    .join('\n')
}

const sendSchema = z
  .object({
    chatId: z.string().describe('Numeric Telegram peer id. Use list_chats to resolve a title.'),
    text: z.string().min(1),
    replyToId: z.number().int().optional().describe('Message id to reply to, if any.'),
    topicId: z
      .number()
      .int()
      .optional()
      .describe('Forum topic id to send into (Telegram top_msg_id).'),
    quoteText: z
      .string()
      .min(1)
      .optional()
      .describe('Exact plain-text span to quote from the replied message. Requires replyToId.'),
    quoteOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('UTF-16 offset of quoteText in the replied message. Requires quoteText.'),
  })
  .superRefine((val, ctx) => {
    if (val.quoteText !== undefined && val.replyToId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'quoteText requires replyToId',
        path: ['quoteText'],
      })
    }
    if (val.quoteOffset !== undefined && val.quoteText === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'quoteOffset requires quoteText',
        path: ['quoteOffset'],
      })
    }
  })

const sendMessage: Tool = {
  name: 'send_message',
  description:
    'Send a text message to a chat. Requires a numeric chatId from list_chats. Use replyToId to reply.',
  schema: sendSchema,
  risk: 'safe',
  async execute(input, ctx: ToolContext) {
    const args = sendSchema.parse(input)
    const targetError = explicitChatIdGuard(ctx, args)
    if (targetError) return targetError
    const sendOpts = {
      ...(args.topicId !== undefined ? { threadId: args.topicId } : {}),
      ...(args.quoteText !== undefined ? { quoteText: args.quoteText } : {}),
      ...(args.quoteOffset !== undefined ? { quoteOffset: args.quoteOffset } : {}),
    }
    const { id } =
      args.replyToId !== undefined
        ? await ctx.tg.reply(args.chatId, args.replyToId, args.text, sendOpts)
        : await ctx.tg.sendText(args.chatId, args.text, sendOpts)
    const issues = lintOutboundMarkdown(args.text)
    const note =
      issues.length > 0
        ? ` Formatting heads-up: ${issues.join('; ')}. Fix with telegram invoke edit_message if needed.`
        : ''
    return { ok: true, content: `Sent (message #${id}).${note}`, data: { id, chatId: args.chatId } }
  },
}

const readSchema = z.object({
  chatId: z.string().describe('Chat to read. Numeric peer id.'),
  limit: z.number().int().positive().max(200).optional().describe('How many recent messages (default 30).'),
  topicId: z.number().int().optional().describe('Forum topic id to scope history to.'),
})

const readMessages: Tool = {
  name: 'read_messages',
  description:
    'Fetch recent message history from a chat. Read-only. Does not mark anything read.',
  schema: readSchema,
  risk: 'safe',
  async execute(input, ctx: ToolContext) {
    const args = readSchema.parse(input)
    const targetError = explicitChatIdGuard(ctx, args)
    if (targetError) return targetError
    const msgs = await ctx.tg.getHistory(args.chatId, {
      limit: args.limit ?? 30,
      ...(args.topicId !== undefined ? { topicId: args.topicId } : {}),
    })
    if (msgs.length === 0) return { ok: true, content: '(no messages)', data: msgs }
    return { ok: true, content: renderTranscript(msgs), data: msgs }
  },
}

const listSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe('Chat title or numeric id to match. Use this to resolve a named target.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe('How many dialogs to inspect (default 50, or 200 with query).'),
})

const listChats: Tool = {
  name: 'list_chats',
  description:
    'List or resolve dialogs with numeric ids, titles, types, and unread counts. Use query before acting on a named chat.',
  schema: listSchema,
  risk: 'safe',
  async execute(input, ctx: ToolContext) {
    const args = listSchema.parse(input)
    const allDialogs = await ctx.tg.listDialogs({ limit: args.limit ?? (args.query ? 200 : 50) })
    const terms = args.query?.toLocaleLowerCase().split(/\s+/)
    const dialogs = terms
      ? allDialogs.filter((dialog) => {
          const haystack = `${dialog.chatId} ${dialog.title} ${dialog.type}`.toLocaleLowerCase()
          return terms.every((term) => haystack.includes(term))
        })
      : allDialogs
    const content = dialogs.length
      ? dialogs
          .map((d) => `${d.chatId} · ${d.type} · ${d.title}${d.unread ? ` (${d.unread} unread)` : ''}`)
          .join('\n')
      : '(no matching dialogs)'
    return { ok: true, content, data: dialogs }
  },
}

const searchSchema = z.object({
  chatId: z.string().describe('Numeric Telegram peer id. Use list_chats to resolve a title.'),
  query: z.string().describe('Text query. Empty string is allowed when filtering by media type only.'),
  fromUserId: z.string().optional().describe('Only messages sent by this user id.'),
  limit: z.number().int().positive().max(100).optional().describe('Max hits (default 20, max 100).'),
  topicId: z.number().int().positive().optional().describe('Forum topic id.'),
})

const searchMessages: Tool = {
  name: 'search_messages',
  description:
    'Search server-side history inside one chat. Use this to find a message by text, sender, or topic. For actions such as react, edit, forward, or media, search the telegram catalog.',
  schema: searchSchema,
  risk: 'safe',
  async execute(input, ctx: ToolContext) {
    const args = searchSchema.parse(input)
    const targetError = explicitChatIdGuard(ctx, args)
    if (targetError) return targetError
    return invokeAction('search_messages', args, ctx)
  },
}

export const tier1Tools: Tool[] = [listChats, readMessages, sendMessage, searchMessages]
