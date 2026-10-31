import { PROJECTS_CATEGORY } from '@backchannel/core';
import type { ApprovalMode } from '@atlas/shared-types';

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
  /** Working directory of every chat the hub opens. */
  cwd: string;
  /** omp approval mode for those chats; absent means omp's own default. */
  approval?: ApprovalMode;
}

export interface HubConfig {
  token: string;
  guildId: string;
  dbPath: string;
  /** Bot user id of Josh's agent; wake-up detection is off when unset. */
  atlasAgentBotId?: string;
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
    approval: approval === 'default' ? undefined : (approval as ApprovalMode),
  };
}

/**
 * Category new forums go in. `FORUM_CATEGORY` lets a server keep its own layout (Claude Central
 * uses `work`); without it the hub uses `Projects`.
 */
export function forumCategoryName(env: Record<string, string | undefined> = process.env): string {
  return env.FORUM_CATEGORY?.trim() || PROJECTS_CATEGORY;
}
