// src/telegram/catalog/interactions.ts — live inspect / press / vote / media-group actions.
import { createHmac, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Message, TelegramClient } from '@mtcute/node'
import type { tl } from '@mtcute/core'
import type { ToolContext, ToolResult } from '../../types'
import { toPeer } from '../normalize'
import { confineToChat, defineAction } from './action'

const BUTTON_FINGERPRINT_KEY = randomBytes(32)

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function chatOf(ctx: ToolContext, chatId?: string): string {
  return chatId ?? ctx.chatId
}

const OPERATIONS = [
  'inspect',
  'press_button',
  'vote_poll',
  'retract_poll_vote',
  'list_media_group',
] as const

type Operation = (typeof OPERATIONS)[number]

type ButtonKind =
  | 'callback'
  | 'game'
  | 'text'
  | 'url'
  | 'url_auth'
  | 'webview'
  | 'simple_webview'
  | 'switch_inline'
  | 'user_profile'
  | 'copy'
  | 'buy'
  | 'request_contact'
  | 'request_geo'
  | 'request_poll'
  | 'request_peer'
  | 'unknown'

interface ButtonCapabilities {
  /** Can be pressed via getCallbackAnswer / sendText without UI. */
  canPress: boolean
  /** Destination/query/id can be resolved and returned without completing a UI flow. */
  canResolve: boolean
  /** Needs a real Telegram UI surface (purchase, contact share, auth, etc.). */
  requiresUi: boolean
}

interface FlatButton {
  index: number
  row: number
  col: number
  text: string
  kind: ButtonKind
  capabilities: ButtonCapabilities
  raw: tl.TypeKeyboardButton
}

interface ButtonView {
  index: number
  row: number
  col: number
  label: string
  kind: ButtonKind
  fingerprint: string
  canPress: boolean
  canResolve: boolean
  requiresUi: boolean
  requiresPassword: boolean
}

interface PollOptionView {
  index: number
  text: string
  voters: number
  chosen: boolean
  correct: boolean | null
}

interface PollView {
  question: string
  closed: boolean
  multiple: boolean
  quiz: boolean
  public: boolean
  voters: number
  options: PollOptionView[]
  solution: string | null
}

interface MediaGroupMemberView {
  item: number
  messageId: number
  mediaType: string | null
  caption: string
}

const schema = z.object({
  operation: z.enum(OPERATIONS),
  messageId: z.number().int(),
  chatId: z.string().optional(),
  /** 1-based row-major button index. */
  button: z.number().int().positive().optional(),
  /** Opaque identity returned by inspect for the selected live button. */
  fingerprint: z.string().min(1).optional(),
  /** 1-based poll option indexes. */
  options: z.array(z.number().int().positive()).optional(),
  /** Dispatch callback/game without waiting for Telegram confirmation. */
  fireAndForget: z.boolean().optional(),
})

type Params = z.infer<typeof schema>

async function fetchMessage(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
): Promise<Message | null> {
  const [msg] = await ctx.tg.guard('safe', 'inspect_message', chatId, () =>
    client(ctx).getMessages(toPeer(chatId), messageId),
  )
  return msg ?? null
}

function classifyButton(btn: tl.TypeKeyboardButton): {
  kind: ButtonKind
  capabilities: ButtonCapabilities
} {
  switch (btn._) {
    case 'keyboardButtonCallback':
      return {
        kind: 'callback',
        capabilities: {
          canPress: !btn.requiresPassword,
          canResolve: false,
          requiresUi: Boolean(btn.requiresPassword),
        },
      }
    case 'keyboardButtonGame':
      return {
        kind: 'game',
        capabilities: { canPress: true, canResolve: false, requiresUi: false },
      }
    case 'keyboardButton':
      return {
        kind: 'text',
        capabilities: { canPress: true, canResolve: false, requiresUi: false },
      }
    case 'keyboardButtonUrl':
      return {
        kind: 'url',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonUrlAuth':
    case 'inputKeyboardButtonUrlAuth':
      return {
        kind: 'url_auth',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonWebView':
      return {
        kind: 'webview',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonSimpleWebView':
      return {
        kind: 'simple_webview',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonSwitchInline':
      return {
        kind: 'switch_inline',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonUserProfile':
    case 'inputKeyboardButtonUserProfile':
      return {
        kind: 'user_profile',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonCopy':
      return {
        kind: 'copy',
        capabilities: { canPress: false, canResolve: true, requiresUi: true },
      }
    case 'keyboardButtonBuy':
      return {
        kind: 'buy',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
    case 'keyboardButtonRequestPhone':
      return {
        kind: 'request_contact',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
    case 'keyboardButtonRequestGeoLocation':
      return {
        kind: 'request_geo',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
    case 'keyboardButtonRequestPoll':
      return {
        kind: 'request_poll',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
    case 'keyboardButtonRequestPeer':
    case 'inputKeyboardButtonRequestPeer':
      return {
        kind: 'request_peer',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
    default:
      return {
        kind: 'unknown',
        capabilities: { canPress: false, canResolve: false, requiresUi: true },
      }
  }
}

function flattenButtons(msg: Message): FlatButton[] {
  const markup = msg.markup
  if (!markup || !('type' in markup)) return []
  if (markup.type !== 'inline' && markup.type !== 'reply') return []
  const out: FlatButton[] = []
  let index = 1
  for (let rowIdx = 0; rowIdx < markup.buttons.length; rowIdx++) {
    const row = markup.buttons[rowIdx]!
    for (let colIdx = 0; colIdx < row.length; colIdx++) {
      const btn = row[colIdx]!
      const { kind, capabilities } = classifyButton(btn)
      out.push({
        index,
        row: rowIdx + 1,
        col: colIdx + 1,
        text: 'text' in btn ? String(btn.text) : '',
        kind,
        capabilities,
        raw: btn,
      })
      index += 1
    }
  }
  return out
}

function buttonFingerprint(messageId: number, btn: FlatButton): string {
  const fingerprint = createHmac('sha256', BUTTON_FINGERPRINT_KEY)
    .update(String(messageId))
    .update('\0')
    .update(String(btn.row))
    .update('\0')
    .update(String(btn.col))
    .update('\0')
    .update(btn.raw._)
    .update('\0')
    .update(btn.text)
  if (btn.raw._ === 'keyboardButtonCallback') {
    fingerprint.update('\0').update(btn.raw.data)
  }
  return fingerprint.digest('hex')
}

function toButtonView(messageId: number, btn: FlatButton): ButtonView {
  return {
    index: btn.index,
    row: btn.row,
    col: btn.col,
    label: btn.text,
    kind: btn.kind,
    fingerprint: buttonFingerprint(messageId, btn),
    canPress: btn.capabilities.canPress,
    canResolve: btn.capabilities.canResolve,
    requiresUi: btn.capabilities.requiresUi,
    requiresPassword:
      btn.raw._ === 'keyboardButtonCallback' ? Boolean(btn.raw.requiresPassword) : false,
  }
}

function pollFromMessage(msg: Message): PollView | null {
  const media = msg.media
  if (!media || media.type !== 'poll') return null
  return {
    question: media.question,
    closed: media.isClosed,
    multiple: media.isMultiple,
    quiz: media.isQuiz,
    public: media.isPublic,
    voters: media.voters,
    solution: media.solution,
    options: media.answers.map((answer, i) => ({
      index: i + 1,
      text: answer.text,
      voters: answer.voters,
      chosen: answer.chosen,
      correct: answer.correct,
    })),
  }
}

function mediaGroupMembers(messages: Message[]): MediaGroupMemberView[] {
  const sorted = [...messages].sort((a, b) => a.id - b.id)
  return sorted.map((m, i) => ({
    item: i + 1,
    messageId: m.id,
    mediaType: m.media?.type ?? null,
    caption: m.text ?? '',
  }))
}

function formatButtons(buttons: ButtonView[]): string {
  if (buttons.length === 0) return 'Buttons: (none)'
  const lines = buttons.map((b) => {
    const flags = [
      b.canPress ? 'pressable' : null,
      b.canResolve ? 'resolvable' : null,
      b.requiresUi ? 'requires-ui' : null,
      b.requiresPassword ? 'password-required' : null,
    ]
      .filter(Boolean)
      .join(', ')
    return `#${b.index} [${b.row},${b.col}] ${b.kind} "${b.label}" (${flags || 'inert'}); fingerprint=${b.fingerprint}`
  })
  return `Buttons (${buttons.length}):\n${lines.join('\n')}`
}

function formatPoll(poll: PollView): string {
  const status = [
    poll.closed ? 'closed' : 'open',
    poll.multiple ? 'multiple' : 'single',
    poll.quiz ? 'quiz' : null,
    poll.public ? 'public' : 'anonymous',
    `${poll.voters} voter(s)`,
  ]
    .filter(Boolean)
    .join(', ')
  const opts = poll.options
    .map((o) => {
      const marks = [
        o.chosen ? 'chosen' : null,
        o.correct === true ? 'correct' : null,
        `${o.voters} vote(s)`,
      ]
        .filter(Boolean)
        .join(', ')
      return `  #${o.index} "${o.text}" (${marks})`
    })
    .join('\n')
  const solution = poll.solution ? `\nSolution: ${poll.solution}` : ''
  return `Poll: "${poll.question}" (${status})\n${opts}${solution}`
}

function formatGroup(members: MediaGroupMemberView[]): string {
  if (members.length === 0) return 'Media group: (empty)'
  const lines = members.map(
    (m) =>
      `#${m.item} message #${m.messageId} · ${m.mediaType ?? 'none'}${m.caption ? ` · ${m.caption}` : ''}`,
  )
  return `Media group (${members.length}):\n${lines.join('\n')}`
}

function resolveButtonPayload(btn: FlatButton): Record<string, unknown> {
  const raw = btn.raw
  switch (raw._) {
    case 'keyboardButtonUrl':
      return { url: raw.url }
    case 'keyboardButtonUrlAuth':
      return { url: raw.url, buttonId: raw.buttonId, fwdText: raw.fwdText ?? null }
    case 'inputKeyboardButtonUrlAuth':
      return { url: raw.url, fwdText: raw.fwdText ?? null }
    case 'keyboardButtonWebView':
    case 'keyboardButtonSimpleWebView':
      return { url: raw.url }
    case 'keyboardButtonSwitchInline':
      return {
        query: raw.query,
        samePeer: Boolean(raw.samePeer),
      }
    case 'keyboardButtonUserProfile':
      return { userId: raw.userId }
    case 'inputKeyboardButtonUserProfile':
      return { userId: 'userId' in raw ? raw.userId : null }
    case 'keyboardButtonCopy':
      return { copyText: raw.copyText }
    default:
      return {}
  }
}

async function inspectMessage(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
): Promise<ToolResult> {
  const msg = await fetchMessage(ctx, chatId, messageId)
  if (!msg) return { ok: false, content: `Message #${messageId} not found in ${chatId}.` }

  const buttons = flattenButtons(msg).map((button) => toButtonView(messageId, button))
  const poll = pollFromMessage(msg)

  let group: MediaGroupMemberView[] | null = null
  if (msg.groupedId != null) {
    const members = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
      client(ctx).getMessageGroup({ chatId: toPeer(chatId), message: messageId }),
    )
    group = mediaGroupMembers(members)
  }

  const parts = [
    `Message #${messageId} in ${chatId}.`,
    formatButtons(buttons),
    poll ? formatPoll(poll) : 'Poll: (none)',
    group ? formatGroup(group) : 'Media group: (not grouped)',
  ]

  return {
    ok: true,
    content: parts.join('\n\n'),
    data: {
      messageId,
      chatId,
      buttons,
      poll,
      mediaGroup: group,
      grouped: group != null,
    },
  }
}

async function pressButton(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
  buttonIndex: number,
  expectedFingerprint: string,
  fireAndForget?: boolean,
): Promise<ToolResult> {
  const msg = await fetchMessage(ctx, chatId, messageId)
  if (!msg) return { ok: false, content: `Message #${messageId} not found in ${chatId}.` }

  const buttons = flattenButtons(msg)
  const btn = buttons.find((b) => b.index === buttonIndex)
  if (!btn) {
    return {
      ok: false,
      content: `No button #${buttonIndex} on message #${messageId}.`,
      data: { buttonCount: buttons.length },
    }
  }

  const view = toButtonView(messageId, btn)
  if (view.fingerprint !== expectedFingerprint) {
    return {
      ok: false,
      content: `Button #${buttonIndex} changed after inspection; inspect message #${messageId} again.`,
      data: { stale: true, button: view },
    }
  }

  if (btn.raw._ === 'keyboardButtonCallback' && btn.raw.requiresPassword) {
    return {
      ok: false,
      content: `Button #${buttonIndex} ("${btn.text}") requires a 2FA password and cannot be pressed.`,
      data: { button: view },
    }
  }

  switch (btn.raw._) {
    case 'keyboardButtonCallback': {
      // Freeze live callback bytes before the RPC so concurrent markup edits cannot race.
      const data = btn.raw.data.slice()
      const answer = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
        client(ctx).getCallbackAnswer({
          chatId: toPeer(chatId),
          message: messageId,
          data,
          fireAndForget,
        }),
      )
      const parts: string[] = []
      if (answer.message) parts.push(answer.message)
      if (answer.url) parts.push(answer.url)
      if (answer.alert) parts.push('(alert)')
      const confirmed = !fireAndForget
      return {
        ok: true,
        content: confirmed
          ? parts.length > 0
            ? parts.join(' ')
            : `Pressed callback button #${buttonIndex}.`
          : `Dispatched callback button #${buttonIndex} without confirmation.`,
        data: {
          confirmed,
          button: view,
          answer: {
            message: answer.message ?? null,
            url: answer.url ?? null,
            alert: Boolean(answer.alert),
            hasUrl: Boolean(answer.hasUrl),
            nativeUi: Boolean(answer.nativeUi),
          },
        },
      }
    }
    case 'keyboardButtonGame': {
      const answer = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
        client(ctx).getCallbackAnswer({
          chatId: toPeer(chatId),
          message: messageId,
          data: new Uint8Array(),
          game: true,
          fireAndForget,
        }),
      )
      const parts: string[] = []
      if (answer.message) parts.push(answer.message)
      if (answer.url) parts.push(answer.url)
      if (answer.alert) parts.push('(alert)')
      const confirmed = !fireAndForget
      return {
        ok: true,
        content: confirmed
          ? parts.length > 0
            ? parts.join(' ')
            : `Pressed game button #${buttonIndex}.`
          : `Dispatched game button #${buttonIndex} without confirmation.`,
        data: {
          confirmed,
          button: view,
          answer: {
            message: answer.message ?? null,
            url: answer.url ?? null,
            alert: Boolean(answer.alert),
            hasUrl: Boolean(answer.hasUrl),
            nativeUi: Boolean(answer.nativeUi),
          },
        },
      }
    }
    case 'keyboardButton': {
      const sent = await ctx.tg.sendText(chatId, btn.text, { format: 'plain' })
      return {
        ok: true,
        content: `Sent reply-keyboard text for button #${buttonIndex}: "${btn.text}".`,
        data: { button: view, messageId: sent.id },
      }
    }
    case 'keyboardButtonUrl':
    case 'keyboardButtonUrlAuth':
    case 'inputKeyboardButtonUrlAuth':
    case 'keyboardButtonWebView':
    case 'keyboardButtonSimpleWebView':
    case 'keyboardButtonSwitchInline':
    case 'keyboardButtonUserProfile':
    case 'inputKeyboardButtonUserProfile':
    case 'keyboardButtonCopy': {
      const resolved = resolveButtonPayload(btn)
      return {
        ok: true,
        content: `Resolved ${btn.kind} button #${buttonIndex} ("${btn.text}") without completing a UI flow: ${JSON.stringify(resolved)}`,
        data: { button: view, resolved },
      }
    }
    case 'keyboardButtonBuy':
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") is a purchase button and cannot be completed.`,
        data: { button: view },
      }
    case 'keyboardButtonRequestPhone':
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") requests contact and requires UI; cannot be pressed.`,
        data: { button: view },
      }
    case 'keyboardButtonRequestGeoLocation':
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") requests location and requires UI; cannot be pressed.`,
        data: { button: view },
      }
    case 'keyboardButtonRequestPoll':
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") requests a poll and requires UI; cannot be pressed.`,
        data: { button: view },
      }
    case 'keyboardButtonRequestPeer':
    case 'inputKeyboardButtonRequestPeer':
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") requests a peer and requires UI; cannot be pressed.`,
        data: { button: view },
      }
    default:
      return {
        ok: false,
        content: `Button #${buttonIndex} ("${btn.text}") has unsupported kind "${btn.kind}" and cannot be pressed.`,
        data: { button: view },
      }
  }
}

async function votePoll(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
  optionIndexes: number[],
): Promise<ToolResult> {
  const msg = await fetchMessage(ctx, chatId, messageId)
  if (!msg) return { ok: false, content: `Message #${messageId} not found in ${chatId}.` }

  const media = msg.media
  if (!media || media.type !== 'poll') {
    return { ok: false, content: `Message #${messageId} is not a poll.` }
  }
  if (media.isClosed) {
    return { ok: false, content: `Poll on message #${messageId} is closed.` }
  }
  if (optionIndexes.length === 0) {
    return { ok: false, content: 'vote_poll requires at least one option (1-based).' }
  }
  if (!media.isMultiple && optionIndexes.length !== 1) {
    return { ok: false, content: 'This poll only allows a single option.' }
  }

  const unique = [...new Set(optionIndexes)]
  if (unique.length !== optionIndexes.length) {
    return { ok: false, content: 'Duplicate poll options are not allowed.' }
  }

  const answerBytes: Uint8Array[] = []
  for (const idx of unique) {
    const answer = media.answers[idx - 1]
    if (!answer) {
      return {
        ok: false,
        content: `Poll has no option #${idx} (1-${media.answers.length}).`,
      }
    }
    // Use live answer.data bytes, not positional indexes, for the RPC.
    answerBytes.push(answer.data.slice())
  }

  const updated = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
    client(ctx).sendVote({
      chatId: toPeer(chatId),
      message: messageId,
      options: answerBytes,
    }),
  )

  const poll: PollView = {
    question: updated.question,
    closed: updated.isClosed,
    multiple: updated.isMultiple,
    quiz: updated.isQuiz,
    public: updated.isPublic,
    voters: updated.voters,
    solution: updated.solution,
    options: updated.answers.map((answer, i) => ({
      index: i + 1,
      text: answer.text,
      voters: answer.voters,
      chosen: answer.chosen,
      correct: answer.correct,
    })),
  }

  return {
    ok: true,
    content: `Voted on poll message #${messageId} (options ${unique.join(', ')}).`,
    data: {
      messageId,
      chatId,
      selected: unique,
      poll,
    },
  }
}

async function retractPollVote(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
): Promise<ToolResult> {
  const msg = await fetchMessage(ctx, chatId, messageId)
  if (!msg) return { ok: false, content: `Message #${messageId} not found in ${chatId}.` }

  const media = msg.media
  if (!media || media.type !== 'poll') {
    return { ok: false, content: `Message #${messageId} is not a poll.` }
  }
  if (media.isClosed) {
    return { ok: false, content: `Poll on message #${messageId} is closed.` }
  }
  if (media.isRevotingDisabled) {
    return {
      ok: false,
      content: `Poll on message #${messageId} does not allow retracting votes.`,
    }
  }

  const updated = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
    client(ctx).sendVote({
      chatId: toPeer(chatId),
      message: messageId,
      options: null,
    }),
  )

  return {
    ok: true,
    content: `Retracted vote on poll message #${messageId}.`,
    data: {
      messageId,
      chatId,
      poll: {
        question: updated.question,
        closed: updated.isClosed,
        multiple: updated.isMultiple,
        voters: updated.voters,
        options: updated.answers.map((answer, i) => ({
          index: i + 1,
          text: answer.text,
          voters: answer.voters,
          chosen: answer.chosen,
        })),
      },
    },
  }
}

async function listMediaGroup(
  ctx: ToolContext,
  chatId: string,
  messageId: number,
): Promise<ToolResult> {
  const msg = await fetchMessage(ctx, chatId, messageId)
  if (!msg) return { ok: false, content: `Message #${messageId} not found in ${chatId}.` }
  if (msg.groupedId == null) {
    return { ok: false, content: `Message #${messageId} is not part of a media group.` }
  }

  const members = await ctx.tg.guard('caution', 'interact_message', chatId, () =>
    client(ctx).getMessageGroup({ chatId: toPeer(chatId), message: messageId }),
  )
  const group = mediaGroupMembers(members)
  if (group.length === 0) {
    return { ok: false, content: `Message #${messageId} media group is empty.` }
  }

  return {
    ok: true,
    content: formatGroup(group),
    data: {
      messageId,
      chatId,
      members: group,
    },
  }
}

const interactMessage = defineAction({
  name: 'interact_message',
  description:
    'Live-inspect and safely act on ordinary Telegram message interactivity: buttons, polls, and media groups. Inspect first, then pass the returned opaque fingerprint when pressing a button. Fetches current message state before every action. Never completes purchases/auth or accepts 2FA passwords.',
  domain: 'messages',
  risk: 'caution',
  schema,
  async run(p, ctx) {
    const chatId = chatOf(ctx, p.chatId)
    const denied = confineToChat(ctx, chatId)
    if (denied) return denied

    const operation = p.operation as Operation
    switch (operation) {
      case 'inspect':
        return inspectMessage(ctx, chatId, p.messageId)
      case 'press_button': {
        if (p.button == null) {
          return { ok: false, content: 'press_button requires a 1-based button index.' }
        }
        if (p.fingerprint == null) {
          return {
            ok: false,
            content: 'press_button requires the opaque fingerprint returned by inspect.',
          }
        }
        return pressButton(
          ctx,
          chatId,
          p.messageId,
          p.button,
          p.fingerprint,
          p.fireAndForget,
        )
      }
      case 'vote_poll': {
        if (p.options == null || p.options.length === 0) {
          return {
            ok: false,
            content: 'vote_poll requires options (1-based positive indexes).',
          }
        }
        return votePoll(ctx, chatId, p.messageId, p.options)
      }
      case 'retract_poll_vote':
        return retractPollVote(ctx, chatId, p.messageId)
      case 'list_media_group':
        return listMediaGroup(ctx, chatId, p.messageId)
      default:
        return { ok: false, content: `Unsupported operation "${String(operation)}".` }
    }
  },
})

export const interactionActions = [interactMessage]

// Keep Params referenced so schema inference stays intentional for tests/tools.
export type InteractMessageParams = Params
