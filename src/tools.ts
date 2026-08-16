import { knifeTool } from './telegram/knife'
import { tier1Tools } from './telegram/tier1'
import type { Tool, ToolRegistry } from './types'

export const PUBLIC_TOOLS: readonly Tool[] = [...tier1Tools, knifeTool]

export function buildRegistry(): ToolRegistry {
  const registry: ToolRegistry = new Map()
  for (const tool of PUBLIC_TOOLS) {
    if (registry.has(tool.name)) {
      throw new Error(`Duplicate tool name in registry: "${tool.name}".`)
    }
    registry.set(tool.name, tool)
  }
  return registry
}
