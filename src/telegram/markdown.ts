import { md } from '@mtcute/node'
import type { InputText, TextWithEntities } from '@mtcute/node'

export function parseOutbound(raw: string): InputText {
  try {
    return md(raw)
  } catch {
    return raw
  }
}

const CODE_ENTITY_TYPES: Record<string, true> = {
  messageEntityCode: true,
  messageEntityPre: true,
}

const DANGLING_TAGS: ReadonlyArray<readonly [tag: string, label: string]> = [
  ['**', 'bold'],
  ['__', 'italic'],
  ['~~', 'strikethrough'],
  ['||', 'spoiler'],
]

export function lintOutboundMarkdown(raw: string): string[] {
  let parsed: TextWithEntities
  try {
    parsed = md(raw)
  } catch {
    return [
      'the markdown failed to parse (an unclosed ``` fence?), so the whole message went out with raw markup characters visible',
    ]
  }

  let visible = parsed.text
  for (const entity of parsed.entities ?? []) {
    const e = entity as unknown as { _: string; offset: number; length: number }
    if (CODE_ENTITY_TYPES[e._]) {
      visible =
        visible.slice(0, e.offset) + ' '.repeat(e.length) + visible.slice(e.offset + e.length)
    }
  }

  const issues: string[] = []
  if (visible.includes('`')) {
    issues.push('a stray ` backtick is visible (code tag never closed)')
  }
  for (const [tag, label] of DANGLING_TAGS) {
    if (visible.includes(tag)) {
      issues.push(`a dangling ${tag} is visible (${label} tag never closed)`)
    }
  }
  if (/^#{1,6} /m.test(visible)) {
    issues.push('a leading # header line renders as plain text (Telegram has no headers)')
  }
  return issues
}
