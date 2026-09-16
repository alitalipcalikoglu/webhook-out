import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, key roles, retry schedule', () => {
  const c = Config.fromEnv(testEnv());
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role]), [['console', 'readwrite'], ['dashboard', 'read'], ['ops', 'write'], ['shop-backend', 'publish']]);
  assert.equal(c.secretsKey.length, 32);
  assert.deepEqual(c.retryScheduleSec, [5, 10, 20]);
  assert.equal(c.disableAfterFailures, 2);
  assert.equal(c.deliveryTimeoutMs, 15_000);
  assert.equal(c.prevSecretGraceHours, 24);
  assert.deepEqual(Config.fromEnv(testEnv({ RETRY_SCHEDULE_SEC: '' })).retryScheduleSec, [60, 300, 1800, 7200, 21600, 86400]);
  assert.ok(Object.isFrozen(c));
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ WEBHOOK_API_KEYS: '' }, /WEBHOOK_API_KEYS is required/);
  bad({ WEBHOOK_API_KEYS: 'a:short' }, /at least 32/);
  bad({ WEBHOOK_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write, readwrite or publish/);
  bad({ SECRETS_KEY: 'abc' }, /64 hex characters/);
  bad({ RETRY_SCHEDULE_SEC: '10,5' }, /must not decrease/);
  bad({ RETRY_SCHEDULE_SEC: '0' }, />= 1/);
  bad({ RETRY_SCHEDULE_SEC: 'soon' }, /must be an integer/);
  bad({ TARGET_ALLOW_PRIVATE: 'true', TARGET_ALLOWED_HOSTS: '' }, /TARGET_ALLOWED_HOSTS is required/);
  bad({ DELIVERY_TIMEOUT_MS: '500' }, />= 1000/);
  bad({ TLS_CERT_PATH: '/x.pem' }, /must be set together/);
});
