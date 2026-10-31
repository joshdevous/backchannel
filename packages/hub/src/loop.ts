import { LOOP_LIMIT, STARBOARD_CHANNEL, baseName } from '@backchannel/core';
import type { Client, Message } from 'discord.js';
import { log, logError } from './log.ts';

export const LOOP_NOTICE = `⏸️ Agents have posted ${LOOP_LIMIT} messages in a row here. A human needs to reply before they can continue.`;

export interface StreakMessage {
  authorIsBot: boolean;
  authorId: string;
  content: string;
}

/**
 * True when the newest `limit` messages are all from bots and none of them is the hub's own
 * notice. The notice counts as a bot message (it keeps agents blocked) but, while it is inside
 * the window, it also stops a second notice. Input is newest first.
 */
export function needsLoopNotice(
  newestFirst: readonly StreakMessage[],
  hubId: string,
  limit = LOOP_LIMIT,
): boolean {
  if (newestFirst.length < limit) return false;
  const window = newestFirst.slice(0, limit);
  if (!window.every((m) => m.authorIsBot)) return false;
  return !window.some((m) => m.authorId === hubId && m.content === LOOP_NOTICE);
}

// Messages arriving together would each see the same streak; check one at a time per channel.
const chains = new Map<string, Promise<void>>();

export function startLoopNotice(client: Client<true>, guildId: string): void {
  client.on('messageCreate', (message) => {
    const key = message.channelId;
    const run = (chains.get(key) ?? Promise.resolve()).then(() => check(message));
    chains.set(key, run);
    void run.then(() => {
      if (chains.get(key) === run) chains.delete(key);
    });
  });

  async function check(message: Message): Promise<void> {
    try {
      // Cheap exit: a human (or the hub itself) as the newest message means no streak.
      if (message.guildId !== guildId || !message.author.bot || message.author.id === client.user.id) return;
      const channel = message.channel;
      if (!channel.isTextBased() || channel.isDMBased()) return;
      // The starboard is written only by the hub, so a run of bot messages there is normal.
      if (!channel.isThread() && baseName(channel.name) === STARBOARD_CHANNEL) return;

      const recent = await channel.messages.fetch({ limit: LOOP_LIMIT });
      const newestFirst = [...recent.values()]
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
        .map((m) => ({ authorIsBot: m.author.bot, authorId: m.author.id, content: m.content }));
      if (!needsLoopNotice(newestFirst, client.user.id)) return;

      await channel.send(LOOP_NOTICE);
      log(`loop notice channel=${channel.id}`);
    } catch (err) {
      logError(`loop notice message=${message.id}`, err);
    }
  }
}
