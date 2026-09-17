# webhook-out

Outbound webhooks for your platform: partners subscribe to event types, your backends publish events, the service fans each event out to every matching subscriber with an HMAC-signed POST, retries on a schedule, disables endpoints that keep failing, and keeps the full delivery history. The counterpart of Stripe's or GitHub's webhooks inside your own product. HTTP only; the worker runs inside the same process.

Runtime dependencies: `fastify`, `@fastify/rate-limit`. Storage is SQLite via `node:sqlite` (built into Node 22.13+). The folder is self-contained: copy it to any host with Node 22 and run.

## Run

```bash
cp .env.example .env        # set WEBHOOK_API_KEYS and SECRETS_KEY
npm ci
npm run dev
```

Production with PM2 (reads `./.env` through Node's `--env-file`):

```bash
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
```

Production with Docker (mount the database directory):

```bash
docker build -t atc-webhook-out .
docker run -p 3009:3009 -v webhook-out-data:/data --env-file .env atc-webhook-out
```

Tests and type check:

```bash
npm test
npm run typecheck
```

## Model

- **A subscription** is a receiver: `name`, `url`, event patterns (`order.paid`, `order.*`, `*`), custom `X-*` headers, a signing secret shown once at creation and stored encrypted (`SECRETS_KEY`, AES-256-GCM). Status `active`, `paused` (by an operator) or `disabled` (automatically, after `DISABLE_AFTER_FAILURES` consecutive dead deliveries). Paused and disabled subscribers receive no new events; their queued deliveries wait.
- **An event** is `{ type, data }` from a backend, optionally with an `idempotencyKey` (per publishing key). Publishing stores the event and queues one **delivery** per matching active subscription in the same transaction; `202` means queued for everyone.
- **A delivery** is one event to one subscriber through every attempt: `pending` → `running` → `succeeded` / `failed`, or `retrying` between attempts on `RETRY_SCHEDULE_SEC` (default 1 min, 5 min, 30 min, 2 h, 6 h, 24 h). `5xx`, `408`, `425`, `429`, timeouts and connection errors retry; other `4xx`, `3xx` and blocked targets fail at once. Interrupted attempts are retried after a restart.
- **Every call** carries `X-Webhook-Id` (event), `X-Webhook-Event`, `X-Webhook-Delivery`, `X-Webhook-Attempt`, `X-Webhook-Subscription`, `X-Webhook-Timestamp` and `X-Webhook-Signature` (`t=<unix>,v1=HMAC-SHA256(secret, "<t>.<body>")`, two `v1` values during a secret rotation). Only `2xx` is success; redirects are not followed.
- **Operator tools**: test event, replay of a time window, redelivery of one delivery, cancel, secret rotation with a dual-signed grace period.
- **Outbound safety**: `https://` only unless `TARGET_ALLOW_HTTP`; host allowlist; private and loopback addresses blocked unless `TARGET_ALLOW_PRIVATE` (which requires the allowlist); the resolved address is pinned; response capture bounded to 1 KiB.

## Boundaries

**Purpose:** durable, retryable delivery of business events to external subscriber URLs.

**Responsibilities:** subscription management (secret rotation, pause/resume); event publish and fan-out; retry/backoff; replay; redeliver; test-delivery; delivery history.

**Non-responsibilities:** webhook-out ≠ scheduler — it delivers events it's told about, it does not schedule recurring or time-based work. No cross-subscription ordering guarantee (one global concurrency pool, not per-subscription); no per-subscription in-flight cap today (documented gap, not yet built).

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Liveness; readiness (database, cached 10 s) with worker state; service identity (version, API version, capabilities, schema version, service-core version). |
| POST | `/v1/subscriptions` | write | `{ name, url, events, description?, headers?, enabled? }` → `201 { subscription, secret }`. |
| GET | `/v1/subscriptions` | read | Sorted by name; `q`, `status`, `event`, `limit` ≤ 200, `cursor`. |
| GET / PATCH / DELETE | `/v1/subscriptions/:id` | read / write / write | Read; partial update incl. `enabled`; delete with its deliveries. |
| POST | `/v1/subscriptions/:id/rotate` | write | New secret → `{ subscription, secret, previousValidUntil }`. |
| POST | `/v1/subscriptions/:id/test` | write | Queue a `webhook.test` event for this subscriber → `202 { event, delivery }`. |
| POST | `/v1/subscriptions/:id/replay` | write | `{ from, to? }` → `202 { queued }`: re-queue matching events of the window. |
| GET | `/v1/subscriptions/:id/deliveries` | read | That subscriber's deliveries (`status`, `limit`, `before`). |
| POST | `/v1/events` | publish | `{ type, data, idempotencyKey? }` → `202 { event, deliveries, duplicate }` (`200` on a repeat). |
| GET | `/v1/events`, `/v1/events/:id` | read | Newest first (`type`, `limit`, `before`); one event with its deliveries. |
| GET | `/v1/event-types` | read | Distinct types with counts and last seen. |
| GET | `/v1/deliveries`, `/v1/deliveries/:id` | read | All deliveries (`status`, `subscription`, `event`, `limit`, `before`); one with every attempt. |
| POST | `/v1/deliveries/:id/redeliver`, `…/cancel` | write | New delivery of the same event (`202`); cancel a queued or retrying one. |
| GET | `/v1/stats` | read | Subscriptions by status, events, deliveries by status (all time, 24 h), backlog, top failures, worker. |
| GET | `/metrics` | read | Prometheus text. |

Error codes: `SUBSCRIPTION_NOT_FOUND`, `SUBSCRIPTION_EXISTS`, `EVENT_NOT_FOUND`, `DELIVERY_NOT_FOUND`, `DELIVERY_NOT_CANCELLABLE`, `INVALID_URL`, `INVALID_PATTERN`, `INVALID_HEADER`, `INVALID_EVENT_TYPE`, `INVALID_RANGE`, `EVENT_TOO_LARGE`, `VALIDATION_FAILED`, `INVALID_JSON`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`.

### Publish from a backend

```bash
curl -s -X POST http://localhost:3009/v1/events \
  -H "Authorization: Bearer $PUBLISH_KEY" -H "Content-Type: application/json" \
  -d '{ "type": "order.paid", "data": { "orderId": 4821, "total": 349.9 }, "idempotencyKey": "order-4821-paid" }'
```

## Examples

Scenario walkthroughs for every feature live in [examples/](examples/README.md), including [receiving and verifying a webhook](examples/receiving.md).

## Configuration

All settings come from environment variables and are validated at startup. See [.env.example](.env.example). Required: `WEBHOOK_API_KEYS`, `SECRETS_KEY`.

## Security notes

- API keys compared in constant time; per-key rate limit; `publish` keys can only inject events; roles checked before body validation.
- Subscriber secrets are generated here (`whsec_` + 256 random bits), returned once, sealed with AES-256-GCM under `SECRETS_KEY` and never logged or listed. Rotation keeps the old secret signing for a bounded grace.
- Subscription headers may not set `Authorization`; provenance is the signature. `X-Webhook-*` names are reserved.
- SSRF guard on every delivery: scheme, host allowlist, credentials in URL, private/special address ranges (IPv4 and IPv6 including mapped and NAT64 forms), pinned address, no redirects, bounded response capture.
- Event data is bounded (`MAX_EVENT_BYTES`), bodies capped (`BODY_LIMIT`), unknown fields rejected.
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every response; container runs as the unprivileged `node` user.

## Code layout

Class-based; dependencies are injected through constructors, `src/application.js` is the composition root.

| Class | File | Role |
|---|---|---|
| `Application` | `src/application.js` | Wiring, startup, graceful shutdown |
| `Config` | `src/config.js` | Validated environment, key roles, retry schedule |
| `Database` | `src/db.js` | SQLite connection, migrations, transactions |
| `SubscriptionStore`, `EventStore`, `DeliveryStore` | `src/store/` | Subscribers, events, the delivery queue and history |
| `SubscriptionService` | `src/domain/subscription-service.js` | Validation, sealed secrets, rotation, pause/resume |
| `EventService` | `src/domain/event-service.js` | Publish and fan-out, idempotency, test, replay, redeliver, cancel |
| `EventMatch`, `WebhookError` | `src/domain/` | Type and pattern rules, errors |
| `SecretBox` | `src/crypto/secret-box.js` | AES-256-GCM sealing of secrets at rest |
| `NetGuard`, `Signer`, `HttpCaller` | `src/net/` | SSRF guard, HMAC signatures, the outbound call |
| `Worker` | `src/worker.js` | Delivery loop, concurrency, retry schedule, auto-disable, recovery, retention |
| `WebhookApi`, `ApiKeyAuth`, `Schemas`, `Views` | `src/http/` | Fastify routes, roles, shapes |

## Out of scope by design

- Per-subscriber transformation of payloads: receivers get the event as published.
- Ordered delivery guarantees: put a sequence in `data`.
- Subscriber self-service (partners creating their own subscriptions): front this API with your own portal and a `write` key.
- Encryption of event payloads at rest: sign, do not encrypt; keep secrets out of `data`.
- True multi-host distribution: every process (API or worker, however many) must reach the same `DB_PATH` file on one host — there is no network-shared counter store. Splitting across hosts still means splitting subscribers across separate `webhook-out` instances, each with its own database.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## API/worker runtime split

`src/index.js` (default) runs both the HTTP API and the worker loop in one process — nothing about
existing single-process deployments changes. Two more entry points exist for a split deployment:
`src/api-main.js` (HTTP only, never claims a delivery) and `src/worker-main.js` (worker only, no
HTTP listener at all — PM2's own process state is the liveness signal). All three share the same
`Config`, the same database, the same migrations. `npm run api` / `npm run worker` run them
directly; `ecosystem.config.cjs` has the split apps ready to uncomment. An API-only process's
`/ready` and `/v1/stats` report worker liveness and in-flight count from the database
(`worker_heartbeat`, `deliveries.status = 'running'`) instead of an in-process `Worker` object.

## Lease ownership and scaling model

Every claimed delivery gets a fencing token (`owner_token`) and a lease (`lease_until`), not just a
status column. A worker renews the lease every `HEARTBEAT_MS` while a call is in flight
(`LEASE_MS`, default 30s; `HEARTBEAT_MS`, default 10s — must be well under `LEASE_MS`), so a call
taking longer than `LEASE_MS` never loses its lease on its own. If a worker crashes or hangs long
enough that its lease genuinely expires, another worker (or the same one, restarted) reclaims the
delivery as a failed attempt — following the normal retry schedule — and the fencing token means
the original worker cannot overwrite that outcome if it later finishes the call it no longer owns.

This makes **multiple worker processes against the same `DB_PATH` a supported topology**: the
commented-out split `webhook-out-worker` app in `ecosystem.config.cjs` can run with `instances` >
1. Claiming is atomic across processes (`BEGIN IMMEDIATE` around the whole read-decide-write),
proven with real cross-connection concurrency in `test/lease-concurrency.test.js`. Still one host,
one SQLite file — not a distributed counter store. See [docs/READINESS.md](docs/READINESS.md) for
the full contract.

## Observability

Every request gets a `reqId`, either generated or accepted unconditionally from an inbound
`X-Request-Id` (`requestIdHeader: 'x-request-id'`, matching every other internal-only service on
this platform). This service does not yet parse or forward the platform's `traceparent` header —
that is implemented in `gateway` only — and neither of its own outbound calls (subscriber
deliveries, audit batches) forwards a request id or trace context onward. `GET /metrics` mixes
database-backed counts (subscriptions, events, deliveries by status) with in-memory counters that
reset on restart (delivery outcomes since start, retries, disables). See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## Backup / restore

The state that matters is the SQLite file at `DB_PATH` plus, out of band, `SECRETS_KEY` (without
it, stored subscriber secrets are unreadable) and `WEBHOOK_API_KEYS` — neither lives in the
database. Use `stack backup`/`stack restore` from the workspace root (see `stack/docs/UPGRADE.md`)
to snapshot and restore the database consistently alongside the rest of the stack — it uses
`VACUUM INTO` against the live file, so a consistent copy does not require stopping the process or
risk missing data still in the WAL file. `SECRETS_KEY` and `WEBHOOK_API_KEYS` are not part of that
backup and must be captured separately. On every start, before applying a pending migration to an
existing database, the service itself also snapshots the file to `DB_PATH.pre-v<N>-<timestamp>`
(directory overridable with `DB_BACKUP_DIR`) — a manual last resort if `stack restore` is
unavailable. Restoring means putting the file back at `DB_PATH` with the *same* `SECRETS_KEY` that
sealed it, then verifying with `/ready` and a read call.

**Rollback limitations:** none of the migrations are reversible; to roll back, restore the
pre-migration copy (or a `stack backup` snapshot taken before the upgrade), with the matching
`SECRETS_KEY`, and run the previous version of this service against it. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
