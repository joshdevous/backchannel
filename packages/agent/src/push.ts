import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { ACK_EMOJI, classifyAuthor } from '@backchannel/core';
import type { CompleteConfig } from './config.ts';
import { loadBotState } from './state.ts';
import type { TypingLoop } from './typing.ts';
import { wakeReason } from './wake.ts';

/** Longest channel event body; anything longer is cut and the agent is told to `read` the rest. */
const PUSH_CONTENT_MAX = 4000;

/**
 * Push mode: a gateway connection with this agent's own bot that turns messages aimed at it into
 * Claude Code channel events (`notifications/claude/channel`). Only messages from the configured
 * server get through; meta carries identifiers and `from_kind` so authority is always visible.
 */
export async function startPush(server: Server, config: CompleteConfig, typing?: TypingLoop): Promise<void> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      // Gate first: nothing outside the configured server, and never our own messages.
      if (message.guildId !== config.guildId || !client.user || message.author.id === client.user.id) return;
      const me = client.user.id;
      const thread = message.channel.isThread() ? message.channel : null;

      const reason = wakeReason(
        {
          authorId: message.author.id,
          channelId: message.channelId,
          mentionIds: [...message.mentions.users.keys()],
          replyToAuthorId: message.reference ? message.mentions.repliedUser?.id : undefined,
          threadOwnerId: thread?.ownerId ?? undefined,
        },
        me,
        loadBotState(me).claimedPosts,
      );
      if (!reason) return;

      let content = message.content;
      for (const user of message.mentions.users.values()) {
        content = content.replaceAll(`<@${user.id}>`, `@${user.displayName}`).replaceAll(`<@!${user.id}>`, `@${user.displayName}`);
      }
      if (content.length > PUSH_CONTENT_MAX) content = `${content.slice(0, PUSH_CONTENT_MAX)}\n… (cut; use the read tool for the rest)`;
      if (message.attachments.size) {
        content += `\n[attachments: ${[...message.attachments.values()].map((a) => a.name).join(', ')} – use the read tool for links]`;
      }

      const meta: Record<string, string> = {
        channel_id: message.channelId,
        message_id: message.id,
        from: message.member?.displayName ?? message.author.displayName,
        from_kind: classifyAuthor({ id: message.author.id, bot: message.author.bot }, config.ownerId),
        reason,
      };
      if (thread) meta.post_title = thread.name;

      await server.notification({ method: 'notifications/claude/channel', params: { content, meta } });

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
    console.error(`[backchannel] push mode connected as ${ready.user.tag}`);
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
