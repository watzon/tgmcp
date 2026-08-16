// src/telegram/catalog/members.ts — catalog actions over chat members / users.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  tl,
  User,
  type FileDownloadLocation,
  type Photo,
  type TelegramClient,
  type Video,
} from '@mtcute/node'
import type { ToolContext, ToolImage, ToolResult } from '../../types'
import { toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

/** Telegram treats windows shorter than 30s or longer than 366 days as forever. */
const FOR_SECONDS_MIN = 30
const FOR_SECONDS_MAX = 366 * 24 * 60 * 60

const forSecondsSchema = z
  .number()
  .int()
  .min(FOR_SECONDS_MIN)
  .max(FOR_SECONDS_MAX)
  .optional()
  .describe(
    'How long the restriction lasts, in seconds (30–31622400). Omit for a permanent action.',
  )

function untilFromSeconds(forSeconds?: number): { until?: number; label: string } {
  if (forSeconds === undefined) return { label: 'permanently' }
  const until = Date.now() + forSeconds * 1000
  return { until, label: `until ${new Date(until).toISOString()}` }
}

function refuseSelf(ctx: ToolContext, userId: string, verb: string): ToolResult | null {
  if (userId !== ctx.ownerId) return null
  return { ok: false, content: `Refused: cannot ${verb} the signed-in account.` }
}

function mapMemberModError(chatId: string, userId: string, err: unknown): ToolResult | null {
  if (!(err instanceof tl.RpcError)) return null
  if (err.is('USER_NOT_PARTICIPANT')) {
    return { ok: false, content: `User ${userId} is not a member of chat ${chatId}.` }
  }
  if (err.is('USER_ADMIN_INVALID')) {
    return { ok: false, content: `User ${userId} is an admin. Demote them before this action.` }
  }
  if (err.is('CHAT_ADMIN_REQUIRED')) {
    return { ok: false, content: `This account is not an admin in chat ${chatId}.` }
  }
  return null
}

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

const getMembers = defineAction({
  name: 'get_members',
  description: 'List members of a group or channel (up to Telegram’s 200-per-query limit).',
  domain: 'members',
  risk: 'safe',
  schema: z.object({
    chatId: z.string().optional(),
    limit: z.number().int().positive().max(200).optional(),
    query: z.string().optional().describe('Filter members by name/username.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const members = await ctx.tg.guard('safe', 'get_members', chatId, () =>
      client(ctx).getChatMembers(toPeer(chatId), { limit: p.limit ?? 200, query: p.query }),
    )
    const rows = members.map((m) => ({
      id: String(m.user.id),
      name: m.user.displayName,
      username: m.user.username,
      status: m.status,
    }))
    const content = rows.length
      ? rows.map((r) => `${r.id} · ${r.name}${r.username ? ` (@${r.username})` : ''} · ${r.status}`).join('\n')
      : '(no members)'
    return { ok: true, content, data: rows }
  },
})

const getUserInfo = defineAction({
  name: 'get_user_info',
  description: 'Get profile information about a user by id.',
  domain: 'members',
  risk: 'safe',
  schema: z.object({ userId: z.string() }),
  async run(p, ctx) {
    const user = await ctx.tg.guard('safe', 'get_user_info', ctx.chatId, () =>
      client(ctx).getUser(toPeer(p.userId)),
    )
    return {
      ok: true,
      content: `${user.displayName}${user.username ? ` (@${user.username})` : ''} · id ${user.id}`,
      data: {
        id: String(user.id),
        name: user.displayName,
        username: user.username,
        isBot: user.isBot,
      },
    }
  },
})


const blockUser = defineAction({
  name: 'block_user',
  description: 'Block a user from contacting this Telegram account.',
  domain: 'members',
  risk: 'owner',
  schema: z.object({
    userId: z.string().regex(/^\d+$/).describe('Numeric Telegram user id.'),
  }),
  async run(p, ctx) {
    await ctx.tg.guard('owner', 'block_user', ctx.chatId, () =>
      client(ctx).blockUser(toPeer(p.userId)),
    )
    return { ok: true, content: `Blocked user ${p.userId}.` }
  },
})

const unblockUser = defineAction({
  name: 'unblock_user',
  description: 'Unblock a previously blocked Telegram user.',
  domain: 'members',
  risk: 'owner',
  schema: z.object({
    userId: z.string().regex(/^\d+$/).describe('Numeric Telegram user id.'),
  }),
  async run(p, ctx) {
    await ctx.tg.guard('owner', 'unblock_user', ctx.chatId, () =>
      client(ctx).unblockUser(toPeer(p.userId)),
    )
    return { ok: true, content: `Unblocked user ${p.userId}.` }
  },
})

const searchUsers = defineAction({
  name: 'search_users',
  description:
    'Search people Telegram knows about (contacts + global username/name matches). Owner only.',
  domain: 'members',
  risk: 'owner',
  schema: z.object({
    query: z.string().trim().min(1).describe('Name or username substring to search for.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe('Max users to return (1-50, default 20).'),
  }),
  async run(p, ctx) {
    const limit = p.limit ?? 20
    const found = await ctx.tg.guard('owner', 'search_users', ctx.chatId, () =>
      client(ctx).call({
        _: 'contacts.search',
        q: p.query,
        limit,
      }),
    )
    // Rank by Telegram order (myResults, then results). users is only an entity table.
    const usersById = new Map<number, User>()
    for (const raw of found.users) {
      if (raw._ !== 'user') continue
      const user = new User(raw)
      usersById.set(user.id, user)
    }
    const rows: Array<{
      id: string
      name: string
      username: string | null
      isBot: boolean
    }> = []
    const seen = new Set<number>()
    for (const peer of [...found.myResults, ...found.results]) {
      if (peer._ !== 'peerUser') continue
      if (seen.has(peer.userId)) continue
      seen.add(peer.userId)
      const user = usersById.get(peer.userId)
      if (!user) continue
      rows.push({
        id: String(user.id),
        name: user.displayName,
        username: user.username,
        isBot: Boolean(user.isBot),
      })
      if (rows.length >= limit) break
    }
    const content = rows.length
      ? rows
          .map(
            (r) =>
              `${r.id} · ${r.name}${r.username ? ` (@${r.username})` : ''}${r.isBot ? ' · bot' : ''}`,
          )
          .join('\n')
      : '(no users)'
    return { ok: true, content, data: rows }
  },
})

const banMember = defineAction({
  name: 'ban_member',
  description:
    'Ban a user from a group or channel. They cannot rejoin until an admin unbans them, or until forSeconds elapses.',
  domain: 'members',
  risk: 'owner',
  schema: z.object({
    userId: z.string().regex(/^\d+$/).describe('Numeric Telegram user id to ban.'),
    chatId: z.string().optional().describe('Group or channel id.'),
    forSeconds: forSecondsSchema,
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const self = refuseSelf(ctx, p.userId, 'ban')
    if (self) return self
    const { until, label } = untilFromSeconds(p.forSeconds)
    try {
      await ctx.tg.guard('owner', 'ban_member', chatId, () =>
        client(ctx).banChatMember({
          chatId: toPeer(chatId),
          participantId: toPeer(p.userId),
          ...(until !== undefined ? { untilDate: until } : {}),
        }),
      )
    } catch (err) {
      const mapped = mapMemberModError(chatId, p.userId, err)
      if (mapped) return mapped
      throw err
    }
    return {
      ok: true,
      content: `Banned ${p.userId} from ${chatId} ${label}.`,
      data: { chatId, userId: p.userId, until: until ?? null },
    }
  },
})

const muteMember = defineAction({
  name: 'mute_member',
  description:
    'Mute a user in a group so they cannot send messages. Lasts until forSeconds elapses, or forever if omitted. Distinct from mute_chat (your notification mute).',
  domain: 'members',
  risk: 'owner',
  schema: z.object({
    userId: z.string().regex(/^\d+$/).describe('Numeric Telegram user id to mute.'),
    chatId: z.string().optional().describe('Group or channel id.'),
    forSeconds: forSecondsSchema,
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const self = refuseSelf(ctx, p.userId, 'mute')
    if (self) return self
    const { until, label } = untilFromSeconds(p.forSeconds)
    try {
      await ctx.tg.guard('owner', 'mute_member', chatId, () =>
        client(ctx).restrictChatMember({
          chatId: toPeer(chatId),
          userId: toPeer(p.userId),
          restrictions: { sendMessages: true },
          ...(until !== undefined ? { until } : {}),
        }),
      )
    } catch (err) {
      const mapped = mapMemberModError(chatId, p.userId, err)
      if (mapped) return mapped
      throw err
    }
    return {
      ok: true,
      content: `Muted ${p.userId} in ${chatId} ${label}.`,
      data: { chatId, userId: p.userId, until: until ?? null },
    }
  },
})

const MAX_STORY_THUMBS = 6

function toToolImage(bytes: Uint8Array, mimeType = 'image/jpeg'): ToolImage {
  return { mimeType, data: Buffer.from(bytes).toString('base64') }
}

function storyThumbLocation(media: Photo | Video): FileDownloadLocation | null {
  if (media.type === 'photo') {
    return (
      media.getThumbnail('s') ??
      media.getThumbnail('m') ??
      media.getThumbnail('a') ??
      media
    )
  }
  const thumbs = media.thumbnails.filter((thumb) => thumb.type !== 'i' && thumb.type !== 'j' && !thumb.isVideo)
  return thumbs[0] ?? null
}

const inspectUser = defineAction({
  name: 'inspect_user',
  description:
    'Get a user’s name, bio, profile photo, and active story thumbnails. Photos come back as MCP images. Fetching stories may mark them viewed.',
  domain: 'members',
  risk: 'safe',
  schema: z.object({
    userId: z.string().regex(/^\d+$/).describe('Numeric Telegram user id.'),
  }),
  async run(p, ctx) {
    const tg = client(ctx)
    const images: ToolImage[] = []
    const saved: { profilePhoto: string | null; storyThumbs: string[] } = {
      profilePhoto: null,
      storyThumbs: [],
    }

    const user = await ctx.tg.guard('safe', 'inspect_user', ctx.chatId, () => tg.getFullUser(toPeer(p.userId)))

    const dir = join(ctx.config.downloadsDir, 'users', p.userId)
    mkdirSync(dir, { recursive: true })

    if (user.photo) {
      const bytes = await ctx.tg.guard('safe', 'inspect_user_photo', ctx.chatId, () =>
        tg.downloadAsBuffer(user.photo!.small),
      )
      const path = join(dir, 'photo.jpg')
      writeFileSync(path, bytes)
      saved.profilePhoto = path
      images.push(toToolImage(bytes))
    }

    let stories: Array<{ id: number; kind: string; caption: string | null; expiresAt: string }> = []
    try {
      const peerStories = await ctx.tg.guard('safe', 'inspect_user_stories', ctx.chatId, () =>
        tg.getPeerStories(toPeer(p.userId)),
      )
      for (const story of peerStories.stories.slice(0, MAX_STORY_THUMBS)) {
        stories.push({
          id: story.id,
          kind: story.media.type,
          caption: story.caption,
          expiresAt: story.expireDate.toISOString(),
        })
        const thumb = storyThumbLocation(story.media)
        if (!thumb) continue
        const bytes = await ctx.tg.guard('safe', 'inspect_user_story_thumb', ctx.chatId, () =>
          tg.downloadAsBuffer(thumb),
        )
        const path = join(dir, `story_${story.id}.jpg`)
        writeFileSync(path, bytes)
        saved.storyThumbs.push(path)
        images.push(toToolImage(bytes))
      }
    } catch {
      stories = []
    }

    const handle = user.username ? ` (@${user.username})` : ''
    const bio = user.bio.trim()
    const photoNote = saved.profilePhoto ? 'profile photo attached' : 'no profile photo'
    const storyNote =
      stories.length === 0
        ? 'no active stories'
        : `${stories.length} story thumb${stories.length === 1 ? '' : 's'} attached`
    return {
      ok: true,
      content: `${user.displayName}${handle} · id ${user.id}\nbio: ${bio || '(empty)'}\n${photoNote} · ${storyNote}`,
      data: {
        id: String(user.id),
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        bio,
        isBot: user.isBot,
        isScam: user.isScam,
        isFake: user.isFake,
        paths: saved,
        stories,
      },
      images,
    }
  },
})

export const memberActions = [
  getMembers,
  getUserInfo,
  inspectUser,
  blockUser,
  unblockUser,
  searchUsers,
  banMember,
  muteMember,
]
