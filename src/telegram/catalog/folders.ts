// src/telegram/catalog/folders.ts — catalog actions for Telegram dialog folders.
import { z } from 'zod'
import { getMarkedPeerId, type TelegramClient } from '@mtcute/node'
import type { tl } from '@mtcute/core'
import type { ToolContext } from '../../types'
import { toPeer } from '../normalize'
import { defineAction } from './action'

function client(ctx: ToolContext): TelegramClient {
  return ctx.tg.client as TelegramClient
}

function peerId(peer: tl.TypeInputPeer): string {
  if (peer._ === 'inputPeerEmpty') return 'empty'
  if (peer._ === 'inputPeerSelf') return 'self'
  return String(getMarkedPeerId(peer))
}

function serializeFolder(folder: tl.TypeDialogFilter): {
  id: number
  title: string
  type: 'default' | 'custom' | 'shared'
  emoji: string | null
  peers: { pinned: string[]; included: string[]; excluded: string[] }
  filters: Record<string, boolean>
} {
  if (folder._ === 'dialogFilterDefault') {
    return {
      id: 0,
      title: 'All chats',
      type: 'default',
      emoji: null,
      peers: { pinned: [], included: [], excluded: [] },
      filters: {},
    }
  }

  const peers = {
    pinned: folder.pinnedPeers.map(peerId),
    included: folder.includePeers.map(peerId),
    excluded: folder._ === 'dialogFilter' ? folder.excludePeers.map(peerId) : [],
  }
  if (folder._ === 'dialogFilterChatlist') {
    return {
      id: folder.id,
      title: folder.title.text,
      type: 'shared',
      emoji: folder.emoticon ?? null,
      peers,
      filters: { hasMyInvites: folder.hasMyInvites ?? false },
    }
  }
  return {
    id: folder.id,
    title: folder.title.text,
    type: 'custom',
    emoji: folder.emoticon ?? null,
    peers,
    filters: {
      contacts: folder.contacts ?? false,
      nonContacts: folder.nonContacts ?? false,
      groups: folder.groups ?? false,
      broadcasts: folder.broadcasts ?? false,
      bots: folder.bots ?? false,
      excludeMuted: folder.excludeMuted ?? false,
      excludeRead: folder.excludeRead ?? false,
      excludeArchived: folder.excludeArchived ?? false,
    },
  }
}

function editableFolder(
  filters: tl.TypeDialogFilter[],
  folderId: number,
): tl.RawDialogFilter {
  const folder = filters.find(
    (candidate): candidate is tl.RawDialogFilter =>
      candidate._ === 'dialogFilter' && candidate.id === folderId,
  )
  if (!folder) throw new Error(`Editable folder ${folderId} was not found.`)
  return folder
}

const listFolders = defineAction({
  name: 'list_folders',
  description: 'List Telegram chat folders with their ids, names, and types.',
  domain: 'folders',
  risk: 'safe',
  schema: z.object({}),
  async run(_p, ctx) {
    const result = await ctx.tg.guard('safe', 'list_folders', ctx.chatId, () =>
      client(ctx).getFolders(),
    )
    const rows = result.filters.map(serializeFolder)
    const content = rows.length
      ? rows.map((folder) => `${folder.id} · ${folder.title} · ${folder.type}`).join('\n')
      : '(no folders)'
    return { ok: true, content, data: rows }
  },
})

const getFolder = defineAction({
  name: 'get_folder',
  description: 'Get one chat folder with its peer lists and inclusion filters.',
  domain: 'folders',
  risk: 'safe',
  schema: z.object({ folderId: z.number().int().nonnegative() }),
  async run(p, ctx) {
    const result = await ctx.tg.guard('safe', 'get_folder', ctx.chatId, () =>
      client(ctx).getFolders(),
    )
    const folder = result.filters.find((candidate) =>
      candidate._ === 'dialogFilterDefault' ? p.folderId === 0 : candidate.id === p.folderId,
    )
    if (!folder) return { ok: false, content: `Folder ${p.folderId} was not found.` }
    const data = serializeFolder(folder)
    return {
      ok: true,
      content: `${data.title} · ${data.peers.included.length} included · ${data.peers.pinned.length} pinned · ${data.peers.excluded.length} excluded`,
      data,
    }
  },
})

const addChatToFolder = defineAction({
  name: 'add_chat_to_folder',
  description: 'Add a chat to a custom Telegram folder.',
  domain: 'folders',
  risk: 'owner',
  schema: z.object({
    folderId: z.number().int().positive(),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = p.chatId ?? ctx.chatId
    await ctx.tg.guard('owner', 'add_chat_to_folder', chatId, async () => {
      const tg = client(ctx)
      const filters = await tg.getFolders()
      const folder = editableFolder(filters.filters, p.folderId)
      const peer = await tg.resolvePeer(toPeer(chatId))
      const target = peerId(peer)
      const isPinned = folder.pinnedPeers.some((candidate) => peerId(candidate) === target)
      const isIncluded = folder.includePeers.some((candidate) => peerId(candidate) === target)
      const includePeers = isPinned || isIncluded ? folder.includePeers : [...folder.includePeers, peer]
      const excludePeers = folder.excludePeers.filter((candidate) => peerId(candidate) !== target)
      await tg.editFolder({ folder, modification: { includePeers, excludePeers } })
    })
    return { ok: true, content: `Added chat ${chatId} to folder ${p.folderId}.` }
  },
})

const removeChatFromFolder = defineAction({
  name: 'remove_chat_from_folder',
  description: 'Remove a chat from a custom Telegram folder.',
  domain: 'folders',
  risk: 'owner',
  schema: z.object({
    folderId: z.number().int().positive(),
    chatId: z.string().optional(),
  }),
  async run(p, ctx) {
    const chatId = p.chatId ?? ctx.chatId
    await ctx.tg.guard('owner', 'remove_chat_from_folder', chatId, async () => {
      const tg = client(ctx)
      const filters = await tg.getFolders()
      const folder = editableFolder(filters.filters, p.folderId)
      const peer = await tg.resolvePeer(toPeer(chatId))
      const target = peerId(peer)
      const includePeers = folder.includePeers.filter((candidate) => peerId(candidate) !== target)
      const pinnedPeers = folder.pinnedPeers.filter((candidate) => peerId(candidate) !== target)
      const isExcluded = folder.excludePeers.some((candidate) => peerId(candidate) === target)
      const excludePeers = isExcluded ? folder.excludePeers : [...folder.excludePeers, peer]
      await tg.editFolder({
        folder,
        modification: { includePeers, pinnedPeers, excludePeers },
      })
    })
    return { ok: true, content: `Removed chat ${chatId} from folder ${p.folderId}.` }
  },
})

export const folderActions = [
  listFolders,
  getFolder,
  addChatToFolder,
  removeChatFromFolder,
]
