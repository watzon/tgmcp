import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { startBrowserLogin } from '../auth/browser'
import type { AuthController } from '../auth/controller'
import { AUTH_REQUIRED_MESSAGE, createAuthTool } from '../auth/tool'
import { PUBLIC_TOOLS } from '../tools'
import type { Tool, ToolContext } from '../types'
import { toMcpResult } from './result'

export const SERVER_INSTRUCTIONS =
  'This server automates one Telegram user account (user API, not a bot). ' +
  'Call the auth tool once per session (command status) before any other tool. ' +
  'The tool list does not change with auth state. If a tool says you are not signed in, use auth to authenticate. ' +
  'Prefer auth command browser on the machine running tgmcp. ' +
  'On a remote host use set_credentials, then send_code or start_qr. ' +
  'Once ready: list_chats, read_messages, send_message, search_messages. ' +
  'Always pass an explicit numeric chatId. Never echo apiHash, login codes, or 2FA passwords.'

function zodShape(schema: z.ZodType): z.ZodRawShape {
  if (schema instanceof z.ZodObject) {
    return schema.shape as z.ZodRawShape
  }
  return { value: schema }
}

export function createMcpServer(auth: AuthController): McpServer {
  const server = new McpServer(
    { name: 'tgmcp', version: '0.1.1' },
    { instructions: SERVER_INSTRUCTIONS },
  )

  const dummy = {} as ToolContext
  registerTool(server, createAuthTool(auth, (controller) => startBrowserLogin(controller, { open: true })), () => dummy)
  for (const tool of PUBLIC_TOOLS) {
    registerTool(server, tool, () => auth.runtime?.ctx ?? null)
  }

  return server
}

function registerTool(server: McpServer, tool: Tool, ctx: () => ToolContext | null): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: zodShape(tool.schema),
    },
    async (args) => {
      const parsed = tool.schema.safeParse(args)
      if (!parsed.success) {
        return toMcpResult({
          ok: false,
          content: `Invalid arguments for ${tool.name}: ${parsed.error.message}`,
        })
      }
      const context = ctx()
      if (!context) {
        return toMcpResult({
          ok: false,
          content: `${tool.name} failed: ${AUTH_REQUIRED_MESSAGE}`,
        })
      }
      try {
        return toMcpResult(await tool.execute(parsed.data, context))
      } catch (err) {
        return toMcpResult({
          ok: false,
          content: `${tool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    },
  )
}

export async function serveStdio(auth: AuthController): Promise<void> {
  const server = createMcpServer(auth)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
