import { ProjectionFailedError } from '../errors';
import type { StoredEvent } from '../types';
import type { Projection, ProjectionContext } from './projection.types';

export const ALL_EVENTS = '*';

export class ProjectionService {
  private readonly projections: readonly Projection[];

  constructor(projections: readonly Projection[]) {
    this.projections = projections;
  }

  private handles(projection: Projection, eventType: string): boolean {
    return projection.handles.includes(ALL_EVENTS) || projection.handles.includes(eventType);
  }

  async run(context: ProjectionContext, events: readonly StoredEvent[]): Promise<void> {
    if (this.projections.length === 0) return;
    for (const event of events) {
      for (const projection of this.projections) {
        if (!this.handles(projection, event.type)) continue;
        try {
          await projection.apply(context, event);
        } catch (cause) {
          throw new ProjectionFailedError(projection.name, event.type, cause);
        }
      }
    }
  }
}
