# Automatic disable

Every delivery that exhausts its retries (or fails permanently) increments the subscription's `consecutiveFailures`; a success resets it to 0. When the counter reaches `DISABLE_AFTER_FAILURES` (default 10) the subscription becomes `disabled`:

```json
{ "id": "sub_9f2c…", "name": "kargocu-a", "status": "disabled", "consecutiveFailures": 10, "lastStatus": "failed", "lastDeliveryAt": "2026-09-19T03:12:44.000Z" }
```

From then on:

- new events are **not queued** for it (nothing piles up behind a dead endpoint);
- deliveries already queued or retrying wait, they are not cancelled;
- the log line `subscription disabled after consecutive failed deliveries` is emitted once, and `webhook_subscriptions{status="disabled"}` goes up in `/metrics`.

With the default schedule ten dead deliveries take at least ten events, each retried for ~33 hours, so a receiver that is down for an evening is not disabled; one that has been broken for days is.

## Resume

```bash
wcurl -X PATCH $WH/v1/subscriptions/sub_9f2c… -d '{ "enabled": true }'
```

`status: active`, counter back to 0, the waiting queue drains. Then [replay](replay.md) the window the subscriber missed:

```bash
wcurl -X POST $WH/v1/subscriptions/sub_9f2c…/replay -d '{ "from": "2026-09-19T03:00:00Z" }'
```

Change the URL in the same `PATCH` if the endpoint moved.

## Tuning

Set `DISABLE_AFTER_FAILURES` high (or the retry schedule long) for partners whose outages should never require an operator; set it low when a broken receiver should be noticed within the hour. The console shows disabled subscriptions in red with the failure count.
