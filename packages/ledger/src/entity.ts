import type { EntityDefinition } from './domain/fsm.types';
import { LedgerError } from './errors';
import type { AppendTarget, EntityLedger, StoredEventOf, TypedAppendParams } from './entity.types';
import type { Ledger, LedgerTransaction } from './ledger.types';
import type { AppendParams, EventInput, StoredEvent } from './types';

const isTransaction = (target: AppendTarget): target is LedgerTransaction =>
  typeof (target as LedgerTransaction).append === 'function';

export const createEntityLedger = <Payloads>(
  ledger: Ledger,
  definition: EntityDefinition<Payloads>,
): EntityLedger<Payloads> => {
  const { streamType } = definition;

  if (ledger.entities.get(streamType) === undefined) {
    throw new LedgerError(
      `Entity "${streamType}" is not registered on this ledger; pass it to createLedger({ entities: [...] }).`,
    );
  }

  const append = (
    target: AppendTarget,
    params: TypedAppendParams<Payloads>,
  ): Promise<StoredEvent[]> => {
    const appendParams: AppendParams = {
      streamId: params.streamId,
      streamType,
      expectedSeq: params.expectedSeq,
      events: params.events as unknown as EventInput[],
    };
    return isTransaction(target)
      ? target.append(appendParams)
      : ledger.append(target, appendParams);
  };

  return {
    definition,
    streamType,
    append,
    readStream: async (streamId, options) =>
      (await ledger.readStream(streamId, options)) as Array<StoredEventOf<Payloads>>,
    getState: (streamId) => ledger.getState(streamId),
    verifyStream: (streamId) => ledger.verifyStream(streamId),
  };
};
