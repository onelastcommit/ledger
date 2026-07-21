import type { Notification, Pool, PoolClient } from 'pg';
import type { SubscriptionRepository } from '../repositories/subscription.repository';
import type { ReadAllOptions, StoredEvent } from '../types';
import type { StreamReaderService } from './stream-reader.service';
import type { Subscription, SubscriptionOptions } from './subscription.types';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;

const quoteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export interface SubscriptionServiceDeps {
  pool: Pool;
  reader: StreamReaderService;
  subscriptions: SubscriptionRepository;
  notifyChannel: string;
}

class SubscriptionRunner implements Subscription {
  readonly name: string;

  private readonly pool: Pool;
  private readonly reader: StreamReaderService;
  private readonly repository: SubscriptionRepository;
  private readonly notifyChannel: string;
  private readonly options: SubscriptionOptions;
  private readonly batchSize: number;
  private readonly pollIntervalMs: number;
  private readonly startPosition: number;
  private readonly onError: (error: unknown) => void;

  private stopped = false;
  private cursor: number;
  private listenClient: PoolClient | undefined;
  private wake: () => void = () => undefined;
  private wakeSignal: Promise<void>;
  private markCaughtUp: () => void = () => undefined;
  private readonly caughtUpSignal: Promise<void>;
  private readonly runner: Promise<void>;

  constructor(deps: SubscriptionServiceDeps, options: SubscriptionOptions) {
    this.name = options.name;
    this.pool = deps.pool;
    this.reader = deps.reader;
    this.repository = deps.subscriptions;
    this.notifyChannel = deps.notifyChannel;
    this.options = options;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.startPosition = options.startPosition ?? 0;
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

  private isStopped(): boolean {
    return this.stopped;
  }

  caughtUp(): Promise<void> {
    return this.caughtUpSignal;
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

  private async startListening(): Promise<void> {
    const client = await this.pool.connect();
    this.listenClient = client;
    client.on('notification', (message: Notification) => {
      if (message.channel === this.notifyChannel) this.wake();
    });
    client.on('error', (error) => {
      this.onError(error);
    });
    await client.query(`LISTEN ${quoteIdentifier(this.notifyChannel)}`);
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

    for (const event of events) {
      if (this.isStopped()) return false;
      await this.options.onEvent(event);
    }

    const last = events.at(-1);
    if (last !== undefined) {
      await this.repository.commitPosition(this.pool, this.name, last.globalPosition);
      this.cursor = last.globalPosition;
    }
    return events.length === this.batchSize;
  }

  private async loop(): Promise<void> {
    try {
      await this.startListening();
      await this.repository.ensure(this.pool, this.name, this.startPosition);
      this.cursor = (await this.repository.findPosition(this.pool, this.name)) ?? this.startPosition;
    } catch (error) {
      this.onError(error);
    }

    while (!this.isStopped()) {
      try {
        let batchWasFull = true;
        while (batchWasFull && !this.isStopped()) {
          batchWasFull = await this.pump();
        }
        this.markCaughtUp();
      } catch (error) {
        this.onError(error);
      }
      if (this.isStopped()) break;
      await this.idle();
    }
  }

  async stop(): Promise<void> {
    if (this.isStopped()) return;
    this.stopped = true;
    this.wake();
    await this.runner;
    if (this.listenClient !== undefined) {
      const client = this.listenClient;
      this.listenClient = undefined;
      client.removeAllListeners('notification');
      await client
        .query(`UNLISTEN ${quoteIdentifier(this.notifyChannel)}`)
        .catch(() => undefined);
      client.release();
    }
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
