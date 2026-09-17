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

## API

Errors are JSON: `{ "error": { "code", "message", "details?" } }`.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready` | none | Liveness; readiness (database, cached 10 s) with worker state. |
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
- Multi-node execution: one process per database; scale by splitting subscribers across instances.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, every completed write request is forwarded to the audit service as one event (`success`, or `denied` on 403) with the calling key as actor, the affected entity as target, client IP, user agent and request id. Events are buffered and sent in batches; the audit service being down never fails a request. Actions: see [examples/audit-events.md](examples/audit-events.md).

## Scaling model

One process owns one SQLite file (WAL mode); `ecosystem.config.cjs` pins `instances: 1` for this
reason. SQLite's own locking means a second instance against the same file would not corrupt data
or double-claim a delivery, but every piece of state that is not in SQLite — worker counters,
the audit-forwarding buffer, the `/ready` cache — is per-process, so two instances would disagree
with each other on `/v1/stats` and `/metrics` and gain no extra throughput. Running more than one
instance is not a supported deployment today. See [docs/READINESS.md](docs/READINESS.md) for the
full contract.

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
database. There is no backup automation in this repository yet: capture a consistent copy with the
process stopped, or with SQLite's own snapshot tools (`.backup` / `VACUUM INTO`) while it runs, since
plain `cp` can miss data still in the WAL file. Restoring means putting the file back at `DB_PATH`
with the *same* `SECRETS_KEY` that sealed it, then verifying with `/ready` and a read call. See
[docs/READINESS.md](docs/READINESS.md) for the full contract.

## License

MIT, see [LICENSE](LICENSE).
