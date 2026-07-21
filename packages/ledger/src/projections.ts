import type { ClientBase } from 'pg';
import { ProjectionFailedError } from './errors.js';
import type { StoredEvent } from './types.js';

export interface ProjectionContext {
  readonly client: ClientBase;
}

export const ALL_EVENTS = '*';

export interface Projection {
  name: string;
  handles: readonly string[];
  apply(tx: ProjectionContext, event: StoredEvent): Promise<void> | void;
}

function handlesEvent(projection: Projection, eventType: string): boolean {
  return projection.handles.includes(ALL_EVENTS) || projection.handles.includes(eventType);
}

export async function runProjections(
  projections: readonly Projection[],
  context: ProjectionContext,
  events: readonly StoredEvent[],
): Promise<void> {
  if (projections.length === 0) return;
  for (const event of events) {
    for (const projection of projections) {
      if (!handlesEvent(projection, event.type)) continue;
      try {
        await projection.apply(context, event);
      } catch (cause) {
        throw new ProjectionFailedError(projection.name, event.type, cause);
      }
    }
  }
}
