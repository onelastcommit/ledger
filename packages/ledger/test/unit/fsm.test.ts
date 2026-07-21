import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  buildEntityRegistry,
  defineEntity,
  foldState,
  isTerminalState,
} from '../../src/domain/fsm';
import {
  InvalidEntityDefinitionError,
  InvalidTransitionError,
  UnknownEventTypeError,
} from '../../src/errors';

const entry = defineEntity({
  streamType: 'entry',
  initial: 'draft',
  states: ['draft', 'confirmed', 'attested', 'superseded', 'entered_in_error'],
  events: {
    EntryDrafted: { from: [null], to: 'draft' },
    EntryConfirmed: { from: ['draft'], to: 'confirmed' },
    EntryEdited: { from: ['confirmed', 'attested'], to: 'confirmed' },
    EntryAttested: { from: ['confirmed'], to: 'attested' },
    EntrySuperseded: { from: ['confirmed', 'attested'], to: 'superseded', terminal: true },
    EntryMarkedInError: {
      from: ['draft', 'confirmed', 'attested'],
      to: 'entered_in_error',
      terminal: true,
    },
  },
});

describe('defineEntity', () => {
  it('precomputes terminal states', () => {
    expect([...entry.terminalStates].sort()).toEqual(['entered_in_error', 'superseded']);
    expect(isTerminalState(entry, 'superseded')).toBe(true);
    expect(isTerminalState(entry, 'confirmed')).toBe(false);
    expect(isTerminalState(entry, null)).toBe(false);
  });

  const invalid: Array<[string, () => unknown]> = [
    [
      'a transition to an unknown state',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a'],
          events: { Created: { from: [null], to: 'a' }, Bad: { from: ['a'], to: 'nowhere' } },
        }),
    ],
    [
      'a transition from an unknown state',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a'],
          events: { Created: { from: [null], to: 'a' }, Bad: { from: ['ghost'], to: 'a' } },
        }),
    ],
    [
      'an initial state not in states',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'b',
          states: ['a'],
          events: { Created: { from: [null], to: 'a' } },
        }),
    ],
    [
      'no creation transition',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a'],
          events: { Moved: { from: ['a'], to: 'a' } },
        }),
    ],
    [
      'an initial state that is unreachable from nothing',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'b',
          states: ['a', 'b'],
          events: { Created: { from: [null], to: 'a' }, Moved: { from: ['a'], to: 'b' } },
        }),
    ],
    [
      'an empty from list',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a'],
          events: { Created: { from: [null], to: 'a' }, Bad: { from: [], to: 'a' } },
        }),
    ],
    [
      'a transition out of a terminal state',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a', 'b'],
          events: {
            Created: { from: [null], to: 'a' },
            Done: { from: ['a'], to: 'b', terminal: true },
            Undone: { from: ['b'], to: 'a' },
          },
        }),
    ],
    [
      'duplicate states',
      () =>
        defineEntity({
          streamType: 'x',
          initial: 'a',
          states: ['a', 'a'],
          events: { Created: { from: [null], to: 'a' } },
        }),
    ],
  ];

  it.each(invalid)('rejects %s', (_label, build) => {
    expect(build).toThrow(InvalidEntityDefinitionError);
  });
});

describe('applyEvent', () => {
  const legal: Array<[string | null, string, string]> = [
    [null, 'EntryDrafted', 'draft'],
    ['draft', 'EntryConfirmed', 'confirmed'],
    ['draft', 'EntryMarkedInError', 'entered_in_error'],
    ['confirmed', 'EntryAttested', 'attested'],
    ['confirmed', 'EntryEdited', 'confirmed'],
    ['confirmed', 'EntrySuperseded', 'superseded'],
    ['attested', 'EntrySuperseded', 'superseded'],
    ['attested', 'EntryMarkedInError', 'entered_in_error'],
  ];

  it.each(legal)('%s + %s -> %s', (from, event, to) => {
    expect(applyEvent(entry, from, event, 's')).toBe(to);
  });

  it('demotes an attested entry back to confirmed when edited', () => {
    expect(applyEvent(entry, 'attested', 'EntryEdited', 's')).toBe('confirmed');
  });

  const illegal: Array<[string | null, string]> = [
    [null, 'EntryConfirmed'],
    [null, 'EntryAttested'],
    ['draft', 'EntryDrafted'],
    ['draft', 'EntryAttested'],
    ['draft', 'EntryEdited'],
    ['confirmed', 'EntryConfirmed'],
    ['attested', 'EntryAttested'],
    ['attested', 'EntryConfirmed'],
  ];

  it.each(illegal)('rejects %s + %s', (from, event) => {
    expect(() => applyEvent(entry, from, event, 's')).toThrow(InvalidTransitionError);
  });

  it.each(['superseded', 'entered_in_error'])('accepts nothing from terminal state %s', (state) => {
    for (const eventType of Object.keys(entry.events)) {
      expect(() => applyEvent(entry, state, eventType, 's')).toThrow(InvalidTransitionError);
    }
  });

  it('rejects an event the entity does not declare', () => {
    expect(() => applyEvent(entry, 'draft', 'SomethingElse', 's')).toThrow(UnknownEventTypeError);
  });

  it('reports the current state and attempted event on the error', () => {
    try {
      applyEvent(entry, 'attested', 'EntryConfirmed', 'entry:1');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTransitionError);
      const typed = error as InvalidTransitionError;
      expect(typed.currentState).toBe('attested');
      expect(typed.eventType).toBe('EntryConfirmed');
      expect(typed.streamId).toBe('entry:1');
    }
  });
});

describe('foldState', () => {
  it('folds an empty stream to null', () => {
    expect(foldState(entry, [])).toBeNull();
  });

  it('folds a full lifecycle', () => {
    expect(
      foldState(entry, ['EntryDrafted', 'EntryConfirmed', 'EntryAttested', 'EntryEdited']),
    ).toBe('confirmed');
  });

  it('propagates the first illegal transition', () => {
    expect(() => foldState(entry, ['EntryDrafted', 'EntryAttested'])).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('buildEntityRegistry', () => {
  it('indexes by stream type', () => {
    expect(buildEntityRegistry([entry]).get('entry')).toBe(entry);
  });

  it('rejects duplicate registrations', () => {
    expect(() => buildEntityRegistry([entry, entry])).toThrow(InvalidEntityDefinitionError);
  });
});
