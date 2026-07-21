import type { ClientBase } from 'pg';
import { buildEntityRegistry } from './domain/fsm';
import type { Ledger, LedgerConfig, LedgerTransaction, ReadOptions } from './ledger.types';
import { loadMigrationSql, MIGRATION_NAMES } from './migration-loader';
import { EventRepository } from './repositories/event.repository';
import { MigrationRepository } from './repositories/migration.repository';
import { StreamRepository } from './repositories/stream.repository';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { AppendService } from './services/append.service';
import { MaintenanceService } from './services/maintenance.service';
import { MigrationService } from './services/migration.service';
import { NotificationHub } from './services/notification-hub';
import { ProjectionService } from './services/projection.service';
import { StreamReaderService } from './services/stream-reader.service';
import { SubscriptionService } from './services/subscription.service';
import { VerificationService } from './services/verification.service';
import type {
  AppendParams,
  IterateAllOptions,
  IterateStreamOptions,
  ReadAllOptions,
  ReadStreamOptions,
  StoredEvent,
} from './types';

export const DEFAULT_NOTIFY_CHANNEL = 'ledger_events';

export const createLedger = (config: LedgerConfig): Ledger => {
  const { pool } = config;
  const entities = buildEntityRegistry(config.entities ?? []);
  const notifyChannel = config.notifyChannel ?? DEFAULT_NOTIFY_CHANNEL;

  const eventRepository = new EventRepository();
  const streamRepository = new StreamRepository();
  const subscriptionRepository = new SubscriptionRepository();
  const migrationRepository = new MigrationRepository();

  const projections = new ProjectionService(config.projections ?? []);
  const reader = new StreamReaderService({
    events: eventRepository,
    streams: streamRepository,
  });
  const appender = new AppendService({
    events: eventRepository,
    streams: streamRepository,
    projections,
    entities,
    notifyChannel,
  });
  const verifier = new VerificationService(reader);
  const maintenance = new MaintenanceService({
    pool,
    events: eventRepository,
    streams: streamRepository,
    reader,
    entities,
  });
  const migrator = new MigrationService({
    pool,
    migrations: migrationRepository,
    names: MIGRATION_NAMES,
    loadSql: loadMigrationSql,
  });
  const hub = new NotificationHub({
    pool,
    channel: notifyChannel,
    onError: (error) => {
      console.error('[ledger] notification listener failed:', error);
    },
  });
  const subscriber = new SubscriptionService({
    pool,
    reader,
    events: eventRepository,
    subscriptions: subscriptionRepository,
    hub,
  });

  const append = (client: ClientBase, params: AppendParams): Promise<StoredEvent[]> =>
    appender.append(client, params);

  const withTransaction = async <T>(fn: (tx: LedgerTransaction) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        client,
        append: (params) => appender.append(client, params),
        readStream: (streamId) => reader.readStream(client, streamId),
        getState: (streamId) => reader.getState(client, streamId),
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };

  return {
    entities,
    append,
    withTransaction,
    migrate: () => migrator.migrate(),
    readStream: (streamId: string, options?: ReadStreamOptions & ReadOptions) =>
      reader.readStream(options?.client ?? pool, streamId, options ?? {}),
    readAll: (options?: ReadAllOptions) => reader.readAll(pool, options),
    iterateAll: (options?: IterateAllOptions) => reader.iterateAll(pool, options),
    iterateStream: (streamId: string, options?: IterateStreamOptions) =>
      reader.iterateStream(pool, streamId, options?.batchSize),
    getState: (streamId: string, options?: ReadOptions) =>
      reader.getState(options?.client ?? pool, streamId),
    verifyStream: (streamId: string) => verifier.verifyStream(pool, streamId),
    subscribe: (options) => subscriber.subscribe(options),
    rebuildStream: (streamId: string) => maintenance.rebuildStream(streamId),
    rebuildAllStreams: () => maintenance.rebuildAllStreams(),
    close: () => hub.close(),
  };
};
