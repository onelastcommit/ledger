import type { Pool } from 'pg';
import type { EventRepository } from '../repositories/event.repository';
import type { SubscriptionRepository } from '../repositories/subscription.repository';
import type { ReadAllOptions, StoredEvent } from '../types';
import type { NotificationHub } from './notification-hub';
import type { StreamReaderService } from './stream-reader.service';
import type {
  Subscription,
  SubscriptionOptions,
  SubscriptionStatus,
} from './subscription.types';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 100;
const DEFAULT_RETRY_MAX_DELAY_MS = 30_000;

const ADVISORY_LOCK_NAMESPACE = 0x1ed6;

const hashName = (name: string): number => {
  let hash = 2_166_136_261;
  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash | 0;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

type HandleOutcome = 'handled' | 'dead-lettered' | 'aborted';

export interface SubscriptionServiceDeps {
  pool: Pool;
  reader: StreamReaderService;
  events: EventRepository;
  subscriptions: SubscriptionRepository;
  hub: NotificationHub;
}

class SubscriptionRunner implements Subscription {
  readonly name: string;

  private readonly pool: Pool;
  private readonly reader: StreamReaderService;
  private readonly events: EventRepository;
  private readonly repository: SubscriptionRepository;
  private readonly hub: NotificationHub;
  private readonly options: SubscriptionOptions;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly startPosition: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly singleRunner: boolean;
  private readonly lockKey: number;
  private readonly onError: (error: unknown) => void;

  private stopped = false;
  private active = false;
  private holdsLock = false;
  private cursor: number;
  private unsubscribeHub: (() => void) | undefined;
  private wake: () => void = () => undefined;
  private wakeSignal: Promise<void>;
  private markCaughtUp: () => void = () => undefined;
  private readonly caughtUpSignal: Promise<void>;
  private readonly runner: Promise<void>;

  constructor(deps: SubscriptionServiceDeps, options: SubscriptionOptions) {
    this.name = options.name;
    this.pool = deps.pool;
    this.reader = deps.reader;
    this.events = deps.events;
    this.repository = deps.subscriptions;
    this.hub = deps.hub;
    this.options = options;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startPosition = options.startPosition ?? 0;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.singleRunner = options.singleRunner ?? false;
    this.lockKey = hashName(options.name);
    this.cursor = this.startPosition;
    this.onError =
      options.onError ??
      ((error: unknown) => {
        console.error(`[ledger] subscription "${this.name}" failed:`, error);
      });

    this.wakeSignal = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    this.caughtUpSignal = new Promise<void>((resolve) => {
      this.markCaughtUp = resolve;
    });
    this.runner = this.loop();
  }

  position(): number {
    return this.cursor;
  }

  isActive(): boolean {
    return this.active;
  }

  caughtUp(): Promise<void> {
    return this.caughtUpSignal;
  }

  async status(): Promise<SubscriptionStatus> {
    const streamTypes = this.options.streamTypes ?? null;
    const [headPosition, lag, deadLettered] = await Promise.all([
      this.events.maxGlobalPosition(this.pool, streamTypes),
      this.events.countPending(this.pool, this.cursor, streamTypes),
      this.repository.countFailures(this.pool, this.name),
    ]);
    return {
      name: this.name,
      position: this.cursor,
      headPosition,
      lag,
      active: this.active,
      deadLettered,
    };
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private resetWakeSignal(): void {
    this.wakeSignal = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  private async idle(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.pollIntervalMs);
      timer.unref();
    });
    try {
      await Promise.race([timeout, this.wakeSignal]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.resetWakeSignal();
    }
  }

  private backoffFor(attempt: number): number {
    const exponential = this.retryBaseMs * 2 ** (attempt - 1);
    const capped = Math.min(exponential, this.retryMaxDelayMs);
    return Math.round(capped * (0.5 + Math.random() * 0.5));
  }

  private async acquireLock(): Promise<boolean> {
    if (!this.singleRunner) return true;
    const session = this.hub.session();
    if (session === undefined) return false;
    if (this.holdsLock) return true;
    this.holdsLock = await this.repository.tryAcquireLock(
      session,
      ADVISORY_LOCK_NAMESPACE,
      this.lockKey,
    );
    return this.holdsLock;
  }

  private async releaseLock(): Promise<void> {
    if (!this.holdsLock) return;
    const session = this.hub.session();
    this.holdsLock = false;
    if (session === undefined) return;
    await this.repository
      .releaseLock(session, ADVISORY_LOCK_NAMESPACE, this.lockKey)
      .catch(() => undefined);
  }

  private async deadLetter(event: StoredEvent, attempts: number, error: unknown): Promise<void> {
    await this.repository
      .recordFailure(this.pool, {
        subscriptionName: this.name,
        globalPosition: event.globalPosition,
        eventId: event.id,
        eventType: event.type,
        attempts,
        error: describeError(error),
      })
      .catch((recordError: unknown) => {
        this.onError(recordError);
      });
    this.options.onDeadLetter?.({ event, attempts, error });
  }

  private async handleWithRetry(event: StoredEvent): Promise<HandleOutcome> {
    for (let attempt = 1; ; attempt += 1) {
      if (this.isStopped()) return 'aborted';
      try {
        await this.options.onEvent(event);
        return 'handled';
      } catch (error) {
        this.onError(error);
        if (attempt > this.maxRetries) {
          await this.deadLetter(event, attempt, error);
          return 'dead-lettered';
        }
        await sleep(this.backoffFor(attempt));
      }
    }
  }

  private async pump(): Promise<boolean> {
    const readOptions: ReadAllOptions = {
      afterGlobalPosition: this.cursor,
      limit: this.batchSize,
    };
    if (this.options.streamTypes !== undefined) {
      readOptions.streamTypes = this.options.streamTypes;
    }

    const events: StoredEvent[] = await this.reader.readAll(this.pool, readOptions);
    if (events.length === 0) return false;

    let handledUpTo: number | undefined;
    for (const event of events) {
      const outcome = await this.handleWithRetry(event);
      if (outcome === 'aborted') break;
      if (outcome === 'dead-lettered' && this.options.deadLetterPolicy === 'stop') {
        if (handledUpTo !== undefined) await this.commit(handledUpTo);
        this.stopped = true;
        return false;
      }
      handledUpTo = event.globalPosition;
    }

    if (handledUpTo !== undefined) await this.commit(handledUpTo);
    return handledUpTo === events.at(-1)?.globalPosition && events.length === this.batchSize;
  }

  private async commit(position: number): Promise<void> {
    await this.repository.commitPosition(this.pool, this.name, position);
    this.cursor = position;
  }

  private async loop(): Promise<void> {
    this.unsubscribeHub = this.hub.subscribe(() => {
      this.wake();
    });

    try {
      await this.hub.ensureConnected();
      await this.repository.ensure(this.pool, this.name, this.startPosition);
      this.cursor = (await this.repository.findPosition(this.pool, this.name)) ?? this.startPosition;
    } catch (error) {
      this.onError(error);
    }

    while (!this.isStopped()) {
      try {
        if (await this.acquireLock()) {
          this.active = true;
          let batchWasFull = true;
          while (batchWasFull && !this.isStopped()) {
            batchWasFull = await this.pump();
          }
        } else {
          this.active = false;
        }
        this.markCaughtUp();
      } catch (error) {
        this.onError(error);
      }
      if (this.isStopped()) break;
      await this.idle();
    }

    this.active = false;
  }

  async stop(): Promise<void> {
    if (this.isStopped()) {
      await this.runner;
      return;
    }
    this.stopped = true;
    this.wake();
    await this.runner;
    await this.releaseLock();
    this.unsubscribeHub?.();
    this.unsubscribeHub = undefined;
  }
}

export class SubscriptionService {
  private readonly deps: SubscriptionServiceDeps;

  constructor(deps: SubscriptionServiceDeps) {
    this.deps = deps;
  }

  subscribe(options: SubscriptionOptions): Subscription {
    return new SubscriptionRunner(this.deps, options);
  }
}
