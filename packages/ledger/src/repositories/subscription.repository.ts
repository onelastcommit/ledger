import type { DeadLetterRecord, Queryable } from './repository.types';

export class SubscriptionRepository {
  async ensure(db: Queryable, name: string, startPosition: number): Promise<void> {
    await db.query(
      'INSERT INTO ledger_subscriptions (name, position) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING',
      [name, startPosition],
    );
  }

  async findPosition(db: Queryable, name: string): Promise<number | undefined> {
    const result = await db.query<{ position: string }>(
      'SELECT position FROM ledger_subscriptions WHERE name = $1',
      [name],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : Number(row.position);
  }

  async commitPosition(db: Queryable, name: string, position: number): Promise<void> {
    await db.query(
      'UPDATE ledger_subscriptions SET position = GREATEST(position, $2), updated_at = now() WHERE name = $1',
      [name, position],
    );
  }

  async recordFailure(db: Queryable, record: DeadLetterRecord): Promise<void> {
    await db.query(
      `INSERT INTO ledger_subscription_failures
         (subscription_name, global_position, event_id, event_type, attempts, error)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subscription_name, global_position) DO UPDATE
         SET attempts  = EXCLUDED.attempts,
             error     = EXCLUDED.error,
             failed_at = now()`,
      [
        record.subscriptionName,
        record.globalPosition,
        record.eventId,
        record.eventType,
        record.attempts,
        record.error,
      ],
    );
  }

  async tryAcquireLock(db: Queryable, namespace: number, key: number): Promise<boolean> {
    const result = await db.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::int, $2::int) AS locked',
      [namespace, key],
    );
    return result.rows[0]?.locked ?? false;
  }

  async releaseLock(db: Queryable, namespace: number, key: number): Promise<void> {
    await db.query('SELECT pg_advisory_unlock($1::int, $2::int)', [namespace, key]);
  }
}
