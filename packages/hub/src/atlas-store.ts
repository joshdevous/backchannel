import type { Database } from 'bun:sqlite';

/** The Atlas chat a Discord channel (forum post, thread or channel) is tied to. */
export interface AtlasChat {
  channelId: string;
  acpSessionId: string;
  machineId: string;
  cwd: string;
}

export type WakeKind = 'spawn' | 'deliver';

/**
 * The Atlas waker's state in hub.db: which chat each channel belongs to, every spawn attempt
 * (keyed by our own request id, so one attempt can only ever produce one mapping), and a log
 * of wakes for the hourly limit. Kept in SQLite so a hub restart neither forgets a chat nor
 * resets the limits.
 */
export class AtlasStore {
  constructor(private readonly db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS atlas_chats (
      channel_id TEXT PRIMARY KEY,
      acp_session_id TEXT NOT NULL,
      machine_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS atlas_spawns (
      request_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      acp_session_id TEXT,
      error TEXT
    )`);
    db.run('CREATE INDEX IF NOT EXISTS atlas_spawns_channel ON atlas_spawns (channel_id, started_at)');
    db.run(`CREATE TABLE IF NOT EXISTS atlas_wakes (
      ts INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS atlas_wakes_ts ON atlas_wakes (ts)');
  }

  chat(channelId: string): AtlasChat | undefined {
    const row = this.db
      .query<
        { channel_id: string; acp_session_id: string; machine_id: string; cwd: string },
        [string]
      >('SELECT channel_id, acp_session_id, machine_id, cwd FROM atlas_chats WHERE channel_id = ?')
      .get(channelId);
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      acpSessionId: row.acp_session_id,
      machineId: row.machine_id,
      cwd: row.cwd,
    };
  }

  /** Records a spawn attempt before the request leaves, so it counts even if the hub dies mid-way. */
  beginSpawn(requestId: string, channelId: string, now: number): void {
    this.db.run(
      `INSERT INTO atlas_spawns (request_id, channel_id, started_at, state) VALUES (?, ?, ?, 'pending')`,
      [requestId, channelId, now],
    );
  }

  /**
   * Settles a spawn with the chat it opened and maps the channel to it, in one transaction.
   * Only a still-pending attempt can do this, and an existing mapping is never replaced, so a
   * late answer to an attempt that was already settled cannot tie the channel to a second chat.
   * Returns whether the mapping was written.
   */
  finishSpawn(requestId: string, chat: AtlasChat, now: number): boolean {
    return this.db.transaction(() => {
      const pending = this.db
        .query<{ channel_id: string }, [string]>(
          `SELECT channel_id FROM atlas_spawns WHERE request_id = ? AND state = 'pending'`,
        )
        .get(requestId);
      if (!pending || pending.channel_id !== chat.channelId) return false;
      this.db.run(`UPDATE atlas_spawns SET state = 'done', acp_session_id = ? WHERE request_id = ?`, [
        chat.acpSessionId,
        requestId,
      ]);
      const inserted = this.db.run(
        `INSERT INTO atlas_chats (channel_id, acp_session_id, machine_id, cwd, created_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (channel_id) DO NOTHING`,
        [chat.channelId, chat.acpSessionId, chat.machineId, chat.cwd, now],
      );
      return inserted.changes > 0;
    })();
  }

  failSpawn(requestId: string, error: string): void {
    this.db.run(
      `UPDATE atlas_spawns SET state = 'failed', error = ? WHERE request_id = ? AND state = 'pending'`,
      [error.slice(0, 500), requestId],
    );
  }

  /**
   * Marks attempts a previous hub process left pending as failed. Their socket is gone, so
   * nothing can finish them; a run they opened has no conversation and the machine reaps it.
   */
  abandonPendingSpawns(): number {
    return this.db.run(
      `UPDATE atlas_spawns SET state = 'failed', error = 'hub restarted' WHERE state = 'pending'`,
    ).changes;
  }

  /** Whether the channel has a spawn started after `since` that has not settled yet. */
  hasPendingSpawn(channelId: string, since: number): boolean {
    return (
      this.db
        .query<{ n: number }, [string, number]>(
          `SELECT COUNT(*) AS n FROM atlas_spawns
           WHERE channel_id = ? AND state = 'pending' AND started_at > ?`,
        )
        .get(channelId, since)!.n > 0
    );
  }

  lastSpawnAt(channelId: string): number | undefined {
    const row = this.db
      .query<{ ts: number | null }, [string]>(
        'SELECT MAX(started_at) AS ts FROM atlas_spawns WHERE channel_id = ?',
      )
      .get(channelId);
    return row?.ts ?? undefined;
  }

  recordWake(channelId: string, kind: WakeKind, now: number): void {
    this.db.run('INSERT INTO atlas_wakes (ts, channel_id, kind) VALUES (?, ?, ?)', [now, channelId, kind]);
  }

  wakesSince(since: number): number {
    return this.db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM atlas_wakes WHERE ts > ?').get(since)!
      .n;
  }

  /** Drops wake log rows older than `before`; only the last hour is ever read. */
  pruneWakes(before: number): void {
    this.db.run('DELETE FROM atlas_wakes WHERE ts < ?', [before]);
  }
}
