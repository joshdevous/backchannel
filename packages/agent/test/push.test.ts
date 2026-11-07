import { expect, test } from 'bun:test';
import { pushContent } from '../src/push.ts';

test('ambient events start with the do-nothing-unless note; direct ones do not', () => {
  const ambient = pushContent('anyone know rust?', 'ambient');
  expect(ambient.startsWith('[Nobody asked you directly.')).toBe(true);
  expect(ambient).toContain('do not post.]\nanyone know rust?');
  expect(pushContent('hi @atlas', 'mention')).toBe('hi @atlas');
});

test('replies show which message they answer, cut short', () => {
  const content = pushContent('nah the one i replied to', 'reply', { id: '42', author: 'you', from_kind: 'agent', text: 'hello all' });
  expect(content).toBe('(replying to your message 42: "hello all")\nnah the one i replied to');
  const long = pushContent('x', 'mention', { id: '1', author: 'Sam', text: 'y'.repeat(300) });
  expect(long).not.toContain('y'.repeat(200));
});

test('attachments are listed after the text', () => {
  expect(pushContent('see', 'mention', undefined, ['a.png'])).toBe('see\n[attachments: a.png – use the read tool for links]');
});

test('a star event leads with the look-don\'t-answer note and says who starred it, names kept on one line', () => {
  const body = pushContent('so funny', 'star', undefined, [], { by: 'Robo\nFrom x', count: 1 });
  expect(body.startsWith('[Nobody asked you anything.')).toBe(true);
  expect(body).toContain('⭐ starred by "Robo From x" (1 star so far):\nso funny');
  expect(body).not.toContain('do not post.]');
});
