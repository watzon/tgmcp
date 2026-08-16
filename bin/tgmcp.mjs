#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const cli = join(dirname(fileURLToPath(import.meta.url)), '../src/cli.ts')

if (typeof globalThis.Bun !== 'undefined') {
  await import(cli)
} else {
  const check = spawnSync('bun', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
  if (check.status !== 0) {
    console.error('tgmcp needs Bun. Install it from https://bun.sh, then run: bunx tgmcp')
    process.exit(1)
  }
  const result = spawnSync('bun', [cli, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(result.status ?? 1)
}
