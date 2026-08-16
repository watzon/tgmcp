import { spawnSync } from 'node:child_process'
import { describe, expect, test } from 'bun:test'

function runCli(...args: string[]) {
  return spawnSync('bun', ['src/cli.ts', ...args], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
}

describe('cli', () => {
  test('help prints usage and does not start the server', () => {
    const result = runCli('help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('tgmcp serve')
    expect(result.stdout).toContain('tgmcp login')
    expect(result.stdout).not.toContain('tgmcp is up')
    expect(result.stdout).not.toContain('waiting for sign-in')
  })

  test('--help is help, not serve', () => {
    const result = runCli('--help')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
  })

  test('unknown command fails', () => {
    const result = runCli('not-a-command')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown command')
  })
})
