import {
  VersionConflictError,
  type Actor,
  type EventInput,
  type StoredEvent,
} from '@1percentlabs/ledger';
import { ledger } from './ledger.ts';

const MAX_ATTEMPTS = 3;

const emit = async (
  streamId: string,
  build: (currentState: string | null) => EventInput,
): Promise<StoredEvent[]> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ledger.withTransaction(async (tx) => {
        const head = await tx
          .getState(streamId)
          .catch(() => ({ state: null as string | null, seq: 0 }));
        return tx.append({
          streamId,
          streamType: 'order',
          expectedSeq: head.seq,
          events: [build(head.state)],
        });
      });
    } catch (error) {
      if (error instanceof VersionConflictError && attempt < MAX_ATTEMPTS) continue;
      throw error;
    }
  }
  throw new Error('unreachable');
};

export const placeOrder = async (
  orderId: string,
  total: number,
  actor: Actor,
): Promise<StoredEvent[]> =>
  emit(orderId, () => ({
    type: 'OrderPlaced',
    payload: { total, currency: 'GBP' },
    actor,
    source: { channel: 'web-checkout' },
  }));

export const payOrder = async (orderId: string, actor: Actor): Promise<StoredEvent[]> =>
  emit(orderId, () => ({ type: 'OrderPaid', payload: { method: 'card' }, actor }));

export const shipOrder = async (orderId: string, actor: Actor): Promise<StoredEvent[]> =>
  emit(orderId, () => ({ type: 'OrderShipped', payload: { carrier: 'royal-mail' }, actor }));
