import type { Pool } from 'pg';
import type { MigrationRepository } from '../repositories/migration.repository';

const MIGRATION_LOCK_KEY = 8_675_309_123;

export interface MigrationServiceDeps {
  pool: Pool;
  migrations: MigrationRepository;
  names: readonly string[];
  loadSql: (name: string) => Promise<string>;
}

export class MigrationService {
  private readonly pool: Pool;
  private readonly migrations: MigrationRepository;
  private readonly names: readonly string[];
  private readonly loadSql: (name: string) => Promise<string>;

  constructor(deps: MigrationServiceDeps) {
    this.pool = deps.pool;
    this.migrations = deps.migrations;
    this.names = deps.names;
    this.loadSql = deps.loadSql;
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.migrations.acquireLock(client, MIGRATION_LOCK_KEY);
      await this.migrations.ensureTable(client);
      const applied = await this.migrations.findApplied(client);

      for (const name of this.names) {
        if (applied.has(name)) continue;
        await this.migrations.apply(client, name, await this.loadSql(name));
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
