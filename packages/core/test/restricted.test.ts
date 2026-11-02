import { expect, test } from 'bun:test';
import { deniedPathReason } from '../src/secrets.ts';
import { isRestricted, restrictedReason } from '../src/restricted.ts';

test('names of UKSBS are restricted wherever they appear', () => {
  for (const text of [
    'see github.com/UKSBS/connect',
    'josh-uksbs account',
    'https://uksbsiss.atlassian.net/browse/X-1',
    'check DIGI-20523 please',
    'the api-super-connect repo',
    'Connect 2.0 login bug',
  ]) {
    expect(restrictedReason(text, [])).toBe('UKSBS');
  }
});

test('ordinary text is not restricted, and extra terms are honoured', () => {
  expect(isRestricted('let us fix the relay', [])).toBe(false);
  expect(isRestricted('digital is fine, DIGI-1 is too short', [])).toBe(false);
  expect(isRestricted('talk about Acme Corp', ['acme corp'])).toBe(true);
});

test('paths mentioning UKSBS are never shared', () => {
  expect(deniedPathReason('/root/projects/uksbs/connect/README.md')).toBe('UKSBS files');
  expect(deniedPathReason('/root/projects/atlas/README.md')).toBeNull();
});
