import { describe, expect, expectTypeOf, it } from 'vitest';
import { defineEntity, payloadOf } from '../../src/domain/fsm';
import type { EventPayloads } from '../../src/domain/fsm.types';
import type { TypedEvent } from '../../src/entity.types';

const order = defineEntity({
  streamType: 'order',
  initial: 'placed',
  states: ['placed', 'paid', 'shipped', 'cancelled'],
  events: {
    OrderPlaced: {
      from: [null],
      to: 'placed',
      payload: payloadOf<{ total: number; currency: string }>(),
    },
    OrderPaid: {
      from: ['placed'],
      to: 'paid',
      payload: payloadOf<{ method: 'card' | 'cash' }>(),
    },
    OrderShipped: {
      from: ['paid'],
      to: 'shipped',
      terminal: true,
      payload: payloadOf<{ carrier: string }>(),
    },
    OrderCancelled: { from: ['placed', 'paid'], to: 'cancelled', terminal: true },
  },
});

type Payloads = NonNullable<(typeof order)['__payloads']>;
type OrderEvent = TypedEvent<Payloads>;

describe('typed entity payloads', () => {
  it('behaves identically at runtime', () => {
    expect(order.streamType).toBe('order');
    expect([...order.terminalStates].sort()).toEqual(['cancelled', 'shipped']);
    expect(order.events['OrderPlaced']?.to).toBe('placed');
  });

  it('erases the payload marker at runtime', () => {
    expect(order.events['OrderPlaced']?.payload).toBeUndefined();
    expect(JSON.parse(JSON.stringify(order.events['OrderPlaced']))).toEqual({
      from: [null],
      to: 'placed',
    });
  });

  it('infers a payload type per event', () => {
    expectTypeOf<Payloads['OrderPlaced']>().toEqualTypeOf<{ total: number; currency: string }>();
    expectTypeOf<Payloads['OrderPaid']>().toEqualTypeOf<{ method: 'card' | 'cash' }>();
    expectTypeOf<Payloads['OrderShipped']>().toEqualTypeOf<{ carrier: string }>();
  });

  it('leaves events without a declared payload as unknown', () => {
    expectTypeOf<Payloads['OrderCancelled']>().toEqualTypeOf<unknown>();
  });

  it('restricts event names to those the entity declares', () => {
    expectTypeOf<OrderEvent['type']>().toEqualTypeOf<
      'OrderPlaced' | 'OrderPaid' | 'OrderShipped' | 'OrderCancelled'
    >();
  });

  it('accepts a correctly shaped event', () => {
    const event: OrderEvent = {
      type: 'OrderPlaced',
      payload: { total: 4999, currency: 'GBP' },
      actor: { kind: 'system' },
    };
    expect(event.payload).toEqual({ total: 4999, currency: 'GBP' });
  });

  it('rejects a payload missing a required field', () => {
    // @ts-expect-error currency is required on OrderPlaced
    const payload: Payloads['OrderPlaced'] = { total: 4999 };
    expect(payload.total).toBe(4999);
  });

  it('rejects a payload with the wrong field type', () => {
    // @ts-expect-error total must be a number
    const payload: Payloads['OrderPlaced'] = { total: 'lots', currency: 'GBP' };
    expect(payload.currency).toBe('GBP');
  });

  it('rejects a payload belonging to a different event', () => {
    // @ts-expect-error OrderPaid does not take a carrier
    const payload: Payloads['OrderPaid'] = { carrier: 'royal-mail' };
    expect(payload).toBeDefined();
  });

  it('narrows a literal union payload', () => {
    // @ts-expect-error method must be 'card' or 'cash'
    const payload: Payloads['OrderPaid'] = { method: 'bitcoin' };
    expect(payload.method).toBe('bitcoin');
  });

  it('rejects an event type the entity does not declare', () => {
    // @ts-expect-error OrderTeleported is not an event of this entity
    const type: OrderEvent['type'] = 'OrderTeleported';
    expect(type).toBe('OrderTeleported');
  });

  it('still types entities declared without any payload markers', () => {
    const audit = defineEntity({
      streamType: 'audit',
      initial: 'open',
      states: ['open'],
      events: { Opened: { from: [null], to: 'open' } },
    });
    type AuditPayloads = EventPayloads<(typeof audit)['events']>;
    expectTypeOf<AuditPayloads['Opened']>().toEqualTypeOf<unknown>();
    expect(audit.streamType).toBe('audit');
  });
});
