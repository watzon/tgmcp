// src/telegram/catalog/media.ts - catalog actions for downloading and sending media.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { z } from 'zod'
import type { FileDownloadLocation, InputMediaLike, Message, Sticker, TelegramClient } from '@mtcute/node'
import { InputMedia, tl } from '@mtcute/node'
import type { ToolContext, ToolResult } from '../../types'
import { parseOutbound } from '../markdown'
import { toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

/** Media kinds that carry a downloadable file (they extend mtcute's FileLocation). */
function downloadableLocation(msg: Message): FileDownloadLocation | null {
  const media = msg.media
  if (!media) return null
  switch (media.type) {
    case 'photo':
    case 'video':
    case 'audio':
    case 'voice':
    case 'sticker':
    case 'document':
      return media
    default:
      return null
  }
}

/** The reusable Telegram file id of a message's media (photo/document-family), or null. */
function mediaFileId(msg: Message): string | null {
  const media = msg.media
  if (media && 'fileId' in media && typeof media.fileId === 'string') return media.fileId
  return null
}

/**
 * Shared guarded send for the typed media actions. `shouldDispatch: true` routes
 * our own send back through ingest for persistence + FTS (same bookkeeping as
 * the tier-1 text path); the guard supplies rate limiting and the ledger row.
 */
async function sendOne(
  ctx: ToolContext,
  action: string,
  chatId: string,
  media: InputMediaLike | string,
  caption: string | undefined,
): Promise<ToolResult> {
  const msg = await ctx.tg.guard('caution', action, chatId, () =>
    client(ctx).sendMedia(toPeer(chatId), media, {
      caption: caption !== undefined ? parseOutbound(caption) : undefined,
      shouldDispatch: true,
    }),
  )
  return { ok: true, content: `Sent ${action.replace(/^send_/, '')} (message #${msg.id}).`, data: { id: msg.id } }
}

/** Original media filename, cleaned for use as a local path segment, or null. */
function safeMediaFileName(msg: Message): string | null {
  const raw = (msg.media as { fileName?: string | null } | null)?.fileName
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/[/\\\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return cleaned.length > 0 && cleaned.length <= 128 ? cleaned : null
}

const downloadMedia = defineAction({
  name: 'download_media',
  description:
    'Download a message’s media to a local file. Returns the saved path AND the reusable file id (prefer the file id + a send_* action to re-send without downloading again).',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    messageId: z.number().int(),
    chatId: z.string().optional(),
    path: z
      .string()
      .optional()
      .describe('Destination file path (default: downloadsDir / <chatId>_<messageId>[_filename]).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const result = await ctx.tg.guard('caution', 'download_media', chatId, async () => {
      const tg = client(ctx)
      const [msg] = await tg.getMessages(toPeer(chatId), p.messageId)
      if (!msg) throw new Error(`Message #${p.messageId} not found in ${chatId}.`)
      const location = downloadableLocation(msg)
      if (!location) throw new Error(`Message #${p.messageId} has no downloadable media.`)
      const fileName = safeMediaFileName(msg)
      const base = fileName ? `${chatId}_${p.messageId}_${fileName}` : `${chatId}_${p.messageId}`
      const path = p.path ?? join(ctx.config.downloadsDir, base)
      mkdirSync(dirname(path), { recursive: true })
      await tg.downloadToFile(path, location)
      return { path, fileId: mediaFileId(msg) }
    })
    return {
      ok: true,
      content: `Downloaded media to ${result.path}.${result.fileId ? ` Reusable file id: ${result.fileId}` : ''}`,
      data: result,
    }
  },
})

const getFileId = defineAction({
  name: 'get_file_id',
  description:
    'Get the reusable Telegram file id (and type) of a message’s media, no download needed. Feed the id back to send_photo/send_file/send_sticker to re-send the same media without downloading and re-uploading.',
  domain: 'media',
  risk: 'safe',
  schema: z.object({
    messageId: z.number().int(),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const [msg] = await client(ctx).getMessages(toPeer(chatId), p.messageId)
    if (!msg) return { ok: false, content: `Message #${p.messageId} not found in ${chatId}.` }
    const fileId = mediaFileId(msg)
    if (!fileId) {
      return {
        ok: false,
        content: `Message #${p.messageId} has no re-usable file (media: ${msg.media?.type ?? 'none'}).`,
      }
    }
    return { ok: true, content: `${msg.media?.type} file id: ${fileId}`, data: { fileId, type: msg.media?.type } }
  },
})

const sendMedia = defineAction({
  name: 'send_media',
  description:
    'Send media (by file path, URL, or file id) to a chat with an optional caption, type auto-detected. Prefer the typed send_photo/send_file/send_voice/send_sticker/send_album actions when the kind is known; auto-detection uploads images as documents, not photos.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    media: z.string().describe('A file path, URL, or existing Telegram file id.'),
    chatId: z.string().optional(),
    caption: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    return sendOne(ctx, 'send_media', chatId, p.media, p.caption)
  },
})

const sendPhoto = defineAction({
  name: 'send_photo',
  description:
    'Send a photo (file path, URL, or file id) as a proper compressed Telegram photo, with optional caption and spoiler blur.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    media: z.string().describe('A file path, URL, or existing Telegram file id.'),
    chatId: z.string().optional(),
    caption: z.string().optional(),
    spoiler: z.boolean().optional().describe('Hide the photo behind a spoiler blur.'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    return sendOne(
      ctx,
      'send_photo',
      chatId,
      InputMedia.photo(p.media, p.spoiler === true ? { spoiler: true } : {}),
      p.caption,
    )
  },
})

const sendFile = defineAction({
  name: 'send_file',
  description:
    'Send a generic file/document (file path, URL, or file id) with an optional caption. Use for PDFs, archives, code, anything that is not a photo/voice/sticker.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    media: z.string().describe('A file path, URL, or existing Telegram file id.'),
    chatId: z.string().optional(),
    caption: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    return sendOne(ctx, 'send_file', chatId, InputMedia.document(p.media), p.caption)
  },
})

/** True for inputs that reference an already-uploaded Telegram file or remote URL. */
function isRemoteMediaRef(media: string): boolean {
  return /^https?:\/\//i.test(media)
}

/**
 * Resolve the file to hand mtcute for a voice note. Telegram voice notes must be
 * OGG/Opus to render with the voice bubble + waveform everywhere; a local file
 * in another format is converted with ffmpeg when available (PATH probe),
 * otherwise passed through as-is with a note. URLs and existing file ids are
 * never downloaded for conversion.
 *
 * When conversion creates a file, `generatedArtifact` is the exclusive temp
 * directory owning it - caller must delete that path only (never the input).
 */
async function toVoiceUpload(media: string): Promise<{
  file: string
  note: string | null
  generatedArtifact: string | null
}> {
  const isLocalPath = !isRemoteMediaRef(media) && /\.[a-z0-9]{2,5}$/i.test(media)
  if (!isLocalPath || /\.(ogg|oga|opus)$/i.test(media)) {
    return { file: media, note: null, generatedArtifact: null }
  }
  const ffmpeg = which('ffmpeg')
  if (!ffmpeg) {
    return {
      file: media,
      note: 'ffmpeg not found: audio sent as-is and may not render as a playable voice note.',
      generatedArtifact: null,
    }
  }
  const artifactDir = mkdtempSync(join(tmpdir(), 'tgmcp-voice-'))
  const out = join(artifactDir, 'voice.ogg')
  try {
    const proc = await runProcess(ffmpeg, ['-y', '-v', 'error', '-i', media, '-c:a', 'libopus', '-b:a', '32k', out], {
      stdout: 'ignore',
      stderr: 'pipe',
    })
    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg voice conversion failed (${proc.exitCode}): ${proc.stderr.slice(0, 200)}`)
    }
    return { file: out, note: null, generatedArtifact: artifactDir }
  } catch (err) {
    rmSync(artifactDir, { recursive: true, force: true })
    throw err
  }
}

/** Best-effort duration (whole seconds) of a local audio file via ffprobe, or null. */
async function probeDurationSeconds(file: string): Promise<number | null> {
  if (isRemoteMediaRef(file)) return null
  const ffprobe = which('ffprobe')
  if (!ffprobe) return null
  try {
    const proc = await runProcess(
      ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { stdout: 'pipe', stderr: 'ignore' },
    )
    if (proc.exitCode !== 0) return null
    const seconds = Number(proc.stdout.trim())
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds) : null
  } catch {
    return null
  }
}

function which(bin: string): string | null {
  const dirs = (process.env.PATH ?? '').split(delimiter)
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${bin}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function runProcess(
  command: string,
  args: string[],
  opts: { stdout: 'pipe' | 'ignore'; stderr: 'pipe' | 'ignore' },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', opts.stdout === 'pipe' ? 'pipe' : 'ignore', opts.stderr === 'pipe' ? 'pipe' : 'ignore'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

const sendVoice = defineAction({
  name: 'send_voice',
  description:
    'Send a voice note (proper Telegram voice bubble, not a file). Input is a local audio path, URL, or existing file id; local non-OGG audio is converted to OGG/Opus automatically when ffmpeg is installed.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    media: z.string().describe('A local audio file path, URL, or existing Telegram file id.'),
    chatId: z.string().optional(),
    caption: z.string().optional(),
    duration: z.number().int().nonnegative().optional().describe('Duration in seconds (probed automatically for local files when omitted).'),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied

    // Admission / rate reservation / ledger wrap conversion + send so paid
    // preprocessing and Telegram failures share one guarded ledger row.
    const { msg, note } = await ctx.tg.guard('caution', 'send_voice', chatId, async () => {
      const upload = await toVoiceUpload(p.media)
      try {
        const duration = p.duration ?? (await probeDurationSeconds(upload.file)) ?? undefined
        const msg = await client(ctx).sendMedia(
          toPeer(chatId),
          InputMedia.voice(upload.file, duration !== undefined ? { duration } : {}),
          {
            caption: p.caption !== undefined ? parseOutbound(p.caption) : undefined,
            shouldDispatch: true,
          },
        )
        return { msg, note: upload.note }
      } finally {
        if (upload.generatedArtifact) {
          rmSync(upload.generatedArtifact, { recursive: true, force: true })
        }
      }
    })
    let content = `Sent voice (message #${msg.id}).`
    if (note) content += ` ${note}`
    return { ok: true, content, data: { id: msg.id } }
  },
})

const sendSticker = defineAction({
  name: 'send_sticker',
  description:
    'Send a sticker by its Telegram file id (from search_stickers / get_sticker_set / get_file_id) or a local .webp/.tgs/.webm sticker file. Stickers have no caption.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    sticker: z.string().describe('A sticker file id, or a path/URL to a .webp/.tgs/.webm sticker file.'),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    return sendOne(ctx, 'send_sticker', chatId, InputMedia.sticker(p.sticker), undefined)
  },
})

const sendAlbum = defineAction({
  name: 'send_album',
  description:
    'Send an album (2-10 photos/videos/documents) as one grouped media message. The first item’s caption becomes the album caption.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    items: z
      .array(
        z.object({
          media: z.string().describe('A file path, URL, or existing Telegram file id.'),
          type: z
            .enum(['photo', 'video', 'document'])
            .optional()
            .describe('Media kind (default photo for images; use document to preserve original files).'),
          caption: z.string().optional(),
        }),
      )
      .min(2)
      .max(10),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const medias: InputMediaLike[] = p.items.map((item) => {
      const caption = item.caption !== undefined ? parseOutbound(item.caption) : undefined
      const extra = caption !== undefined ? { caption } : {}
      switch (item.type ?? 'photo') {
        case 'video':
          return InputMedia.video(item.media, extra)
        case 'document':
          return InputMedia.document(item.media, extra)
        default:
          return InputMedia.photo(item.media, extra)
      }
    })
    // shouldDispatch routes our own album back through ingest for persistence + FTS.
    const sent = await ctx.tg.guard('caution', 'send_album', chatId, () =>
      client(ctx).sendMediaGroup(toPeer(chatId), medias, { shouldDispatch: true }),
    )
    const ids = sent.map((m) => m.id)
    return {
      ok: true,
      content: `Sent album of ${sent.length} items (messages ${ids.map((id) => `#${id}`).join(', ')}).`,
      data: { ids },
    }
  },
})

/* ---------------------------------------------------------------------------
 * Sticker / GIF discovery. Full sticker-set listings are cached process-locally
 * (sets change rarely); every action stays caution-tier per PLAN Phase D.
 * ------------------------------------------------------------------------- */

const STICKER_SET_CACHE_TTL_MS = 15 * 60 * 1000
const STICKER_SEARCH_MAX_SETS = 20

interface CachedSticker {
  fileId: string
  emoji: string
  alt: string
  sourceType: string
}

const stickerSetCache = new Map<string, { fetchedAt: number; stickers: CachedSticker[] }>()

function stickerInfo(media: Sticker): CachedSticker {
  return {
    fileId: media.fileId,
    emoji: media.emoji,
    alt: media.emoji,
    sourceType: media.sourceType,
  }
}

/** Full sticker list of one set, from the process-local cache when fresh. */
async function cachedSetStickers(tg: TelegramClient, shortName: string): Promise<CachedSticker[]> {
  const hit = stickerSetCache.get(shortName)
  if (hit && Date.now() - hit.fetchedAt < STICKER_SET_CACHE_TTL_MS) return hit.stickers
  const full = await tg.getStickerSet(shortName)
  const stickers = full.stickers.map((info) => stickerInfo(info.sticker))
  stickerSetCache.set(shortName, { fetchedAt: Date.now(), stickers })
  return stickers
}

const listStickerSets = defineAction({
  name: 'list_sticker_sets',
  description:
    'List the sticker packs installed on this account (short name, title, size, kind). Use get_sticker_set or search_stickers to find a specific sticker to send.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({}),
  async run(_p, ctx) {
    const sets = await ctx.tg.guard('caution', 'list_sticker_sets', ctx.chatId, () =>
      client(ctx).getInstalledStickers(),
    )
    const shaped = sets.slice(0, 50).map((set) => ({
      shortName: set.shortName,
      title: set.title,
      count: set.count,
      type: set.type,
      official: set.isOfficial,
      archived: set.isArchived,
    }))
    return {
      ok: true,
      content:
        shaped.length === 0
          ? 'No sticker packs installed on this account.'
          : `${shaped.length}${sets.length > 50 ? '+' : ''} installed sticker pack(s):\n` +
            shaped.map((s) => `- "${s.title}" (${s.shortName}) · ${s.count} ${s.type}`).join('\n'),
      data: { sets: shaped, truncated: sets.length > 50 },
    }
  },
})

const getStickerSet = defineAction({
  name: 'get_sticker_set',
  description:
    'List the stickers inside one installed pack by short name: each sticker’s emoji and reusable file id (send with send_sticker).',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    set: z.string().describe('Sticker pack short name (from list_sticker_sets).'),
  }),
  async run(p, ctx) {
    const stickers = await ctx.tg.guard('caution', 'get_sticker_set', ctx.chatId, () =>
      cachedSetStickers(client(ctx), p.set),
    )
    const shown = stickers.slice(0, 100)
    return {
      ok: true,
      content:
        shown.length === 0
          ? `Sticker pack "${p.set}" is empty or does not exist.`
          : `${stickers.length} sticker(s) in "${p.set}"${stickers.length > 100 ? ' (first 100 shown)' : ''}:\n` +
            shown.map((s) => `- ${s.emoji || '(no emoji)'} [${s.sourceType}] ${s.fileId}`).join('\n'),
      data: { set: p.set, count: stickers.length, stickers: shown, truncated: stickers.length > 100 },
    }
  },
})

const searchStickers = defineAction({
  name: 'search_stickers',
  description:
    'Search installed sticker packs by emoji (e.g. "😂" or "👍") and return matching stickers with file ids for send_sticker. Scans up to 20 packs.',
  domain: 'media',
  risk: 'caution',
  schema: z.object({
    emoji: z.string().min(1).describe('Emoji (or substring) to match against each sticker’s associated emojis.'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default 8).'),
  }),
  async run(p, ctx) {
    const limit = p.limit ?? 8
    const matches = await ctx.tg.guard('caution', 'search_stickers', ctx.chatId, async () => {
      const tg = client(ctx)
      const sets = await tg.getInstalledStickers()
      const out: Array<CachedSticker & { set: string }> = []
      for (const set of sets.slice(0, STICKER_SEARCH_MAX_SETS)) {
        if (out.length >= limit) break
        try {
          const stickers = await cachedSetStickers(tg, set.shortName)
          for (const s of stickers) {
            if (s.emoji.includes(p.emoji)) out.push({ ...s, set: set.shortName })
            if (out.length >= limit) break
          }
        } catch {
          // A single unloadable set must not sink the search.
        }
      }
      return out
    })
    return {
      ok: true,
      content:
        matches.length === 0
          ? `No installed sticker matches ${p.emoji}.`
          : matches.map((s) => `- ${s.emoji} from "${s.set}" [${s.sourceType}] ${s.fileId}`).join('\n'),
      data: { matches },
    }
  },
})

const searchGifs = defineAction({
  name: 'search_gifs',
  description:
    'Search GIFs saved to this account (Saved Messages) by caption text, or list recent saved GIFs with an empty query. Owner only - returns file ids for send_file/send_media.',
  domain: 'media',
  risk: 'owner',
  schema: z.object({
    query: z.string().optional().describe('Caption text to match; omit to list the most recent saved GIFs.'),
    limit: z.number().int().min(1).max(20).optional().describe('Max results (default 8).'),
  }),
  async run(p, ctx) {
    const limit = p.limit ?? 8
    const gifs = await ctx.tg.guard('owner', 'search_gifs', ctx.chatId, async () => {
      const found = await client(ctx).searchMessages({
        chatId: 'me',
        query: p.query ?? '',
        filter: { _: 'inputMessagesFilterGif' } satisfies tl.TypeMessagesFilter,
        limit,
      })
      const out: Array<{ fileId: string; duration: number; dims: string; caption: string }> = []
      for (const msg of found) {
        const media = msg.media
        if (media?.type !== 'video') continue
        const fileId = mediaFileId(msg)
        if (!fileId) continue
        out.push({
          fileId,
          duration: media.duration,
          dims: `${media.width}×${media.height}`,
          caption: msg.text,
        })
        if (out.length >= limit) break
      }
      return out
    })
    return {
      ok: true,
      content:
        gifs.length === 0
          ? 'No saved GIFs found. Save GIFs to Saved Messages from any Telegram client first.'
          : gifs
              .map(
                (g) =>
                  `- ${g.dims}, ${g.duration}s${g.caption ? ` "${g.caption.slice(0, 60)}"` : ''} ${g.fileId}`,
              )
              .join('\n'),
      data: { gifs },
    }
  },
})

export const mediaActions = [
  downloadMedia,
  getFileId,
  sendMedia,
  sendPhoto,
  sendFile,
  sendVoice,
  sendSticker,
  sendAlbum,
  listStickerSets,
  getStickerSet,
  searchStickers,
  searchGifs,
]
