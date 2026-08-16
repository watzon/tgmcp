import { z } from 'zod'
import type { Tool, ToolContext } from '../types'
import type { AuthController } from './controller'

const authInputSchema = z.object({
  command: z.enum([
    'status',
    'set_credentials',
    'send_code',
    'resend_code',
    'sign_in',
    'start_qr',
    'browser',
  ]),
  apiId: z.number().int().positive().optional().describe('From my.telegram.org. Never echoed back.'),
  apiHash: z.string().optional().describe('From my.telegram.org. Stored on disk, never returned.'),
  phone: z.string().optional().describe('E.164 phone for send_code, e.g. +15551234567.'),
  code: z.string().optional().describe('Login code from Telegram. Never stored in results.'),
  password: z.string().optional().describe('2FA password if enabled. Prefer the browser command.'),
})

const authCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('status') }),
  z.object({ command: z.literal('set_credentials'), apiId: z.number().int().positive(), apiHash: z.string() }),
  z.object({ command: z.literal('send_code'), phone: z.string() }),
  z.object({ command: z.literal('resend_code') }),
  z.object({ command: z.literal('sign_in'), code: z.string(), password: z.string().optional() }),
  z.object({ command: z.literal('start_qr'), password: z.string().optional() }),
  z.object({ command: z.literal('browser') }),
])

export const AUTH_TOOL_NAME = 'auth'

export const AUTH_TOOL_DESCRIPTION =
  'Call this tool once per session before any other tgmcp tool to check the current auth state (command status). ' +
  'If not ready, sign in. Prefer command browser on the machine running tgmcp (secrets stay out of the model). ' +
  'On a remote host use set_credentials, then send_code/sign_in or start_qr. ' +
  'Never repeat apiHash, login codes, or 2FA passwords in later messages.'

export const AUTH_REQUIRED_MESSAGE =
  'Not signed in. Use the auth tool to authenticate this account before using other tools. ' +
  'Call auth with command status to check, or command browser to sign in.'

export function createAuthTool(
  auth: AuthController,
  startBrowser: (auth: AuthController) => Promise<{ url: string }>,
): Tool {
  return {
    name: AUTH_TOOL_NAME,
    description: AUTH_TOOL_DESCRIPTION,
    schema: authInputSchema,
    risk: 'owner',
    async execute(input, _ctx: ToolContext) {
      const cmd = authCommandSchema.parse(input)
      switch (cmd.command) {
        case 'status': {
          const status = auth.status()
          return {
            ok: true,
            content: `${status.phase}. ${status.hint}`,
            data: status,
          }
        }
        case 'set_credentials':
          return auth.setCredentials(cmd.apiId, cmd.apiHash)
        case 'send_code':
          return auth.sendCode(cmd.phone)
        case 'resend_code':
          return auth.resendCode()
        case 'sign_in':
          return auth.signIn(cmd.code, cmd.password)
        case 'start_qr':
          return auth.startQr(cmd.password)
        case 'browser': {
          const { url } = await startBrowser(auth)
          return {
            ok: true,
            content: `Browser login is on ${url}. Open it on the machine that runs tgmcp. If this host is remote, use SSH port-forward or use send_code / start_qr instead.`,
            data: { url, bind: '127.0.0.1' },
          }
        }
      }
    },
  }
}
