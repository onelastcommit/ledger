import {
  InvalidEntityDefinitionError,
  InvalidTransitionError,
  UnknownEventTypeError,
} from '../errors';
import type {
  AnyEntityDefinition,
  EntityDefinition,
  EntityDefinitionInput,
  EventPayloads,
  PayloadMarker,
} from './fsm.types';

export const payloadOf = <P>(): PayloadMarker<P> => undefined as unknown as PayloadMarker<P>;

export const defineEntity = <const Input extends EntityDefinitionInput>(
  input: Input,
): EntityDefinition<EventPayloads<Input['events']>> => {
  const { streamType, initial, states, events } = input;
  const fail = (message: string): never => {
    throw new InvalidEntityDefinitionError(`Entity "${streamType}": ${message}`);
  };

  if (!streamType) fail('streamType must be a non-empty string.');
  if (states.length === 0) fail('states must not be empty.');

  const stateSet = new Set(states);
  if (stateSet.size !== states.length) fail('states contains duplicates.');
  if (!stateSet.has(initial)) fail(`initial state "${initial}" is not listed in states.`);
  if (Object.keys(events).length === 0) fail('events must not be empty.');

  const terminalStates = new Set<string>();
  let hasCreationTransition = false;
  let initialIsReachable = false;

  for (const [eventType, transition] of Object.entries(events)) {
    if (transition.from.length === 0) {
      fail(`event "${eventType}" has an empty "from" list, so it can never fire.`);
    }
    if (!stateSet.has(transition.to)) {
      fail(`event "${eventType}" transitions to unknown state "${transition.to}".`);
    }
    for (const from of transition.from) {
      if (from === null) {
        hasCreationTransition = true;
        if (transition.to === initial) initialIsReachable = true;
        continue;
      }
      if (!stateSet.has(from)) {
        fail(`event "${eventType}" transitions from unknown state "${from}".`);
      }
    }
    if (transition.terminal === true) terminalStates.add(transition.to);
  }

  if (!hasCreationTransition) {
    fail('no event declares `from: [null]`, so a stream of this type could never be created.');
  }
  if (!initialIsReachable) {
    fail(`initial state "${initial}" is not the target of any creation transition.`);
  }

  for (const [eventType, transition] of Object.entries(events)) {
    for (const from of transition.from) {
      if (from !== null && terminalStates.has(from)) {
        fail(`state "${from}" is terminal, but event "${eventType}" transitions out of it.`);
      }
    }
  }

  return { ...input, terminalStates };
};

export const isTerminalState = (definition: AnyEntityDefinition, state: string | null): boolean =>
  state !== null && definition.terminalStates.has(state);

export const applyEvent = (
  definition: AnyEntityDefinition,
  currentState: string | null,
  eventType: string,
  streamId: string,
): string => {
  const transition = definition.events[eventType];
  if (transition === undefined) {
    throw new UnknownEventTypeError(definition.streamType, eventType);
  }
  if (isTerminalState(definition, currentState) || !transition.from.includes(currentState)) {
    throw new InvalidTransitionError(streamId, definition.streamType, currentState, eventType);
  }
  return transition.to;
};

export const foldState = (
  definition: AnyEntityDefinition,
  eventTypes: readonly string[],
  streamId = '<unknown>',
): string | null => {
  let state: string | null = null;
  for (const eventType of eventTypes) {
    state = applyEvent(definition, state, eventType, streamId);
  }
  return state;
};

export const buildEntityRegistry = (
  entities: readonly AnyEntityDefinition[],
): ReadonlyMap<string, AnyEntityDefinition> => {
  const registry = new Map<string, AnyEntityDefinition>();
  for (const entity of entities) {
    if (registry.has(entity.streamType)) {
      throw new InvalidEntityDefinitionError(
        `Duplicate entity definition for stream type "${entity.streamType}".`,
      );
    }
    registry.set(entity.streamType, entity);
  }
  return registry;
};
