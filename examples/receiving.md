# Receiving a webhook

## What arrives

```
POST /hooks/orders HTTP/1.1
Host: api.kargocu-a.example
Content-Type: application/json
User-Agent: atc-webhook-out/1.0
X-Tenant: shop-1                          ← subscription headers
X-Webhook-Id: evt_5d1e…                   ← event id, same on every retry
X-Webhook-Event: order.paid
X-Webhook-Delivery: 8412
X-Webhook-Attempt: 1
X-Webhook-Subscription: sub_9f2c…
X-Webhook-Timestamp: 2026-09-17T10:00:01.300Z
X-Webhook-Signature: t=1758103201,v1=9f2c…
```

```json
{ "id": "evt_5d1e…", "type": "order.paid", "createdAt": "2026-09-17T10:00:01.204Z", "data": { "orderId": 4821, "total": 349.9, "currency": "TRY" } }
```

## Verify the signature

`v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. During a rotation the header carries two `v1` values; accept if any matches. Reject stale timestamps.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(secret, rawBody, header, toleranceSec = 300) {
  const parts = String(header ?? '').split(',');
  const t = Number(parts[0]?.startsWith('t=') ? parts[0].slice(2) : NaN);
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return parts.slice(1).some((p) => {
    if (!/^v1=[0-9a-f]{64}$/.test(p)) return false;
    const given = Buffer.from(p.slice(3), 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
```

Use the raw request bytes, not a re-serialised object. Fastify receiver:

```js
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => { req.rawBody = body; done(null, JSON.parse(body)); });
app.post('/hooks/orders', async (req, reply) => {
  if (!verifyWebhook(process.env.WEBHOOK_SECRET, req.rawBody, req.headers['x-webhook-signature'])) return reply.code(401).send();
  if (await seen(req.headers['x-webhook-id'])) return reply.code(200).send();   // duplicate
  await handle(req.body);                                                       // fast, or enqueue
  await markSeen(req.headers['x-webhook-id']);
  return reply.code(200).send();
});
```

## Duplicates

The same event id reaches you again after a timeout on our side, on a redelivery or a replay. Store processed `X-Webhook-Id`s (a table with a unique index is enough) and answer `200` for repeats without doing the work again.

## What counts as success

| Answer | Delivery |
|---|---|
| `2xx` | `succeeded`; the first KiB of the body is stored as `response` |
| `408`, `425`, `429`, `5xx` | attempt failed, retried on the [schedule](retries.md) |
| other `4xx`, any `3xx` | `failed` at once, no retry |
| timeout (`DELIVERY_TIMEOUT_MS`), connection or DNS error | attempt failed, retried |

Answer within the timeout: acknowledge quickly and process in the background if the work is slow. Redirects are not followed, so give the final URL.
