export class LedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    Error.captureStackTrace(this, new.target);
  }
}

export class VersionConflictError extends LedgerError {
  constructor(
    readonly streamId: string,
    readonly expectedSeq: number,
    readonly actualSeq: number | null,
  ) {
    super(
      actualSeq === null
        ? `Version conflict on stream "${streamId}": expected seq ${expectedSeq}, but a concurrent append claimed seq ${expectedSeq + 1} first.`
        : `Version conflict on stream "${streamId}": expected seq ${expectedSeq}, but the stream is at ${actualSeq}.`,
    );
  }
}

export class InvalidTransitionError extends LedgerError {
  constructor(
    readonly streamId: string,
    readonly streamType: string,
    readonly currentState: string | null,
    readonly eventType: string,
  ) {
    super(
      `Event "${eventType}" is not a valid transition for ${streamType} stream "${streamId}" in state ${
        currentState === null ? '<new stream>' : `"${currentState}"`
      }.`,
    );
  }
}

export class UnknownEventTypeError extends LedgerError {
  constructor(
    readonly streamType: string,
    readonly eventType: string,
  ) {
    super(`Event type "${eventType}" is not declared on entity "${streamType}".`);
  }
}

export class StreamNotFoundError extends LedgerError {
  constructor(readonly streamId: string) {
    super(`Stream "${streamId}" does not exist.`);
  }
}

export class HashChainBrokenError extends LedgerError {
  constructor(
    readonly streamId: string,
    readonly firstBadSeq: number,
  ) {
    super(`Hash chain for stream "${streamId}" first diverges at seq ${firstBadSeq}.`);
  }
}

export class InvalidEntityDefinitionError extends LedgerError {}

export class ProjectionFailedError extends LedgerError {
  constructor(
    readonly projectionName: string,
    readonly eventType: string,
    cause: unknown,
  ) {
    super(
      `Projection "${projectionName}" failed while handling "${eventType}"; the append was rolled back.`,
      { cause },
    );
  }
}
