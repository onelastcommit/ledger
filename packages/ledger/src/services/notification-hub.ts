import type { Notification, Pool, PoolClient } from 'pg';

const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 10_000;

const quoteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

export interface NotificationHubDeps {
  pool: Pool;
  channel: string;
  onError: (error: unknown) => void;
}

export class NotificationHub {
  private readonly pool: Pool;
  private readonly channel: string;
  private readonly onError: (error: unknown) => void;
  private readonly listeners = new Set<() => void>();

  private client: PoolClient | undefined;
  private connecting: Promise<void> | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;

  constructor(deps: NotificationHubDeps) {
    this.pool = deps.pool;
    this.channel = deps.channel;
    this.onError = deps.onError;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    void this.ensureConnected();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) void this.disconnect();
    };
  }

  async ensureConnected(): Promise<void> {
    if (this.closed || this.client !== undefined) return;
    this.connecting ??= this.connect().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.on('notification', (message: Notification) => {
        if (message.channel !== this.channel) return;
        for (const listener of this.listeners) listener();
      });
      client.on('error', (error) => {
        this.onError(error);
        this.handleDrop();
      });
      await client.query(`LISTEN ${quoteIdentifier(this.channel)}`);
      this.client = client;
      this.reconnectAttempts = 0;
    } catch (error) {
      this.onError(error);
      this.handleDrop();
    }
  }

  private handleDrop(): void {
    const dropped = this.client;
    this.client = undefined;
    if (dropped !== undefined) {
      dropped.removeAllListeners();
      dropped.release(true);
    }
    if (this.closed || this.listeners.size === 0) return;

    for (const listener of this.listeners) listener();

    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      void this.ensureConnected();
    }, delay);
    this.reconnectTimer.unref();
  }

  session(): PoolClient | undefined {
    return this.client;
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const client = this.client;
    this.client = undefined;
    if (client === undefined) return;
    client.removeAllListeners('notification');
    await client.query(`UNLISTEN ${quoteIdentifier(this.channel)}`).catch(() => undefined);
    client.release();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listeners.clear();
    await this.disconnect();
  }
}
