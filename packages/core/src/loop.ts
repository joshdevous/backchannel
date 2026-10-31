import { LOOP_LIMIT } from './constants.ts';

/**
 * Number of consecutive bot messages at the newest end of `messages`.
 * `messages` is newest first, which is the order Discord's message list returns.
 */
export function botStreak(messages: readonly { bot: boolean }[]): number {
  let streak = 0;
  for (const message of messages) {
    if (!message.bot) break;
    streak++;
  }
  return streak;
}

/** True when the newest `limit` messages are all from bots, so agents must stop and wait for a human. */
export function loopLimitReached(messages: readonly { bot: boolean }[], limit = LOOP_LIMIT): boolean {
  return botStreak(messages) >= limit;
}
