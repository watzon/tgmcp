import type { z } from 'zod'
import type { RiskTier, ToolContext, ToolResult } from '../../types'

export interface CatalogAction<I = unknown> {
  name: string
  description: string
  domain: string
  risk: RiskTier
  schema: z.ZodType<I>
  run(params: I, ctx: ToolContext): Promise<ToolResult>
}

export function confineToChat(ctx: ToolContext, targetChatId: string): ToolResult | null {
  if (targetChatId !== ctx.chatId && !ctx.isOwner) {
    return {
      ok: false,
      content: `Can only act on the current chat (${ctx.chatId}) right now.`,
    }
  }
  return null
}

export function defineAction<S extends z.ZodType>(spec: {
  name: string
  description: string
  domain: string
  risk: RiskTier
  schema: S
  run: (params: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>
}): CatalogAction {
  return {
    name: spec.name,
    description: spec.description,
    domain: spec.domain,
    risk: spec.risk,
    schema: spec.schema as z.ZodType<unknown>,
    run: (params, ctx) => spec.run(spec.schema.parse(params), ctx),
  }
}
