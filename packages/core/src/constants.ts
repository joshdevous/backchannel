/** Shared contract between the hub bot and every agent. See docs/design.md. */

export const STATUS_TAGS = [
  { name: 'Open', emoji: '🟢' },
  { name: 'Claimed', emoji: '🔒' },
  { name: 'Blocked', emoji: '🧱' },
  { name: 'Done', emoji: '✅' },
] as const;

export type StatusName = (typeof STATUS_TAGS)[number]['name'];

export const STAR_EMOJI = '⭐';
export const STAR_THRESHOLD = 2;

/** The agent's own bot reacts this to a message that woke it: "got it, on it". */
export const ACK_EMOJI = '👀';

/** `post` refuses when this many messages in a row are all from bots. */
export const LOOP_LIMIT = 10;

/**
 * Channels carry an emoji prefix joined by `・` (U+30FB), e.g. `💬・general`.
 * Code finds channels by their base name (`baseName`), so a channel someone
 * renamed without the prefix, or a forum made before the hub added it, still resolves.
 */
export const NAME_SEPARATOR = '・';
export const GENERAL_CHANNEL = 'general';
export const GENERAL_EMOJI = '💬';
export const STARBOARD_CHANNEL = 'starboard';
export const STARBOARD_EMOJI = '⭐';
/** Every forum gets this prefix; the hub adds it to any forum created without it. */
export const FORUM_EMOJI = '📁';
export const PROJECTS_CATEGORY = 'Projects';

/** Starboard embed accent colour (star gold, #F5C518). */
export const STARBOARD_COLOUR = 0xf5c518;

/** `💬・general` -> `general`; a name without the separator is returned as-is. */
export function baseName(channelName: string): string {
  const at = channelName.indexOf(NAME_SEPARATOR);
  return at === -1 ? channelName : channelName.slice(at + NAME_SEPARATOR.length);
}

/** `('📁', 'atlas')` -> `📁・atlas`. Leaves an already-prefixed name alone. */
export function prefixedName(emoji: string, name: string): string {
  return name.includes(NAME_SEPARATOR) ? name : `${emoji}${NAME_SEPARATOR}${name}`;
}
export const AGENT_ROLE = 'Agent';
export const HUMAN_ROLE = 'Human';

/** First-line prefixes of claim bookkeeping messages. Readable by humans on purpose. */
export const CLAIM_MARKER = '🔒 Claimed by';
export const RELEASE_MARKER = '🔓 Released by';

/** Discord's hard message length cap, and where we cut over to an attached file. */
export const DISCORD_MAX_CONTENT = 2000;
export const INLINE_CUTOFF = 1800;
