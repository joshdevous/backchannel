import { afterEach, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { classifyPrompt, OmpRpcLlm, parseOmpOutput } from '../src/omp-llm.ts';
import type { Llm } from '../src/project-classifier.ts';

const FAKE_OMP = fileURLToPath(new URL('./fixtures/fake-omp-rpc.ts', import.meta.url));
const running: OmpRpcLlm[] = [];
afterEach(() => {
  for (const llm of running.splice(0)) llm.stop();
});

function rpcLlm() {
  const fallbackCalls: string[] = [];
  const fallback: Llm = {
    ask: async (_system, user) => {
      fallbackCalls.push(user);
      return { text: `fallback ${user}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    },
  };
  const llm = new OmpRpcLlm({ bin: FAKE_OMP, fallback });
  running.push(llm);
  return { llm, fallbackCalls };
}

test("omp's JSON output: the last reply with usage, served by Anthropic", () => {
  const line = (message: object) => JSON.stringify({ type: 'message_end', message });
  const ok = [
    '{"type":"session"}',
    'not json',
    line({ provider: 'anthropic', stopReason: 'stop', content: [{ type: 'text', text: 'Atlas' }], usage: { input: 312, output: 3, cacheRead: 0, cacheWrite: 0 } }),
  ].join('\n');
  expect(parseOmpOutput(ok)).toEqual({ text: 'Atlas', usage: { input: 312, output: 3, cacheRead: 0, cacheWrite: 0 } });
  expect(() => parseOmpOutput(line({ provider: 'openai', stopReason: 'stop', content: [], usage: {} }))).toThrow('not anthropic');
  expect(() => parseOmpOutput('{"type":"session"}')).toThrow('no reply');
});

test('the prompt carries the instruction and message for the trim extension, as base64 JSON', () => {
  const prompt = classifyPrompt('sys', 'a "quoted"\nmessage');
  expect(prompt).toMatch(/^classify:[A-Za-z0-9+/=]+$/);
  expect(JSON.parse(Buffer.from(prompt.slice('classify:'.length), 'base64').toString())).toEqual({ system: 'sys', user: 'a "quoted"\nmessage' });
});

test('one omp rpc process answers every call, each in a fresh session, one at a time', async () => {
  const { llm, fallbackCalls } = rpcLlm();
  llm.start();
  const answers = await Promise.all(['one', 'two', 'three'].map((user) => llm.ask('sys', user, 5_000)));
  expect(answers.map((a) => a.text)).toEqual(['one #1', 'two #1', 'three #1']);
  expect(answers[0]!.usage).toEqual({ input: 5, output: 2, cacheRead: 0, cacheWrite: 0 });
  expect(fallbackCalls).toEqual([]);
});

test('after the process dies, calls go to the fallback until it is restarted', async () => {
  const { llm, fallbackCalls } = rpcLlm();
  await expect(llm.ask('sys', 'crash', 5_000)).rejects.toThrow('exited with 3');
  // The exit is handled before the failed call settles, so the very next call already falls back.
  expect((await llm.ask('sys', 'next', 5_000)).text).toBe('fallback next');
  expect(fallbackCalls).toEqual(['next']);
});
