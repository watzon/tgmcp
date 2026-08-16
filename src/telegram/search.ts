import type { Message } from '@mtcute/node'
import { SearchFilters } from '@mtcute/node'
import type { tl } from '@mtcute/core'
import { mediaSummary } from './normalize'

export const MESSAGE_SEARCH_FILTERS = [
  'empty',
  'photo',
  'video',
  'photo_and_video',
  'document',
  'url',
  'gif',
  'voice',
  'audio',
  'chat_photo_change',
  'call',
  'round',
  'round_and_voice',
  'my_mention',
  'location',
  'contact',
  'pinned',
  'poll',
] as const

export type MessageSearchFilterName = (typeof MESSAGE_SEARCH_FILTERS)[number]

const FILTER_TO_TL: Record<MessageSearchFilterName, tl.TypeMessagesFilter> = {
  empty: SearchFilters.Empty,
  photo: SearchFilters.Photo,
  video: SearchFilters.Video,
  photo_and_video: SearchFilters.PhotoAndVideo,
  document: SearchFilters.Document,
  url: SearchFilters.Url,
  gif: SearchFilters.Gif,
  voice: SearchFilters.Voice,
  audio: SearchFilters.Audio,
  chat_photo_change: SearchFilters.ChatPhotoChange,
  call: SearchFilters.Call,
  round: SearchFilters.Round,
  round_and_voice: SearchFilters.RoundAndVoice,
  my_mention: SearchFilters.MyMention,
  location: SearchFilters.Location,
  contact: SearchFilters.Contact,
  pinned: SearchFilters.Pinned,
  poll: SearchFilters.Polls,
}

export function toTlMessagesFilter(name: MessageSearchFilterName): tl.TypeMessagesFilter {
  return FILTER_TO_TL[name]
}

export interface CompactMessageHit {
  chatId: string
  id: number
  senderId: string
  senderName: string
  text: string
  date: number
  replyToId: number | null
  mediaSummary: string | null
}

export function toCompactMessageHit(msg: Message): CompactMessageHit {
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

export interface CompactMessageHitRenderOpts {
  includeChatId?: boolean
}

export function formatMessageHitLine(
  hit: CompactMessageHit,
  opts: CompactMessageHitRenderOpts = {},
): string {
  const when = new Date(hit.date * 1000).toISOString().replace('T', ' ').slice(0, 16)
  const who = hit.senderName || 'unknown'
  const scope = opts.includeChatId ? ` [chat ${hit.chatId}]` : ''
  const media = hit.mediaSummary ? ` [${hit.mediaSummary}]` : ''
  const body = hit.text || (hit.mediaSummary ? '' : '(no text)')
  return `[${when}]${scope} ${who}: ${body}${media}`.trimEnd()
}

export function renderCompactMessageHits(
  hits: readonly CompactMessageHit[],
  opts: CompactMessageHitRenderOpts = {},
): string {
  if (hits.length === 0) return '(no messages)'
  return hits.map((hit) => formatMessageHitLine(hit, opts)).join('\n')
}
