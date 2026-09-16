# Rotating a secret

```bash
wcurl -X POST $WH/v1/subscriptions/sub_9f2c…/rotate
```

```json
{ "subscription": { "id": "sub_9f2c…", "secretRotatedUntil": "2026-09-18T10:00:00.000Z", … }, "secret": "whsec_n3W…", "previousValidUntil": "2026-09-18T10:00:00.000Z" }
```

For `PREV_SECRET_GRACE_HOURS` (default 24) every delivery is signed with **both** secrets:

```
X-Webhook-Signature: t=1758103201,v1=<new>,v1=<old>
```

A receiver that checks "any `v1` matches" keeps working on the old secret and can switch whenever it is ready. After the grace only the new secret signs. `PREV_SECRET_GRACE_HOURS=0` cuts over at once.

Steps for the partner: receive the new secret out of band → deploy it → nothing else; deliveries never stop. Rotate again if the new secret leaked before it was deployed: each rotation starts a fresh grace period for the secret it replaces (the one before that stops signing).
