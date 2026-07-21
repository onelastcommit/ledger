import type { Notification, Pool, PoolClient } from 'pg';
import type { ReadAllOptions, StoredEvent } from './types.js';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 1000;

export interface SubscriptionOptions {
  name: string;
  streamTypes?: string[];
  batchSize?: number;
  pollIntervalMs?: number;
  startPosition?: number;
  onEvent(event: StoredEvent): Promise<void> | void;
  onError?(error: unknown): void;
}

export interface Subscription {
  readonly name: string;
  stop(): Promise<void>;
  caughtUp(): Promise<void>;
  position(): number;
}

export interface SubscriptionDeps {
  pool: Pool;
  notifyChannel: string;
  readAll(options: ReadAllOptions): Promise<StoredEvent[]>;
}

export function startSubscription(
  deps: SubscriptionDeps,
  options: SubscriptionOptions,
): Subscription {
  const {
    name,
    onEvent,
    streamTypes,
    batchSize = DEFAULT_BATCH_SIZE,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    startPosition = 0,
  } = options;
  const onError =
    options.onError ??
    ((error: unknown) => {
      console.error(`[ledger] subscription "${name}" failed:`, error);
    });

  let stopped = false;
  let position = startPosition;
  let listenClient: PoolClient | undefined;

  let wake: () => void = () => undefined;
  let wakeSignal = new Promise<void>((resolve) => {
    wake = resolve;
  });

  function resetWakeSignal(): void {
    wakeSignal = new Promise<void>((resolve) => {
      wake = resolve;
    });
  }

  let markCaughtUp: () => void = () => undefined;
  const caughtUpSignal = new Promise<void>((resolve) => {
    markCaughtUp = resolve;
  });

  async function idle(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, pollIntervalMs);
      timer.unref?.();
    });
    try {
      await Promise.race([timeout, wakeSignal]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      resetWakeSignal();
    }
  }

  async function loadPosition(): Promise<number> {
    await deps.pool.query(
      'INSERT INTO ledger_subscriptions (name, position) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, startPosition],
    );
    const result = await deps.pool.query<{ position: string }>(
      'SELECT position FROM ledger_subscriptions WHERE name = $1',
      [name],
    );
    return Number(result.rows[0]?.position ?? startPosition);
  }

  async function commitPosition(next: number): Promise<void> {
    await deps.pool.query(
      'UPDATE ledger_subscriptions SET position = GREATEST(position, $2), updated_at = now() WHERE name = $1',
      [name, next],
    );
    position = next;
  }

  async function startListening(): Promise<void> {
    const client = await deps.pool.connect();
    listenClient = client;
    client.on('notification', (message: Notification) => {
      if (message.channel === deps.notifyChannel) wake();
    });
    client.on('error', (error) => {
      onError(error);
    });
    await client.query(`LISTEN ${quoteIdentifier(deps.notifyChannel)}`);
  }

  async function pump(): Promise<boolean> {
    const readOptions: ReadAllOptions = { afterGlobalPosition: position, limit: batchSize };
    if (streamTypes !== undefined) readOptions.streamTypes = streamTypes;

    const events = await deps.readAll(readOptions);
    if (events.length === 0) return false;

    for (const event of events) {
      if (stopped) return false;
      await onEvent(event);
    }

    const last = events.at(-1);
    if (last !== undefined) await commitPosition(last.globalPosition);
    return events.length === batchSize;
  }

  const runner = (async () => {
    try {
      await startListening();
      position = await loadPosition();
    } catch (error) {
      onError(error);
    }

    while (!stopped) {
      try {
        let batchWasFull = true;
        while (batchWasFull && !stopped) {
          batchWasFull = await pump();
        }
        markCaughtUp();
      } catch (error) {
        onError(error);
      }
      if (stopped) break;
      await idle();
    }
  })();

  return {
    name,
    position: () => position,
    caughtUp: () => caughtUpSignal,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      wake();
      await runner;
      if (listenClient !== undefined) {
        const client = listenClient;
        listenClient = undefined;
        client.removeAllListeners('notification');
        await client.query(`UNLISTEN ${quoteIdentifier(deps.notifyChannel)}`).catch(() => undefined);
        client.release();
      }
    },
  };
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
