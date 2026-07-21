export interface TransitionDefinition {
  from: readonly (string | null)[];
  to: string;
  terminal?: boolean;
}

export interface EntityDefinitionInput {
  streamType: string;
  initial: string;
  states: readonly string[];
  events: Readonly<Record<string, TransitionDefinition>>;
}

export interface EntityDefinition extends EntityDefinitionInput {
  readonly terminalStates: ReadonlySet<string>;
}
