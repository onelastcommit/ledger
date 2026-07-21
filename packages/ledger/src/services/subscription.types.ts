import type { StoredEvent } from '../types';

export interface SubscriptionOptions {
  name: string;
  streamTypes?: string[];
  batchSize?: number;
  pollIntervalMs?: number;
  startPosition?: number;
  onEvent: (event: StoredEvent) => Promise<void> | void;
  onError?: (error: unknown) => void;
}

export interface Subscription {
  readonly name: string;
  stop(): Promise<void>;
  caughtUp(): Promise<void>;
  position(): number;
}
