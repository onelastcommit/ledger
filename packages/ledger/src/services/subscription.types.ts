import type { StoredEvent } from '../types';

export type DeadLetterPolicy = 'skip' | 'stop';

export interface DeadLetter {
  event: StoredEvent;
  attempts: number;
  error: unknown;
}

export interface SubscriptionOptions {
  name: string;
  streamTypes?: string[];
  batchSize?: number;
  pollIntervalMs?: number;
  startPosition?: number;
  /** Handler attempts before an event is dead-lettered. Defaults to 5. */
  maxRetries?: number;
  /** First retry delay; doubles with jitter up to retryMaxDelayMs. Defaults to 100. */
  retryBaseMs?: number;
  /** Ceiling for the retry backoff. Defaults to 30000. */
  retryMaxDelayMs?: number;
  /**
   * What to do once retries are exhausted. 'skip' records the failure and moves
   * on (the default); 'stop' halts the subscription at the offending event.
   */
  deadLetterPolicy?: DeadLetterPolicy;
  /**
   * Hold a Postgres advisory lock so only one runner per name is active.
   * Off by default: duplicates are already expected under at-least-once
   * delivery, and this trades liveness for exclusivity. Turn it on when
   * running several instances and the handler is expensive rather than merely
   * idempotent.
   */
  singleRunner?: boolean;
  onEvent: (event: StoredEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
  onDeadLetter?: (deadLetter: DeadLetter) => void;
}

export interface Subscription {
  readonly name: string;
  stop(): Promise<void>;
  caughtUp(): Promise<void>;
  position(): number;
  /** False while a singleRunner subscription is waiting to acquire its lock. */
  isActive(): boolean;
}
