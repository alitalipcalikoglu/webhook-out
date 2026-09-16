# Replaying events

Scenario: the partner's endpoint was misconfigured for two hours; deliveries died; or a new subscriber wants everything since midnight.

```bash
wcurl -X POST $WH/v1/subscriptions/sub_9f2c…/replay -d '{ "from": "2026-09-17T08:00:00Z", "to": "2026-09-17T10:00:00Z" }'
```

`202 { "queued": 137 }`: every stored event in the window (`to` exclusive, default now) whose type matches the subscription's patterns gets a **new** delivery. Existing deliveries are untouched, so a receiver that already processed some of them must de-duplicate on `X-Webhook-Id` ([receiving](receiving.md)).

- Works on paused and disabled subscriptions too; the deliveries wait until the subscription is resumed.
- Test events (`webhook.test`) are never replayed.
- The window is bounded by `EVENT_RETENTION_DAYS`; older events are gone.
- Large windows are processed in one transaction in batches of 1 000 events; a window with more than 1 000 events in the same millisecond stops at that millisecond (write the next call with `from` set to it).

Use `GET /v1/subscriptions/:id/deliveries?status=failed` first to see what died, and `GET /v1/events?type=order.paid` to eyeball the window.
