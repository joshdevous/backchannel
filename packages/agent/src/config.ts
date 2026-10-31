import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `~/.backchannel/config.json`; see docs/design.md "Config". */
export interface AgentConfig {
  token?: string;
  guildId?: string;
  ownerId?: string;
  agentName?: string;
}

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
  return config;
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
  return config as CompleteConfig;
}
