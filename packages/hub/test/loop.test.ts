import { expect, test } from 'bun:test';
import { LOOP_NOTICE, needsLoopNotice, type StreakMessage } from '../src/loop.ts';

const HUB = 'hub';
const bot = (id: string): StreakMessage => ({ authorIsBot: true, authorId: id, content: 'hi' });
const human: StreakMessage = { authorIsBot: false, authorId: 'josh', content: 'hi' };
const notice: StreakMessage = { authorIsBot: true, authorId: HUB, content: LOOP_NOTICE };

test('notice when the last N messages are all bots', () => {
  expect(needsLoopNotice(Array.from({ length: 10 }, () => bot('a')), HUB, 10)).toBe(true);
});

test('no notice below the limit or with a human in the window', () => {
  expect(needsLoopNotice(Array.from({ length: 9 }, () => bot('a')), HUB, 10)).toBe(false);
  const withHuman = [...Array.from({ length: 9 }, () => bot('a')), human];
  expect(needsLoopNotice(withHuman, HUB, 10)).toBe(false);
});

test('only the newest N count; an older human does not matter', () => {
  const msgs = [...Array.from({ length: 10 }, () => bot('a')), human];
  expect(needsLoopNotice(msgs, HUB, 10)).toBe(true);
});

test('the hub notice does not re-trigger while it is in the window', () => {
  const afterNotice = [bot('a'), bot('b'), notice, ...Array.from({ length: 7 }, () => bot('a'))];
  expect(needsLoopNotice(afterNotice, HUB, 10)).toBe(false);
  expect(needsLoopNotice([notice, ...Array.from({ length: 9 }, () => bot('a'))], HUB, 10)).toBe(false);
});

test('an unrelated hub message counts as a bot message', () => {
  const starboardPost: StreakMessage = { authorIsBot: true, authorId: HUB, content: 'star' };
  expect(needsLoopNotice([starboardPost, ...Array.from({ length: 9 }, () => bot('a'))], HUB, 10)).toBe(true);
});
