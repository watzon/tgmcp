import { describe, expect, test } from 'bun:test'
import { toMcpResult } from './result'

describe('toMcpResult', () => {
  test('marks failures as MCP errors', () => {
    const result = toMcpResult({ ok: false, content: 'blocked' })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'blocked' })
  })

  test('appends structured data for the host', () => {
    const result = toMcpResult({ ok: true, content: 'Sent', data: { id: 9 } })
    expect(result.isError).toBe(false)
    const part = result.content[0]
    expect(part?.type).toBe('text')
    if (part?.type !== 'text') throw new Error('expected text')
    expect(part.text).toContain('Sent')
    expect(part.text).toContain('"id": 9')
  })

  test('attaches MCP image parts after the text', () => {
    const result = toMcpResult({
      ok: true,
      content: 'photo',
      images: [{ mimeType: 'image/jpeg', data: 'AAAA' }],
    })
    expect(result.content).toHaveLength(2)
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: 'AAAA' })
  })
})
