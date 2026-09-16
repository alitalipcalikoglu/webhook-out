# Retries and dead deliveries

The schedule is global, from `RETRY_SCHEDULE_SEC` (default `60,300,1800,7200,21600,86400`): after a retryable failure, retry 1 comes 1 minute later, retry 2 five minutes after that, then 30 min, 2 h, 6 h, 24 h. Seven attempts over roughly 33 hours, then the delivery is `failed` (dead).

```
attempt 1 ──503──▶ retrying (+60 s)
attempt 2 ──503──▶ retrying (+300 s)
attempt 3 ──200──▶ succeeded
```

## Retryable or not

Retried: `5xx`, `408`, `425`, `429`, timeouts, connection errors, DNS failures, attempts interrupted by a restart.

Failed at once: `3xx`, other `4xx`, a receiver on a private or blocked address, a subscription or event deleted while queued.

## Reading a delivery

```bash
wcurl $WH/v1/deliveries/8412
```

```json
{
  "delivery": {
    "id": 8412, "eventId": "evt_5d1e…", "subscriptionId": "sub_9f2c…", "status": "retrying",
    "attempt": 2, "maxAttempts": 7, "nextAttemptAt": "2026-09-17T10:06:02.310Z",
    "startedAt": "2026-09-17T10:01:01.001Z", "finishedAt": null, "durationMs": 15001,
    "httpStatus": null, "response": null, "error": "receiver timed out after 15000ms",
    "attempts": [
      { "n": 1, "startedAt": "2026-09-17T10:00:01.300Z", "durationMs": 812, "httpStatus": 503, "error": "receiver responded 503: upstream unavailable" },
      { "n": 2, "startedAt": "2026-09-17T10:01:01.001Z", "durationMs": 15001, "httpStatus": null, "error": "receiver timed out after 15000ms" }
    ],
    "createdAt": "2026-09-17T10:00:01.204Z"
  }
}
```

`error`, `httpStatus` and `response` describe the latest attempt; `attempts` keeps them all.

## Cancel

```bash
wcurl -X POST $WH/v1/deliveries/8412/cancel
```

Works while `pending` or `retrying` (`200`, status `cancelled`); a running attempt cannot be interrupted (`409 DELIVERY_NOT_CANCELLABLE`).

## Redeliver

After the receiver is fixed:

```bash
wcurl -X POST $WH/v1/deliveries/8412/redeliver
```

`202` with a **new** delivery of the same event to the same subscriber, starting at attempt 1. The old row stays as history. The receiver sees the same `X-Webhook-Id` again.

## Restart in the middle of an attempt

On startup, deliveries left `running` by the previous process are settled as a failed attempt (`error: "interrupted by restart"`) and continue on the schedule. PM2's `kill_timeout` is above `DELIVERY_TIMEOUT_MS` so a normal restart waits for in-flight calls instead.
