export interface RebuiltStream {
  streamId: string;
  streamType: string;
  lastSeq: number;
  state: string | null;
  changed: boolean;
}

export interface RebuildReport {
  streams: number;
  changed: number;
  details: RebuiltStream[];
}
