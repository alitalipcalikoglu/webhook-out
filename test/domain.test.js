import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SecretBox } from '../src/crypto/secret-box.js';
import { WebhookError } from '../src/domain/errors.js';
import { EventMatch } from '../src/domain/event-match.js';
import { Signer } from '../src/net/signer.js';
import { SECRETS_KEY, testService } from './helpers.js';

const iso = (/** @type {number|null} */ t) => (t === null ? null : new Date(t).toISOString());

test('EventMatch: types, patterns, matching', () => {
  assert.equal(EventMatch.assertType('order.paid'), 'order.paid');
  assert.equal(EventMatch.assertType('user.password-reset_v2'), 'user.password-reset_v2');
  for (const bad of ['Order.Paid', 'order..paid', '.order', 'order.', 'order paid', '']) assert.throws(() => EventMatch.assertType(bad), (e) => e instanceof WebhookError && e.code === 'INVALID_EVENT_TYPE', bad);
  assert.deepEqual(EventMatch.normalize([' order.paid', 'order.*', 'order.paid', '*']), ['*', 'order.*', 'order.paid']);
  for (const bad of [[], ['order.**'], ['*.paid'], ['Order.*']]) assert.throws(() => EventMatch.normalize(bad), (e) => e instanceof WebhookError && e.code === 'INVALID_PATTERN', JSON.stringify(bad));
  assert.ok(EventMatch.matches('*', 'anything.at.all'));
  assert.ok(EventMatch.matches('order.*', 'order.paid'));
  assert.ok(EventMatch.matches('order.*', 'order.item.added'));
  assert.ok(!EventMatch.matches('order.*', 'order'));
  assert.ok(!EventMatch.matches('order.*', 'orders.paid'));
  assert.ok(EventMatch.matches('order.paid', 'order.paid'));
  assert.ok(!EventMatch.matches('order.paid', 'order.paid.late'));
  assert.ok(EventMatch.any(['user.*', 'order.paid'], 'order.paid'));
  assert.ok(!EventMatch.any(['user.*'], 'order.paid'));
});

test('SecretBox: seals and opens, rejects tampering; Signer: two secrets during rotation', () => {
  const box = new SecretBox(Buffer.from(SECRETS_KEY, 'hex'));
  const secret = SecretBox.generate();
  assert.match(secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  const sealed = box.seal(secret);
  assert.notEqual(sealed, box.seal(secret), 'fresh iv every time');
  assert.equal(box.open(sealed), secret);
  const [v, iv, ct, tag] = sealed.split('.');
  assert.throws(() => box.open([v, iv, ct, tag.slice(0, -2) + 'AA'].join('.')));
  assert.throws(() => new SecretBox(Buffer.from(SECRETS_KEY, 'hex')).open('v0.x.y.z'), /unknown format/);
  assert.throws(() => new SecretBox(Buffer.alloc(16)), /32-byte/);

  const header = Signer.sign('{"a":1}', 1_758_000_000, ['new-secret', 'old-secret']);
  assert.match(header, /^t=1758000000,v1=[0-9a-f]{64},v1=[0-9a-f]{64}$/);
  const now = 1_758_000_100_000;
  assert.ok(Signer.verify('new-secret', '{"a":1}', header, { now }));
  assert.ok(Signer.verify('old-secret', '{"a":1}', header, { now }), 'receiver still on the old secret');
  assert.ok(!Signer.verify('other', '{"a":1}', header, { now }));
  assert.ok(!Signer.verify('new-secret', '{"a":2}', header, { now }), 'body mismatch');
  assert.ok(!Signer.verify('new-secret', '{"a":1}', header, { now: 1_758_001_000_000 }), 'too old');
  assert.ok(!Signer.verify('new-secret', '{"a":1}', 'garbage', { now }));
});

test('SubscriptionService: create, validation, update, pause/resume, rotate, delete', () => {
  const { subscriptionService: s, box, clock, config } = testService();
  const { row, secret } = s.create({ name: 'kargocu-a', url: 'https://api.partner.example/hooks', events: ['order.paid', 'order.*'], headers: { 'X-Tenant': 'shop-1' }, description: 'Cargo partner' }, 'console');
  assert.match(row.id, /^sub_[0-9a-f]{16}$/);
  assert.equal(row.status, 'active');
  assert.deepEqual(JSON.parse(row.events), ['order.*', 'order.paid']);
  assert.deepEqual(JSON.parse(row.headers), { 'x-tenant': 'shop-1' });
  assert.equal(box.open(row.secret_enc), secret, 'sealed at rest');
  assert.notEqual(row.secret_enc, secret);
  assert.deepEqual(s.signingSecrets(row), [secret]);
  assert.equal(s.create({ name: 'paused-one', url: 'https://api.partner.example/x', events: ['*'], enabled: false }, 'console').row.status, 'paused');

  const fails = (/** @type {any} */ input, /** @type {string} */ code, /** @type {RegExp} */ re) => assert.throws(() => s.create({ name: 'bad', url: 'https://api.partner.example/x', events: ['*'], ...input }, 'console'), (e) => e instanceof WebhookError && e.code === code && re.test(e.message), `${code}: ${re}`);
  fails({ name: 'kargocu-a' }, 'SUBSCRIPTION_EXISTS', /already exists/);
  fails({ url: 'ftp://api.partner.example/x' }, 'INVALID_URL', /scheme/);
  fails({ url: 'https://evil.example/x' }, 'INVALID_URL', /TARGET_ALLOWED_HOSTS/);
  fails({ url: 'https://u:p@api.partner.example/x' }, 'INVALID_URL', /credentials/);
  fails({ events: ['order.**'] }, 'INVALID_PATTERN', /pattern/);
  fails({ headers: { Authorization: 'x' } }, 'INVALID_HEADER', /not allowed/);
  fails({ headers: { 'X-Webhook-Id': 'x' } }, 'INVALID_HEADER', /not allowed/);
  fails({ headers: { 'X-A': 'ünïcode' } }, 'INVALID_HEADER', /printable ASCII/);

  clock.advance(1000);
  let u = s.update(row.id, { enabled: false, description: 'd2' });
  assert.deepEqual([u.status, u.description, u.updated_at > row.updated_at], ['paused', 'd2', true]);
  // Simulate the automatic disable, then resume: counter resets.
  s.subscriptions.recordOutcome(row.id, { at: clock.now(), status: 'failed', consecutiveFailures: 7, subscriptionStatus: 'disabled' });
  u = s.update(row.id, { enabled: true });
  assert.deepEqual([u.status, u.consecutive_failures], ['active', 0]);
  u = s.update(row.id, { events: ['user.*'], name: 'kargocu-b' });
  assert.deepEqual([JSON.parse(u.events), u.name], [['user.*'], 'kargocu-b']);
  assert.throws(() => s.update(row.id, { name: 'paused-one' }), (e) => e instanceof WebhookError && e.code === 'SUBSCRIPTION_EXISTS');

  const rotated = s.rotate(row.id);
  assert.notEqual(rotated.secret, secret);
  assert.equal(rotated.previousValidUntil, iso(clock.now() + config.prevSecretGraceHours * 3_600_000));
  assert.deepEqual(s.signingSecrets(rotated.row), [rotated.secret, secret], 'both secrets sign during the grace');
  clock.advance(config.prevSecretGraceHours * 3_600_000 + 1);
  assert.deepEqual(s.signingSecrets(/** @type {any} */ (s.get(row.id))), [rotated.secret], 'grace over');
  s.remove(row.id);
  assert.throws(() => s.get(row.id), (e) => e instanceof WebhookError && e.code === 'SUBSCRIPTION_NOT_FOUND');
});

test('EventService: publish fans out to matching active subscriptions; idempotency; test; replay; redeliver; cancel', () => {
  const { subscriptionService: s, eventService: ev, deliveries, clock } = testService();
  const a = s.create({ name: 'a', url: 'https://api.partner.example/a', events: ['order.*'] }, 'console').row;
  const b = s.create({ name: 'b', url: 'https://api.partner.example/b', events: ['*'] }, 'console').row;
  const c = s.create({ name: 'c', url: 'https://api.partner.example/c', events: ['user.*'] }, 'console').row;
  const p = s.create({ name: 'p', url: 'https://api.partner.example/p', events: ['*'], enabled: false }, 'console').row;
  let out = ev.publish({ type: 'order.paid', data: { orderId: 42 }, idempotencyKey: 'ord-42' }, 'shop-backend');
  assert.match(out.event.id, /^evt_[0-9a-f]{16}$/);
  assert.equal(out.duplicate, false);
  assert.deepEqual(out.deliveries.map((d) => d.subscription_id).sort(), [a.id, b.id].sort(), 'a and b match, c does not, p is paused');
  assert.equal(out.deliveries[0].max_attempts, 4, 'schedule of 3 retries = 4 attempts');
  assert.equal(out.deliveries[0].status, 'pending');
  const again = ev.publish({ type: 'order.paid', data: { orderId: 42 }, idempotencyKey: 'ord-42' }, 'shop-backend');
  assert.deepEqual([again.duplicate, again.event.id, again.deliveries.length], [true, out.event.id, 2], 'same source + key → original event, nothing new');
  assert.equal(ev.publish({ type: 'order.paid', data: {}, idempotencyKey: 'ord-42' }, 'other-backend').duplicate, false, 'keys are per source');
  assert.throws(() => ev.publish({ type: 'Order.Paid', data: {} }, 'x'), (e) => e instanceof WebhookError && e.code === 'INVALID_EVENT_TYPE');
  assert.throws(() => ev.publish({ type: 'big', data: 'x'.repeat(70_000) }, 'x'), (e) => e instanceof WebhookError && e.code === 'EVENT_TOO_LARGE');
  assert.deepEqual(ev.publish({ type: 'nobody.listens', data: null }, 'x').deliveries.map((d) => d.subscription_id), [b.id], 'only the catch-all subscription');

  const t = ev.test(p.id, 'console');
  assert.deepEqual([t.event.type, t.event.only_subscription, t.delivery.subscription_id], ['webhook.test', p.id, p.id], 'test goes to the one subscription even while paused');
  assert.equal(ev.events.list({}, { limit: 10 }).some((e) => e.type === 'webhook.test'), false, 'test events stay out of the event list');

  clock.advance(60_000);
  const replay = ev.replay(c.id, { from: Date.parse('2026-09-17T09:00:00Z'), to: clock.now() });
  assert.equal(replay.queued, 0, 'c has no matching events');
  const late = s.create({ name: 'late', url: 'https://api.partner.example/late', events: ['order.paid'] }, 'console').row;
  assert.equal(ev.replay(late.id, { from: Date.parse('2026-09-17T09:00:00Z'), to: clock.now() }).queued, 2, 'both order.paid events, the test event excluded');
  assert.throws(() => ev.replay(late.id, { from: 10, to: 5 }), (e) => e instanceof WebhookError && e.code === 'INVALID_RANGE');

  const d = out.deliveries[0];
  const again2 = ev.redeliver(d.id);
  assert.deepEqual([again2.event_id, again2.subscription_id, again2.status, again2.id !== d.id], [d.event_id, d.subscription_id, 'pending', true]);
  assert.equal(ev.cancel(again2.id).status, 'cancelled');
  assert.throws(() => ev.cancel(again2.id), (e) => e instanceof WebhookError && e.code === 'DELIVERY_NOT_CANCELLABLE');
  assert.throws(() => ev.delivery(999), (e) => e instanceof WebhookError && e.code === 'DELIVERY_NOT_FOUND');
  assert.deepEqual([1, 2, 3, 4].map((n) => ev.retryDelayMs(n)), [5000, 10_000, 20_000, null]);
  s.remove(b.id);
  assert.equal(deliveries.list({ subscriptionId: b.id }, { limit: 10 }).length, 0, 'deliveries go with the subscription');
});

test('EventService: publish falls back to the existing event on a UNIQUE violation, instead of a raw 500 (belt and braces)', () => {
  // The check-then-insert in publish() already can't race across connections (one BEGIN IMMEDIATE
  // transaction serializes it — see event-service.js's comment): a genuine race would need
  // byIdempotencyKey to miss at check time (nothing committed yet) and then insert() to conflict
  // anyway, with the SAME key resolving on a second lookup — the exact sequence forced below,
  // since single-threaded tests cannot otherwise produce a true TOCTOU here.
  const { subscriptionService: s, eventService: ev } = testService();
  s.create({ name: 'a', url: 'https://api.partner.example/a', events: ['*'] }, 'console');
  const concurrentWriter = ev.events.insert({ id: 'evt_concurrent', type: 'order.paid', data: '{}', idem_key: 'k1', source: 'shop', only_subscription: null, created_at: Date.now() });

  const realByIdem = ev.events.byIdempotencyKey.bind(ev.events);
  const realInsert = ev.events.insert.bind(ev.events);
  let byIdemCalls = 0;
  ev.events.byIdempotencyKey = (/** @type {string} */ source, /** @type {string} */ key) => (byIdemCalls++ === 0 ? undefined : realByIdem(source, key));
  ev.events.insert = () => {
    const err = /** @type {Error & { code: string }} */ (new Error('UNIQUE constraint failed: events.source, events.idem_key'));
    err.code = 'ERR_SQLITE_ERROR';
    throw err;
  };
  try {
    const dup = ev.publish({ type: 'order.paid', data: {}, idempotencyKey: 'k1' }, 'shop');
    assert.deepEqual([dup.duplicate, dup.event.id], [true, concurrentWriter.id], 'caught the forced UNIQUE violation and returned the concurrently-committed event instead of throwing');
  } finally {
    ev.events.byIdempotencyKey = realByIdem;
    ev.events.insert = realInsert;
  }
});
