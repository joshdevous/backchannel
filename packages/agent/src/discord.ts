import { REST, type RawFile } from '@discordjs/rest';
import { ChannelType, Routes, type APIGuild, type APIGuildMember, type APIMessage, type APIUser } from 'discord-api-types/v10';
import {
  GENERAL_CHANNEL,
  PROJECTS_CATEGORY,
  STATUS_TAGS,
  baseName,
  type StatusName,
} from '@backchannel/core';
import type { CompleteConfig } from './config.ts';

/**
 * Thin wrapper over Discord's REST API with this agent's own bot token. Nothing here connects
 * until a tool actually needs Discord, so the MCP server starts (and lists tools) without a token.
 */

/** The channel fields we use. Discord returns more; the union types in discord-api-types are awkward here. */
export interface Channel {
  id: string;
  type: ChannelType;
  name?: string;
  guild_id?: string;
  parent_id?: string | null;
  topic?: string | null;
  last_message_id?: string | null;
  owner_id?: string;
  applied_tags?: string[];
  available_tags?: { id: string; name: string; emoji_name?: string | null }[];
  thread_metadata?: { archived: boolean; archive_timestamp: string; locked?: boolean };
  message_count?: number;
}

export interface ThreadList {
  threads: Channel[];
  has_more?: boolean;
}

export const THREAD_TYPES = new Set([ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread]);
const TEXT_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement]);

export function isThread(channel: Channel): boolean {
  return THREAD_TYPES.has(channel.type);
}

export function displayName(user: { username: string; global_name?: string | null }): string {
  return user.global_name || user.username;
}

/** Status tag on a post, read from its parent forum's tag list. */
export function statusOf(thread: Channel, forum: Channel | undefined): StatusName | null {
  if (!forum?.available_tags || !thread.applied_tags) return null;
  const names = new Set(STATUS_TAGS.map((tag) => tag.name as string));
  for (const tagId of thread.applied_tags) {
    const tag = forum.available_tags.find((t) => t.id === tagId);
    if (tag && names.has(tag.name)) return tag.name as StatusName;
  }
  return null;
}

/** Applied tags with every status tag replaced by `status`. Non-status tags survive. */
export function withStatus(thread: Channel, forum: Channel, status: StatusName): string[] {
  const statusIds = new Set(
    (forum.available_tags ?? []).filter((t) => STATUS_TAGS.some((s) => s.name === t.name)).map((t) => t.id),
  );
  const target = forum.available_tags?.find((t) => t.name === status);
  if (!target) throw new Error(`Forum ${baseName(forum.name ?? forum.id)} has no "${status}" tag yet. The hub adds missing status tags; try again shortly.`);
  return [...(thread.applied_tags ?? []).filter((id) => !statusIds.has(id)), target.id];
}

const SNOWFLAKE = /^\d{17,20}$/;
const CACHE_MS = 30_000;

export interface ResolvedChannel {
  channel: Channel;
  /** The forum a post belongs to, when the channel is a forum post. */
  forum?: Channel;
}

export class Discord {
  private restClient?: REST;
  private meCache?: APIUser;
  private channelsCache?: { at: number; channels: Channel[] };

  constructor(readonly config: CompleteConfig) {}

  get rest(): REST {
    // Created on first use: listing tools must never need a token.
    this.restClient ??= new REST({ version: '10' }).setToken(this.config.token);
    return this.restClient;
  }

  async me(): Promise<APIUser> {
    this.meCache ??= (await this.rest.get(Routes.user())) as APIUser;
    return this.meCache;
  }

  guild(): Promise<APIGuild> {
    return this.rest.get(Routes.guild(this.config.guildId)) as Promise<APIGuild>;
  }

  async channels(fresh = false): Promise<Channel[]> {
    if (!fresh && this.channelsCache && Date.now() - this.channelsCache.at < CACHE_MS) {
      return this.channelsCache.channels;
    }
    const channels = (await this.rest.get(Routes.guildChannels(this.config.guildId))) as Channel[];
    this.channelsCache = { at: Date.now(), channels };
    return channels;
  }

  async forums(fresh = false): Promise<Channel[]> {
    return (await this.channels(fresh)).filter((c) => c.type === ChannelType.GuildForum);
  }

  async textChannels(): Promise<Channel[]> {
    return (await this.channels()).filter((c) => TEXT_TYPES.has(c.type));
  }

  async projectsCategory(): Promise<Channel | undefined> {
    return (await this.channels()).find(
      (c) => c.type === ChannelType.GuildCategory && baseName(c.name ?? '').toLowerCase() === PROJECTS_CATEGORY.toLowerCase(),
    );
  }

  /** Finds a forum by base name (`atlas` matches `📁・atlas`) or id. */
  async findForum(ref: string): Promise<Channel> {
    const forums = await this.forums();
    const wanted = baseName(ref.trim()).toLowerCase();
    const forum = forums.find((f) => f.id === ref.trim() || baseName(f.name ?? '').toLowerCase() === wanted);
    if (!forum) {
      const names = forums.map((f) => baseName(f.name ?? '')).join(', ') || 'none';
      throw new Error(`No forum called "${ref}". Forums: ${names}.`);
    }
    return forum;
  }

  async activeThreads(): Promise<Channel[]> {
    const result = (await this.rest.get(Routes.guildActiveThreads(this.config.guildId))) as ThreadList;
    return result.threads;
  }

  async archivedThreads(forumId: string, limit = 50): Promise<Channel[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    const result = (await this.rest.get(Routes.channelThreads(forumId, 'public'), { query })) as ThreadList;
    return result.threads;
  }

  async channel(id: string): Promise<Channel> {
    return (await this.rest.get(Routes.channel(id))) as Channel;
  }

  /**
   * Resolves what tools call a "channel": `general` (or any text channel's base name), a post id,
   * a channel id, or a forum post title. Anything outside the configured server is refused.
   */
  async resolveChannel(ref: string): Promise<ResolvedChannel> {
    const trimmed = ref.trim().replace(/^<#(\d+)>$/, '$1').replace(/^#/, '');
    if (!trimmed) throw new Error('Channel is empty. Use "general", a post title, or an id.');

    if (SNOWFLAKE.test(trimmed)) {
      const channel = await this.channel(trimmed);
      if (channel.guild_id !== this.config.guildId) throw new Error(`Channel ${trimmed} is not in the Backchannel server.`);
      return this.withForum(channel);
    }

    const wanted = baseName(trimmed).toLowerCase();
    const text = (await this.textChannels()).find((c) => baseName(c.name ?? '').toLowerCase() === wanted);
    if (text) return { channel: text };

    return this.findPostByTitle(trimmed);
  }

  private async withForum(channel: Channel): Promise<ResolvedChannel> {
    if (!isThread(channel) || !channel.parent_id) return { channel };
    const forum = (await this.forums()).find((f) => f.id === channel.parent_id);
    return { channel, forum };
  }

  async findPostByTitle(title: string): Promise<ResolvedChannel> {
    const wanted = title.trim().toLowerCase();
    const forums = await this.forums();
    const forumIds = new Set(forums.map((f) => f.id));
    const matches = (await this.activeThreads()).filter(
      (t) => t.parent_id && forumIds.has(t.parent_id) && t.name?.toLowerCase() === wanted,
    );
    if (matches.length === 0) {
      // Fall back to recently archived posts; bounded to one page per forum.
      for (const forum of forums) {
        for (const thread of await this.archivedThreads(forum.id)) {
          if (thread.name?.toLowerCase() === wanted) matches.push(thread);
        }
      }
    }
    if (matches.length === 0) {
      throw new Error(`No channel or forum post called "${title}". Use list_forums / list_posts to find it, or pass an id.`);
    }
    if (matches.length > 1) {
      const options = matches.map((t) => `${t.id} (in ${baseName(forums.find((f) => f.id === t.parent_id)?.name ?? '?')})`);
      throw new Error(`Several posts are called "${title}": ${options.join(', ')}. Pass the post id instead.`);
    }
    const thread = matches[0]!;
    return { channel: thread, forum: forums.find((f) => f.id === thread.parent_id) };
  }

  async general(): Promise<Channel | undefined> {
    return (await this.textChannels()).find((c) => baseName(c.name ?? '').toLowerCase() === GENERAL_CHANNEL);
  }

  async messages(channelId: string, options: { limit?: number; before?: string; after?: string } = {}): Promise<APIMessage[]> {
    const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 50, 1), 100)) });
    if (options.before) query.set('before', options.before);
    if (options.after) query.set('after', options.after);
    return (await this.rest.get(Routes.channelMessages(channelId), { query })) as APIMessage[];
  }

  async send(channelId: string, body: Record<string, unknown>, files: RawFile[] = []): Promise<APIMessage> {
    return (await this.rest.post(Routes.channelMessages(channelId), { body, files: files.length ? files : undefined })) as APIMessage;
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.rest.delete(Routes.channelMessage(channelId, messageId));
  }

  async editThread(threadId: string, body: Record<string, unknown>): Promise<Channel> {
    return (await this.rest.patch(Routes.channel(threadId), { body })) as Channel;
  }

  async createPost(forumId: string, body: Record<string, unknown>, files: RawFile[] = []): Promise<Channel & { message?: APIMessage }> {
    return (await this.rest.post(Routes.threads(forumId), { body, files: files.length ? files : undefined })) as Channel & {
      message?: APIMessage;
    };
  }

  async createChannel(body: Record<string, unknown>): Promise<Channel> {
    const channel = (await this.rest.post(Routes.guildChannels(this.config.guildId), { body })) as Channel;
    this.channelsCache = undefined;
    return channel;
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)));
  }

  /** Needs the Server Members privileged intent enabled for this bot in the developer portal. */
  async members(): Promise<APIGuildMember[]> {
    const query = new URLSearchParams({ limit: '1000' });
    return (await this.rest.get(Routes.guildMembers(this.config.guildId), { query })) as APIGuildMember[];
  }
}
