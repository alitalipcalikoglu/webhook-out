# Events and deliveries

## Events

```bash
wcurl "$WH/v1/events?type=order.paid&limit=50"
wcurl "$WH/v1/events/evt_5d1e…"       # the event plus every delivery it produced
wcurl $WH/v1/event-types              # distinct types with counts and last seen, for pickers
```

Newest first; keyset pagination with `nextBefore` → `before`. Test events are excluded.

## Deliveries

```bash
wcurl "$WH/v1/deliveries?status=failed&limit=50"
wcurl "$WH/v1/deliveries?subscription=sub_9f2c…&status=retrying"
wcurl "$WH/v1/deliveries?event=evt_5d1e…"
wcurl "$WH/v1/subscriptions/sub_9f2c…/deliveries"
```

Filters: `status` (`pending`, `running`, `retrying`, `succeeded`, `failed`, `cancelled`), `subscription`, `event`. `limit` ≤ 200; `nextBefore` → `before`.

## Stats

```bash
wcurl $WH/v1/stats
```

```json
{
  "subscriptions": { "active": 11, "paused": 1, "disabled": 1 },
  "events": { "total": 48210, "last24h": 1930 },
  "deliveries": {
    "byStatus": { "pending": 3, "running": 2, "retrying": 14, "succeeded": 61020, "failed": 88, "cancelled": 4 },
    "last24h": { "pending": 3, "running": 2, "retrying": 14, "succeeded": 2410, "failed": 6, "cancelled": 0 },
    "backlog": { "queued": 17, "oldestAt": "2026-09-17T08:41:00.000Z" },
    "avgDurationMs24h": 212,
    "topFailures24h": [{ "subscriptionId": "sub_9f2c…", "failed": 6 }]
  },
  "worker": { "running": true, "inFlight": 2, "concurrency": 16, "sinceStart": { "succeeded": 2410, "failed": 6, "retried": 40, "disabled": 0 } }
}
```

`backlog.oldestAt` growing means receivers are slow or the worker is starved; raise `WORKER_CONCURRENCY` or look at the top failures.

## Retention

Events older than `EVENT_RETENTION_DAYS` (default 30) are deleted once a minute together with their deliveries, whatever their status. Subscriptions are kept until deleted.
