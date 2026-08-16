import type { ToolResult } from '../types'

export function toMcpResult(result: ToolResult) {
  const text =
    result.data === undefined
      ? result.content
      : `${result.content}\n\n${JSON.stringify(result.data, null, 2)}`
  const content: Array<
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string }
  > = [{ type: 'text', text }]
  for (const image of result.images ?? []) {
    content.push({ type: 'image', mimeType: image.mimeType, data: image.data })
  }
  return {
    content,
    isError: !result.ok,
  }
}
