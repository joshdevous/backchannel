import type { Database } from 'bun:sqlite';

/** Where an Atlas chat runs: what the device needs to reach it. */
export interface ChatTarget {
  acpSessionId: string;
  machineId: string;
  cwd: string;
}

/**
 * The Atlas chat a Discord channel (forum post, thread or channel) is tied to, for one Atlas
 * project. A forum post has one chat; a plain channel has one per project it talks about.
 */
export interface AtlasChat extends ChatTarget {
  channelId: string;
  /** Atlas project id; `UNFILED` when the project list was unavailable. */
  projectId: string;
  projectName: string;
}

/** Project key of a chat opened while the project list was unavailable; it is never filed. */
export const UNFILED = '';

export type WakeKind = 'spawn' | 'deliver';

/**
 * The Atlas waker's state in hub.db: which chat each (channel, project) belongs to, every spawn
 * attempt (keyed by our own request id, so one attempt can only ever produce one mapping), the
 * project each channel last talked about, and a log of wakes for the hourly limit. Kept in
 * SQLite so a hub restart neither forgets a chat nor resets the limits.
 */
export class AtlasStore {
  constructor(private readonly db: Database) {
    db.transaction(() => {
      // `atlas_chats` was keyed by channel alone. Its rows move to the (channel, project) key
      // under `UNFILED`: a forum post keeps its chat (a post's chat is found by channel alone),
      // a plain channel's next batch opens a chat in its classified project.
      const columns = db.query<{ name: string }, []>('PRAGMA table_info(atlas_chats)').all();
      const legacy = columns.length > 0 && !columns.some((c) => c.name === 'project_id');
      if (legacy) db.run('ALTER TABLE atlas_chats RENAME TO atlas_chats_by_channel');
      db.run(`CREATE TABLE IF NOT EXISTS atlas_chats (
        channel_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        acp_session_id TEXT NOT NULL,
        machine_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel_id, project_id)
      )`);
      if (!legacy) return;
      db.run(
        `INSERT INTO atlas_chats (channel_id, project_id, project_name, acp_session_id, machine_id, cwd, created_at)
         SELECT channel_id, '', '', acp_session_id, machine_id, cwd, created_at FROM atlas_chats_by_channel`,
      );
      db.run('DROP TABLE atlas_chats_by_channel');
    })();
    db.run(`CREATE TABLE IF NOT EXISTS atlas_spawns (
      request_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL,
      state TEXT NOT NULL,
      acp_session_id TEXT,
      error TEXT
    )`);
    if (!hasColumn(db, 'atlas_spawns', 'project_id')) {
      db.run(`ALTER TABLE atlas_spawns ADD COLUMN project_id TEXT NOT NULL DEFAULT ''`);
    }
    db.run('CREATE INDEX IF NOT EXISTS atlas_spawns_channel ON atlas_spawns (channel_id, started_at)');
    db.run(`CREATE TABLE IF NOT EXISTS atlas_wakes (
      ts INTEGER NOT NULL,
      channel_id TEXT NOT NULL,
      kind TEXT NOT NULL
    )`);
    db.run('CREATE INDEX IF NOT EXISTS atlas_wakes_ts ON atlas_wakes (ts)');
    db.run(`CREATE TABLE IF NOT EXISTS atlas_channel_projects (
      channel_id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  /**
   * The chat tied to this channel for `projectId`; with no project, the channel's first chat
   * (a forum post has only one).
   */
  chat(channelId: string, projectId?: string): AtlasChat | undefined {
    const row =
      projectId === undefined
        ? this.db
            .query<ChatRow, [string]>(`SELECT ${CHAT_COLUMNS} FROM atlas_chats WHERE channel_id = ? ORDER BY created_at LIMIT 1`)
            .get(channelId)
        : this.db
            .query<ChatRow, [string, string]>(`SELECT ${CHAT_COLUMNS} FROM atlas_chats WHERE channel_id = ? AND project_id = ?`)
            .get(channelId, projectId);
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      projectId: row.project_id,
      projectName: row.project_name,
      acpSessionId: row.acp_session_id,
      machineId: row.machine_id,
      cwd: row.cwd,
    };
  }

  /** Records a spawn attempt before the request leaves, so it counts even if the hub dies mid-way. */
  beginSpawn(requestId: string, channelId: string, projectId: string, now: number): void {
    this.db.run(
      `INSERT INTO atlas_spawns (request_id, channel_id, project_id, started_at, state) VALUES (?, ?, ?, ?, 'pending')`,
      [requestId, channelId, projectId, now],
    );
  }

  /**
   * Settles a spawn with the chat it opened and maps the (channel, project) to it, in one
   * transaction. Only a still-pending attempt for that same key can do this, and an existing
   * mapping is never replaced, so a late answer to an attempt that was already settled cannot
   * tie the key to a second chat. Returns whether the mapping was written.
   */
  finishSpawn(requestId: string, chat: AtlasChat, now: number): boolean {
    return this.db.transaction(() => {
      const pending = this.db
        .query<{ channel_id: string; project_id: string }, [string]>(
          `SELECT channel_id, project_id FROM atlas_spawns WHERE request_id = ? AND state = 'pending'`,
        )
        .get(requestId);
      if (!pending || pending.channel_id !== chat.channelId || pending.project_id !== chat.projectId) return false;
      this.db.run(`UPDATE atlas_spawns SET state = 'done', acp_session_id = ? WHERE request_id = ?`, [
        chat.acpSessionId,
        requestId,
      ]);
      const inserted = this.db.run(
        `INSERT INTO atlas_chats (channel_id, project_id, project_name, acp_session_id, machine_id, cwd, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (channel_id, project_id) DO NOTHING`,
        [chat.channelId, chat.projectId, chat.projectName, chat.acpSessionId, chat.machineId, chat.cwd, now],
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

  /** Whether (channel, project) – or the channel for any project – has a spawn started after `since` still pending. */
  hasPendingSpawn(channelId: string, projectId: string | undefined, since: number): boolean {
    return (
      this.db
        .query<{ n: number }, [string, string | null, string | null, number]>(
          `SELECT COUNT(*) AS n FROM atlas_spawns
           WHERE channel_id = ? AND (? IS NULL OR project_id = ?) AND state = 'pending' AND started_at > ?`,
        )
        .get(channelId, projectId ?? null, projectId ?? null, since)!.n > 0
    );
  }

  /** The latest spawn for (channel, project), or for the channel and any project. */
  lastSpawnAt(channelId: string, projectId: string | undefined): number | undefined {
    const row = this.db
      .query<{ ts: number | null }, [string, string | null, string | null]>(
        'SELECT MAX(started_at) AS ts FROM atlas_spawns WHERE channel_id = ? AND (? IS NULL OR project_id = ?)',
      )
      .get(channelId, projectId ?? null, projectId ?? null);
    return row?.ts ?? undefined;
  }

  /** The project name the channel's previous batch went to: the classifier's hint. */
  lastProject(channelId: string): string | undefined {
    return (
      this.db
        .query<{ project_name: string }, [string]>('SELECT project_name FROM atlas_channel_projects WHERE channel_id = ?')
        .get(channelId)?.project_name ?? undefined
    );
  }

  setLastProject(channelId: string, projectName: string, now: number): void {
    this.db.run(
      `INSERT INTO atlas_channel_projects (channel_id, project_name, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET project_name = excluded.project_name, updated_at = excluded.updated_at`,
      [channelId, projectName, now],
    );
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

interface ChatRow {
  channel_id: string;
  project_id: string;
  project_name: string;
  acp_session_id: string;
  machine_id: string;
  cwd: string;
}

const CHAT_COLUMNS = 'channel_id, project_id, project_name, acp_session_id, machine_id, cwd';

function hasColumn(db: Database, table: string, column: string): boolean {
  return db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

