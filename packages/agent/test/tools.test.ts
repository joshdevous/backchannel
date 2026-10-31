import { expect, test } from 'bun:test';
import { RefusedError } from '../src/files.ts';
import { TOOLS, messageArg, refuseSelfStar } from '../src/tools.ts';

test('post takes its text from message, else content or text', () => {
  expect(messageArg({ message: 'a', content: 'b' })).toBe('a');
  expect(messageArg({ content: 'b' })).toBe('b');
  expect(messageArg({ text: 'c' })).toBe('c');
  expect(messageArg({ message: '', content: 'b' })).toBe('b');
  expect(() => messageArg({ channel: 'general' })).toThrow('Missing argument: message');
});

test('post documents message but does not require it, so an alias passes schema validation', () => {
  const post = TOOLS.find((t) => t.name === 'post')!;
  expect(post.inputSchema.properties.message).toBeDefined();
  expect(post.inputSchema.required).toEqual(['channel']);
});

test('star refuses the agent\'s own message', () => {
  expect(() => refuseSelfStar('me', 'me')).toThrow(RefusedError);
  expect(() => refuseSelfStar('me', 'me')).toThrow("Self-stars don't count");
  expect(() => refuseSelfStar('someone', 'me')).not.toThrow();
});

test('unstar is a tool with the same arguments as star', () => {
  const unstar = TOOLS.find((t) => t.name === 'unstar')!;
  expect(unstar.inputSchema.required).toEqual(['message_id', 'channel']);
});
