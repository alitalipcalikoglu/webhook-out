# webhook-out examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `WEBHOOK_API_KEYS`. Base URL below is `http://localhost:3009`.

| Example | Shows |
|---|---|
| [Subscriptions](subscriptions.md) | Creating a subscriber, event patterns, custom headers, the one-time secret, pause and resume |
| [Publishing events](publishing.md) | The publish call from your backends, idempotency keys, fan-out, what a 202 means |
| [Receiving a webhook](receiving.md) | What the receiver sees, verifying the signature, handling duplicates, what counts as success |
| [Retries and dead deliveries](retries.md) | The retry schedule, retryable versus permanent failures, cancel, redeliver |
| [Ordering and per-subscription concurrency](ordering-and-concurrency.md) | Best-effort `ordered: true` delivery, the per-subscription concurrency cap |
| [Automatic disable](disable.md) | Consecutive failures, the disabled state, resuming, catching up |
| [Replaying events](replay.md) | Re-queueing a time window for one subscriber after downtime or a late subscription |
| [Rotating a secret](rotation.md) | Dual-signed grace period, the receiver's steps |
| [Testing a subscription](testing.md) | The `webhook.test` event |
| [Events and deliveries](history.md) | Listing, filters, pagination, event types, stats |
| [API keys and roles](keys-and-roles.md) | read, write, readwrite, publish; error codes |
| [Operations](operations.md) | Health, readiness, metrics, environment, PM2, Docker, backups, the secrets key |
| [Audit events](audit-events.md) | Which write actions are forwarded to the audit service, event shape, configuration |

Set up once for the examples:

```bash
export WH=http://localhost:3009
export KEY=<a readwrite secret from WEBHOOK_API_KEYS>
alias wcurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
```
