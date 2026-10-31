import { describe, expect, test } from 'bun:test';
import { claimMarkerText, compareSnowflakes, isClaimMarker, releaseMarkerText, resolveClaim, type MarkerMessage } from '../src/claims.ts';

const msg = (id: string, authorId: string, content: string): MarkerMessage => ({ id, authorId, authorName: `bot-${authorId}`, content });

describe('resolveClaim', () => {
  test('no markers means nobody holds it', () => {
    expect(resolveClaim([msg('100', 'a', 'hello')]).holder).toBeNull();
  });

  test('earliest claim marker wins regardless of input order', () => {
    const messages = [msg('300', 'b', claimMarkerText('B')), msg('200', 'a', claimMarkerText('A', 'on it')), msg('100', 'c', 'chat')];
    const state = resolveClaim(messages);
    expect(state.holder).toEqual({ authorId: 'a', authorName: 'bot-a', markerId: '200' });
    expect(state.markers.map((m) => m.id)).toEqual(['200', '300']);
  });

  test('compares snowflakes numerically, not as strings', () => {
    // '99…' sorts after '100…' as a string but is smaller as a number.
    const early = '99999999999999999';
    const late = '100000000000000000';
    const state = resolveClaim([msg(late, 'late', claimMarkerText('L')), msg(early, 'early', claimMarkerText('E'))]);
    expect(state.holder?.authorId).toBe('early');
    expect(compareSnowflakes(early, late)).toBe(-1);
  });

  test('a release clears earlier claims; the first claim after it wins', () => {
    const state = resolveClaim([
      msg('100', 'a', claimMarkerText('A')),
      msg('200', 'a', releaseMarkerText('A', 'Open')),
      msg('300', 'b', claimMarkerText('B')),
      msg('400', 'c', claimMarkerText('C')),
    ]);
    expect(state.holder?.authorId).toBe('b');
  });

  test('released with no later claim means free', () => {
    const state = resolveClaim([msg('100', 'a', claimMarkerText('A')), msg('200', 'a', releaseMarkerText('A', 'Done', 'shipped'))]);
    expect(state.holder).toBeNull();
  });

  test('marker must be on the first line', () => {
    expect(isClaimMarker(`I will do it\n${claimMarkerText('A')}`)).toBe(false);
    expect(isClaimMarker(claimMarkerText('A', 'note'))).toBe(true);
  });
});
