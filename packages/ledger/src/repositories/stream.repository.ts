import type { StreamState } from '../types';
import type { Queryable, StreamHead } from './repository.types';

export class StreamRepository {
  async findHead(db: Queryable, streamId: string): Promise<StreamHead | undefined> {
    const result = await db.query<{
      stream_type: string;
      last_seq: number;
      state: string | null;
      last_hash: string;
    }>('SELECT stream_type, last_seq, state, last_hash FROM ledger_streams WHERE stream_id = $1', [
      streamId,
    ]);

    const row = result.rows[0];
    if (row === undefined) return undefined;
    return {
      streamType: row.stream_type,
      lastSeq: row.last_seq,
      state: row.state,
      lastHash: row.last_hash,
    };
  }

  async findState(db: Queryable, streamId: string): Promise<StreamState | undefined> {
    const result = await db.query<{ state: string | null; last_seq: number }>(
      'SELECT state, last_seq FROM ledger_streams WHERE stream_id = $1',
      [streamId],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { state: row.state, seq: row.last_seq };
  }

  async upsertHead(
    db: Queryable,
    head: {
      streamId: string;
      streamType: string;
      lastSeq: number;
      state: string | null;
      lastHash: string;
      expectedSeq: number;
    },
  ): Promise<boolean> {
    const result = await db.query(
      `INSERT INTO ledger_streams (stream_id, stream_type, last_seq, state, last_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (stream_id) DO UPDATE
         SET last_seq   = EXCLUDED.last_seq,
             state      = EXCLUDED.state,
             last_hash  = EXCLUDED.last_hash,
             updated_at = now()
         WHERE ledger_streams.last_seq = $6`,
      [head.streamId, head.streamType, head.lastSeq, head.state, head.lastHash, head.expectedSeq],
    );
    return result.rowCount !== 0;
  }
}
