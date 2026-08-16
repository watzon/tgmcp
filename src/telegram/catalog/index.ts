import { z } from 'zod'
import type { ToolContext, ToolResult } from '../../types'
import { explicitChatIdGuard } from '../targeting'
import type { CatalogAction } from './action'
import { chatActions } from './chats'
import { draftActions } from './drafts'
import { folderActions } from './folders'
import { interactionActions } from './interactions'
import { mediaActions } from './media'
import { memberActions } from './members'
import { messageActions } from './messages'
import { profileActions } from './profile'
import { topicActions } from './topics'

const allActions: CatalogAction[] = [
  ...messageActions,
  ...chatActions,
  ...memberActions,
  ...draftActions,
  ...folderActions,
  ...mediaActions,
  ...profileActions,
  ...interactionActions,
  ...topicActions,
]

/**
 * Inbox and lookup actions shown when telegram search has no query.
 * Account-admin actions (join, leave, profile edits, folders, invites) stay
 * invokable but are not in this default browse set.
 */
export const CORE_ACTION_NAMES: ReadonlySet<string> = new Set([
  'search_messages',
  'search_global',
  'react',
  'edit_message',
  'delete_message',
  'forward',
  'pin',
  'unpin',
  'get_chat_info',
  'get_user_info',
  'inspect_user',
  'get_members',
  'search_users',
  'get_me',
  'download_media',
  'get_file_id',
  'send_photo',
  'send_file',
  'send_media',
  'send_voice',
  'send_sticker',
  'send_album',
  'interact_message',
  'list_topics',
  'read_topic_history',
])

function isCore(name: string): boolean {
  return CORE_ACTION_NAMES.has(name)
}

const registry: Map<string, CatalogAction> = new Map(allActions.map((a) => [a.name, a]))

export interface ActionCard {
  name: string
  description: string
  domain: string
  risk: string
  core: boolean
}

function toCard(a: CatalogAction): ActionCard {
  return {
    name: a.name,
    description: a.description,
    domain: a.domain,
    risk: a.risk,
    core: isCore(a.name),
  }
}

export function listActions(): ActionCard[] {
  return allActions.map(toCard)
}

export function searchActions(query: string): ActionCard[] {
  const q = query.trim().toLowerCase()
  if (q === '') return allActions.filter((a) => isCore(a.name)).map(toCard)
  const terms = q.split(/\s+/)
  const scored = allActions
    .map((a) => {
      const hay = `${a.name} ${a.domain} ${a.description}`.toLowerCase()
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
      return { a, score }
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || Number(isCore(y.a.name)) - Number(isCore(x.a.name)))
  return scored.map((s) => toCard(s.a))
}

export function describeAction(name: string): {
  name: string
  description: string
  domain: string
  risk: string
  schema: unknown
} | null {
  const action = registry.get(name)
  if (!action) return null
  return {
    name: action.name,
    description: action.description,
    domain: action.domain,
    risk: action.risk,
    schema: z.toJSONSchema(action.schema),
  }
}

function actionHasChatId(action: CatalogAction): boolean {
  const schema = z.toJSONSchema(action.schema) as {
    properties?: Record<string, unknown>
  }
  return schema.properties?.chatId !== undefined
}

export async function invokeAction(
  name: string,
  params: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const action = registry.get(name)
  if (!action) {
    return { ok: false, content: `Unknown action "${name}". Use command "search" to find one.` }
  }
  if (action.risk === 'owner' && !ctx.isOwner) {
    return { ok: false, content: `"${name}" isn’t available in this chat.` }
  }
  if (ctx.requireExplicitChatId && actionHasChatId(action)) {
    const targetError = explicitChatIdGuard(ctx, params)
    if (targetError) return targetError
  }
  const parsed = action.schema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, content: `Invalid params for "${name}": ${parsed.error.message}` }
  }
  try {
    return await action.run(parsed.data, ctx)
  } catch (err) {
    return {
      ok: false,
      content: `Action "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
