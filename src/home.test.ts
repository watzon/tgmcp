import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { DEFAULT_CONFIG_PATH, DEFAULT_FILE_CONFIG, loadConfig } from './config'
import { ensureHome, resolveHome } from './home'

const repoRoot = process.cwd()

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('resolveHome', () => {
  test('uses TGMCP_HOME when set', () => {
    const dir = tempDir('tgmcp-home-env-')
    expect(resolveHome(repoRoot, { TGMCP_HOME: dir })).toBe(resolve(dir))
    rmSync(dir, { recursive: true, force: true })
  })

  test('uses cwd when tgmcp.config.json is there', () => {
    const dir = tempDir('tgmcp-home-cwd-')
    writeFileSync(join(dir, DEFAULT_CONFIG_PATH), '{}\n')
    expect(resolveHome(dir, {})).toBe(resolve(dir))
    rmSync(dir, { recursive: true, force: true })
  })

  test('falls back to ~/.tgmcp when cwd has no config', () => {
    const dir = tempDir('tgmcp-home-fallback-')
    expect(resolveHome(dir, {})).toBe(resolve(join(process.env.HOME ?? '', '.tgmcp')))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('ensureHome', () => {
  test('writes the default config only when missing', () => {
    const dir = tempDir('tgmcp-ensure-')
    ensureHome(dir)
    const path = join(dir, DEFAULT_CONFIG_PATH)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(DEFAULT_FILE_CONFIG)
    writeFileSync(path, '{"ownerId":"keep"}\n')
    ensureHome(dir)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ownerId: 'keep' })
    rmSync(dir, { recursive: true, force: true })
  })

  test('generated default is loadable', () => {
    const dir = tempDir('tgmcp-load-')
    ensureHome(dir)
    const config = loadConfig(join(dir, DEFAULT_CONFIG_PATH))
    expect(config.telegram.sessionPath).toBe('storage/session')
    expect(config.rateLimits.globalPerHour).toBe(120)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('DEFAULT_FILE_CONFIG', () => {
  test('matches the committed tgmcp.config.json', () => {
    const committed = JSON.parse(readFileSync(join(repoRoot, 'tgmcp.config.json'), 'utf8'))
    expect(committed).toEqual(DEFAULT_FILE_CONFIG)
  })
})
