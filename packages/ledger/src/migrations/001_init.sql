-- ledger_events is append-only: this library never issues UPDATE or DELETE
-- against it. Corrections are new events, and each row's hash covers the
-- previous row's, so editing history invalidates the chain. To enforce it at
-- the database rather than by convention, grant your application role only:
--   REVOKE UPDATE, DELETE, TRUNCATE ON ledger_events FROM your_app_role;
--   GRANT INSERT, SELECT ON ledger_events TO your_app_role;

CREATE TABLE IF NOT EXISTS ledger_events (
  global_position BIGSERIAL PRIMARY KEY,
  id              TEXT        NOT NULL UNIQUE,
  stream_id       TEXT        NOT NULL,
  stream_type     TEXT        NOT NULL,
  seq             INTEGER     NOT NULL,
  type            TEXT        NOT NULL,
  payload         JSONB       NOT NULL,
  actor           JSONB       NOT NULL,
  source          JSONB,
  payload_version INTEGER,
  occurred_at     TIMESTAMPTZ NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  hash            TEXT        NOT NULL,

  CONSTRAINT ledger_events_stream_seq_unique UNIQUE (stream_id, seq),
  CONSTRAINT ledger_events_seq_positive CHECK (seq >= 1)
);

CREATE INDEX IF NOT EXISTS ledger_events_stream_type_position_idx
  ON ledger_events (stream_type, global_position);

CREATE TABLE IF NOT EXISTS ledger_streams (
  stream_id   TEXT        PRIMARY KEY,
  stream_type TEXT        NOT NULL,
  last_seq    INTEGER     NOT NULL,
  state       TEXT,
  last_hash   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_streams_type_idx ON ledger_streams (stream_type);

CREATE TABLE IF NOT EXISTS ledger_subscriptions (
  name       TEXT        PRIMARY KEY,
  position   BIGINT      NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
