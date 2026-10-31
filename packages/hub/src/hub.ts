import type { Database } from 'bun:sqlite';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import type { HubConfig } from './config.ts';
import { openDb } from './db.ts';
import { registerCommands, startForumCommand } from './forum.ts';
import { log, logError } from './log.ts';
import { startLoopNotice } from './loop.ts';
import { startRoleLabels } from './roles.ts';
import { ensureStructure } from './setup.ts';
import { startStarboard } from './starboard.ts';
import { ensureAllForums, startTagWatchers } from './tags.ts';
import type { Waker } from './waker.ts';
import { startWakeDetection, type WakeDetector } from './wakeups.ts';

export interface HubOptions {
  config: HubConfig;
  /** Receives wake-ups aimed at ATLAS_AGENT_BOT_ID. Detection is off without it. */
  waker?: Waker;
}

export interface Hub {
  client: Client<true>;
  db: Database;
  /** Flushes pending wake-ups, disconnects and closes the database. */
  stop(): Promise<void>;
}

/** Gateway intents: MessageContent and GuildMembers are privileged and must be enabled in the developer portal. */
export const HUB_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
];

export async function startHub({ config, waker }: HubOptions): Promise<Hub> {
  const db = openDb(config.dbPath);
  const client = new Client({
    intents: HUB_INTENTS,
    partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  });
  const { promise: ready, resolve } = Promise.withResolvers<void>();
  client.once('clientReady', () => resolve());
  client.on('error', (err) => logError('client error', err));
  await client.login(config.token);
  await ready;
  const live = client as Client<true>;
  log(`logged in as ${live.user.tag}`);

  const guild = await live.guilds.fetch(config.guildId);
  const { missing } = await ensureStructure(guild, live.user.id, 'check');
  if (missing.length) log(`server is missing: ${missing.join(', ')} (run: bun run setup)`);

  startTagWatchers(live);
  startStarboard(live, db, config.guildId);
  startLoopNotice(live, config.guildId);
  startForumCommand(live, config.guildId);

  let wakes: WakeDetector | undefined;
  if (config.atlasAgentBotId && waker) {
    wakes = startWakeDetection(live, config.atlasAgentBotId, waker);
    log(`wake-up detection on for bot ${config.atlasAgentBotId}`);
  } else {
    log('wake-up detection off');
  }

  await registerCommands(guild);
  await ensureAllForums(guild);
  await startRoleLabels(live, guild);
  log('hub ready');

  return {
    client: live,
    db,
    async stop() {
      await wakes?.flush();
      await live.destroy();
      db.close();
    },
  };
}
