# `webhook-out` readiness contract

## Purpose
`webhook-out` is the platform's outbound-webhook fan-out service: internal backends publish
events (`POST /v1/events`), external partners subscribe to event-type patterns, and the service
delivers each matching event to every active subscriber as an HMAC-signed HTTP POST, retrying on a
schedule, auto-disabling receivers that stay dead, and keeping the full delivery history queryable.
It lets the rest of the platform notify third parties of things that happened without any other
service having to know about HTTP delivery, retries, signing or subscriber management itself.

## Dependencies
- **Subscriber endpoints** (arbitrary external URLs stored per subscription, not an env var): the
  service's core job. Required for a delivery to succeed at all; when one is unreachable or slow,
  only that subscription's deliveries are affected — they retry on `RETRY_SCHEDULE_SEC` and the
  subscription is auto-disabled after `DISABLE_AFTER_FAILURES` consecutive dead deliveries
  (`src/worker.js`, `src/store/subscription-store.js`). Every other subscriber and the rest of the
  API are unaffected.
- **`audit` service** (`AUDIT_URL` + `AUDIT_API_KEY`): optional, both-or-neither
  (`src/config.js`). When unset, audit forwarding is a no-op (`AuditClient.enabled` is `false`)
  and nothing else changes. When set, every completed write request is queued in memory
  (`AuditClient.record`, called from the Fastify `onSend` hook) and flushed asynchronously on a
  timer — the queuing itself never touches the network, so an audit outage never slows or fails
  the business request. If the audit service is down, batches retry with backoff and stay
  buffered (capped at `AuditClient.MAX_BUFFER = 5_000` events, oldest dropped once full) until it
  recovers; there is no other effect on `webhook-out`'s own behaviour.

No other service or external system is called by `webhook-out` itself (it does not call `auth`,
`notify`, or any other sibling service).

## Persistence
Engine: SQLite via `node:sqlite`'s `DatabaseSync` (`src/db.js`), one file at `DB_PATH` (default
`./data/webhook-out.db`; `/data/webhook-out.db` in the Docker image; `:memory:` in tests). Opened
with `PRAGMA journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000`, `foreign_keys =
ON`.

Schema (one migration today, see below):
- `subscriptions` — id/name/url/event patterns/custom headers, `secret_enc`/`prev_secret_enc`/
  `prev_until` for the signing-secret rotation grace, `status` (`active`/`paused`/`disabled`),
  failure counter and last-outcome fields; indexed on `status`.
- `events` — id/type/data/idempotency key/source, `only_subscription` for test events; a unique
  partial index on `(source, idem_key)` enforces publish idempotency at the DB level, plus indexes
  on `(type, seq desc)` and `created_at`.
- `deliveries` — one row per event×subscriber attempt history: status, attempt/max_attempts,
  `next_attempt_at`, timing, response/error, a JSON `attempts` array, and, since Stage 6,
  `owner_token` (the fencing token of whoever currently holds the lease; null when not `running`)
  and `lease_until` (ms since epoch; null when not `running`, or a pre-Stage-6 leftover row).
  Indexed on the due-queue predicate (`next_attempt_at` where status is pending/retrying), on
  `(subscription_id, id desc)`, `event_id`, `(status, id desc)`, `created_at`, and (Stage 6)
  `lease_until` (partial, the reclaim sweep).
- `worker_heartbeat` — one row per live worker process (`instance` primary key, `seen_at`); written
  on a timer by any process running a `Worker` loop, read by an API-only process's `/ready` and
  `/v1/stats` in place of the in-process `Worker` object it doesn't have.

Migration mechanism: `Database.MIGRATIONS` is an ordered array of SQL strings; `#migrate()` reads
`PRAGMA user_version`, and runs every migration whose index is `>= current` inside its own
`BEGIN`/`COMMIT` (rolled back on error), then sets `user_version` to that index + 1. Today the
array has exactly one entry (the full initial schema above). Fresh install: `user_version` starts
at 0, that one migration runs, all three tables and their indexes are created, `user_version`
becomes 1. Upgrade (an existing database, `user_version` already 1): the loop finds nothing with a
higher index and is a no-op — there is no schema change to apply yet. A future schema change would
be added as a new array entry and would run automatically, once, the next time the process starts.

## Health endpoint
`GET /health` (`src/http/webhook-api.js`) checks nothing and always returns `{"status":"ok"}`
with no dependency lookups. It cannot be slow or fail while the process is otherwise alive — it is
pure static JSON. Route-level `logLevel: 'warn'` keeps routine polling out of the info log.

## Readiness endpoint
`GET /ready` checks `Database.ping()` (`SELECT 1`) and caches the result for
`WebhookApi.READY_CACHE_MS = 10_000` ms: a call within that window returns the cached outcome
without touching SQLite again; a call after it re-pings and refreshes the cache. On success it
returns `200 {"status":"ok","worker":"running"|"stopped"}`; on a failed ping it returns `503
{"status":"unavailable","error"}` and logs a warning. It never mutates business state, never
discards in-flight work, and its only side effect is updating the in-memory cache timestamp — safe
to poll at any frequency.

Since Stage 6, `worker` comes from either of two sources depending on process role: the combined
and worker-only roles have an in-process `Worker`, so `worker` is exactly `this.worker.running`; the
API-only role (`src/api-main.js`) has none, so `WebhookApi#workerStatus()` instead reads the
`worker_heartbeat` table's most recent row and reports `"running"` when it is fresher than
`HEARTBEAT_MS * 4` (`WebhookApi.PRESENCE_STALE_FACTOR`), `"stopped"` otherwise.

## Graceful shutdown
`SIGTERM` and `SIGINT` both call `Application#shutdown(reason)`; an `unhandledRejection` also
triggers it. An `uncaughtException`, by contrast, does **not** go through graceful shutdown — it
logs fatally and calls `process.exit(1)` immediately (`src/application.js`,
`#installSignalHandlers`).

`shutdown()` is idempotent (`Lifecycle.install`'s own guard) and runs, in this exact order (Stage 6
fixed this order — see below for what it was and why):
1. `worker?.stopClaiming()` — flips a flag `#pass()` checks before claiming new deliveries;
   whatever is already in flight keeps running. Present only when this process runs a worker at all
   (skipped in the API-only role).
2. `await app.close()` — Fastify stops accepting new connections and waits for in-flight HTTP
   requests to finish. Present only in the API and combined roles.
3. `await worker.stop()` — (redundant `running = false`) waits (`Promise.allSettled`) for
   deliveries already executing to finish, clearing each one's heartbeat interval as it settles.
   Stage 6.1: this wait is itself bounded by `options.drainMs` (`config.deliveryTimeoutMs + 5_000`)
   — races `Promise.allSettled(inFlight)` against a `sleep(drainMs)`, cancelled with an
   `AbortController` so the loser doesn't leak a timer. On timeout it logs `'drain timed out;
   continuing shutdown with deliveries still in flight'` and moves straight to the remaining steps
   instead of hanging forever.
4. `await audit.close()` — stops the audit flush timer and flushes whatever is still buffered,
   including its own retry loop (see Retry policy).
5. `db.close()`.

**Before Stage 6** step 4 (audit flush) was step 2, running *before* the worker drained — see
`scheduler`'s identical fix for the general reasoning. The fix is purely a reordering.

A force-exit timer is armed before any of this: `setTimeout(() => { log.error(...); process.exit(1); }, config.deliveryTimeoutMs + 10_000).unref()`. With the default `DELIVERY_TIMEOUT_MS=15000` that is
**25 s**. `webhook-out/ecosystem.config.cjs` sets PM2's `kill_timeout: 150000` (150 s, Stage 6 —
was 40 s). `DELIVERY_TIMEOUT_MS` is bounded at `max: 120_000` (unchanged by Stage 6, it already had
this ceiling), so the worst-case force-exit timer is `120_000 + 10_000 = 130_000` ms — comfortably
under the new 150 s `kill_timeout` regardless of how `DELIVERY_TIMEOUT_MS` is configured within its
validated range, closing the previously-real misconfiguration this section used to describe (raising
`DELIVERY_TIMEOUT_MS` toward its own max used to push the force-exit timer past the old, static
40 s `kill_timeout`).

The five numbers that matter for shutdown, and why `drainMs < forceExitMs` by design (a 5 s margin):
worker drain timeout (`drainMs = deliveryTimeoutMs + 5_000`) fires first and lets audit-flush/db-close
still run; the outer force-exit timer (`deliveryTimeoutMs + 10_000`) is the hard backstop that calls
`process.exit(1)` if even those remaining steps hang; `DELIVERY_TIMEOUT_MS` is the external call's own
timeout (what bounds one delivery attempt); `HEARTBEAT_MS` is how often an in-flight delivery renews
its lease; `LEASE_MS` is the lease TTL a stalled/crashed worker's claim expires after, for another
worker to reclaim. PM2's `kill_timeout` (150 s) sits above all of them so PM2 never SIGKILLs before
the app's own force-exit timer has a chance to run.

Audit's own flush retry loop (up to 6 attempts with backoff, cumulative sleeps of roughly
1+2+4+8+16 s, plus up to 5 s per HTTP attempt) can still, by itself, consume a large fraction of the
force-exit budget if `audit` is unreachable — but it now runs *after* the worker has already
drained, so a slow or hung audit flush no longer delays the far more important step of finishing
in-flight deliveries cleanly; it only delays process exit itself, which the force-exit timer still
bounds.

## Resource limits
- `BODY_LIMIT` (default 65 536 bytes / 64 KiB) — Fastify request body cap; must stay above
  `MAX_EVENT_BYTES` per the operator-facing comment in `.env.example`.
- `MAX_EVENT_BYTES` (default 65 536) — largest JSON-encoded event `data`, enforced in
  `EventService.publish` (`413 EVENT_TOO_LARGE` if exceeded).
- List page size: `Schemas.limit` restricts `?limit=` to `1–200` on every listing endpoint; unset
  defaults to 50 in the handlers.
- `events` patterns per subscription: up to `EventMatch.MAX_PATTERNS = 100`; custom headers: up to
  `SubscriptionService.MAX_HEADERS = 10`.
- `WORKER_CONCURRENCY` (default 16, range 1–128) — concurrent outbound delivery calls in flight.
- `RATE_LIMIT_MAX` (default 1 200) — requests per API key per minute, via `@fastify/rate-limit`.
- `max_memory_restart: '300M'` in `ecosystem.config.cjs` — PM2 restarts the process if RSS exceeds
  300 MB.
- Outbound response capture bounded to `HttpCaller.MAX_RESPONSE = 1024` bytes per delivery
  attempt.

## Timeouts
- `DELIVERY_TIMEOUT_MS` (default 15 000, range 1 000–120 000) — per outbound call to a subscriber
  (`HttpCaller`/`node:http`'s socket `timeout`); firing destroys the request with a retryable
  `CallError` (`code: 'TIMEOUT'`).
- Audit-service HTTP calls: `timeoutMs` default 5 000 ms per batch POST (`AbortSignal.timeout`,
  `AuditClient` constructor default) — **not** exposed as an env var; `Application` wires
  `AuditClient` with only `target`, so this and `flushMs`/`batchSize` always use their code
  defaults.
- SQLite `busy_timeout` PRAGMA: 5 000 ms wait on a locked database before erroring.
- Shutdown force-exit: `DELIVERY_TIMEOUT_MS + 10_000` ms (see Graceful shutdown).
- `LEASE_MS` (default 30 000 ms, range 2 000–300 000) / `HEARTBEAT_MS` (default 10 000 ms, `min`
  250, must be `<LEASE_MS`) — Stage 6: the lease a claimed delivery holds, and how often an
  in-flight call renews it. Deliberately independent of `DELIVERY_TIMEOUT_MS` — a call can run far
  longer than `LEASE_MS` without losing its lease, as long as its heartbeat keeps succeeding; see
  "Lease ownership".
- PM2 `listen_timeout: 10000` ms — how long PM2 waits for `wait_ready`'s `process.send('ready')`
  at startup.
- No explicit Fastify/Node `requestTimeout` is configured for inbound API requests — the platform
  API itself has no per-request hard timeout beyond what Node's HTTP server does by default.

## Retry policy
- **Deliveries** (`Worker#settle` in `src/worker.js`, delay from `EventService.retryDelayMs`): a
  fixed schedule, not a formula — `RETRY_SCHEDULE_SEC` (default `60,300,1800,7200,21600,86400`,
  i.e. 1 m/5 m/30 m/2 h/6 h/24 h), validated non-decreasing at config load, at most 50 entries.
  Max attempts = `retryScheduleSec.length + 1` (7 by default). No jitter — the delay is exactly
  the scheduled number of seconds added to the current time. Retryable outcomes: HTTP `408`,
  `425`, `429`, any `5xx`, timeouts, connection errors, and `NetGuardError` DNS failures; a
  disallowed target (private address, blocked scheme/host, credentials in URL) is **not**
  retryable and fails on the first attempt. A crash-interrupted (`running`) delivery is recovered
  once at the next start (`Worker#recover`) and counted as one failed, retryable attempt.
- **Audit forwarding** (`AuditClient#send` in `src/net/audit-client.js`): exponential backoff with
  a cap, `min(30_000, 500 * 2 ** attempt)` between up to `MAX_ATTEMPTS = 6` attempts per flush
  cycle; no jitter. A batch that exhausts its attempts stays in the buffer for the next periodic
  flush (every `flushMs`, default 2 000 ms) rather than being dropped — events are only dropped
  when the buffer overflows (`MAX_BUFFER = 5_000`, oldest dropped) or the audit service rejects
  the batch with a non-retryable `4xx` (other than `429`).

## Idempotency
- **`POST /v1/events` with `idempotencyKey`**: idempotent per publishing source. A repeat with the
  same `source` (API key id) and key returns the original event (`200`, not `201`/`202`) and
  queues no new deliveries; enforced both in `EventService.publish` and by the DB's unique partial
  index `events_idem` on `(source, idem_key)`, so a race between two identical concurrent
  publishes cannot create two events either. The check-then-insert already can't race across
  connections — the whole method runs inside one `BEGIN IMMEDIATE` transaction, so a concurrent
  publish with the same key blocks until this one commits, then sees the row on its own check —
  but Stage 6 also added a belt-and-braces `try/catch` around the insert: if it ever throws a raw
  `UNIQUE constraint failed` anyway (only reachable today by deliberately breaking that invariant,
  as `test/domain.test.js`'s forced-failure test does), it's mapped to the existing event instead of
  surfacing as an unhandled `500`.
- **`POST /v1/events` without `idempotencyKey`**: not idempotent — every call creates a new event
  and new deliveries.
- **Delivery attempts / retries**: not idempotent from the subscriber's point of view. A delivery
  interrupted by a crash after the subscriber actually received it, but before `webhook-out`
  recorded success, is retried as a fresh attempt on restart; a receiver that already saw the same
  `X-Webhook-Id`/`X-Webhook-Delivery` must de-duplicate itself — this service makes no dedup
  guarantee on the wire, only a signed, identifiable payload.
- **`POST /v1/subscriptions/:id/redeliver`**: explicitly not idempotent by design — it always
  creates a brand-new delivery row for the same event/subscriber (an operator-triggered duplicate
  send).
- **`POST /v1/subscriptions/:id/replay`**: explicitly not deduplicated — matching events in the
  window are re-queued every time it is called, "the receiver sees repeated event ids and must
  de-duplicate" (comment in `src/domain/event-service.js`).
- **`POST /v1/subscriptions/:id/rotate`**: not idempotent — every call mints a fresh secret.

## Retention
`EVENT_RETENTION_DAYS` (default 30) bounds how long a published event (and, by `ON DELETE CASCADE`,
its deliveries) is kept; the worker's periodic maintenance pass calls `EventStore.purge(now -
retentionDays * 86_400_000)` every `Worker.MAINTENANCE_INTERVAL_MS` (60 s). **Stage 6 fix**: purge
used to delete unconditionally by `events.created_at < before`, which meant a paused or broken
subscriber's still-queued (`pending`/`retrying`) or in-flight (`running`) deliveries could be
destroyed by the cascade the moment their event aged past retention — silently losing work that had
never actually been attempted or was mid-attempt. Purge now excludes any event that still has a
delivery in `pending`/`retrying`/`running` (`NOT EXISTS (...)` in the same `DELETE`); such an event
survives past its nominal retention window until every one of its deliveries reaches a terminal
state, at which point the next periodic purge removes it normally. `test/worker.test.js`'s
retention test covers both halves: kept while a delivery is still queued, purged once it isn't.

## Backup
State that must survive a disk loss: the SQLite file at `DB_PATH` (subscriptions with their
*encrypted* signing secrets, events, and full delivery history) plus, out of band, `SECRETS_KEY`
and `WEBHOOK_API_KEYS` from `.env` — neither lives in the database, and `SECRETS_KEY` is what
makes the stored `secret_enc`/`prev_secret_enc` values readable at all.

There is no backup mechanism implemented in this codebase today (no backup script, no scheduled
export). Because the database runs in WAL mode, a plain `cp` of the `.db` file while the process is
running can miss data still in the `-wal` file; capturing it today means either stopping the
process and copying `DB_PATH` (and its `-wal`/`-shm` siblings if present), or using SQLite's own
consistent-snapshot tools (e.g. `sqlite3 <path> ".backup <dest>"` or `VACUUM INTO`) against the
live file, plus separately recording `SECRETS_KEY` and `WEBHOOK_API_KEYS`.

## Restore
1. Stop `webhook-out`.
2. Place the backed-up database file at `DB_PATH` (the parent directory is created automatically
   by `Database`'s constructor if missing).
3. Restore `.env` with the **same** `SECRETS_KEY` that sealed the backed-up secrets — a mismatched
   key does not fail at startup, it fails later and per-subscription, the first time
   `SubscriptionService.signingSecrets` tries to `SecretBox.open` a row sealed under the old key
   (thrown error, that subscriber's deliveries fail until the subscription is fixed).
4. Start the process; `#migrate()` re-checks `user_version` and is a no-op if the restored file is
   already at the current schema version.
5. Verify with `GET /ready` and a read-role call to `GET /v1/subscriptions`.

No ordering constraint exists with other services' data — `webhook-out` has no foreign keys or
cross-service references into another service's storage. If continuity of the audit trail matters
operationally, restore the `audit` service's own data independently; there is no technical
coupling requiring the two to be restored together.

## Metrics
`GET /metrics` (read role) returns Prometheus text.

Durable, backed by the database (computed fresh from SQLite on every scrape):
`webhook_subscriptions{status}`, `webhook_events_total`, `webhook_deliveries{status}` (all-time,
`GROUP BY status`), `webhook_backlog`, `webhook_oldest_queued_age_seconds`.

Per-process counters, in memory only, **reset to zero on every restart**:
`webhook_deliveries_finished_total{status="succeeded"|"failed"}`,
`webhook_attempts_retried_total`, `webhook_subscriptions_disabled_total` (all from
`Worker.counters`), `webhook_in_flight` (live gauge of `worker.inFlight.size`), and
`webhook_process_uptime_seconds` (`process.uptime()`).

## Logging
Fastify's default structured request logging applies: `reqId` (see Tracing), and `responseTime`
(this platform's `durationMs` equivalent, different field name) on every request line;
`req.headers.authorization` is redacted. The route path is only available implicitly via the
default `req.url` field, not as a normalised `route`/`op` name. The worker adds its own
delivery-specific structured fields on top (`delivery`, `event`, `subscription`, `attempt`,
`status`, `httpStatus`, `durationMs`, `nextAttemptAt`, `error`) — useful operationally, but outside
the platform's shared vocabulary in [OBSERVABILITY.md](../../stack/docs/OBSERVABILITY.md).

Against that shared vocabulary, `webhook-out` does **not** yet emit: `traceId` / `spanId` (it does
not parse `traceparent` at all — see Tracing), a normalised `route`/`op` (only implicit `req.url`),
`upstream` / `upstreamMs` for either of its outbound call types (subscriber deliveries, audit
batches — neither is logged with a labelled upstream/timing field), `service` / `version` (no
service-identity fields on any log line), or `code` for handled domain errors (`WebhookError`'s
machine code reaches the HTTP response body but is not echoed into the log line; only unhandled
`5xx` errors are logged, via `request.log.error({ err })`).

## Tracing
`webhook-out` sets `requestIdHeader: 'x-request-id'` with `genReqId: () => randomUUID()` in its
Fastify build (`src/http/webhook-api.js`) — it unconditionally accepts and logs (as `reqId`)
whatever `X-Request-Id` a caller sends, generating its own only when the header is absent. This is
not new to this review; it predates it, and matches every other internal-only service on this
platform.

It does **not** parse, honour, or forward a `traceparent` header —
`traceparent` propagation is implemented in `gateway` and `console` (Stage 10). Neither of `webhook-out`'s own outbound
call paths forwards a request id or trace context onward: `HttpCaller.call` (deliveries to
subscribers, `src/net/http-caller.js`) sends only `content-type`, `content-length`, `accept`,
`user-agent`, the `X-Webhook-*` delivery headers and the HMAC signature — no `X-Request-Id`, no
`traceparent`; `AuditClient#send` (`src/net/audit-client.js`) sends only `authorization` and
`content-type` to the audit service — same gap. So an inbound request id is logged locally but
does not survive either outbound hop today.

## Security model
**Authentication**: Bearer API keys from `WEBHOOK_API_KEYS` (`id:secret[:role]`, comma-separated),
compared via SHA-256 + `timingSafeEqual` against every configured key
(`ApiKeyAuth.#secretsEqual`) so timing reveals neither a match nor which key matched. Roles:
`read`, `write`, `readwrite`, `publish` (`publish` may only `POST /v1/events`; `write`/`readwrite`
can do everything `publish` can plus manage subscriptions/deliveries). The role check
(`ApiKeyAuth.require`) runs in `preValidation`, before body-schema validation, so a wrong-role call
gets `403` rather than a `400` for an incidentally malformed body. Per-key rate limiting via
`@fastify/rate-limit` (`RATE_LIMIT_MAX`, default 1 200/min).

**Secret rotation**:
- `WEBHOOK_API_KEYS` (caller-facing): no runtime rotation support — keys are read once from the
  environment at startup and frozen on the `Config` object; rotating means editing `.env` and
  restarting the process (you can add a new id/secret alongside an old one and remove the old one
  on your own schedule, but there is no built-in overlap/rotation primitive).
- Subscriber-facing signing secrets: first-class rotation via `POST /v1/subscriptions/:id/rotate`
  (`SubscriptionService.rotate`) — a fresh secret is sealed immediately, the previous secret keeps
  signing a second `v1` value for `PREV_SECRET_GRACE_HOURS` (default 24 h, `0` = cut over
  immediately), checked in `SubscriptionService.signingSecrets`.
- `SECRETS_KEY` (encrypts subscriber secrets at rest, AES-256-GCM, 32 bytes from 64 hex chars via
  `SecretBox`): **no rotation support at all**. It is read once at startup and used for the process
  lifetime; there is no script or endpoint to re-seal existing `secret_enc`/`prev_secret_enc`
  values under a new key. `.env.example`'s own comment states the consequence plainly: "Losing it
  makes every stored secret unreadable; rotate subscriptions afterwards" — i.e. the only recovery
  path today is re-creating/re-rotating each subscription, not a key-rotation migration.

**Boundary validation**: JSON Schema (Ajv, `removeAdditional: false` so unknown fields are
rejected as `400 VALIDATION_FAILED` rather than silently stripped; `coerceTypes: false` so types
must match exactly) covers shape for every body/params/querystring. Semantic checks — URL
scheme/host/credentials, event-type/pattern syntax, header name/value charset, the `Authorization`
and `X-Webhook-*` header bans — live in the domain layer (`SubscriptionService`, `EventMatch`), not
in the JSON Schema.

**Outbound safety** (`NetGuard`, applied to every delivery): `https://` only unless
`TARGET_ALLOW_HTTP`; optional `TARGET_ALLOWED_HOSTS` allowlist; credentials-in-URL rejected;
private/loopback/link-local/multicast/reserved addresses blocked for both IPv4 and IPv6 (including
mapped, NAT64, 6to4 and Teredo forms) unless `TARGET_ALLOW_PRIVATE` (which itself requires a
non-empty host allowlist); DNS is resolved once and the resulting address is pinned for the actual
TCP connection, closing the DNS-rebinding gap between check and connect; redirects are never
followed; response capture is bounded to 1 KiB.

**Explicitly out of scope** (README, confirmed against the code): per-subscriber payload
transformation; ordered-delivery guarantees; subscriber self-service; encryption of event `data`
at rest (only signing secrets are encrypted — event payloads are stored as plaintext JSON);
multi-node execution.

## API/worker runtime split
Stage 6 adds two more entry points alongside the default combined one — `src/api-main.js` (HTTP
only, no `Worker`, never claims a delivery) and `src/worker-main.js` (`Worker` only, no HTTP
listener at all). `Application`'s `role` constructor option (`'combined'` default, `'api'`,
`'worker'`) picks which parts get built; `Config`, the database, and the migrations are identical
across all three. `ecosystem.config.cjs` ships the split apps commented out, ready to enable.

## Lease ownership
Every claimed delivery gets, in addition to `status = 'running'`: **`owner_token`** (a fresh random
value per `claim()` call — the fencing token; no separate generation counter, since a fresh random
token per claim can never collide with a previous one) and **`lease_until`** (renewed every
`HEARTBEAT_MS` while the call is in flight). Every write that ends a claimed attempt —
`DeliveryStore#finish` and `DeliveryStore#heartbeat` — is guarded by `WHERE id = ? AND owner_token
= ? AND status = 'running'`, so a worker that hung long enough to be reclaimed by someone else can
never overwrite the row when it eventually returns. `DeliveryStore#reclaimExpired` (called by
`Worker#recover()` at startup, labeled `"interrupted by restart"`, and by the in-loop
`#reclaimStale()` on every poll pass, labeled `"lease expired"`) reads every row whose `lease_until`
is strictly less than `now` (`now == lease_until` is NOT yet expired — same invariant as
claim/heartbeat/finish, locked in by the Stage 6.1 regression test `test/lease.test.js`
"DeliveryStore: reclaimExpired exact-boundary invariant") and settles it as a failed attempt inside
one transaction with every write — the same race-free
construction as `scheduler`'s identical primitive (see its README for the full "why one
transaction" reasoning, kept independent per service rather than shared since the state machines
and store shapes differ).

**What changed from before Stage 6**: `recover()` used to settle every `status = 'running'` row
unconditionally (there was no lease to check), correct only because it ran once, at this same
process's own startup. The in-loop sweep and multi-process topology below both depend on the lease
existing — extending the old unconditional logic to run periodically, or from a second process,
would have stolen a still-live worker's genuinely in-flight delivery.

## Ordering and per-subscription concurrency (Stage 10)
`subscriptions.ordered` (default `0`/false, additive migration — every existing subscription is
unaffected) and `SUBSCRIPTION_CONCURRENCY_MAX` (default `4`) are both enforced inside
`DeliveryStore#claim`'s single query, the same `BEGIN IMMEDIATE` transaction that already makes
claiming atomic across processes — neither is a process-local `Set`/counter, so both hold under
real multi-process concurrency exactly like lease ownership does.

**Ordering key**: `(subscription_id, deliveries.id)`. `id` is the `deliveries` table's own
`INTEGER PRIMARY KEY AUTOINCREMENT`, assigned in creation order (`EventService#publish`/`replay`/
`redeliver` all insert within one transaction) — a stable, monotonically increasing, collision-free
sequence per subscription. A timestamp alone was rejected as the ordering key: two deliveries queued
for the same subscription in the same millisecond (a real possibility under `replay`, which can
queue many at once) would tie, and a tie has no well-defined "next".

**Claim-time rule for an `ordered` subscription**: a delivery is only a candidate if no OTHER
non-terminal delivery (`pending`, `running`, or `retrying` — deliberately including `retrying`, not
just `running`) exists for the same subscription with a smaller `id`. This alone guarantees, with no
separate bookkeeping: at most one delivery per ordered subscription is ever `running`; delivery N+1
is never claimed while N is anything but terminal — including while N is sitting out its own retry
backoff (not yet due again), which is exactly the "N+1 must not overtake N" requirement; and at most
one row per ordered subscription can ever satisfy the query's WHERE clause in a single call, before
`LIMIT` is even applied (two candidate rows for the same subscription always see each other as a
blocking smaller/larger id). An ordered subscription's effective cap is therefore always 1,
regardless of `SUBSCRIPTION_CONCURRENCY_MAX`.

**Claim-time rule for an unordered subscription's cap**: `running_n + batch_rank <= ?`, where
`running_n` is that subscription's currently-`running` count (any process) and `batch_rank` is the
candidate's 1-based position among that subscription's due rows within THIS SAME call, ordered
identically to the final result — so claiming 3 of one subscription's rows in a single call counts
as 3 against the cap immediately, before any of their `start` UPDATEs have even run.

**Why this is safe across processes, not just within one**: `DeliveryStore#claim`'s whole body runs
inside `db.transaction()`, which issues `BEGIN IMMEDIATE` — this acquires SQLite's write lock at the
very start of the transaction, before the `due` query even runs. A second process's own `claim()`
call cannot begin its own `BEGIN IMMEDIATE` (and therefore cannot even execute its `running_counts`/
ordering read) until the first process's transaction has fully committed. There is no window where
two processes' claim decisions are made from an inconsistent, partially-applied view of each
other's in-flight claims — the entire decision (read the current state, decide who's eligible,
write `status = 'running'` for the winners) is one atomic, serialized unit, exactly the same
primitive lease ownership already relies on.

**Interaction with lease/retry (Stage 6 fencing, unmodified)**: none of the above changes how a
lease is granted, renewed, or fenced — `owner_token`/`lease_until` and the `WHERE owner_token = ?
AND status = 'running'` guard on `finish`/`heartbeat` are untouched. A reclaimed ordered delivery
(lease expired, no heartbeat) goes back to `retrying` exactly as before; the NEXT delivery for that
subscription still can't be claimed until the reclaimed one reaches a terminal state, because
`retrying` is one of the three states the ordering check treats as blocking. Proven directly in
`test/ordering-and-cap.test.js` ("lease expiry + reclaim still fences correctly").

**Telemetry**: a claim attempt is a claim attempt regardless of ordering/cap — `/metrics` and the
access-log fields for a delivery attempt are unaffected; there is no new "rejected by cap" event to
log, because the cap and the ordering rule simply mean the row was never selected by `claim()` in
the first place (nothing to record — it stays `pending`, indistinguishable from "not due yet" until
it is eventually claimed).

**Best-effort, explicitly not stronger**: this is ordering of WHEN a delivery may start relative to
its subscription's earlier ones — it is not exactly-once delivery (retries still exist and are the
point), not global cross-subscription ordering, and not a guarantee that two deliveries can never be
*in flight* for different reasons at once (e.g. a redelivered/replayed copy of an already-succeeded
delivery is its own new row with its own, later id — it is correctly ordered after everything queued
before it, but the semantics of "the same underlying event happening twice" are the receiver's own
idempotency concern, unchanged from before Stage 10).

## Scaling model
**B — single-node stateful, but "single-node" now means one HOST, not one PROCESS.** One SQLite
file (`node:sqlite` `DatabaseSync`, WAL mode, `busy_timeout` 5 000 ms). `ecosystem.config.cjs`'s
default (combined) app still pins `instances: 1`, but the commented-out split `webhook-out-worker`
app documents raising its own `instances` above 1 as a supported topology.

Two (or more) worker processes pointed at the same file: SQLite's own file locking (`BEGIN
IMMEDIATE` inside `DeliveryStore.claim`) prevents the same delivery row from being claimed twice —
proven with real cross-connection concurrency (not same-process `Promise.all`) in
`test/lease-concurrency.test.js` — and the same atomicity is what makes per-subscription ordering
and the concurrency cap hold across processes too (`test/ordering-and-cap.test.js`, "Ordering and
per-subscription concurrency" above). The lease/fencing model above means a crash in one worker is
reclaimed by any live sibling's next poll pass, not only by that same process restarting. What is
**still** per-process and will diverge across instances: `Worker.counters` (`/v1/stats`'s
`sinceStart`, `/metrics`'s `*_total` counters), the `AuditClient` buffer and flush timer, and the
`/ready` readiness cache (though `/ready`'s `worker` field itself is now DB-backed and does agree
across instances — see "Readiness endpoint"). Throughput genuinely improves with more worker
processes, up to SQLite's single-writer ceiling on the brief claim/finish/heartbeat writes
themselves; the outbound HTTP calls' own duration is fully parallel across processes.

## Single-node / multi-node guarantees
With exactly one process (API+worker combined, the default), every guarantee holds as it always
has. Running several worker processes against the same `DB_PATH` (Stage 6's split-deployment
topology) is now a supported configuration: no double-claiming, no double-delivery-from-a-lease-
race, and a crash in one worker is reclaimed by any live sibling — at the cost of write-lock
contention under very high claim rates (`busy_timeout = 5000` ms) and the per-process metrics
divergence noted above. Still one host, one SQLite file — there is no network-shared counter
store, so scaling across *hosts* still means separate `webhook-out` instances with disjoint
subscriber sets and separate databases.

## Known failure modes
- **Disk full during a delivery settle.** `Worker#execute` calls `DeliveryStore#finish` exactly
  once, outside any inner `try/catch` of its own (Stage 6 restructured this method; there is no
  longer a second, nested settle attempt on failure). If that SQLite write itself fails (e.g.
  `ENOSPC`), it propagates out of `#execute` and rejects the promise tracked in `Worker#inFlight`,
  which nothing in the normal poll loop (`#run`/`#pass`) awaits or catches individually — it
  surfaces as an unhandled promise rejection, which `Application`'s
  `process.on('unhandledRejection', …)` handler turns into a full `shutdown('unhandledRejection')`.
  A single disk-full write inside the delivery loop can still bring the whole process down via the
  shutdown path, not just fail that one delivery — unchanged by Stage 6, out of this stage's scope.
- **Heartbeat failure while a call is genuinely still in flight** (event loop stall, a slow/busy DB
  write for the heartbeat `UPDATE` itself): Stage 6. The heartbeat's own guarded write detects the
  lost lease and logs a warning immediately, but cannot cancel the outbound HTTP call already in
  progress. If the lease then expires and another process reclaims the delivery, the original
  call's eventual `finish()` is rejected by the same `owner_token`/`status` guard (logged, not
  thrown) — its result is discarded, and the reclaim's own "lease expired" failed-attempt outcome
  is what stands. A genuinely successful call whose heartbeat failed can be silently wasted from
  the subscriber's point of view and retried.
- **Audit service unreachable at shutdown.** Since Stage 6, `audit.close()` runs *after*
  `worker.stop()` (previously before it — see Graceful shutdown), so an unreachable audit endpoint
  taking up to ~6 retries with backoff (each with its own 5 s timeout) no longer prevents in-flight
  deliveries from draining cleanly first; it can still consume enough of the force-exit budget to
  make the *process itself* exit via the force-exit timer rather than the clean path, but the
  deliveries are safely finished (or cleanly not-yet-claimed) by that point either way.
- **`DELIVERY_TIMEOUT_MS` raised without touching `kill_timeout`.** Fixed in Stage 6: `kill_timeout`
  is now `150000` (was a static `40000`), derived from `DELIVERY_TIMEOUT_MS`'s own validated ceiling
  (`max: 120_000`) plus the force-exit margin plus headroom — see Graceful shutdown. Any value
  `DELIVERY_TIMEOUT_MS` can validly take now keeps the force-exit timer safely under `kill_timeout`.
- **Killed without any graceful shutdown (SIGKILL, power loss).** Deliveries left `running` in
  SQLite are no longer left until the next restart: since Stage 6, the in-loop `#reclaimStale()`
  sweep (not only `Worker#recover()` at startup) reclaims any row whose lease has expired — at most
  `LEASE_MS` after the kill — on the next poll pass of *any* live worker process, this one
  restarting or a sibling in a multi-worker deployment. A single-instance PM2 deployment still
  self-heals via `autorestart: true` either way.
- **Multiple worker processes against one file.** Stage 6: now a supported topology (see "Scaling
  model"), not a failure mode — listed here only to be explicit that it no longer is one. The
  remaining, expected cost under high contention is write-lock contention (`busy_timeout = 5000`
  ms) and the per-process metrics/audit-buffer/readiness-cache divergence noted in "Scaling model".
