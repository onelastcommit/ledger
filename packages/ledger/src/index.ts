export { createLedger, DEFAULT_NOTIFY_CHANNEL } from './ledger';
export type { Ledger, LedgerConfig, LedgerTransaction, ReadOptions } from './ledger.types';

export { applyEvent, defineEntity, foldState, isTerminalState } from './domain/fsm';
export type {
  EntityDefinition,
  EntityDefinitionInput,
  TransitionDefinition,
} from './domain/fsm.types';

export { canonicalise, canonicaliseEvent, chainHashes, hashEvent, verifyChain } from './domain/hash';
export type { CanonicalisableEvent } from './domain/hash.types';

export { decodeUlidTime, isUlid, monotonicUlidFactory, ulid } from './domain/ulid';

export { ALL_EVENTS } from './services/projection.service';
export type { Projection, ProjectionContext } from './services/projection.types';
export type {
  DeadLetter,
  DeadLetterPolicy,
  Subscription,
  SubscriptionOptions,
  SubscriptionStatus,
} from './services/subscription.types';
export type { RebuildReport, RebuiltStream } from './services/maintenance.types';

export {
  HashChainBrokenError,
  InvalidEntityDefinitionError,
  InvalidTransitionError,
  LedgerError,
  ProjectionFailedError,
  StreamNotFoundError,
  UnknownEventTypeError,
  VersionConflictError,
} from './errors';

export type {
  Actor,
  AppendParams,
  EventInput,
  JsonValue,
  IterateAllOptions,
  IterateStreamOptions,
  ReadAllOptions,
  ReadStreamOptions,
  SourceRef,
  StoredEvent,
  StreamState,
  VerificationResult,
} from './types';
