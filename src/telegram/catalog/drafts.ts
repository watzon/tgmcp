// src/telegram/catalog/drafts.ts — catalog actions for reading and managing chat drafts.
import { z } from 'zod'
import type { TelegramClient } from '@mtcute/node'
import type { ToolContext } from '../../types'
import { toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

const getDraft = defineAction({
  name: 'get_draft',
  description: 'Get the saved draft message for a chat.',
  domain: 'drafts',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    const [dialog] = await ctx.tg.guard('safe', 'get_draft', chatId, () =>
      client(ctx).getPeerDialogs(toPeer(chatId)),
    )
    const draft = dialog?.draftMessage
    if (!draft) return { ok: true, content: '(no draft)', data: { draft: null } }
    const data = {
      text: draft.text,
      updatedAt: draft.date.toISOString(),
      disableWebPreview: draft.disableWebPreview,
    }
    return { ok: true, content: draft.text, data }
  },
})

const setDraft = defineAction({
  name: 'set_draft',
  description: 'Save or replace the draft message for a chat.',
  domain: 'drafts',
  risk: 'caution',
  schema: z.object({
    text: z.string().min(1).max(4096),
    chatId: z.string().optional(),
    disableWebPreview: z.boolean().optional(),
  }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.guard('caution', 'set_draft', chatId, () =>
      client(ctx).saveDraft(toPeer(chatId), {
        message: p.text,
        noWebpage: p.disableWebPreview,
      }),
    )
    return { ok: true, content: `Saved draft for ${chatId}.` }
  },
})

const clearDraft = defineAction({
  name: 'clear_draft',
  description: 'Clear the saved draft message from a chat.',
  domain: 'drafts',
  risk: 'safe',
  schema: z.object({ chatId: z.string().optional() }),
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied
    await ctx.tg.guard('safe', 'clear_draft', chatId, () =>
      client(ctx).saveDraft(toPeer(chatId), null),
    )
    return { ok: true, content: `Cleared draft for ${chatId}.` }
  },
})

export const draftActions = [getDraft, setDraft, clearDraft]
