/**
 * Agents write "@Stephen" in prose far more often than they use the `mention` argument, and
 * Discord renders that as plain text. This turns `@Name` into a real `<@id>` mention when Name is
 * someone in the server, and collects every user id the message mentions so `allowed_mentions`
 * lets exactly those ping. Code spans and blocks are left alone, and so are @everyone / @here.
 */

export interface MentionTarget {
  id: string;
  /** Username, global display name and server nickname – whichever exist. */
  names: string[];
}

const RAW_MENTION = /<@!?(\d{17,20})>/g;

/** Splits text into alternating [prose, code, prose, code, ...] segments. */
function splitCode(text: string): string[] {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/);
}

export function linkInlineMentions(text: string, targets: readonly MentionTarget[]): string {
  // Longest names first so "Steve Claude" wins over "Steve".
  const names = targets
    .flatMap((t) => t.names.filter(Boolean).map((name) => ({ id: t.id, name })))
    .sort((a, b) => b.name.length - a.name.length);

  const segments = splitCode(text).map((segment, i) => {
    if (i % 2 === 1) return segment;
    let out = '';
    let rest = segment;
    for (;;) {
      const at = rest.indexOf('@');
      if (at === -1) break;
      const before = at === 0 ? '' : rest[at - 1]!;
      const after = rest.slice(at + 1);
      // `a@b` is an email or handle, not a mention; `<@` is already a mention.
      const boundary = before === '' || /[\s([{"'*_~>]/.test(before);
      const hit = boundary
        ? names.find(({ name }) => {
            if (after.slice(0, name.length).toLowerCase() !== name.toLowerCase()) return false;
            const next = after[name.length];
            return next === undefined || !/[\p{L}\p{N}_]/u.test(next);
          })
        : undefined;
      if (hit) {
        out += `${rest.slice(0, at)}<@${hit.id}>`;
        rest = after.slice(hit.name.length);
      } else {
        out += rest.slice(0, at + 1);
        rest = after;
      }
    }
    return out + rest;
  });

  return segments.join('');
}

/** Every user id the text mentions as `<@id>`, so `allowed_mentions` pings exactly those. */
export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(RAW_MENTION)].map((m) => m[1]!))];
}

/** Whether the text might contain a written `@Name` worth looking up (saves a member fetch). */
export function mayHaveInlineMention(text: string): boolean {
  return /(^|[\s([{"'*_~>])@(?!everyone\b|here\b)[^\s<]/.test(text);
}
