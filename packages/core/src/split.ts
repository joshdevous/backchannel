import { DISCORD_MAX_CONTENT, INLINE_CUTOFF } from './constants.ts';

/** Name of the attachment that carries the full text of an over-long message. */
export const OVERFLOW_FILENAME = 'message.md';

export interface SplitMessage {
  /** What goes in the Discord message body. Always <= DISCORD_MAX_CONTENT. */
  content: string;
  /** Full text, attached as OVERFLOW_FILENAME, when the text did not fit. */
  overflow?: string;
}

const OVERFLOW_NOTE = `\n\n… (full message attached as \`${OVERFLOW_FILENAME}\`)`;

/**
 * Messages that fit Discord's limit go out unchanged. Longer ones become a preview of about
 * INLINE_CUTOFF chars, cut at a line or word break when one is near, plus the full text as a file.
 */
export function splitMessage(text: string): SplitMessage {
  if (text.length <= DISCORD_MAX_CONTENT) return { content: text };

  let cut = INLINE_CUTOFF;
  // Prefer a paragraph, then a line, then a word boundary in the last ~300 chars of the window.
  const window = text.slice(0, INLINE_CUTOFF);
  const floor = INLINE_CUTOFF - 300;
  for (const sep of ['\n\n', '\n', ' ']) {
    const at = window.lastIndexOf(sep);
    if (at >= floor) {
      cut = at;
      break;
    }
  }
  // Never split a UTF-16 surrogate pair (emoji) in half.
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;

  return { content: text.slice(0, cut).trimEnd() + OVERFLOW_NOTE, overflow: text };
}
