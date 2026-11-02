import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LISTEN, parseListenMode, type ListenMode } from '@backchannel/core';

/** `~/.backchannel/config.json`; see docs/design.md "Config". */
export interface AgentConfig {
  token?: string;
  guildId?: string;
  ownerId?: string;
  agentName?: string;
  /** Push mode: `all` (default) also hears ordinary human conversation, `mentions` only direct triggers. */
  listen?: ListenMode;
  /**
   * Discord user ids of people the owner gave their own authority (`from_kind` "trusted").
   * People only: a bot's id here is ignored. Josh's agent lists Stephen.
   */
  trustedIds?: string[];
}

/** Required fields. `listen` is optional and defaults to `all`. */
export const CONFIG_FIELDS = ['token', 'guildId', 'ownerId', 'agentName'] as const;

const ENV_FOR_FIELD: Record<(typeof CONFIG_FIELDS)[number], string> = {
  token: 'BACKCHANNEL_TOKEN',
  guildId: 'BACKCHANNEL_GUILD_ID',
  ownerId: 'BACKCHANNEL_OWNER_ID',
  agentName: 'BACKCHANNEL_AGENT_NAME',
};

export function backchannelDir(): string {
  return join(homedir(), '.backchannel');
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.BACKCHANNEL_CONFIG || join(backchannelDir(), 'config.json');
}

export function statePath(): string {
  return join(backchannelDir(), 'state.json');
}

/** Reads the config file, then lets non-empty env vars override each field. Never throws on a missing file. */
export function loadConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const path = configPath(env);
  let fromFile: AgentConfig = {};
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
    } catch (error) {
      throw new Error(`Could not parse ${path}: ${(error as Error).message}`);
    }
  }
  const config: AgentConfig = {};
  for (const field of CONFIG_FIELDS) {
    const value = env[ENV_FOR_FIELD[field]] || fromFile[field];
    if (typeof value === 'string' && value.trim()) config[field] = value.trim();
  }
  const listen = env.BACKCHANNEL_LISTEN || fromFile.listen;
  if (typeof listen === 'string' && listen.trim()) {
    config.listen = parseListenMode(listen, env.BACKCHANNEL_LISTEN ? 'BACKCHANNEL_LISTEN' : `"listen" in ${path}`);
  }
  const trusted = env.BACKCHANNEL_TRUSTED_IDS ?? fromFile.trustedIds;
  const trustedIds = parseTrustedIds(trusted, env.BACKCHANNEL_TRUSTED_IDS ? 'BACKCHANNEL_TRUSTED_IDS' : `"trustedIds" in ${path}`);
  if (trustedIds.length) config.trustedIds = trustedIds;
  return config;
}

/** A comma separated string or an array of Discord user ids. Anything that is not an id is an error, never skipped. */
export function parseTrustedIds(raw: unknown, source: string): string[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const items = typeof raw === 'string' ? raw.split(',') : Array.isArray(raw) ? raw : null;
  if (!items) throw new Error(`${source} must be a list of Discord user ids`);
  const ids = items.map((item) => (typeof item === 'string' ? item.trim() : '')).filter((item) => item !== '');
  for (const id of ids) if (!/^\d{17,20}$/.test(id)) throw new Error(`${source} has "${id}", which is not a Discord user id`);
  return [...new Set(ids)];
}

export function missingFields(config: AgentConfig): string[] {
  return CONFIG_FIELDS.filter((field) => !config[field]);
}

/** A config with every field present. Tools that talk to Discord need this. */
export type CompleteConfig = Required<AgentConfig>;

export function requireConfig(config: AgentConfig, env: Record<string, string | undefined> = process.env): CompleteConfig {
  const missing = missingFields(config);
  if (missing.length) {
    throw new Error(
      `Backchannel is not configured: missing ${missing.join(', ')} in ${configPath(env)}. ` +
        'Run the Backchannel setup (`bun packages/agent/src/setup.ts`, or `/backchannel:configure` in Claude Code).',
    );
  }
  return { ...config, listen: config.listen ?? DEFAULT_LISTEN, trustedIds: config.trustedIds ?? [] } as CompleteConfig;
}
