import { expect, test } from 'bun:test';
import {
  REPLY_TEXT_MAX,
  decideWakeReason,
  isAmbient,
  isDirect,
  parseListenMode,
  replyLine,
  shortText,
  strongestReason,
  systemText,
  type AmbientInput,
} from '../src/wake.ts';

const talk: AmbientInput = { fromBot: false, type: 0, where: 'text', channelName: 'general' };

test('ambient: people talking in text channels and forum posts', () => {
  expect(isAmbient(talk)).toBe(true);
  expect(isAmbient({ ...talk, type: 19 })).toBe(true);
  expect(isAmbient({ ...talk, where: 'forum_post', channelName: 'Fix the build' })).toBe(true);
});

test('not ambient: bots, system messages, #starboard, other channel kinds', () => {
  expect(isAmbient({ ...talk, fromBot: true })).toBe(false);
  for (const type of [6, 7, 18, 21, 20]) expect(isAmbient({ ...talk, type })).toBe(false);
  expect(isAmbient({ ...talk, channelName: 'starboard' })).toBe(false);
  expect(isAmbient({ ...talk, channelName: 'Starboard' })).toBe(false);
  expect(isAmbient({ ...talk, where: 'other' })).toBe(false);
});

test('decideWakeReason: direct always wakes, ambient only in mode all', () => {
  expect(decideWakeReason('mention', false, 'mentions')).toBe('mention');
  expect(decideWakeReason('reply', true, 'all')).toBe('reply');
  expect(decideWakeReason(null, true, 'all')).toBe('ambient');
  expect(decideWakeReason(null, true, 'mentions')).toBeNull();
  expect(decideWakeReason(null, false, 'all')).toBeNull();
});

test('strongest reason: mention > reply > claimed_post > started_post > ambient', () => {
  expect(strongestReason(['ambient', 'mention', 'reply'])).toBe('mention');
  expect(strongestReason(['ambient', 'reply'])).toBe('reply');
  expect(strongestReason(['started_post', 'claimed_post'])).toBe('claimed_post');
  expect(strongestReason(['ambient', 'started_post', 'ambient'])).toBe('started_post');
  expect(strongestReason(['ambient', 'ambient'])).toBe('ambient');
  expect(isDirect('ambient')).toBe(false);
  expect(isDirect('claimed_post')).toBe(true);
});

test('listen mode parsing: default all, case-insensitive, readable error', () => {
  expect(parseListenMode(undefined, 'X')).toBe('all');
  expect(parseListenMode(' ', 'X')).toBe('all');
  expect(parseListenMode('Mentions', 'X')).toBe('mentions');
  expect(() => parseListenMode('loud', 'ATLAS_LISTEN')).toThrow('ATLAS_LISTEN must be one of all, mentions');
});

test('reply lines quote the replied-to message on one line, cut at ~200 chars', () => {
  expect(replyLine({ id: '9', author: 'Sam', text: 'look at\nthis' })).toBe('(replying to Sam\'s message 9: "look at this")');
  expect(replyLine({ id: '9', author: 'you', text: 'hi' })).toBe('(replying to your message 9: "hi")');
  const long = shortText('x'.repeat(500));
  expect(long).toHaveLength(REPLY_TEXT_MAX);
  expect(long.endsWith('…')).toBe(true);
  expect(replyLine({ id: '1', author: 'a', text: 'y'.repeat(500) })).not.toContain('y'.repeat(REPLY_TEXT_MAX));
});

test('system messages get a readable line; spoken ones none', () => {
  expect(systemText(7, 'Stephen', '')).toBe('Stephen joined the server');
  expect(systemText(6, 'Josh', '')).toBe('Josh pinned a message');
  expect(systemText(18, 'Josh', 'ideas')).toBe('Josh started a thread: ideas');
  expect(systemText(0, 'Josh', 'hi')).toBeUndefined();
  expect(systemText(19, 'Josh', 'hi')).toBeUndefined();
});
