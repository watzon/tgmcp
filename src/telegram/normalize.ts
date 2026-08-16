import type { Message } from '@mtcute/bun'
import type { StoredMessage } from '../types'

export function toPeer(chatId: string): number {
  const n = Number(chatId)
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid chat id (not a numeric peer id): "${chatId}"`)
  }
  return n
}

export function mediaSummary(msg: Message): string | null {
  const media = msg.media
  return media ? media.type : null
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

export function mediaDetail(msg: Message): string | null {
  const media = msg.media
  if (!media) return null
  switch (media.type) {
    case 'sticker': {
      const emoji = media.emoji || null
      const set = media.inputStickerSet
      const setName =
        set && set._ === 'inputStickerSetShortName' ? ` from "${set.shortName}"` : ''
      const kind =
        media.sourceType === 'animated'
          ? 'animated sticker'
          : media.sourceType === 'video'
            ? 'video sticker'
            : 'sticker'
      return `${kind}${emoji ? ` ${emoji}` : ''}${setName}`
    }
    case 'document': {
      const parts: string[] = []
      if (media.fileName) parts.push(media.fileName)
      if (media.mimeType) parts.push(media.mimeType)
      if (media.fileSize != null) parts.push(formatBytes(media.fileSize))
      return parts.length > 0 ? parts.join(' · ') : null
    }
    case 'audio': {
      const title = [media.title, media.performer].filter(Boolean).join(' · ')
      const parts: string[] = []
      if (title) parts.push(title)
      parts.push(formatDuration(media.duration))
      if (media.fileSize != null) parts.push(formatBytes(media.fileSize))
      return parts.join(' · ')
    }
    case 'voice':
      return formatDuration(media.duration)
    case 'video': {
      const parts: string[] = []
      if (media.isAnimation) parts.push('GIF')
      if (media.isRound) parts.push('round')
      parts.push(`${media.width}×${media.height}`)
      parts.push(formatDuration(media.duration))
      if (media.fileSize != null) parts.push(formatBytes(media.fileSize))
      return parts.join(' · ')
    }
    case 'photo':
      return media.fileSize != null ? formatBytes(media.fileSize) : null
    default:
      return null
  }
}

export function messageToStored(msg: Message): StoredMessage {
  return {
    id: msg.id,
    chatId: String(msg.chat.id),
    senderId: String(msg.sender.id),
    senderName: msg.sender.displayName,
    text: msg.text,
    date: Math.floor(msg.date.getTime() / 1000),
    replyToId: msg.replyToMessage?.id ?? null,
    topicId: msg.replyToMessage?.threadId ?? null,
    isTopicMessage: Boolean(msg.isTopicMessage),
    isOutgoing: msg.isOutgoing,
    mediaSummary: mediaSummary(msg),
    mediaDetail: mediaDetail(msg),
  }
}
