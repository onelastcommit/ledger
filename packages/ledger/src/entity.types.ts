import type { ClientBase } from 'pg';
import type { EntityDefinition } from './domain/fsm.types';
import type { LedgerTransaction } from './ledger.types';
import type {
  Actor,
  ReadStreamOptions,
  SourceRef,
  StoredEvent,
  StreamState,
  VerificationResult,
} from './types';

export interface TypedEventInput<Payloads, K extends keyof Payloads> {
  type: K;
  payload: Payloads[K];
  actor: Actor;
  source?: SourceRef;
  occurredAt?: string;
  payloadVersion?: number;
}

export type TypedEvent<Payloads> = {
  [K in keyof Payloads]: TypedEventInput<Payloads, K>;
}[keyof Payloads];

export interface TypedAppendParams<Payloads> {
  streamId: string;
  expectedSeq: number;
  events: Array<TypedEvent<Payloads>>;
}

export type AppendTarget = LedgerTransaction | ClientBase;

export type StoredEventOf<Payloads> = {
  [K in keyof Payloads]: Omit<StoredEvent<Payloads[K]>, 'type'> & { type: K };
}[keyof Payloads];

export type PayloadsOf<D> = D extends { readonly definition: { readonly __payloads?: infer P } }
  ? NonNullable<P>
  : D extends { readonly __payloads?: infer P }
    ? NonNullable<P>
    : never;

export type EventTypeOf<D> = keyof PayloadsOf<D> & string;

export type PayloadOf<D, K extends EventTypeOf<D>> = PayloadsOf<D>[K];

export type EventsOf<D> = TypedEvent<PayloadsOf<D>>;

export interface EntityLedger<Payloads> {
  readonly definition: EntityDefinition<Payloads>;
  readonly streamType: string;
  append(target: AppendTarget, params: TypedAppendParams<Payloads>): Promise<StoredEvent[]>;
  readStream(
    streamId: string,
    options?: ReadStreamOptions,
  ): Promise<Array<StoredEventOf<Payloads>>>;
  getState(streamId: string): Promise<StreamState>;
  verifyStream(streamId: string): Promise<VerificationResult>;
}
