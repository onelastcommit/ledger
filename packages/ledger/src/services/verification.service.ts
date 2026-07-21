import { verifyChain } from '../domain/hash';
import { StreamNotFoundError } from '../errors';
import type { EventRepository } from '../repositories/event.repository';
import type { Queryable } from '../repositories/repository.types';
import type { VerificationResult } from '../types';

export class VerificationService {
  private readonly events: EventRepository;

  constructor(events: EventRepository) {
    this.events = events;
  }

  async verifyStream(db: Queryable, streamId: string): Promise<VerificationResult> {
    const events = await this.events.findByStream(db, streamId);
    if (events.length === 0) throw new StreamNotFoundError(streamId);
    return verifyChain(events);
  }
}
