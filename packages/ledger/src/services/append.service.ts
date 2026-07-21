import type { ClientBase } from 'pg';
import { applyEvent } from '../domain/fsm';
import type { EntityDefinition } from '../domain/fsm.types';
import { hashEvent } from '../domain/hash';
import { ulid } from '../domain/ulid';
import { LedgerError, VersionConflictError } from '../errors';
import type { EventRepository } from '../repositories/event.repository';
import type { InsertableEvent } from '../repositories/repository.types';
import type { StreamRepository } from '../repositories/stream.repository';
import type { AppendParams, StoredEvent } from '../types';
import type { ProjectionService } from './projection.service';

const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: unknown }).code === UNIQUE_VIOLATION;

const normaliseTimestamp = (value: string | undefined, fallback: Date): string => {
  if (value === undefined) return fallback.toISOString();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new LedgerError(`occurredAt is not a valid ISO 8601 timestamp: "${value}"`);
  }
  return parsed.toISOString();
};

export interface AppendServiceDeps {
  events: EventRepository;
  streams: StreamRepository;
  projections: ProjectionService;
  entities: ReadonlyMap<string, EntityDefinition>;
  notifyChannel: string;
}

export class AppendService {
  private readonly events: EventRepository;
  private readonly streams: StreamRepository;
  private readonly projections: ProjectionService;
  private readonly entities: ReadonlyMap<string, EntityDefinition>;
  private readonly notifyChannel: string;

  constructor(deps: AppendServiceDeps) {
    this.events = deps.events;
    this.streams = deps.streams;
    this.projections = deps.projections;
    this.entities = deps.entities;
    this.notifyChannel = deps.notifyChannel;
  }

  async append(client: ClientBase, params: AppendParams): Promise<StoredEvent[]> {
    const { streamId, streamType, expectedSeq, events } = params;

    if (events.length === 0) {
      throw new LedgerError('append requires at least one event.');
    }
    if (!Number.isInteger(expectedSeq) || expectedSeq < 0) {
      throw new LedgerError(`expectedSeq must be a non-negative integer, got ${expectedSeq}.`);
    }

    const head = await this.streams.findHead(client, streamId);

    if (head !== undefined && head.streamType !== streamType) {
      throw new LedgerError(
        `Stream "${streamId}" already exists with stream type "${head.streamType}"; refusing to append "${streamType}" events to it.`,
      );
    }

    const lastSeq = head?.lastSeq ?? 0;
    if (lastSeq !== expectedSeq) {
      throw new VersionConflictError(streamId, expectedSeq, lastSeq);
    }

    const definition = this.entities.get(streamType);
    const now = new Date();

    let state: string | null = head?.state ?? null;
    let previousHash = head?.lastHash ?? '';
    let seq = lastSeq;

    const prepared: StoredEvent[] = [];
    const insertable: InsertableEvent[] = [];

    for (const input of events) {
      seq += 1;
      if (definition !== undefined) {
        state = applyEvent(definition, state, input.type, streamId);
      }

      const id = ulid();
      const occurredAt = normaliseTimestamp(input.occurredAt, now);
      const hash = hashEvent(previousHash, {
        id,
        streamId,
        seq,
        type: input.type,
        payload: input.payload,
        actor: input.actor,
        source: input.source,
        occurredAt,
      });
      previousHash = hash;

      const event: StoredEvent = {
        id,
        streamId,
        streamType,
        seq,
        globalPosition: 0,
        type: input.type,
        payload: input.payload,
        actor: input.actor,
        occurredAt,
        recordedAt: now.toISOString(),
        hash,
      };
      if (input.source !== undefined) event.source = input.source;
      if (input.payloadVersion !== undefined) event.payloadVersion = input.payloadVersion;

      prepared.push(event);
      insertable.push({
        id,
        streamId,
        streamType,
        seq,
        type: input.type,
        payload: input.payload,
        actor: input.actor,
        source: input.source,
        payloadVersion: input.payloadVersion,
        occurredAt,
        hash,
      });
    }

    let inserted;
    try {
      inserted = await this.events.insert(client, insertable);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new VersionConflictError(streamId, expectedSeq, null);
      }
      throw error;
    }

    const assigned = new Map(inserted.map((row) => [row.seq, row] as const));
    for (const event of prepared) {
      const row = assigned.get(event.seq);
      if (row === undefined) continue;
      event.globalPosition = row.globalPosition;
      event.recordedAt = row.recordedAt;
    }

    const updated = await this.streams.upsertHead(client, {
      streamId,
      streamType,
      lastSeq: seq,
      state,
      lastHash: previousHash,
      expectedSeq,
    });
    if (!updated) {
      throw new VersionConflictError(streamId, expectedSeq, null);
    }

    await this.projections.run({ client }, prepared);

    await this.events.notify(
      client,
      this.notifyChannel,
      JSON.stringify({
        streamId,
        streamType,
        lastPosition: prepared.at(-1)?.globalPosition ?? 0,
      }),
    );

    return prepared;
  }
}
