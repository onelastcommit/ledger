import type { Queryable } from './repository.types';

export class MigrationRepository {
  async acquireLock(db: Queryable, key: number): Promise<void> {
    await db.query('SELECT pg_advisory_xact_lock($1)', [key]);
  }

  async ensureTable(db: Queryable): Promise<void> {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ledger_migrations (
        name       TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async findApplied(db: Queryable): Promise<Set<string>> {
    const result = await db.query<{ name: string }>('SELECT name FROM ledger_migrations');
    return new Set(result.rows.map((row) => row.name));
  }

  async apply(db: Queryable, name: string, sql: string): Promise<void> {
    await db.query(sql);
    await db.query('INSERT INTO ledger_migrations (name) VALUES ($1)', [name]);
  }
}
