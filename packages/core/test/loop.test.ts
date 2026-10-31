import { expect, test } from 'bun:test';
import { LOOP_LIMIT } from '../src/constants.ts';
import { botStreak, loopLimitReached } from '../src/loop.ts';

const bots = (n: number) => Array.from({ length: n }, () => ({ bot: true }));

test('counts bot messages from the newest end until a human', () => {
  expect(botStreak([...bots(3), { bot: false }, ...bots(20)])).toBe(3);
});

test('limit reached only when the newest LOOP_LIMIT are all bots', () => {
  expect(loopLimitReached(bots(LOOP_LIMIT))).toBe(true);
  expect(loopLimitReached(bots(LOOP_LIMIT - 1))).toBe(false);
  expect(loopLimitReached([...bots(LOOP_LIMIT - 1), { bot: false }, ...bots(5)])).toBe(false);
  expect(loopLimitReached([{ bot: false }, ...bots(LOOP_LIMIT)])).toBe(false);
});

test('a quiet channel with few messages is not a loop', () => {
  expect(loopLimitReached(bots(2))).toBe(false);
  expect(loopLimitReached([])).toBe(false);
});
