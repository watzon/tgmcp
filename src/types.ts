import type { z } from 'zod'
import type { TgmcpConfig } from './config'

export type RiskTier = 'safe' | 'caution' | 'owner'

export interface ToolImage {
  mimeType: string
  /** Base64-encoded image bytes for MCP image content. */
  data: string
}

export interface ToolResult {
  ok: boolean
  content: string
  data?: unknown
  images?: ToolImage[]
}

export interface Tool<I = unknown> {
  name: string
  description: string
  schema: z.ZodType<I>
  risk: RiskTier
  execute(input: I, ctx: ToolContext): Promise<ToolResult>
}

export interface LedgerEntry {
  chatId: string
  action: string
  risk: RiskTier
  detail?: string
  ok: boolean
}

export interface StoredMessage {
  id: number
  chatId: string
  senderId: string
  senderName: string
  text: string
  date: number
  replyToId: number | null
  topicId: number | null
  isTopicMessage: boolean
  isOutgoing: boolean
  mediaSummary: string | null
  mediaDetail: string | null
}

export interface TelegramSendTextOptions {
  format?: 'markdown' | 'plain'
  threadId?: number
  replyToId?: number
  quoteText?: string
  quoteOffset?: number
}

export interface TelegramReplyOptions {
  threadId?: number
  quoteText?: string
  quoteOffset?: number
}

export interface TelegramActions {
  sendText(
    chatId: string,
    text: string,
    opts?: TelegramSendTextOptions,
  ): Promise<{ id: number }>
  reply(
    chatId: string,
    replyToId: number,
    text: string,
    opts?: TelegramReplyOptions,
  ): Promise<{ id: number }>
  react(chatId: string, messageId: number, emoji: string): Promise<void>
  readHistory(chatId: string): Promise<void>
  setTyping(chatId: string, on: boolean): Promise<void>
  getHistory(
    chatId: string,
    opts?: { limit?: number; topicId?: number },
  ): Promise<StoredMessage[]>
  listDialogs(
    opts?: { limit?: number },
  ): Promise<Array<{ chatId: string; title: string; type: string; unread: number }>>
  /** Raw mtcute client. Catalog actions must call it only through guard(). */
  client: unknown
  guard<T>(risk: RiskTier, action: string, chatId: string, fn: () => Promise<T>): Promise<T>
}

export interface ToolContext {
  /**
   * Ledger chat for account-wide actions. Always the authenticated user id.
   * Chat-scoped tools must still pass an explicit numeric chatId.
   */
  chatId: string
  ownerId: string
  isOwner: boolean
  requireExplicitChatId: boolean
  tg: TelegramActions
  config: TgmcpConfig
  log(msg: string): void
  ledger(entry: LedgerEntry): Promise<void>
}

export type ToolRegistry = Map<string, Tool>
