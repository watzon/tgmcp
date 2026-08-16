import { z } from 'zod'
import type { Tool, ToolContext } from '../types'
import { describeAction, invokeAction, searchActions } from './catalog'

const knifeInputSchema = z.object({
  command: z.enum(['search', 'describe', 'invoke']),
  query: z.string().optional().describe('For "search": keywords to match action names/descriptions.'),
  name: z.string().optional().describe('For "describe"/"invoke": the exact action name.'),
  params: z.unknown().optional().describe('For "invoke": the action’s parameters object.'),
})

const knifeCommandSchema = z.discriminatedUnion('command', [
  z.object({ command: z.literal('search'), query: z.string().default('') }),
  z.object({ command: z.literal('describe'), name: z.string() }),
  z.object({ command: z.literal('invoke'), name: z.string(), params: z.unknown().optional() }),
])

export const knifeTool: Tool = {
  name: 'telegram',
  description:
    'Long-tail Telegram actions (react, edit, forward, media, user lookup, topics). ' +
    'Empty search lists inbox/lookup actions only; pass a query such as "join" or "folder" for account-admin actions. ' +
    'Commands: "search", "describe", "invoke". Chat-scoped actions need an explicit numeric chatId.',
  schema: knifeInputSchema,
  risk: 'caution',
  async execute(input, ctx: ToolContext) {
    const cmd = knifeCommandSchema.parse(input)
    switch (cmd.command) {
      case 'search': {
        const results = searchActions(cmd.query)
        const content = results.length
          ? results.map((r) => `${r.name} [${r.domain}/${r.risk}] · ${r.description}`).join('\n')
          : '(no matching actions)'
        return { ok: true, content, data: results }
      }
      case 'describe': {
        const info = describeAction(cmd.name)
        if (!info) {
          return { ok: false, content: `Unknown action "${cmd.name}". Try command "search" first.` }
        }
        return {
          ok: true,
          content: `${info.name} [${info.domain}/${info.risk}] · ${info.description}\nparams: ${JSON.stringify(info.schema)}`,
          data: info,
        }
      }
      case 'invoke':
        return invokeAction(cmd.name, cmd.params, ctx)
    }
  },
}
