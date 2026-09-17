import { Database as CoreDatabase } from '@atc-web/service-core/db';

/** SQLite connection with schema migrations applied on open. */
export class Database extends CoreDatabase {
  static MIGRATIONS = [
    `
    CREATE TABLE subscriptions (
      id                   TEXT PRIMARY KEY,
      name                 TEXT NOT NULL UNIQUE,
      description          TEXT NOT NULL DEFAULT '',
      url                  TEXT NOT NULL,
      events               TEXT NOT NULL,
      headers              TEXT NOT NULL DEFAULT '{}',
      secret_enc           TEXT NOT NULL,
      prev_secret_enc      TEXT,
      prev_until           INTEGER,
      status               TEXT NOT NULL CHECK (status IN ('active', 'paused', 'disabled')),
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_delivery_at     INTEGER,
      last_status          TEXT,
      created_by           TEXT NOT NULL,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX subscriptions_status ON subscriptions (status);

    CREATE TABLE events (
      seq               INTEGER PRIMARY KEY AUTOINCREMENT,
      id                TEXT NOT NULL UNIQUE,
      type              TEXT NOT NULL,
      data              TEXT NOT NULL,
      idem_key          TEXT,
      source            TEXT NOT NULL,
      only_subscription TEXT,
      created_at        INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX events_idem ON events (source, idem_key) WHERE idem_key IS NOT NULL;
    CREATE INDEX events_type ON events (type, seq DESC);
    CREATE INDEX events_created ON events (created_at);

    CREATE TABLE deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'retrying', 'succeeded', 'failed', 'cancelled')),
      attempt         INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL,
      next_attempt_at INTEGER,
      started_at      INTEGER,
      finished_at     INTEGER,
      duration_ms     INTEGER,
      http_status     INTEGER,
      response        TEXT,
      error           TEXT,
      attempts        TEXT NOT NULL DEFAULT '[]',
      created_at      INTEGER NOT NULL
    );
    CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying');
    CREATE INDEX deliveries_subscription ON deliveries (subscription_id, id DESC);
    CREATE INDEX deliveries_event ON deliveries (event_id);
    CREATE INDEX deliveries_status ON deliveries (status, id DESC);
    CREATE INDEX deliveries_created ON deliveries (created_at);
    `,
    `
    -- Stage 6: lease ownership. owner_token is the fencing token — a fresh random value per claim,
    -- never reused, so a write guarded by "WHERE owner_token = ?" can only ever succeed for whoever
    -- currently holds the lease. lease_until is renewed by the heartbeat while a call is in flight;
    -- NULL for every pre-migration 'running' row (no legacy lease to compare against, so the
    -- reclaim query treats a NULL lease as already expired).
    ALTER TABLE deliveries ADD COLUMN owner_token TEXT;
    ALTER TABLE deliveries ADD COLUMN lease_until INTEGER;
    CREATE INDEX deliveries_lease ON deliveries (lease_until) WHERE status = 'running';

    -- One row per live worker process (API-only processes have none of their own). Written on a
    -- timer by any process running a Worker loop; read by an API-only process's /ready and /stats
    -- in place of the in-process Worker object it doesn't have.
    CREATE TABLE worker_heartbeat (
      instance TEXT PRIMARY KEY,
      seen_at  INTEGER NOT NULL
    );
    `,
    `
    -- Stage 10: optional best-effort ordered delivery. Default 0 (false) — existing subscriptions
    -- are unaffected; unordered delivery behaves exactly as before. See DeliveryStore#claim's doc
    -- for the exact ordering/claim semantics this column enables.
    ALTER TABLE subscriptions ADD COLUMN ordered INTEGER NOT NULL DEFAULT 0;
    `,
  ];
}
