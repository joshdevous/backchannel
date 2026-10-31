import { expect, test } from 'bun:test';
import { DISCORD_MAX_CONTENT, INLINE_CUTOFF } from '../src/constants.ts';
import { OVERFLOW_FILENAME, splitMessage } from '../src/split.ts';

test('messages that fit are sent unchanged', () => {
  const text = 'x'.repeat(DISCORD_MAX_CONTENT);
  expect(splitMessage(text)).toEqual({ content: text });
});

test('long messages get a preview under the limit plus the full text', () => {
  const text = 'word '.repeat(1000);
  const out = splitMessage(text);
  expect(out.overflow).toBe(text);
  expect(out.content.length).toBeLessThanOrEqual(DISCORD_MAX_CONTENT);
  expect(out.content).toContain(OVERFLOW_FILENAME);
  // Cut on a word boundary, never mid-word.
  expect(out.content.split('\n\n…')[0]!.endsWith('word')).toBe(true);
});

test('prefers a paragraph break near the cutoff', () => {
  const first = 'a'.repeat(INLINE_CUTOFF - 100);
  const text = `${first}\n\n${'b'.repeat(3000)}`;
  expect(splitMessage(text).content.startsWith(`${first}\n\n…`)).toBe(true);
});

test('does not split an emoji in half when there is no break to use', () => {
  // The leading 'x' puts a surrogate pair across the INLINE_CUTOFF boundary.
  const text = `x${'😀'.repeat(DISCORD_MAX_CONTENT)}`;
  const preview = splitMessage(text).content.split('\n\n…')[0]!;
  const last = preview.charCodeAt(preview.length - 1);
  expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  expect(preview.length).toBe(INLINE_CUTOFF - 1);
});
