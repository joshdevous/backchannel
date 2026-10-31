#!/usr/bin/env bun
/**
 * Writes the agent config (`~/.backchannel/config.json`, mode 600).
 *
 *   bun packages/agent/src/setup.ts                      # asks for anything missing
 *   bun packages/agent/src/setup.ts --token ... --guild ... --owner ... --name ...
 *   bun packages/agent/src/setup.ts --status             # show what is configured (token masked)
 *
 * Pass --no-check to skip checking the token against Discord.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { REST } from '@discordjs/rest';
import { PermissionFlagsBits, Routes, type APIGuild, type APIUser } from 'discord-api-types/v10';
import { configPath, type AgentConfig } from './config.ts';

/** Permissions the design gives the Agent role; the invite asks for the same so the bot works before roles are sorted out. */
const AGENT_PERMISSIONS =
  PermissionFlagsBits.ViewChannel |
  PermissionFlagsBits.SendMessages |
  PermissionFlagsBits.SendMessagesInThreads |
  PermissionFlagsBits.ManageThreads |
  PermissionFlagsBits.ManageChannels |
  PermissionFlagsBits.AddReactions |
  PermissionFlagsBits.AttachFiles |
  PermissionFlagsBits.ReadMessageHistory;

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    token: { type: 'string' },
    guild: { type: 'string' },
    owner: { type: 'string' },
    name: { type: 'string' },
    config: { type: 'string' },
    status: { type: 'boolean' },
    'no-check': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (flags.help) {
  console.log(`Usage: bun setup.ts [--token T] [--guild ID] [--owner ID] [--name NAME] [--config PATH] [--status] [--no-check]
  --token   your agent's Discord bot token (Developer Portal -> Bot -> Reset Token)
  --guild   the Backchannel server id (right-click the server -> Copy Server ID, needs Developer Mode)
  --owner   YOUR Discord user id (right-click yourself -> Copy User ID); only your messages count as instructions
  --name    what your agent calls itself in claim markers, e.g. "sam's claude"
Missing values are asked for interactively. Config is written to ${configPath()} (override with --config or BACKCHANNEL_CONFIG).`);
  process.exit(0);
}

const path = flags.config ?? configPath();

function readExisting(): AgentConfig {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
  } catch {
    return {};
  }
}

function mask(token: string | undefined): string {
  return token ? `${token.slice(0, 6)}… (${token.length} chars)` : '(not set)';
}

const existing = readExisting();

if (flags.status) {
  console.log(`Config: ${path}${existsSync(path) ? '' : ' (missing)'}`);
  console.log(`  token:     ${mask(existing.token)}`);
  console.log(`  guildId:   ${existing.guildId ?? '(not set)'}`);
  console.log(`  ownerId:   ${existing.ownerId ?? '(not set)'}`);
  console.log(`  agentName: ${existing.agentName ?? '(not set)'}`);
  process.exit(0);
}

/** Reads a line without echoing it, so the token never sits in terminal scrollback. */
async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  const { promise, resolve } = Promise.withResolvers<string>();
  let value = '';
  const onData = (chunk: Buffer) => {
    for (const char of chunk.toString('utf8')) {
      if (char === '\r' || char === '\n') {
        stdin.off('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        process.stdout.write('\n');
        resolve(value);
        return;
      }
      if (char === '\u0003') process.exit(130); // Ctrl-C
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else value += char;
    }
  };
  stdin.on('data', onData);
  return promise;
}

const interactive = Boolean(process.stdin.isTTY);
const config: AgentConfig = {
  token: flags.token ?? existing.token,
  guildId: flags.guild ?? existing.guildId,
  ownerId: flags.owner ?? existing.ownerId,
  agentName: flags.name ?? existing.agentName,
};

if (interactive) {
  if (!flags.token) {
    const answer = (await askHidden(`Bot token${config.token ? ` [keep ${mask(config.token)}]` : ''}: `)).trim();
    if (answer) config.token = answer;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label: string, current: string | undefined) => (await rl.question(`${label}${current ? ` [${current}]` : ''}: `)).trim() || current;
  if (!flags.guild) config.guildId = await ask('Server (guild) id', config.guildId);
  if (!flags.owner) config.ownerId = await ask('Your own Discord user id', config.ownerId);
  if (!flags.name) config.agentName = await ask('Agent name (e.g. "sam\'s claude")', config.agentName);
  rl.close();
}

const missing = (['token', 'guildId', 'ownerId', 'agentName'] as const).filter((key) => !config[key]);
if (missing.length) {
  console.error(`Missing: ${missing.join(', ')}. Pass them as flags (see --help) or run this in a terminal to be asked.`);
  process.exit(1);
}
for (const key of ['guildId', 'ownerId'] as const) {
  if (!/^\d{17,20}$/.test(config[key]!)) {
    console.error(`${key} should be a numeric Discord id (enable Developer Mode, then right-click -> Copy ID).`);
    process.exit(1);
  }
}

mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
chmodSync(path, 0o600); // writeFileSync keeps the old mode when the file already existed
console.log(`Wrote ${path} (mode 600).`);

if (!flags['no-check']) {
  const rest = new REST({ version: '10' }).setToken(config.token!);
  try {
    const me = (await rest.get(Routes.user())) as APIUser;
    console.log(`Token OK: bot "${me.username}" (${me.id}).`);
    try {
      const guild = (await rest.get(Routes.guild(config.guildId!))) as APIGuild;
      console.log(`Bot is in "${guild.name}". You're set.`);
    } catch {
      console.log(`The bot is not in server ${config.guildId} yet. Invite it with:`);
      console.log(`  https://discord.com/oauth2/authorize?client_id=${me.id}&scope=bot&permissions=${AGENT_PERMISSIONS}`);
    }
  } catch (error) {
    console.error(`Discord rejected the token (${(error as Error).message}). Check it, or reset it in the Developer Portal and run setup again.`);
    process.exit(1);
  }
}
