# API keys and roles

`WEBHOOK_API_KEYS=id:secret[:role],…`

| Role | Can | Give to |
|---|---|---|
| `publish` | `POST /v1/events` only | every backend that emits events |
| `write` | manage subscriptions, rotate, test, replay, redeliver, cancel; publish | deploy tooling |
| `read` | list subscriptions, events, deliveries; stats; metrics | dashboards |
| `readwrite` | everything (default) | the admin console |

```env
WEBHOOK_API_KEYS=console:3f9a…,shop-backend:71cc…:publish,billing:b02e…:publish,grafana:e6d1…:read
```

The key id becomes `source` on events and `createdBy` on subscriptions. Secrets are compared in constant time against every configured secret.

## Three kinds of secrets

- `WEBHOOK_API_KEYS`: who may call this API.
- Subscriber secrets (`whsec_…`): sign deliveries; one per subscription, shown once, stored encrypted, rotated per subscription.
- `SECRETS_KEY`: encrypts the subscriber secrets at rest. Never shared with anyone.

## Rate limit

`RATE_LIMIT_MAX` requests per key per minute (default 1 200); `429 RATE_LIMITED`.

## Responses

| Status | Code | Meaning |
|---|---|---|
| 401 | `UNAUTHORIZED` | Missing or unknown secret; `WWW-Authenticate: Bearer`. |
| 403 | `FORBIDDEN` | Role does not allow the operation (checked before body validation). |
| 400 | `VALIDATION_FAILED`, `INVALID_JSON` | Schema or JSON problems. |
| 400 | `INVALID_URL`, `INVALID_PATTERN`, `INVALID_HEADER`, `INVALID_EVENT_TYPE`, `INVALID_RANGE` | Semantic problems. |
| 404 | `SUBSCRIPTION_NOT_FOUND`, `EVENT_NOT_FOUND`, `DELIVERY_NOT_FOUND`, `NOT_FOUND` | |
| 409 | `SUBSCRIPTION_EXISTS`, `DELIVERY_NOT_CANCELLABLE` | |
| 413 | `EVENT_TOO_LARGE` | Event data above `MAX_EVENT_BYTES`. |
| 429 | `RATE_LIMITED` | |

Errors are always `{ "error": { "code", "message", "details?" } }`.
