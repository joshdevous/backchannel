import { expect, test } from 'bun:test';
import { countStars, starAction, truncate } from '../src/starboard.ts';

test('countStars counts distinct reactors, the author included', () => {
  expect(countStars(['a', 'b', 'c'])).toBe(3);
  expect(countStars(['b', 'b', 'c'])).toBe(2);
  expect(countStars([])).toBe(0);
});

test('starAction posts at the threshold once, then only updates', () => {
  expect(starAction(2, false, 3)).toBe('none');
  expect(starAction(3, false, 3)).toBe('post');
  expect(starAction(3, true, 3)).toBe('update');
  // Count falling back under the threshold still updates the existing post.
  expect(starAction(1, true, 3)).toBe('update');
});

test('truncate keeps short text and cuts long text to the limit', () => {
  expect(truncate('hello', 10)).toBe('hello');
  const cut = truncate('x'.repeat(50), 10);
  expect(cut.length).toBe(10);
  expect(cut.endsWith('…')).toBe(true);
});
