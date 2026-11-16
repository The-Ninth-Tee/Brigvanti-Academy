// node tool/test-b2b.mjs  Tests for the B2B layer. Run before every push, next to the cap and payment tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerOnly } from '../netlify/lib/consumer-only.mjs';
import { createPayHandlers } from '../netlify/lib/pay.mjs';
import { createAccountDelete } from '../netlify/lib/account-delete.mjs';
import * as O from '../netlify/lib/b2b-orgs.mjs';
import { resolvePlan } from '../netlify/lib/coach-caps.mjs';

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

// Company data model
const T0 = Date.UTC(2026, 11, 1, 9);
const ORG = { orgId: 'northwind', name: 'Northwind Logistics', tenantId: 'northwind-x1y2', domains: ['northwind.example'], seats: 3, contractStart: T0, contractEnd: T0 + 365 * O.DAY, founding: true, source: 'invoice' };
const tok = (email, uid = 'u9', tenant = ORG.tenantId) => ({ uid, email, firebase: { tenant } });

check('a company record is validated', () => {
  assert.deepEqual(O.validateOrg(ORG), []);
  assert.deepEqual(O.validateOrg({ ...ORG, orgId: 'X', domains: [], seats: 0, contractEnd: T0 }), ['orgId', 'domains', 'seats', 'contract']);
});

check('invites keep only email and department, and respect seats, domain and duplicates', () => {
  const r = O.planInvites(ORG, [], [
    { email: ' Sam@Northwind.example ', department: 'Customer service', jobTitle: 'never stored' },
    { email: 'sam@northwind.example', department: 'Sales' },
    { email: 'pat@gmail.com', department: 'Sales' },
    { email: 'not-an-email', department: 'Sales' },
    { email: 'a@northwind.example' }, { email: 'b@northwind.example' }, { email: 'c@northwind.example' },
  ], T0 + O.DAY);
  assert.equal(r.add.length, 3);
  assert.deepEqual(Object.keys(r.add[0].member).sort(), ['deleteAfter', 'department', 'email', 'endedAt', 'firstSignInAt', 'invitedAt', 'status', 'uid']);
  assert.equal(r.add[0].member.email, 'sam@northwind.example');
  assert.deepEqual(r.refused.map((x) => x.reason), ['already_has_seat', 'wrong_domain', 'invalid_email', 'no_seats_left']);
  assert.equal(r.left, 0);
  assert.equal(O.planInvites(ORG, [], [{ email: 'a@northwind.example' }], T0 - O.DAY).refused[0].reason, 'contract_not_active');
});

check('first sign-in binds the seat only through the company tenant and the invited email', () => {
  const m = O.planInvites(ORG, [], [{ email: 'sam@northwind.example', department: 'Sales' }], T0).add[0].member;
  const now = T0 + 2 * O.DAY;
  assert.equal(O.activate(ORG, m, tok('sam@northwind.example', 'u9', 'other-tenant'), now).error, 'wrong_tenant');
  assert.equal(O.activate(ORG, m, { uid: 'u9', email: 'sam@northwind.example' }, now).error, 'wrong_tenant', 'a consumer token never activates a seat');
  assert.equal(O.activate(ORG, m, tok('pat@northwind.example'), now).error, 'wrong_email');
  const a = O.activate(ORG, m, tok('sam@northwind.example'), now);
  assert.equal(a.member.status, 'active');
  assert.equal(a.member.firstSignInAt, now);
  assert.equal(resolvePlan(a.entitlement, now), 'b2b');
  assert.equal(O.activate(ORG, a.member, tok('sam@northwind.example', 'u10'), now).error, 'seat_bound');
});

check('a removed seat stops the coach at once and is deleted after 30 days', () => {
  const m = O.activate(ORG, O.planInvites(ORG, [], [{ email: 'sam@northwind.example' }], T0).add[0].member, tok('sam@northwind.example'), T0).member;
  const at = T0 + 10 * O.DAY;
  const e = O.endSeat(m, at);
  assert.equal(e.status, 'ended');
  assert.equal(e.deleteAfter, at + 30 * O.DAY);
  assert.equal(resolvePlan(O.entitlementFor(ORG, e), at), 'b2b_ended', 'coach cap 0 from that moment');
  assert.equal(O.endSeat(e, at + O.DAY).deleteAfter, e.deleteAfter, 'ending twice does not extend the 30 days');
  const inv = O.endSeat({ email: 'x@northwind.example', status: 'invited', uid: null }, at);
  assert.equal(inv.status, 'removed');
  assert.equal(inv.deleteAfter, at, 'an unused invite has nothing to keep');
});

check('the contract end ends access for every seat', () => {
  const m = O.activate(ORG, O.planInvites(ORG, [], [{ email: 'sam@northwind.example' }], T0).add[0].member, tok('sam@northwind.example'), T0).member;
  assert.equal(resolvePlan(O.entitlementFor(ORG, m), ORG.contractEnd - 1), 'b2b');
  assert.equal(resolvePlan(O.entitlementFor(ORG, m), ORG.contractEnd), 'b2b_ended');
});

check('self deletion frees the seat for someone else', () => {
  const r1 = O.planInvites(ORG, [], [{ email: 'a@northwind.example' }, { email: 'b@northwind.example' }, { email: 'c@northwind.example' }], T0);
  const members = r1.add.map((x) => x.member);
  members[0] = O.freeSeat(members[0], T0 + O.DAY);
  const r2 = O.planInvites(ORG, members, [{ email: 'd@northwind.example' }], T0 + O.DAY);
  assert.equal(r2.add.length, 1);
  assert.equal(members[0].uid, null);
});

check('company data stays in server-only paths', () => {
  const rules = read('firestore.rules');
  assert.ok(!/match\s+\/orgs/.test(rules) && !/match\s+\/entitlements/.test(rules), 'no browser rule for orgs or entitlements');
  assert.ok(!/match\s+\/\{document=\*\*\}/.test(rules), 'no catch-all rule');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
if (failed) { console.error(`\nB2B TESTS FAILED: ${failed}`); process.exit(1); }
console.log('\nB2B tests passed.');
