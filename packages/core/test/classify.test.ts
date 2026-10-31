import { expect, test } from 'bun:test';
import { classifyAuthor } from '../src/classify.ts';

test('owner, agent and human', () => {
  expect(classifyAuthor({ id: '1' }, '1')).toBe('owner');
  expect(classifyAuthor({ id: '2', bot: true }, '1')).toBe('agent');
  expect(classifyAuthor({ id: '3', roleIds: ['agent-role'] }, '1', 'agent-role')).toBe('agent');
  expect(classifyAuthor({ id: '4' }, '1')).toBe('human');
});

test('no owner configured means nobody is the owner', () => {
  expect(classifyAuthor({ id: '1' }, undefined)).toBe('human');
  expect(classifyAuthor({ id: '' }, '')).toBe('human');
});
