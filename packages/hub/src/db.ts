import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Opens the hub database. Other hub parts (e.g. the Atlas waker's post -> chat mapping)
 * create their own tables on this same handle.
 */
export function openDb(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.run('PRAGMA journal_mode = WAL');
  db.run(`CREATE TABLE IF NOT EXISTS starboard (
    source_message_id TEXT PRIMARY KEY,
    source_channel_id TEXT NOT NULL,
    starboard_message_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  return db;
}
