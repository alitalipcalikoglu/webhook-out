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
  `next_attempt_at`, timing, response/error, a JSON `attempts` array; indexed on the due-queue
  predicate (`next_attempt_at` where status is pending/retrying), on `(subscription_id, id desc)`,
  `event_id`, `(status, id desc)` and `created_at`.

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

## Graceful shutdown
`SIGTERM` and `SIGINT` both call `Application#shutdown(reason)`; an `unhandledRejection` also
triggers it. An `uncaughtException`, by contrast, does **not** go through graceful shutdown — it
logs fatally and calls `process.exit(1)` immediately (`src/application.js`,
`#installSignalHandlers`).

`shutdown()` is idempotent (`this.shuttingDown` guard) and runs, in this exact order:
1. `await app.close()` — Fastify stops accepting new connections and waits for in-flight HTTP
   requests to finish.
2. `await audit.close()` — stops the audit flush timer and flushes whatever is still buffered,
   including its own retry loop (see Retry policy).
3. `await worker.stop()` — stops claiming new deliveries and waits (`Promise.allSettled`) for
   deliveries already executing to finish.
4. `db.close()`.

A force-exit timer is armed before any of this: `setTimeout(() => { log.error(...); process.exit(1); }, config.deliveryTimeoutMs + 10_000).unref()`. With the default `DELIVERY_TIMEOUT_MS=15000` that is
**25 s**. `webhook-out/ecosystem.config.cjs` sets PM2's `kill_timeout: 40000` (40 s), so at the
default configuration the app's own force-exit fires first, with 15 s of margin before PM2 would
SIGKILL. That margin is **not derived from `DELIVERY_TIMEOUT_MS`**, though: `DELIVERY_TIMEOUT_MS`
is operator-configurable up to 120 000 ms, and raising it (e.g. to 60 000) pushes the internal
force-exit to 70 000 ms — past the static 40 000 ms `kill_timeout` — so PM2 would SIGKILL the
process before its own graceful sequence, or even its own force-exit fallback, completes. This is
a real, currently-possible misconfiguration; see Known failure modes.

Separately, step 2 (`audit.close()`) runs **before** step 3 (`worker.stop()`), and `audit.close()`
flushes with its own internal retry loop of up to 6 attempts with backoff (cumulative sleeps of
roughly 1+2+4+8+16 s, plus up to 5 s per HTTP attempt) — so an unreachable audit service can, by
itself, consume more than the entire 25 s default force-exit budget before the worker is ever told
to stop draining. See Known failure modes.

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
  publishes cannot create two events either.
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

It does **not** parse, honour, or forward a `traceparent` header — as of this review's Stage 1,
`traceparent` propagation is implemented only in `gateway`. Neither of `webhook-out`'s own outbound
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

## Scaling model
**B — single-node stateful.** One process owns one SQLite file (`node:sqlite` `DatabaseSync`, WAL
mode, `busy_timeout` 5 000 ms). `ecosystem.config.cjs` pins `instances: 1` with the comment "one
process per SQLite file."

Two instances pointed at the same file today: SQLite's own file locking (`BEGIN IMMEDIATE` inside
`DeliveryStore.claim`, WAL + `busy_timeout`) prevents the *file* from being corrupted and prevents
the same delivery row from being claimed twice — the claim transaction is atomic per row regardless
of which process runs it. What is **not** safe or useful: every piece of runtime state that is not
in SQLite is per-process and would diverge between the two instances — `Worker.counters`
(`/v1/stats`, `/metrics`), the `AuditClient` buffer and flush timer, and the `/ready` cache — so an
operator querying one instance vs. the other would see different numbers for the same underlying
system, and both instances would independently poll and contend for the same write lock with no
throughput benefit.

## Single-node / multi-node guarantees
With exactly one instance (the only configuration this service is built, tested and documented
for), every guarantee above holds as stated. Running more than one instance today is not
prevented by the code, but is not supported, not tested, and gives no additional capacity: writes
serialize through SQLite's single-writer lock regardless of process count, and per-process
in-memory metrics/audit-buffer/readiness state will disagree across instances.

## Known failure modes
- **Disk full during a delivery settle.** `Worker#execute` calls `#settle()` (a SQLite write)
  inside its `try`, and again inside its `catch` if the first call throws. If the SQLite write
  itself fails (e.g. `ENOSPC`), the first `#settle()` throws, is caught, and the `catch` block
  calls `#settle()` a second time — which fails the same way and this time is not caught by
  anything inside `#execute`. That rejects the promise tracked in `Worker#inFlight`, which nothing
  in the normal poll loop (`#run`/`#pass`) awaits or catches individually — it surfaces as an
  unhandled promise rejection, which `Application`'s `process.on('unhandledRejection', …)` handler
  turns into a full `shutdown('unhandledRejection')`. In other words, a single disk-full write
  inside the delivery loop can bring the whole process down via the shutdown path, not just fail
  that one delivery.
- **Audit service unreachable at shutdown.** As described under Graceful shutdown, `audit.close()`
  runs before `worker.stop()` and can itself take longer than the default 25 s force-exit budget
  when the audit endpoint is down or hanging (up to ~6 retries with backoff, each with its own 5 s
  timeout). If it does, the force-exit timer fires and the process exits before the worker is ever
  asked to drain in-flight deliveries — those are simply killed mid-flight, to be recovered as
  `interrupted by restart` (one failed, retryable attempt) the next time the process starts. No
  data is corrupted, but the "graceful" part of shutdown does not reach the worker in this
  scenario.
- **`DELIVERY_TIMEOUT_MS` raised without touching `kill_timeout`.** The force-exit timer is
  `DELIVERY_TIMEOUT_MS + 10_000`; PM2's `kill_timeout` in `ecosystem.config.cjs` is a static
  `40000` unrelated to that env var. Raising `DELIVERY_TIMEOUT_MS` past 30 000 ms pushes the
  force-exit timer past PM2's `kill_timeout`, so PM2 sends `SIGKILL` before the application's own
  shutdown sequence — graceful or forced — has a chance to finish.
- **Killed without any graceful shutdown (SIGKILL, power loss).** Deliveries left `running` in
  SQLite are not reconciled by any background sweep; `Worker#recover()` only runs once, from
  `start()`, at the next process boot. If the process is killed and not restarted, those rows stay
  `running` indefinitely with no other path back to `pending`/`retrying`.
- **Two instances against one file.** As above: no corruption, no double-claiming of the same
  delivery row, but real write-lock contention under load and permanently inconsistent
  `/v1/stats`, `/metrics` and audit-buffering behaviour between the two processes — there is no
  coordination layer that would make running two instances a supported way to add capacity.
