// src/telegram/catalog/profile.ts — catalog actions over Fenneko's own account.
//
// These all act on Fenneko's own Telegram account (the account she is logged in
// as). She manages her own identity autonomously — `risk: 'caution'` just keeps
// each change rate-limited and ledgered, not gated. Descriptions are written in
// her own voice ("your account") so nothing reads as permissioned.
import { z } from 'zod'
import type { TelegramClient } from '@mtcute/node'
import type { ToolContext } from '../../types'
import { defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

const getMe = defineAction({
  name: 'get_me',
  description: 'Get your own account info (id, name, username).',
  domain: 'profile',
  risk: 'safe',
  schema: z.object({}),
  async run(_p, ctx) {
    const me = await ctx.tg.guard('safe', 'get_me', ctx.chatId, () => client(ctx).getMe())
    return {
      ok: true,
      content: `${me.displayName}${me.username ? ` (@${me.username})` : ''} · id ${me.id}`,
      data: { id: String(me.id), name: me.displayName, username: me.username },
    }
  },
})

const setBio = defineAction({
  name: 'set_bio',
  description: 'Set the bio on your account (max 70 chars; pass "" to clear it).',
  domain: 'profile',
  risk: 'caution',
  schema: z.object({ bio: z.string().max(70) }),
  async run(p, ctx) {
    await ctx.tg.guard('caution', 'set_bio', ctx.chatId, () =>
      client(ctx).updateProfile({ bio: p.bio }),
    )
    return { ok: true, content: 'Updated your bio.' }
  },
})

const setName = defineAction({
  name: 'set_name',
  description: 'Set the first/last name on your account.',
  domain: 'profile',
  risk: 'caution',
  schema: z
    .object({ firstName: z.string().optional(), lastName: z.string().optional() })
    .refine((v) => v.firstName !== undefined || v.lastName !== undefined, {
      message: 'Provide firstName and/or lastName.',
    }),
  async run(p, ctx) {
    await ctx.tg.guard('caution', 'set_name', ctx.chatId, () =>
      client(ctx).updateProfile({ firstName: p.firstName, lastName: p.lastName }),
    )
    return { ok: true, content: 'Updated your name.' }
  },
})

const setUsername = defineAction({
  name: 'set_username',
  description:
    'Set or change your @username: 5–32 chars (letters, digits, underscore), or pass "" to remove it.',
  domain: 'profile',
  risk: 'caution',
  schema: z.object({
    username: z
      .string()
      .regex(/^$|^[a-zA-Z0-9_]{5,32}$/, 'Username must be 5–32 chars (letters, digits, underscore), or "" to remove.'),
  }),
  async run(p, ctx) {
    const value = p.username === '' ? null : p.username
    await ctx.tg.guard('caution', 'set_username', ctx.chatId, () => client(ctx).setMyUsername(value))
    return { ok: true, content: value ? `Username set to @${value}.` : 'Removed your username.' }
  },
})

/** Profile photos can't be set from a URL (mtcute rejects it) — cap the download we fetch. */
const MAX_PROFILE_MEDIA_BYTES = 15 * 1024 * 1024

const setProfilePhoto = defineAction({
  name: 'set_profile_photo',
  description:
    'Set a new profile photo (or video) on your account from a DIRECT image/video URL (must point at the file itself, not a webpage).',
  domain: 'profile',
  risk: 'caution',
  schema: z.object({
    url: z.string().url().describe('Direct URL to the image/video file itself (not a page that contains it).'),
    type: z.enum(['photo', 'video']).default('photo').describe('Media kind; defaults to photo.'),
  }),
  async run(p, ctx) {
    // mtcute's setMyProfilePhoto won't accept a URL string — fetch the bytes and upload them.
    let bytes: Uint8Array
    try {
      const res = await fetch(p.url, { redirect: 'follow' })
      if (!res.ok) return { ok: false, content: `Couldn’t fetch ${p.url} (HTTP ${res.status}).` }
      const contentType = res.headers.get('content-type') ?? ''
      const expected = p.type === 'video' ? 'video/' : 'image/'
      if (contentType && !contentType.startsWith(expected)) {
        return {
          ok: false,
          content: `That URL is ${contentType}, not a ${p.type}. Give a direct ${p.type} file URL.`,
        }
      }
      const buf = await res.arrayBuffer()
      if (buf.byteLength === 0) return { ok: false, content: 'Fetched an empty file.' }
      if (buf.byteLength > MAX_PROFILE_MEDIA_BYTES) {
        return { ok: false, content: `File is too large (${Math.round(buf.byteLength / 1e6)} MB; max 15 MB).` }
      }
      bytes = new Uint8Array(buf)
    } catch (err) {
      return { ok: false, content: `Couldn’t download the ${p.type}: ${err instanceof Error ? err.message : String(err)}` }
    }
    await ctx.tg.guard('caution', 'set_profile_photo', ctx.chatId, () =>
      client(ctx).setMyProfilePhoto({ type: p.type, media: bytes }),
    )
    return { ok: true, content: `Updated your profile ${p.type}.` }
  },
})

const deleteProfilePhoto = defineAction({
  name: 'delete_profile_photo',
  description: 'Remove your current profile photo.',
  domain: 'profile',
  risk: 'caution',
  schema: z.object({}),
  async run(_p, ctx) {
    const photos = await client(ctx).getProfilePhotos('me', { limit: 1 })
    const current = photos[0]
    if (!current) return { ok: false, content: 'No profile photo to remove.' }
    await ctx.tg.guard('caution', 'delete_profile_photo', ctx.chatId, () =>
      client(ctx).deleteProfilePhotos(current.inputPhoto),
    )
    return { ok: true, content: 'Removed your current profile photo.' }
  },
})

export const profileActions = [
  getMe,
  setBio,
  setName,
  setUsername,
  setProfilePhoto,
  deleteProfilePhoto,
]
