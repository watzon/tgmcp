import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { LedgerEntry } from './types'

export interface LedgerStore {
  write(entry: LedgerEntry): Promise<void>
  close(): void
}

export function createLedger(path: string): LedgerStore {
  const abs = resolve(process.cwd(), path)
  mkdirSync(dirname(abs), { recursive: true })
  const db = new Database(abs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      action TEXT NOT NULL,
      risk TEXT NOT NULL,
      ok INTEGER NOT NULL,
      detail TEXT
    )
  `)
  const insert = db.prepare(
    'INSERT INTO ledger (ts, chat_id, action, risk, ok, detail) VALUES (?, ?, ?, ?, ?, ?)',
  )
  return {
    async write(entry) {
      insert.run(
        Date.now(),
        entry.chatId,
        entry.action,
        entry.risk,
        entry.ok ? 1 : 0,
        entry.detail ?? null,
      )
    },
    close() {
      db.close()
    },
  }
}
