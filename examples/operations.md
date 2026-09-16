# Operations

## Probes

```bash
curl -s $WH/health   # {"status":"ok"}
curl -s $WH/ready    # {"status":"ok","worker":"running"} when SQLite answers; 503 otherwise (cached 10 s)
```

## Metrics

```bash
wcurl $WH/metrics
```

```
webhook_subscriptions{status="active"} 11
webhook_subscriptions{status="disabled"} 1
webhook_events_total 48210
webhook_deliveries{status="retrying"} 14
webhook_deliveries_finished_total{status="succeeded"} 2410
webhook_deliveries_finished_total{status="failed"} 6
webhook_attempts_retried_total 40
webhook_subscriptions_disabled_total 0
webhook_backlog 17
webhook_oldest_queued_age_seconds 95
webhook_in_flight 2
webhook_process_uptime_seconds 86400
```

Alert on `webhook_oldest_queued_age_seconds` growing past your retry schedule's first step, on `webhook_subscriptions{status="disabled"}` above zero, and on `webhook_deliveries_finished_total{status="failed"}` increasing.

## Environment

Required: `WEBHOOK_API_KEYS`, `SECRETS_KEY`. Full list with defaults: [.env.example](../.env.example).

`SECRETS_KEY` encrypts every subscriber secret. Back it up with the same care as the database: with the database and without the key, no delivery can be signed and every subscription must be rotated. Changing the key has the same effect.

One process per database file; the worker lives inside the API process. Claims are transactional and per-row, so a second process on the same file would not double-deliver, but SQLite on a shared or network filesystem is not supported.

## Process manager

```bash
cp .env.example .env && $EDITOR .env
npm ci --omit=dev
pm2 start ecosystem.config.cjs
pm2 save && pm2 startup
pm2 reload webhook-out
```

`kill_timeout` is 40 s: SIGTERM stops accepting connections, stops claiming, waits for in-flight deliveries (at most `DELIVERY_TIMEOUT_MS`), closes the database. Raise it if you raise the timeout.

## Docker

```bash
docker build -t atc-webhook-out .
docker run -d -p 3009:3009 -v webhook-out-data:/data --env-file .env atc-webhook-out
```

## Logs

JSON lines. `Authorization` is redacted; subscriber secrets never appear. One line per delivery outcome (`delivered`, `attempt failed, retry scheduled`, `delivery failed`) with delivery, event, subscription, attempt, HTTP status and duration; one line when a subscription is disabled.

## Backups

```bash
sqlite3 data/webhook-out.db ".backup 'webhook-out-$(date +%F).db'"
```

Subscriptions (with sealed secrets), events and deliveries are the whole state; plus `SECRETS_KEY` from the environment.
