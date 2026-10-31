import { FORUM_EMOJI, PROJECTS_CATEGORY, STATUS_TAGS, baseName, prefixedName } from '@backchannel/core';
import {
  ChannelType,
  InteractionContextType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
  type Guild,
} from 'discord.js';
import { log, logError } from './log.ts';

const FORUM_NAME_MAX = 100;
const FORUM_TOPIC_MAX = 1024;

const forumCommand = new SlashCommandBuilder()
  .setName('forum')
  .setDescription('Create a project forum with the Open / Claimed / Blocked / Done status tags')
  .addStringOption((o) =>
    o.setName('name').setDescription('Project name, e.g. atlas').setRequired(true).setMaxLength(80),
  )
  .addStringOption((o) =>
    o.setName('topic').setDescription('What the forum is for').setRequired(false).setMaxLength(FORUM_TOPIC_MAX),
  )
  .setContexts(InteractionContextType.Guild)
  .toJSON();

export async function registerCommands(guild: Guild): Promise<void> {
  await guild.commands.set([forumCommand]);
  log(`commands registered guild=${guild.id}`);
}

async function projectsCategoryId(guild: Guild): Promise<string> {
  await guild.channels.fetch();
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === PROJECTS_CATEGORY.toLowerCase(),
  );
  if (existing) return existing.id;
  const created = await guild.channels.create({ name: PROJECTS_CATEGORY, type: ChannelType.GuildCategory });
  log(`created category ${PROJECTS_CATEGORY}`);
  return created.id;
}

async function handleForum(interaction: ChatInputCommandInteraction<'cached'>): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const guild = interaction.guild;
  const name = interaction.options.getString('name', true).trim();
  const topic = interaction.options.getString('topic')?.trim() || undefined;

  const wanted = prefixedName(FORUM_EMOJI, name).slice(0, FORUM_NAME_MAX);
  await guild.channels.fetch();
  const clash = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildForum && baseName(c.name).toLowerCase() === baseName(wanted).toLowerCase(),
  );
  if (clash) {
    await interaction.editReply(`A forum called **${baseName(wanted)}** already exists: <#${clash.id}>`);
    return;
  }

  const forum = await guild.channels.create({
    name: wanted,
    type: ChannelType.GuildForum,
    parent: await projectsCategoryId(guild),
    topic,
    availableTags: STATUS_TAGS.map((t) => ({ name: t.name, emoji: { id: null, name: t.emoji } })),
    reason: `/forum by ${interaction.user.tag}`,
  });
  log(`forum created id=${forum.id} name=${baseName(wanted)} by=${interaction.user.id}`);
  await interaction.editReply(`Created <#${forum.id}>`);
}

export function startForumCommand(client: Client<true>, guildId: string): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'forum') return;
    if (interaction.guildId !== guildId || !interaction.inCachedGuild()) return;
    try {
      await handleForum(interaction);
    } catch (err) {
      logError('/forum failed', err);
      const reply = 'Could not create the forum. The hub needs Manage Channels.';
      if (interaction.deferred || interaction.replied) await interaction.editReply(reply).catch(() => undefined);
      else await interaction.reply({ content: reply, ephemeral: true }).catch(() => undefined);
    }
  });
}
