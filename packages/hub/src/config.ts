import { PROJECTS_CATEGORY, parseListenMode, type ListenMode } from '@backchannel/core';
import type { ApprovalMode } from '@atlas/shared-types';
import { DEFAULT_OMP_BIN } from './project-classifier.ts';

/** Waking Josh's agent as an Atlas chat (`atlas-waker.ts`). */
export interface AtlasWakeConfig {
  /** Josh's own Discord user id; only his messages are instructions to the agent. */
  ownerId: string;
  /** Atlas web origin that mints the relay token. */
  atlasUrl: string;
  /** Atlas's agent Cloudflare Access service token (`/root/.config/atlas-agent-access`). */
  accessClientId: string;
  accessClientSecret: string;
  deviceId: string;
  machineId: string;
  /** Working directory of a chat whose project has no checkout on this machine. */
  cwd: string;
  /** `ATLAS_DEFAULT_PROJECT`: the project for chat that is not about any specific one. */
  defaultProject: string;
  /** `OMP_BIN`: the omp the project classifier runs. */
  ompBin: string;
  /** omp approval mode for those chats; absent means omp's own default. */
  approval?: ApprovalMode;
}

export interface HubConfig {
  token: string;
  guildId: string;
  dbPath: string;
  /** Bot user id of Josh's agent; wake-up detection is off when unset. */
  atlasAgentBotId?: string;
  /** `ATLAS_LISTEN`: `all` (default) also wakes the agent for ordinary human conversation; `mentions` only for direct triggers. */
  atlasListen: ListenMode;
}

const APPROVALS = ['always-ask', 'write', 'yolo'] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): HubConfig {
  const token = env.DISCORD_TOKEN?.trim();
  const guildId = env.GUILD_ID?.trim();
  const missing = [!token && 'DISCORD_TOKEN', !guildId && 'GUILD_ID'].filter(Boolean);
  if (!token || !guildId) throw new Error(`Missing required env: ${missing.join(', ')}`);
  return {
    token,
    guildId,
    dbPath: env.DB_PATH?.trim() || './backchannel.db',
    atlasAgentBotId: env.ATLAS_AGENT_BOT_ID?.trim() || undefined,
    atlasListen: parseListenMode(env.ATLAS_LISTEN, 'ATLAS_LISTEN'),
  };
}

/**
 * Atlas wake settings, read only by the hub's entry point (not `setup`). The Access pair is read
 * from env under the names its file already uses, so the service unit (and `scripts/wake-test.ts`)
 * load that file as an env file instead of copying the secret anywhere.
 */
export function loadAtlasWakeConfig(env: Record<string, string | undefined>): AtlasWakeConfig {
  const ownerId = env.BACKCHANNEL_OWNER_ID?.trim();
  const accessClientId = env.CF_ACCESS_CLIENT_ID?.trim();
  const accessClientSecret = env.CF_ACCESS_CLIENT_SECRET?.trim();
  const atlasUrl = env.ATLAS_URL?.trim();
  const missing = [
    !ownerId && 'BACKCHANNEL_OWNER_ID',
    !accessClientId && 'CF_ACCESS_CLIENT_ID',
    !accessClientSecret && 'CF_ACCESS_CLIENT_SECRET',
    !atlasUrl && 'ATLAS_URL',
  ].filter(Boolean);
  if (!ownerId || !accessClientId || !accessClientSecret || !atlasUrl) {
    throw new Error(`Atlas wake-ups need env: ${missing.join(', ')}`);
  }
  // Chats opened for peers default to `write`: reads and edits run unattended, a shell command
  // waits for Josh. `default` passes no flag (omp's own default).
  const approval = env.ATLAS_WAKE_APPROVAL?.trim() || 'write';
  if (approval !== 'default' && !(APPROVALS as readonly string[]).includes(approval)) {
    throw new Error(`ATLAS_WAKE_APPROVAL must be one of ${[...APPROVALS, 'default'].join(', ')}`);
  }
  return {
    ownerId,
    accessClientId,
    accessClientSecret,
    atlasUrl,
    deviceId: env.ATLAS_WAKE_DEVICE_ID?.trim() || 'backchannel-hub',
    machineId: env.ATLAS_WAKE_MACHINE?.trim() || 'atlas-vps',
    cwd: env.ATLAS_WAKE_CWD?.trim() || '/root/chats',
    defaultProject: env.ATLAS_DEFAULT_PROJECT?.trim() || 'Backchannel',
    ompBin: env.OMP_BIN?.trim() || DEFAULT_OMP_BIN,
    approval: approval === 'default' ? undefined : (approval as ApprovalMode),
  };
}

/** The bot user id a Discord bot token belongs to: its first dot-separated part, base64. */
export function botIdFromToken(token: string): string | undefined {
  const first = token.split('.')[0];
  if (!first) return undefined;
  const id = Buffer.from(first, 'base64').toString('utf8');
  return /^\d{17,20}$/.test(id) ? id : undefined;
}

export type AgentTokenResult = { token: string; source: string } | { token?: undefined; why: string };

/**
 * The agent bot's token, used to react and type as that bot. `ATLAS_AGENT_TOKEN` wins; else the
 * `token` in the agent config file (`BACKCHANNEL_CONFIG`, default `~/.backchannel/config.json`),
 * but only when that file is for this guild. Either way the token must belong to `botId`, so a
 * wrong file can never make the hub act as some other bot. Never returns a reason that holds
 * the token.
 */
export function loadAgentToken(
  env: Record<string, string | undefined>,
  guildId: string,
  botId: string,
  readConfigFile: (path: string) => string | undefined,
  home: string,
): AgentTokenResult {
  const check = (token: string, source: string): AgentTokenResult =>
    botIdFromToken(token) === botId ? { token, source } : { why: `${source} is not the token of bot ${botId}` };

  const fromEnv = env.ATLAS_AGENT_TOKEN?.trim();
  if (fromEnv) return check(fromEnv, 'ATLAS_AGENT_TOKEN');

  const path = env.BACKCHANNEL_CONFIG?.trim() || `${home}/.backchannel/config.json`;
  const raw = readConfigFile(path);
  if (raw === undefined) return { why: `ATLAS_AGENT_TOKEN unset and ${path} not readable` };
  let parsed: { token?: unknown; guildId?: unknown };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { why: `${path} is not valid JSON` };
  }
  if (typeof parsed.token !== 'string' || !parsed.token.trim()) return { why: `${path} has no token` };
  if (parsed.guildId !== guildId) return { why: `${path} is for a different guild` };
  return check(parsed.token.trim(), path);
}

/**
 * Category new forums go in. `FORUM_CATEGORY` lets a server keep its own layout (Claude Central
 * uses `work`); without it the hub uses `Projects`.
 */
export function forumCategoryName(env: Record<string, string | undefined> = process.env): string {
  return env.FORUM_CATEGORY?.trim() || PROJECTS_CATEGORY;
}
