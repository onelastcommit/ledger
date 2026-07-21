CREATE TABLE IF NOT EXISTS ledger_subscription_failures (
  id                BIGSERIAL PRIMARY KEY,
  subscription_name TEXT        NOT NULL,
  global_position   BIGINT      NOT NULL,
  event_id          TEXT        NOT NULL,
  event_type        TEXT        NOT NULL,
  attempts          INTEGER     NOT NULL,
  error             TEXT        NOT NULL,
  failed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ledger_subscription_failures_unique UNIQUE (subscription_name, global_position)
);

CREATE INDEX IF NOT EXISTS ledger_subscription_failures_name_idx
  ON ledger_subscription_failures (subscription_name, failed_at DESC);
