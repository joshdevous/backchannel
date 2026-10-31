import {
  AGENT_ROLE,
  GENERAL_CHANNEL,
  GENERAL_EMOJI,
  HUMAN_ROLE,
  STARBOARD_CHANNEL,
  STARBOARD_EMOJI,
  baseName,
  prefixedName,
} from '@backchannel/core';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  PermissionFlagsBits as P,
  PermissionsBitField,
  type Guild,
  type GuildBasedChannel,
  type OverwriteResolvable,
} from 'discord.js';
import { forumCategoryName, loadConfig } from './config.ts';
import { log, logError } from './log.ts';

/**
 * Permissions the hub itself needs. Discord only lets a bot grant permissions it holds, so this
 * includes everything the Agent role gets, plus what the hub does on its own (embeds, roles).
 */
export const HUB_PERMISSIONS = new PermissionsBitField([
  P.ViewChannel,
  P.SendMessages,
  P.SendMessagesInThreads,
  P.CreatePublicThreads,
  P.EmbedLinks,
  P.AttachFiles,
  P.AddReactions,
  P.ReadMessageHistory,
  P.ManageThreads,
  P.ManageChannels,
  P.ManageRoles,
]).bitfield;

export function inviteUrl(clientId: string): string {
  const scopes = encodeURIComponent('bot applications.commands');
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=${scopes}&permissions=${HUB_PERMISSIONS}`;
}

const AGENT_PERMISSIONS = [
  P.ViewChannel,
  P.SendMessages,
  P.CreatePublicThreads,
  P.SendMessagesInThreads,
  P.ManageThreads,
  P.ManageChannels,
  P.AddReactions,
  P.AttachFiles,
  P.ReadMessageHistory,
];

const HUMAN_PERMISSIONS = [
  P.ViewChannel,
  P.SendMessages,
  P.CreatePublicThreads,
  P.SendMessagesInThreads,
  P.AddReactions,
  P.AttachFiles,
  P.EmbedLinks,
  P.ReadMessageHistory,
];

/** Everyone reads and reacts in #starboard; only the hub writes. */
function starboardOverwrites(everyoneId: string, hubId: string): OverwriteResolvable[] {
  return [
    {
      id: everyoneId,
      allow: [P.ViewChannel, P.ReadMessageHistory, P.AddReactions],
      deny: [P.SendMessages, P.SendMessagesInThreads, P.CreatePublicThreads, P.CreatePrivateThreads],
    },
    { id: hubId, allow: [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory] },
  ];
}

export interface SetupReport {
  /** Things that did not exist (check mode) or that were just created (apply mode). */
  missing: string[];
}

function findChannel(guild: Guild, type: ChannelType, base: string): GuildBasedChannel | undefined {
  return guild.channels.cache.find((c) => c.type === type && baseName(c.name).toLowerCase() === base.toLowerCase());
}

/**
 * Makes the server match the design. `apply` creates what is missing; `check` only reports it.
 * Idempotent, and never deletes or renames anything that exists.
 */
export async function ensureStructure(guild: Guild, hubId: string, mode: 'apply' | 'check'): Promise<SetupReport> {
  const apply = mode === 'apply';
  const missing: string[] = [];
  await Promise.all([guild.channels.fetch(), guild.roles.fetch()]);

  for (const [name, permissions] of [
    [AGENT_ROLE, AGENT_PERMISSIONS],
    [HUMAN_ROLE, HUMAN_PERMISSIONS],
  ] as const) {
    if (guild.roles.cache.some((r) => r.name === name)) continue;
    missing.push(`role ${name}`);
    if (apply) {
      await guild.roles.create({ name, permissions, reason: 'Backchannel setup' });
      log(`setup created role ${name}`);
    }
  }

  const category = forumCategoryName();
  if (!findChannel(guild, ChannelType.GuildCategory, category)) {
    missing.push(`category ${category}`);
    if (apply) {
      await guild.channels.create({ name: category, type: ChannelType.GuildCategory });
      log(`setup created category ${category}`);
    }
  }

  if (!findChannel(guild, ChannelType.GuildText, GENERAL_CHANNEL)) {
    missing.push(`channel ${GENERAL_CHANNEL}`);
    if (apply) {
      await guild.channels.create({
        name: prefixedName(GENERAL_EMOJI, GENERAL_CHANNEL),
        type: ChannelType.GuildText,
        reason: 'Backchannel setup',
      });
      log(`setup created channel ${GENERAL_CHANNEL}`);
    }
  }

  const starboard = findChannel(guild, ChannelType.GuildText, STARBOARD_CHANNEL);
  if (!starboard) {
    missing.push(`channel ${STARBOARD_CHANNEL}`);
    if (apply) {
      await guild.channels.create({
        name: prefixedName(STARBOARD_EMOJI, STARBOARD_CHANNEL),
        type: ChannelType.GuildText,
        permissionOverwrites: starboardOverwrites(guild.roles.everyone.id, hubId),
        reason: 'Backchannel setup',
      });
      log(`setup created channel ${STARBOARD_CHANNEL}`);
    }
  } else if (starboard.type === ChannelType.GuildText) {
    const everyone = starboard.permissionOverwrites.cache.get(guild.roles.everyone.id);
    const hub = starboard.permissionOverwrites.cache.get(hubId);
    const locked = everyone?.deny.has(P.SendMessages) === true && hub?.allow.has(P.SendMessages) === true;
    if (!locked) {
      missing.push(`write lock on ${STARBOARD_CHANNEL}`);
      if (apply) {
        // Overwrites are edited one id at a time, so other overwrites on the channel survive.
        await starboard.permissionOverwrites.edit(guild.roles.everyone, {
          ViewChannel: true,
          ReadMessageHistory: true,
          AddReactions: true,
          SendMessages: false,
          SendMessagesInThreads: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
        });
        await starboard.permissionOverwrites.edit(hubId, {
          ViewChannel: true,
          SendMessages: true,
          EmbedLinks: true,
          ReadMessageHistory: true,
        });
        log(`setup locked channel ${STARBOARD_CHANNEL}`);
      }
    }
  }

  return { missing };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const { promise: ready$, resolve } = Promise.withResolvers<void>();
    client.once('clientReady', () => resolve());
    await client.login(config.token);
    await ready$;
    const ready = client as Client<true>;
    const guild = await ready.guilds.fetch(config.guildId);
    const { missing } = await ensureStructure(guild, ready.user.id, 'apply');
    log(missing.length ? `setup done, created: ${missing.join(', ')}` : 'setup done, nothing to change');
    log(`invite URL: ${inviteUrl(ready.user.id)}`);
  } catch (err) {
    logError('setup failed', err);
    process.exitCode = 1;
  } finally {
    await client.destroy();
  }
}

if (import.meta.main) await main();
