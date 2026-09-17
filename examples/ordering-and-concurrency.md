# Ordering and per-subscription concurrency

## Best-effort ordered delivery

Most subscribers don't care what order events arrive in. Some do — a subscriber that maintains a
running balance from `payment.captured`/`payment.refunded` events, for example, breaks if a refund
is ever processed before its matching capture. Set `ordered: true` on that subscription:

```bash
wcurl -X POST $WH/v1/subscriptions -d '{
  "name": "ledger-sync", "url": "https://ledger.example.com/webhooks",
  "events": ["payment.captured", "payment.refunded"], "ordered": true
}'
```

Once set, the worker never starts a later delivery for `ledger-sync` while an earlier one (by
creation order) is still `pending`, `running` or `retrying` — including while the earlier one is
waiting out its own retry backoff. A `payment.refunded` delivery queued after a still-retrying
`payment.captured` delivery simply waits its turn.

**This is best-effort ordering, not a stronger guarantee.** It does not mean exactly-once delivery
(retries still happen), and it does not order deliveries *across* different subscriptions — only
within one `ordered` subscription's own queue. A redelivery (`POST .../redeliver`) or a replayed
event is its own new, later-ordered delivery; if your receiver needs to recognize "this is the same
underlying event as before," that's still its own idempotency check on `X-Webhook-Id`, same as
today.

`ordered` defaults to `false`; every existing subscription is unaffected until you opt one in.

## Per-subscription concurrency cap

By default, an unordered subscription with a large backlog can claim as many of the worker's
`WORKER_CONCURRENCY` slots as are free — a burst of retries for one flaky receiver could, in
principle, crowd out every other subscription's deliveries. `SUBSCRIPTION_CONCURRENCY_MAX`
(default `4`) bounds how many of any ONE unordered subscription's deliveries may be `running` at
once, worker-wide, regardless of how many processes are running the worker loop. An `ordered`
subscription's effective cap is always exactly 1 — `SUBSCRIPTION_CONCURRENCY_MAX` doesn't loosen
that.

There's no per-subscription override today — it's one setting applied to every unordered
subscription. Raise it in `.env` (`SUBSCRIPTION_CONCURRENCY_MAX=8`) if your subscribers are
consistently fast and you want more parallelism per subscription; lower it if a single noisy
subscriber has been observed to dominate the queue.

## Checking a subscription's setting

```bash
wcurl $WH/v1/subscriptions/sub_9f2c1a2b3c4d5e6f
```

```json
{ "subscription": { "id": "sub_9f2c1a2b3c4d5e6f", "name": "ledger-sync", "ordered": true, "…": "…" } }
```

`PATCH` toggles it like any other field: `{ "ordered": false }` turns ordering back off (existing
queued deliveries are unaffected either way — the claim rule is evaluated fresh every poll).
