import { expect, test } from 'bun:test';
import { appliedStatusTagIds, missingStatusTags } from '../src/tags.ts';

test('missingStatusTags lists only absent status tags', () => {
  expect(missingStatusTags([]).map((t) => t.name)).toEqual(['Open', 'Claimed', 'Blocked', 'Done']);
  expect(missingStatusTags(['Open', 'bug', 'Done']).map((t) => t.name)).toEqual(['Claimed', 'Blocked']);
  expect(missingStatusTags(['Open', 'Claimed', 'Blocked', 'Done'])).toEqual([]);
});

test('appliedStatusTagIds ignores non-status tags', () => {
  const available = [
    { id: '1', name: 'Open' },
    { id: '2', name: 'bug' },
    { id: '3', name: 'Done' },
  ];
  expect(appliedStatusTagIds(['2'], available)).toEqual([]);
  expect(appliedStatusTagIds(['1', '2'], available)).toEqual(['1']);
  expect(appliedStatusTagIds(['1', '3'], available)).toEqual(['1', '3']);
});
