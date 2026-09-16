# Subscriptions

Scenario: a shipping partner ("Kargocu A") must be told when orders are paid or cancelled.

## 1. Create

```bash
wcurl -X POST $WH/v1/subscriptions -d '{
  "name": "kargocu-a",
  "description": "Shipping partner, production integration",
  "url": "https://api.kargocu-a.example/hooks/orders",
  "events": ["order.paid", "order.cancelled"],
  "headers": { "X-Tenant": "shop-1" }
}'
```

`201` with `Location: /v1/subscriptions/sub_…`:

```json
{
  "subscription": {
    "id": "sub_9f2c1a7e5b3d0c4e", "name": "kargocu-a", "description": "Shipping partner, production integration",
    "url": "https://api.kargocu-a.example/hooks/orders", "events": ["order.cancelled", "order.paid"], "headers": { "x-tenant": "shop-1" },
    "status": "active", "consecutiveFailures": 0, "lastDeliveryAt": null, "lastStatus": null, "secretRotatedUntil": null,
    "createdBy": "console", "createdAt": "2026-09-17T10:00:00.000Z", "updatedAt": "2026-09-17T10:00:00.000Z"
  },
  "secret": "whsec_k3Y…"
}
```

**The secret appears here once.** Hand it to the partner out of band; the service stores it encrypted (`SECRETS_KEY`) and never returns it again. Lost it? [Rotate](rotation.md).

## Event patterns

| Pattern | Matches |
|---|---|
| `order.paid` | exactly that type |
| `order.*` | `order.paid`, `order.item.added`, … (anything under `order.`) |
| `*` | every event |

Types are lower-case dot-separated segments (`^[a-z0-9]+([._-][a-z0-9]+)*(\.…)*$`). Patterns are validated when saved; a typo like `Order.*` is `400 INVALID_PATTERN`.

## Custom headers

Up to 10 `X-*` headers, printable ASCII, sent with every delivery. `Authorization` is not accepted: receivers authenticate the call by its signature ([receiving](receiving.md)). `X-Webhook-*` names are reserved.

## URL rules

`https://` only unless `TARGET_ALLOW_HTTP=true`; no credentials in the URL; host inside `TARGET_ALLOWED_HOSTS` when set; private and loopback addresses refused unless `TARGET_ALLOW_PRIVATE=true` (which requires the allowlist). Scheme, credentials and allowlist are checked on save; DNS and address class at delivery time.

## Pause and resume

```bash
wcurl -X PATCH $WH/v1/subscriptions/sub_9f2c1a7e5b3d0c4e -d '{ "enabled": false }'   # status: paused
wcurl -X PATCH $WH/v1/subscriptions/sub_9f2c1a7e5b3d0c4e -d '{ "enabled": true }'    # status: active
```

While paused (or automatically `disabled`, see [disable](disable.md)):

- events published meanwhile are **not queued** for this subscriber;
- deliveries already queued or retrying wait; they go out on resume;
- resuming resets the failure counter. To catch up on what was missed, [replay](replay.md) the window.

`PATCH` also takes `name`, `description`, `url`, `events`, `headers`; each is validated like on create.

## Delete

```bash
wcurl -X DELETE $WH/v1/subscriptions/sub_9f2c1a7e5b3d0c4e   # 204
```

Deletes the subscriber and its delivery history. Pause instead to keep the history.
