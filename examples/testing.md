# Testing a subscription

```bash
wcurl -X POST $WH/v1/subscriptions/sub_9f2c…/test
```

`202`:

```json
{ "event": { "id": "evt_71cc…", "type": "webhook.test", "data": { "subscription": "sub_9f2c…", "name": "kargocu-a", "at": "2026-09-17T10:05:00.000Z" }, "test": true, … }, "delivery": { "id": 8413, "status": "pending", … } }
```

The event goes to this subscription only, whatever its patterns, and is signed and retried like any other delivery. Poll `GET /v1/deliveries/8413` for the outcome, or watch the receiver's log. Test events do not appear in `GET /v1/events`, are not counted in `/v1/event-types` and are never replayed.

A paused or disabled subscription still accepts a test; the delivery waits until it is resumed. Use it to confirm the endpoint before flipping `enabled`.
