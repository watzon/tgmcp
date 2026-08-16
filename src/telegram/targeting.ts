import type { ToolContext, ToolResult } from '../types'

export function explicitChatIdGuard(
  ctx: Pick<ToolContext, 'requireExplicitChatId'>,
  params: unknown,
): ToolResult | null {
  if (!ctx.requireExplicitChatId) return null
  const chatId =
    typeof params === 'object' && params !== null
      ? (params as Record<string, unknown>).chatId
      : undefined
  if (typeof chatId === 'string' && /^-?\d+$/.test(chatId.trim())) return null
  return {
    ok: false,
    content:
      'This action requires an explicit numeric chatId. Call list_chats with the title, then retry with the returned chatId.',
  }
}
