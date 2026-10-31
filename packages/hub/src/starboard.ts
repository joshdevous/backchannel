import {
  STARBOARD_CHANNEL,
  STARBOARD_COLOUR,
  STAR_EMOJI,
  STAR_THRESHOLD,
  baseName,
} from '@backchannel/core';
import type { Database } from 'bun:sqlite';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  type Client,
  type Message,
  type MessageReaction,
  type PartialMessageReaction,
  type PartialUser,
  type User,
} from 'discord.js';
import { log, logError } from './log.ts';

/** Distinct reactors. The author's own star counts too. */
export function countStars(reactorIds: Iterable<string>): number {
  return new Set(reactorIds).size;
}

export type StarAction = 'post' | 'update' | 'none';

/** What to do given the current count and whether the message is already on the starboard. */
export function starAction(count: number, alreadyOnBoard: boolean, threshold = STAR_THRESHOLD): StarAction {
  if (alreadyOnBoard) return 'update';
  return count >= threshold ? 'post' : 'none';
}

const EMBED_TEXT_MAX = 1500;

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** The message line carrying the editable count and the source channel. */
export function starLine(count: number, sourceChannelId: string): string {
  return `${STAR_EMOJI} ${count} in <#${sourceChannelId}>`;
}

function firstImageUrl(message: Message): string | null {
  for (const a of message.attachments.values()) {
    if (a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name)) return a.url;
  }
  return null;
}

function starboardMessage(message: Message<true>, count: number) {
  const author = message.member?.displayName ?? message.author.displayName;
  const embed = new EmbedBuilder()
    .setColor(STARBOARD_COLOUR)
    .setAuthor({ name: author, iconURL: (message.member ?? message.author).displayAvatarURL() })
    .setTimestamp(message.createdAt);
  if (message.content) embed.setDescription(truncate(message.content, EMBED_TEXT_MAX));
  const image = firstImageUrl(message);
  if (image) embed.setImage(image);
  const link = new ButtonBuilder().setLabel('Jump to message').setStyle(ButtonStyle.Link).setURL(message.url);
  return {
    content: starLine(count, message.channelId),
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(link)],
    allowedMentions: { parse: [] as never[] },
  };
}

async function fetchReactorIds(reaction: MessageReaction): Promise<string[]> {
  const ids: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await reaction.users.fetch({ limit: 100, after });
    ids.push(...page.keys());
    if (page.size < 100) return ids;
    after = page.lastKey();
  }
}

// Two reactions on one message can arrive together; handle each message one at a time so it
// is never posted to the starboard twice.
const inFlight = new Map<string, Promise<void>>();

export function startStarboard(client: Client<true>, db: Database, guildId: string): void {
  const find = db.query<{ starboard_message_id: string }, [string]>(
    'SELECT starboard_message_id FROM starboard WHERE source_message_id = ?',
  );
  const insert = db.query(
    'INSERT INTO starboard (source_message_id, source_channel_id, starboard_message_id, created_at) VALUES (?, ?, ?, ?)',
  );

  async function process(reaction: MessageReaction | PartialMessageReaction): Promise<void> {
    const full = reaction.partial ? await reaction.fetch() : reaction;
    const message = full.message.partial ? await full.message.fetch() : full.message;
    if (!message.inGuild() || message.guildId !== guildId) return;
    if (message.author.id === client.user.id) return;

    const starboard = message.guild.channels.cache.find(
      (c) => c.type === ChannelType.GuildText && baseName(c.name) === STARBOARD_CHANNEL,
    );
    if (!starboard?.isTextBased()) return;
    if (message.channelId === starboard.id) return;

    const count = countStars(await fetchReactorIds(full));
    const existing = find.get(message.id);
    const action = starAction(count, existing !== null);
    if (action === 'none') return;

    const payload = starboardMessage(message, count);
    if (action === 'post') {
      const sent = await starboard.send(payload);
      insert.run(message.id, message.channelId, sent.id, Date.now());
      log(`posted to starboard message=${message.id} stars=${count}`);
      return;
    }
    if (!existing) return;
    const current = await starboard.messages.fetch(existing.starboard_message_id).catch(() => null);
    if (!current) {
      log(`starboard post missing, count not updated message=${message.id}`);
      return;
    }
    if (current.content === payload.content) return;
    await current.edit({ content: payload.content });
    log(`starboard count updated message=${message.id} stars=${count}`);
  }

  function handler(reaction: MessageReaction | PartialMessageReaction, _user: User | PartialUser): void {
    if (reaction.emoji.name !== STAR_EMOJI) return;
    const key = reaction.message.id;
    const run = (inFlight.get(key) ?? Promise.resolve())
      .then(() => process(reaction))
      .catch((err) => logError(`starboard message=${key}`, err));
    inFlight.set(key, run);
    void run.then(() => {
      if (inFlight.get(key) === run) inFlight.delete(key);
    });
  }

  client.on('messageReactionAdd', handler);
  client.on('messageReactionRemove', handler);
}
