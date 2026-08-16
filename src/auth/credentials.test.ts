import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { containsSecret, loadCredentials, maskHash, maskPhone, saveCredentials } from './credentials'

describe('credentials file', () => {
  test('round-trips apiId, apiHash, and ownerId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgmcp-creds-'))
    const path = join(dir, 'credentials.json')
    saveCredentials(path, { apiId: 12345, apiHash: 'abcdef0123456789', ownerId: '99' })
    const loaded = loadCredentials(path)
    expect(loaded).toEqual({ apiId: 12345, apiHash: 'abcdef0123456789', ownerId: '99' })
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('abcdef0123456789')
    rmSync(dir, { recursive: true, force: true })
  })

  test('mask helpers never print the secret in full', () => {
    expect(maskHash('abcdef0123456789')).toBe('abcd…')
    expect(maskPhone('+15551234567')).toBe('+•••4567')
    expect(containsSecret('saved hash abcd…', ['abcdef0123456789'])).toBe(false)
    expect(containsSecret('oops abcdef0123456789 leaked', ['abcdef0123456789'])).toBe(true)
  })
})
