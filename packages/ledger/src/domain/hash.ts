import { createHash } from 'node:crypto';
import type { StoredEvent, VerificationResult } from '../types';
import type { CanonicalisableEvent } from './hash.types';

const canonicaliseValue = (value: unknown): string | undefined => {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'undefined':
      return undefined;
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Cannot canonicalise non-finite number: ${String(value)}`);
      }
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      throw new TypeError('Cannot canonicalise a bigint; convert it to a string or number first.');
    case 'function':
    case 'symbol':
      throw new TypeError(`Cannot canonicalise a ${typeof value}.`);
    case 'object':
      break;
  }

  const object = value as { toJSON?: (key?: string) => unknown };
  if (typeof object.toJSON === 'function') return canonicaliseValue(object.toJSON());

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicaliseValue(item) ?? 'null').join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const encoded = canonicaliseValue(record[key]);
    if (encoded === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${encoded}`);
  }
  return `{${parts.join(',')}}`;
};

export const canonicalise = (value: unknown): string => canonicaliseValue(value) ?? 'null';

export const canonicaliseEvent = (event: CanonicalisableEvent): string => {
  const fields: Record<string, unknown> = {
    id: event.id,
    streamId: event.streamId,
    seq: event.seq,
    type: event.type,
    payload: event.payload,
    actor: event.actor,
    occurredAt: event.occurredAt,
  };
  if (event.source !== undefined && event.source !== null) fields['source'] = event.source;
  return canonicalise(fields);
};

export const hashEvent = (prevHash: string, event: CanonicalisableEvent): string =>
  createHash('sha256').update(prevHash).update(canonicaliseEvent(event)).digest('hex');

export const chainHashes = (prevHash: string, events: CanonicalisableEvent[]): string[] => {
  const hashes: string[] = [];
  let previous = prevHash;
  for (const event of events) {
    previous = hashEvent(previous, event);
    hashes.push(previous);
  }
  return hashes;
};

export const verifyChain = (events: StoredEvent[]): VerificationResult => {
  let previous = '';
  for (const event of events) {
    const expected = hashEvent(previous, event);
    if (expected !== event.hash) return { valid: false, firstBadSeq: event.seq };
    previous = expected;
  }
  return { valid: true };
};
