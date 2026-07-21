import { VersionConflictError, type Actor, type StoredEvent } from '@1percentlabs/ledger';
import { ledger, orders, type OrderEvent } from './ledger.ts';

const MAX_ATTEMPTS = 3;

const emit = async (streamId: string, event: OrderEvent): Promise<StoredEvent[]> => {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ledger.withTransaction(async (tx) => {
        const head = await tx.getState(streamId).catch(() => ({ seq: 0 }));
        return orders.append(tx, { streamId, expectedSeq: head.seq, events: [event] });
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
  emit(orderId, {
    type: 'OrderPlaced',
    payload: { total, currency: 'GBP' },
    actor,
    source: { channel: 'web-checkout' },
  });

export const payOrder = async (orderId: string, actor: Actor): Promise<StoredEvent[]> =>
  emit(orderId, { type: 'OrderPaid', payload: { method: 'card' }, actor });

export const shipOrder = async (orderId: string, actor: Actor): Promise<StoredEvent[]> =>
  emit(orderId, { type: 'OrderShipped', payload: { carrier: 'royal-mail' }, actor });
