import { z } from 'zod'
import { tl, type TelegramClient } from '@mtcute/bun'
import type { ToolContext } from '../../types'
import { toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

const getChatInfo = defineAction({
  name: 'get_chat_info',
  description: 'Get basic information about a user, group, or channel (title, type, id).',
  domain: 'chats',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const peer = await ctx.tg.guard('safe', 'get_chat_info', chatId, () =>
      client(ctx).getPeer(toPeer(chatId)),
    )
    const type = peer.type === 'user' ? 'user' : peer.chatType
    return {
      ok: true,
      content: `${peer.displayName} · ${type} · id ${peer.id}`,
      data: { id: String(peer.id), title: peer.displayName, type, username: peer.username },
    }
  },
})

const muteChat = defineAction({
  name: 'mute_chat',
  description: 'Mute or unmute your notifications for a chat.',
  domain: 'chats',
  risk: 'caution',
  schema: z.object({
    chatId: z.string().optional(),
    mute: z.boolean().optional().describe('true to mute (default), false to unmute.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const mute = p.mute ?? true
    await ctx.tg.guard('caution', 'mute_chat', chatId, async () => {
      const tg = client(ctx)
      const peer = await tg.resolvePeer(toPeer(chatId))
      await tg.call({
        _: 'account.updateNotifySettings',
        peer: { _: 'inputNotifyPeer', peer },
        settings: { _: 'inputPeerNotifySettings', muteUntil: mute ? 2147483647 : 0 },
      })
    })
    return { ok: true, content: mute ? `Muted ${chatId}.` : `Unmuted ${chatId}.` }
  },
})

const markUnread = defineAction({
  name: 'mark_unread',
  description: 'Mark a chat as unread.',
  domain: 'chats',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('safe', 'mark_unread', chatId, () =>
      client(ctx).markChatUnread(toPeer(chatId)),
    )
    return { ok: true, content: `Marked ${chatId} unread.` }
  },
})

const joinChat = defineAction({
  name: 'join_chat',
  description: 'Join a public group or channel by @username or Telegram invite link.',
  domain: 'chats',
  risk: 'owner',
  schema: z.object({
    target: z
      .string()
      .min(1)
      .describe('Public @username, t.me username link, or t.me/+ invite link.'),
  }),
  async run(p, ctx) {
    const target = p.target.trim()
    let result
    try {
      result = await ctx.tg.guard('owner', 'join_chat', ctx.chatId, () =>
        client(ctx).joinChat(target),
      )
    } catch (err) {
      if (err instanceof tl.RpcError && err.is('USER_ALREADY_PARTICIPANT')) {
        return { ok: true, content: `Already a member of ${target}.` }
      }
      throw err
    }

    if (result.status === 'request_sent') {
      return {
        ok: true,
        content: `Join request sent for ${target}; an admin must approve it.`,
      }
    }
    if (result.status === 'webview') {
      return {
        ok: false,
        content: `Telegram requires completing a verification webview before joining ${target}.`,
      }
    }
    return {
      ok: true,
      content: `Joined ${result.chat.displayName} (id ${result.chat.id}).`,
      data: {
        id: String(result.chat.id),
        title: result.chat.displayName,
        username: result.chat.username,
      },
    }
  },
})

const leaveChat = defineAction({
  name: 'leave_chat',
  description: 'Leave a group or channel.',
  domain: 'chats',
  risk: 'owner',
  schema: z.object({
    chatId: z.string().optional().describe('Numeric group or channel id.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    await ctx.tg.guard('owner', 'leave_chat', chatId, () =>
      client(ctx).leaveChat(toPeer(chatId)),
    )
    return { ok: true, content: `Left chat ${chatId}.` }
  },
})

const archiveChat = defineAction({
  name: 'archive_chat',
  description: 'Move a chat into the Telegram archive.',
  domain: 'chats',
  risk: 'caution',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.guard('caution', 'archive_chat', chatId, () =>
      client(ctx).archiveChats(toPeer(chatId)),
    )
    return { ok: true, content: `Archived chat ${chatId}.` }
  },
})

const unarchiveChat = defineAction({
  name: 'unarchive_chat',
  description: 'Move an archived chat back into the main chat list.',
  domain: 'chats',
  risk: 'caution',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.guard('caution', 'unarchive_chat', chatId, () =>
      client(ctx).unarchiveChats(toPeer(chatId)),
    )
    return { ok: true, content: `Unarchived chat ${chatId}.` }
  },
})

const getInviteLink = defineAction({
  name: 'get_invite_link',
  description: 'Get the primary invite link for a group or channel.',
  domain: 'chats',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const invite = await ctx.tg.guard('safe', 'get_invite_link', chatId, () =>
      client(ctx).getPrimaryInviteLink(toPeer(chatId)),
    )
    return {
      ok: true,
      content: invite.link,
      data: {
        link: invite.link,
        isPrimary: invite.isPrimary,
        isRevoked: invite.isRevoked,
        usageLimit: invite.usageLimit,
        approvalNeeded: invite.approvalNeeded,
      },
    }
  },
})

const createInviteLink = defineAction({
  name: 'create_invite_link',
  description: 'Create an additional invite link for a group or channel.',
  domain: 'chats',
  risk: 'owner',
  schema: z.object({
    chatId: z.string().optional(),
    expiresAt: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Expiration time as a Unix timestamp in milliseconds.'),
    usageLimit: z.number().int().min(1).max(99999).optional(),
    withApproval: z.boolean().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const invite = await ctx.tg.guard('owner', 'create_invite_link', chatId, () =>
      client(ctx).createInviteLink(toPeer(chatId), {
        expires: p.expiresAt,
        usageLimit: p.usageLimit,
        withApproval: p.withApproval,
      }),
    )
    return {
      ok: true,
      content: `Created invite link ${invite.link}`,
      data: { link: invite.link, expiresAt: invite.endDate?.toISOString() ?? null },
    }
  },
})

const revokeInviteLink = defineAction({
  name: 'revoke_invite_link',
  description: 'Revoke an existing invite link for a group or channel.',
  domain: 'chats',
  risk: 'owner',
  schema: z.object({
    link: z.string().url(),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const invite = await ctx.tg.guard('owner', 'revoke_invite_link', chatId, () =>
      client(ctx).revokeInviteLink(toPeer(chatId), p.link),
    )
    return {
      ok: true,
      content: `Revoked invite link ${p.link}.`,
      data: { link: invite.link, isRevoked: invite.isRevoked },
    }
  },
})

export const chatActions = [
  getChatInfo,
  muteChat,
  markUnread,
  joinChat,
  leaveChat,
  archiveChat,
  unarchiveChat,
  getInviteLink,
  createInviteLink,
  revokeInviteLink,
]
