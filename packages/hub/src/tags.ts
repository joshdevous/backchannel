import { FORUM_EMOJI, STATUS_TAGS, baseName, prefixedName } from '@backchannel/core';
import { ChannelType, type Client, type ForumChannel, type Guild, type ThreadChannel } from 'discord.js';
import { log, logError } from './log.ts';

const STATUS_NAMES: readonly string[] = STATUS_TAGS.map((t) => t.name);

/** The status tags a forum is missing. Pure. */
export function missingStatusTags(existingNames: readonly string[]): (typeof STATUS_TAGS)[number][] {
  return STATUS_TAGS.filter((t) => !existingNames.includes(t.name));
}

/** Applied tag ids that are status tags, given the forum's tag list. Pure. */
export function appliedStatusTagIds(
  appliedIds: readonly string[],
  available: readonly { id: string; name: string }[],
): string[] {
  return appliedIds.filter((id) => {
    const tag = available.find((t) => t.id === id);
    return tag !== undefined && STATUS_NAMES.includes(tag.name);
  });
}

// Tag edits replace the whole list, so two concurrent runs on one forum could add duplicates.
const queues = new Map<string, Promise<unknown>>();

function serialised<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job, job);
  queues.set(key, run.catch(() => undefined));
  return run;
}

/** Adds any missing status tag to a forum, keeping every other tag. */
export function ensureStatusTags(forum: ForumChannel): Promise<void> {
  return serialised(forum.id, async () => {
    const missing = missingStatusTags(forum.availableTags.map((t) => t.name));
    if (missing.length === 0) return;
    await forum.setAvailableTags(
      [...forum.availableTags, ...missing.map((t) => ({ name: t.name, emoji: { id: null, name: t.emoji } }))],
      'Backchannel status tags',
    );
    log(`tags added forum=${forum.id} added=${missing.map((t) => t.name).join(',')}`);
  });
}

/** New forums made without the emoji prefix get it. Never touches already-prefixed names. */
export async function ensureForumPrefix(forum: ForumChannel): Promise<void> {
  const wanted = prefixedName(FORUM_EMOJI, forum.name);
  if (wanted === forum.name) return;
  await forum.setName(wanted, 'Backchannel forum naming');
  log(`forum renamed id=${forum.id} name=${baseName(wanted)}`);
}

/** Gives a new post the Open tag when it has no status tag; leaves multi-status posts alone. */
export async function tagNewPost(thread: ThreadChannel): Promise<void> {
  const forum = thread.parent;
  if (forum?.type !== ChannelType.GuildForum) return;
  await ensureStatusTags(forum);
  const statusIds = appliedStatusTagIds(thread.appliedTags, forum.availableTags);
  if (statusIds.length > 1) {
    log(`post has ${statusIds.length} status tags, left alone post=${thread.id}`);
    return;
  }
  if (statusIds.length === 1) return;
  const open = forum.availableTags.find((t) => t.name === 'Open');
  if (!open) return;
  if (thread.appliedTags.length >= 5) {
    log(`post already has 5 tags, cannot add Open post=${thread.id}`);
    return;
  }
  await thread.setAppliedTags([...thread.appliedTags, open.id], 'Backchannel: new post is Open');
  log(`post tagged Open post=${thread.id}`);
}

export async function ensureAllForums(guild: Guild): Promise<void> {
  const channels = await guild.channels.fetch();
  for (const channel of channels.values()) {
    if (channel?.type !== ChannelType.GuildForum) continue;
    await ensureStatusTags(channel).catch((err) => logError(`ensure tags forum=${channel.id}`, err));
  }
}

export function startTagWatchers(client: Client<true>): void {
  client.on('channelCreate', async (channel) => {
    if (channel.type !== ChannelType.GuildForum) return;
    try {
      await ensureForumPrefix(channel);
      await ensureStatusTags(channel);
    } catch (err) {
      logError(`forum setup forum=${channel.id}`, err);
    }
  });
  client.on('channelUpdate', async (_old, channel) => {
    if (channel.type !== ChannelType.GuildForum) return;
    await ensureStatusTags(channel).catch((err) => logError(`ensure tags forum=${channel.id}`, err));
  });
  client.on('threadCreate', async (thread, newlyCreated) => {
    if (!newlyCreated || thread.parent?.type !== ChannelType.GuildForum) return;
    await tagNewPost(thread).catch((err) => logError(`tag new post post=${thread.id}`, err));
  });
}
