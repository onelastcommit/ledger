import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalise,
  canonicaliseEvent,
  chainHashes,
  hashEvent,
  verifyChain,
  type CanonicalisableEvent,
} from '../../src/hash.js';
import type { StoredEvent } from '../../src/types.js';

const baseEvent: CanonicalisableEvent = {
  id: '01HZY000000000000000000000',
  streamId: 'order:1',
  seq: 1,
  type: 'OrderPlaced',
  payload: { total: 42, currency: 'GBP' },
  actor: { kind: 'user', id: 'u1' },
  occurredAt: '2026-01-01T00:00:00.000Z',
};

describe('canonicalise', () => {
  it('is insensitive to key order', () => {
    expect(canonicalise({ b: 1, a: 2 })).toBe(canonicalise({ a: 2, b: 1 }));
    expect(canonicalise({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('sorts keys recursively', () => {
    const left = canonicalise({ outer: { z: 1, a: { y: 2, b: 3 } } });
    const right = canonicalise({ outer: { a: { b: 3, y: 2 }, z: 1 } });
    expect(left).toBe(right);
    expect(left).toBe('{"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it('preserves array order', () => {
    expect(canonicalise([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalise([1, 2, 3])).not.toBe(canonicalise([3, 2, 1]));
  });

  it('omits undefined properties but keeps null', () => {
    expect(canonicalise({ a: undefined, b: null })).toBe('{"b":null}');
    expect(canonicalise({ b: null })).toBe(canonicalise({ a: undefined, b: null }));
  });

  it('turns undefined array elements into null, as JSON does', () => {
    expect(canonicalise([1, undefined, 2])).toBe('[1,null,2]');
  });

  it('handles unicode and escaping deterministically', () => {
    expect(canonicalise({ 'ä': 'ø', 'z': '“quoted”' })).toBe(canonicalise({ 'z': '“quoted”', 'ä': 'ø' }));
    expect(canonicalise('naïve')).toBe('"naïve"');
    expect(canonicalise('tab\there')).toBe('"tab\\there"');
    expect(canonicalise({ '😀': 1 })).toBe('{"😀":1}');
  });

  it('sorts keys by code unit, so non-ASCII keys are stable', () => {
    expect(canonicalise({ b: 1, ä: 2, a: 3 })).toBe('{"a":3,"b":1,"ä":2}');
  });

  it('normalises negative zero', () => {
    expect(canonicalise(-0)).toBe('0');
    expect(canonicalise({ n: -0 })).toBe(canonicalise({ n: 0 }));
  });

  it('formats numbers as JSON does', () => {
    expect(canonicalise(1)).toBe('1');
    expect(canonicalise(1.0)).toBe('1');
    expect(canonicalise(0.1)).toBe('0.1');
    expect(canonicalise(1e21)).toBe('1e+21');
    expect(canonicalise(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  it('honours toJSON', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(canonicalise({ at: date })).toBe('{"at":"2026-01-01T00:00:00.000Z"}');
  });

  it('refuses values that JSON would silently corrupt', () => {
    expect(() => canonicalise(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalise(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => canonicalise({ big: 1n })).toThrow(TypeError);
    expect(() => canonicalise(() => undefined)).toThrow(TypeError);
    expect(() => canonicalise(Symbol('s'))).toThrow(TypeError);
  });

  it('encodes top-level primitives', () => {
    expect(canonicalise(null)).toBe('null');
    expect(canonicalise(undefined)).toBe('null');
    expect(canonicalise(true)).toBe('true');
    expect(canonicalise('x')).toBe('"x"');
  });

  it('produces identical output across repeated calls', () => {
    const value = { z: [1, { b: 2, a: 3 }], a: 'x' };
    const runs = new Set(Array.from({ length: 50 }, () => canonicalise(value)));
    expect(runs.size).toBe(1);
  });
});

describe('canonicaliseEvent', () => {
  it('covers exactly the immutable fields', () => {
    expect(canonicaliseEvent(baseEvent)).toBe(
      '{"actor":{"id":"u1","kind":"user"},"id":"01HZY000000000000000000000","occurredAt":"2026-01-01T00:00:00.000Z","payload":{"currency":"GBP","total":42},"seq":1,"streamId":"order:1","type":"OrderPlaced"}',
    );
  });

  it('treats an absent source and an undefined source identically', () => {
    expect(canonicaliseEvent({ ...baseEvent, source: undefined })).toBe(
      canonicaliseEvent(baseEvent),
    );
  });

  it('includes source when present', () => {
    const withSource = canonicaliseEvent({ ...baseEvent, source: { form: 'checkout' } });
    expect(withSource).toContain('"source":{"form":"checkout"}');
    expect(withSource).not.toBe(canonicaliseEvent(baseEvent));
  });
});

describe('hashEvent', () => {
  it('matches sha256(prevHash + canonical(event))', () => {
    const expected = createHash('sha256')
      .update('')
      .update(canonicaliseEvent(baseEvent))
      .digest('hex');
    expect(hashEvent('', baseEvent)).toBe(expected);
  });

  it('is deterministic', () => {
    expect(hashEvent('abc', baseEvent)).toBe(hashEvent('abc', baseEvent));
  });

  it('changes when the previous hash changes', () => {
    expect(hashEvent('a', baseEvent)).not.toBe(hashEvent('b', baseEvent));
  });

  it.each([
    ['payload', { payload: { total: 43, currency: 'GBP' } }],
    ['actor', { actor: { kind: 'system' } }],
    ['type', { type: 'OrderCancelled' }],
    ['seq', { seq: 2 }],
    ['streamId', { streamId: 'order:2' }],
    ['id', { id: '01HZY00000000000000000000X' }],
    ['occurredAt', { occurredAt: '2026-01-02T00:00:00.000Z' }],
    ['source', { source: { form: 'checkout' } }],
  ])('changes when %s changes', (_field, patch) => {
    expect(hashEvent('', { ...baseEvent, ...patch })).not.toBe(hashEvent('', baseEvent));
  });
});

describe('chainHashes', () => {
  it('threads each hash into the next', () => {
    const second = { ...baseEvent, seq: 2, type: 'OrderPaid' };
    const [first, next] = chainHashes('', [baseEvent, second]);
    expect(first).toBe(hashEvent('', baseEvent));
    expect(next).toBe(hashEvent(first as string, second));
  });

  it('continues from an existing tail hash', () => {
    expect(chainHashes('tail', [baseEvent])[0]).toBe(hashEvent('tail', baseEvent));
  });
});

function stored(event: Omit<CanonicalisableEvent, 'source'>, hash: string): StoredEvent {
  return {
    ...event,
    streamType: 'order',
    globalPosition: event.seq,
    recordedAt: '2026-01-01T00:00:00.000Z',
    actor: { kind: 'system' },
    hash,
  };
}

describe('verifyChain', () => {
  const one = { ...baseEvent, actor: { kind: 'system' as const } };
  const two = { ...one, seq: 2, type: 'OrderPaid' };
  const three = { ...one, seq: 3, type: 'OrderShipped' };
  const hashes = chainHashes('', [one, two, three]);
  const chain = [one, two, three].map((event, i) => stored(event, hashes[i] as string));

  it('accepts an intact chain', () => {
    expect(verifyChain(chain)).toEqual({ valid: true });
  });

  it('accepts an empty stream', () => {
    expect(verifyChain([])).toEqual({ valid: true });
  });

  it('reports the first seq whose payload was altered', () => {
    const tampered = chain.map((event) =>
      event.seq === 2 ? { ...event, payload: { total: 999 } } : event,
    );
    expect(verifyChain(tampered)).toEqual({ valid: false, firstBadSeq: 2 });
  });

  it('reports the first seq whose stored hash was altered', () => {
    const tampered = chain.map((event) => (event.seq === 1 ? { ...event, hash: 'deadbeef' } : event));
    expect(verifyChain(tampered)).toEqual({ valid: false, firstBadSeq: 1 });
  });

  it('detects a removed event, because the chain no longer links', () => {
    expect(verifyChain(chain.filter((event) => event.seq !== 2))).toEqual({
      valid: false,
      firstBadSeq: 3,
    });
  });
});
