import { describe, expect, it } from 'vitest';
import { decodeUlidTime, isUlid, monotonicUlidFactory, ulid } from '../../src/domain/ulid';

describe('ulid', () => {
  it('is 26 Crockford base32 characters', () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isUlid(id)).toBe(true);
  });

  it('encodes the generation time', () => {
    const before = Date.now();
    const decoded = decodeUlidTime(ulid());
    expect(decoded).toBeGreaterThanOrEqual(before - 1);
    expect(decoded).toBeLessThanOrEqual(Date.now() + 1);
  });

  it('does not collide across many draws', () => {
    const ids = Array.from({ length: 5000 }, () => ulid());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sorts lexicographically in creation order within a fixed clock', () => {
    const now = 1_700_000_000_000;
    const next = monotonicUlidFactory(() => now);
    const ids = Array.from({ length: 200 }, () => next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('sorts lexicographically as the clock advances', () => {
    let now = 1_700_000_000_000;
    const next = monotonicUlidFactory(() => (now += 1));
    const ids = Array.from({ length: 200 }, () => next());
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays monotonic if the clock steps backwards', () => {
    const clock = [1_700_000_000_100, 1_700_000_000_000, 1_700_000_000_050];
    let i = 0;
    const next = monotonicUlidFactory(() => clock[i++] ?? 0);
    const ids = [next(), next(), next()];
    expect([...ids].sort()).toEqual(ids);
  });

  it('rejects malformed ids', () => {
    expect(isUlid('')).toBe(false);
    expect(isUlid('too-short')).toBe(false);
    expect(isUlid('I'.repeat(26))).toBe(false);
    expect(isUlid('U'.repeat(26))).toBe(false);
    expect(() => decodeUlidTime('nope')).toThrow(TypeError);
    expect(() => decodeUlidTime('I'.repeat(26))).toThrow(TypeError);
  });
});
