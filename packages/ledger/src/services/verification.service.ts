import { hashEvent } from '../domain/hash';
import { StreamNotFoundError } from '../errors';
import type { Queryable } from '../repositories/repository.types';
import type { VerificationResult } from '../types';
import type { StreamReaderService } from './stream-reader.service';

const DEFAULT_BATCH_SIZE = 1000;

export class VerificationService {
  private readonly reader: StreamReaderService;
  private readonly batchSize: number;

  constructor(reader: StreamReaderService, batchSize = DEFAULT_BATCH_SIZE) {
    this.reader = reader;
    this.batchSize = batchSize;
  }

  async verifyStream(db: Queryable, streamId: string): Promise<VerificationResult> {
    let previous = '';
    let seen = 0;

    for await (const batch of this.reader.iterateStream(db, streamId, this.batchSize)) {
      for (const event of batch) {
        seen += 1;
        const expected = hashEvent(previous, event);
        if (expected !== event.hash) return { valid: false, firstBadSeq: event.seq };
        previous = expected;
      }
    }

    if (seen === 0) throw new StreamNotFoundError(streamId);
    return { valid: true };
  }
}
