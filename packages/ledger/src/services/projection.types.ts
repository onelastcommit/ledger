import type { ClientBase } from 'pg';
import type { StoredEvent } from '../types';

export interface ProjectionContext {
  readonly client: ClientBase;
}

export interface Projection {
  name: string;
  handles: readonly string[];
  apply(tx: ProjectionContext, event: StoredEvent): Promise<void> | void;
}
