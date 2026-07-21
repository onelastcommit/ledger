export interface CanonicalisableEvent {
  id: string;
  streamId: string;
  seq: number;
  type: string;
  payload: unknown;
  actor: unknown;
  source?: unknown;
  occurredAt: string;
}
