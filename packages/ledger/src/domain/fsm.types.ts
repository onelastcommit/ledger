declare const PAYLOAD_BRAND: unique symbol;

export interface PayloadMarker<P> {
  readonly [PAYLOAD_BRAND]: P;
}

export interface TransitionDefinition<P = unknown> {
  from: readonly (string | null)[];
  to: string;
  terminal?: boolean;
  payload?: PayloadMarker<P>;
}

export interface EntityDefinitionInput {
  streamType: string;
  initial: string;
  states: readonly string[];
  events: Readonly<Record<string, TransitionDefinition<unknown>>>;
}

export type EventPayloads<E> = {
  [K in keyof E]: E[K] extends TransitionDefinition<infer P> ? P : unknown;
};

export interface EntityDefinition<Payloads = Record<string, unknown>> {
  streamType: string;
  initial: string;
  states: readonly string[];
  events: Readonly<Record<string, TransitionDefinition<unknown>>>;
  readonly terminalStates: ReadonlySet<string>;
  readonly __payloads?: Payloads;
}

export type AnyEntityDefinition = EntityDefinition<Record<string, unknown>>;
