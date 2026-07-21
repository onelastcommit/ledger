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
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxDelayMs?: number;
  deadLetterPolicy?: DeadLetterPolicy;
  singleRunner?: boolean;
  onEvent: (event: StoredEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
  onDeadLetter?: (deadLetter: DeadLetter) => void;
}

export interface SubscriptionStatus {
  name: string;
  position: number;
  headPosition: number;
  lag: number;
  active: boolean;
  deadLettered: number;
}

export interface Subscription {
  readonly name: string;
  stop(): Promise<void>;
  caughtUp(): Promise<void>;
  position(): number;
  isActive(): boolean;
  status(): Promise<SubscriptionStatus>;
}
