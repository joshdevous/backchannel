import { expect, test } from 'bun:test';
import { linkInlineMentions, mayHaveInlineMention, mentionedIds } from '../src/mentions.ts';

const S = '676926873669992459';
const SC = '1565935051794022510';
const targets = [
  { id: S, names: ['stephen.gg', 'Stephen'] },
  { id: SC, names: ['SteveClaude', 'Steve Claude'] },
];

test('links a written @Name to the member, case-insensitively', () => {
  expect(linkInlineMentions('@Stephen, Josh asked me', targets)).toBe(`<@${S}>, Josh asked me`);
  expect(linkInlineMentions('hey @stephen', targets)).toBe(`hey <@${S}>`);
});

test('prefers the longest matching name', () => {
  expect(linkInlineMentions('ask @Steve Claude about it', [{ id: S, names: ['Steve'] }, ...targets])).toBe(`ask <@${SC}> about it`);
});

test('needs a word boundary on both sides', () => {
  expect(linkInlineMentions('mail stephen@Stephen.dev', targets)).toBe('mail stephen@Stephen.dev');
  expect(linkInlineMentions('@Stephenson is not Stephen', targets)).toBe('@Stephenson is not Stephen');
});

test('leaves code, unknown names and @everyone alone', () => {
  expect(linkInlineMentions('run `@Stephen` and\n```\n@Stephen\n```', targets)).toBe('run `@Stephen` and\n```\n@Stephen\n```');
  expect(linkInlineMentions('@nobody @everyone', targets)).toBe('@nobody @everyone');
  expect(mayHaveInlineMention('@everyone look')).toBe(false);
  expect(mayHaveInlineMention('(@Stephen)')).toBe(true);
});

test('collects ids of raw mentions once', () => {
  expect(mentionedIds(`<@${S}> and <@!${S}> and <@${SC}>`)).toEqual([S, SC]);
});
