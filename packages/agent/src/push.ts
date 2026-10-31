import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ChannelType, Client, Events, GatewayIntentBits, type Message } from 'discord.js';
import {
  ACK_EMOJI,
  AGENT_ROLE,
  AMBIENT_NOTE,
  MESSAGE_TYPE_REPLY,
  baseName,
  classifyAuthor,
  isDirect,
  replyLine,
  shortText,
  systemText,
  type FromKind,
  type WakeReason,
} from '@backchannel/core';
import type { CompleteConfig } from './config.ts';
import { loadBotState } from './state.ts';
import type { TypingLoop } from './typing.ts';
import { pushReason } from './wake.ts';

/** Longest channel event body; anything longer is cut and the agent is told to `read` the rest. */
const PUSH_CONTENT_MAX = 4000;

export interface PushReply {
  id: string;
  /** Display name; "you" for this agent's own message. */
  author: string;
  from_kind?: FromKind;
  text: string;
}

/** The event body: ambient note, reply context, then the message text (cut at `PUSH_CONTENT_MAX`). */
export function pushContent(text: string, reason: WakeReason, reply?: PushReply, attachments: readonly string[] = []): string {
  let body = text.length > PUSH_CONTENT_MAX ? `${text.slice(0, PUSH_CONTENT_MAX)}\n… (cut; use the read tool for the rest)` : text;
  if (attachments.length) body += `\n[attachments: ${attachments.join(', ')} – use the read tool for links]`;
  const lines: string[] = [];
  if (!isDirect(reason)) lines.push(`[${AMBIENT_NOTE}]`);
  if (reply) lines.push(replyLine(reply));
  lines.push(body);
  return lines.join('\n');
}

function nameOf(message: Message): string {
  return message.member?.displayName ?? message.author.displayName;
}

function renderMentions(message: Message, content: string): string {
  for (const user of message.mentions.users.values()) {
    content = content.replaceAll(`<@${user.id}>`, `@${user.displayName}`).replaceAll(`<@!${user.id}>`, `@${user.displayName}`);
  }
  return content;
}

async function replyOf(message: Message, meId: string, ownerId: string): Promise<PushReply | undefined> {
  const id = message.reference?.messageId;
  if (message.type !== MESSAGE_TYPE_REPLY || !id) return undefined;
  const ref = await message.fetchReference().catch(() => null);
  if (!ref) return { id, author: 'someone', text: '(message not available, maybe deleted)' };
  return {
    id: ref.id,
    author: ref.author.id === meId ? 'you' : nameOf(ref),
    from_kind: classifyAuthor({ id: ref.author.id, bot: ref.author.bot }, ownerId),
    text: shortText(systemText(ref.type, nameOf(ref), ref.content) ?? renderMentions(ref, ref.content)),
  };
}

/**
 * Push mode: a gateway connection with this agent's own bot that turns messages it should hear
 * into Claude Code channel events (`notifications/claude/channel`): direct triggers always, and
 * with `listen: all` ordinary human conversation too (`reason="ambient"`). Only messages from
 * the configured server get through; meta carries identifiers and `from_kind` so authority is
 * always visible.
 */
export async function startPush(server: Server, config: CompleteConfig, typing?: TypingLoop): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      // Gate first: nothing outside the configured server, and never our own messages.
      if (!message.inGuild() || message.guildId !== config.guildId || !client.user || message.author.id === client.user.id) return;
      const me = client.user.id;
      const channel = message.channel;
      const thread = channel.isThread() ? channel : null;
      const forumPost = thread?.parent?.type === ChannelType.GuildForum;
      const replyToAuthorId = message.reference ? message.mentions.repliedUser?.id : undefined;
      const fromBot = message.author.bot || Boolean(message.member?.roles.cache.some((r) => r.name === AGENT_ROLE));

      const reason = pushReason(
        {
          authorId: message.author.id,
          channelId: message.channelId,
          mentionIds: [...message.mentions.users.keys()],
          replyToAuthorId,
          threadOwnerId: thread?.ownerId ?? undefined,
          ambient: {
            fromBot,
            type: message.type,
            where: forumPost ? 'forum_post' : channel.type === ChannelType.GuildText ? 'text' : 'other',
            channelName: baseName(channel.name),
          },
        },
        me,
        loadBotState(me).claimedPosts,
        config.listen,
      );
      if (!reason) return;

      const reply = await replyOf(message, me, config.ownerId);
      const text = systemText(message.type, nameOf(message), message.content) ?? renderMentions(message, message.content);
      const content = pushContent(text, reason, reply, [...message.attachments.values()].map((a) => a.name));

      const meta: Record<string, string> = {
        channel_id: message.channelId,
        message_id: message.id,
        from: nameOf(message),
        from_kind: classifyAuthor({ id: message.author.id, bot: message.author.bot }, config.ownerId),
        reason,
      };
      if (thread) meta.post_title = thread.name;
      if (reply) {
        meta.reply_to_message_id = reply.id;
        meta.reply_to_author = reply.author;
        if (reply.from_kind) meta.reply_to_from_kind = reply.from_kind;
      }

      await server.notification({ method: 'notifications/claude/channel', params: { content, meta } });

      // Overheard conversation may well get no answer: no 👀 and no owed answer for it.
      if (!isDirect(reason)) return;
      // The agent has the message: tell the channel (👀), and owe it an answer (typing starts with the next tool call).
      typing?.pushed(message.channelId);
      await message.react(ACK_EMOJI).catch((error: Error) => {
        console.error(`[backchannel] push: could not react ${ACK_EMOJI}: ${error.message}`);
      });
    } catch (error) {
      console.error(`[backchannel] push: failed to forward message: ${(error as Error).message}`);
    }
  });

  client.once(Events.ClientReady, (ready) => {
    console.error(`[backchannel] push mode connected as ${ready.user.tag}, listening to ${config.listen === 'all' ? 'all conversation' : 'mentions only'}`);
  });
  client.on(Events.Error, (error) => console.error(`[backchannel] gateway error: ${error.message}`));

  try {
    await client.login(config.token);
  } catch (error) {
    const text = (error as Error).message.replace(/\.$/, '');
    const hint = /disallowed intents/i.test(text)
      ? ' Enable "Message Content Intent" for this bot in the Discord developer portal (Bot page).'
      : '';
    console.error(`[backchannel] push mode could not connect: ${text}.${hint} Tools still work.`);
  }
}
