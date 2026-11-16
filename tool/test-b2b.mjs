// node tool/test-b2b.mjs  Tests for the B2B layer. Run before every push, next to the cap and payment tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerOnly } from '../netlify/lib/consumer-only.mjs';
import { createPayHandlers } from '../netlify/lib/pay.mjs';
import { createAccountDelete } from '../netlify/lib/account-delete.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const checks = [];
const check = (name, fn) => checks.push([name, fn]);

// Decoded tokens as the Admin SDK returns them. A tenant token carries firebase.tenant.
const TOKENS = {
  consumer: { uid: 'u1', email: 'a@b.c', firebase: { sign_in_provider: 'password' } },
  tenant: { uid: 'u2', email: 'sam@northwind.example', firebase: { sign_in_provider: 'saml.northwind', tenant: 'northwind-x1y2' } },
};
const adminVerify = async (t) => { if (!TOKENS[t]) throw new Error('bad'); return { ...TOKENS[t], sub: TOKENS[t].uid }; };
const verify = consumerOnly(adminVerify);
const req = (auth, body) => new Request('https://x/', { method: 'POST', headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

check('a consumer token passes unchanged', async () => {
  const u = await verify('consumer');
  assert.equal(u.sub, 'u1');
  assert.equal(u.email, 'a@b.c');
});

check('a company tenant token is refused', async () => {
  await assert.rejects(verify('tenant'));
  await assert.rejects(verify('nonsense'));
});

check('payments refuse a company tenant token with 401 and never reach Mollie', async () => {
  const calls = [];
  const store = { billing: async () => null, entitlement: async () => null, setBilling: async () => {}, setEntitlement: async () => {}, claim: async () => true };
  const mollie = new Proxy({}, { get: (_, k) => async () => { calls.push(k); return { id: 'x', _links: { checkout: { href: 'https://pay/x' } } }; } });
  const h = createPayHandlers({ verify, store, mollie, env: { URL: 'https://app.test' } });
  assert.equal((await h.start(req('tenant', { interval: 'month', consent: true }))).status, 401);
  assert.equal((await h.manage(new Request('https://x/', { headers: { authorization: 'Bearer tenant' } }))).status, 401);
  assert.deepEqual(calls, [], 'Mollie untouched');
  assert.notEqual((await h.start(req('consumer', { interval: 'month', consent: true }))).status, 401, 'consumer still reaches checkout');
});

check('account deletion refuses a company tenant token and deletes nothing', async () => {
  const done = [];
  const store = new Proxy({}, { get: (_, k) => async () => { done.push(k); return null; } });
  const del = createAccountDelete({ verify, store, mollie: null });
  assert.equal((await del(req('tenant'))).status, 401);
  assert.deepEqual(done, [], 'nothing touched');
});

check('both consumer functions are wired through consumerOnly', () => {
  for (const f of ['netlify/lib/pay-env.mjs', 'netlify/functions/account-delete.mjs']) {
    const s = read(f);
    assert.ok(/verify:\s*consumerOnly\(/.test(s), f);
  }
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
if (failed) { console.error(`\nB2B TESTS FAILED: ${failed}`); process.exit(1); }
console.log('\nB2B tests passed.');
