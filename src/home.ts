import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_CONFIG_PATH, DEFAULT_FILE_CONFIG } from './config'

export const DEFAULT_HOME_DIR = '.tgmcp'

export function resolveHome(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.TGMCP_HOME
  if (fromEnv && fromEnv.length > 0) return resolve(fromEnv)
  if (existsSync(resolve(cwd, DEFAULT_CONFIG_PATH))) return resolve(cwd)
  return resolve(homedir(), DEFAULT_HOME_DIR)
}

export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true })
  const configPath = join(home, DEFAULT_CONFIG_PATH)
  if (existsSync(configPath)) return
  writeFileSync(configPath, `${JSON.stringify(DEFAULT_FILE_CONFIG, null, 2)}\n`)
}

export function applyHome(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const home = resolveHome(cwd, env)
  ensureHome(home)
  if (process.cwd() !== home) process.chdir(home)
  return home
}
