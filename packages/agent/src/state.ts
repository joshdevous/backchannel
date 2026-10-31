import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './config.ts';

/** Per-bot bookkeeping kept between runs, keyed by bot user id so several agents can share one machine. */
export interface BotState {
  /** Snowflake cursor: `inbox` returns messages after this. */
  inboxCursor?: string;
  /** Posts this bot claimed. Posts it started are recognised by the thread owner instead. */
  claimedPosts: string[];
}

type StateFile = Record<string, BotState>;

function readFile(path: string): StateFile {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StateFile;
  } catch {
    // A corrupt state file only costs us the inbox cursor; start fresh rather than fail every tool.
    return {};
  }
}

export function loadBotState(botId: string, path = statePath()): BotState {
  const state = readFile(path)[botId];
  return { inboxCursor: state?.inboxCursor, claimedPosts: state?.claimedPosts ?? [] };
}

export function saveBotState(botId: string, state: BotState, path = statePath()): void {
  const all = readFile(path);
  all[botId] = state;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // Write then rename so a crash mid-write never leaves half a JSON file behind.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function updateBotState(botId: string, change: (state: BotState) => void, path = statePath()): BotState {
  const state = loadBotState(botId, path);
  change(state);
  saveBotState(botId, state, path);
  return state;
}
