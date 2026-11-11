// node tool/test-pay.mjs  Runs the payment handlers against a fake Mollie and store.
import assert from 'node:assert/strict';
import { createPayHandlers, withdrawRefund, accessUntil, addPeriod, GRACE_DAYS } from '../netlify/lib/pay.mjs';
import { resolvePlan } from '../netlify/lib/coach-caps.mjs';

const DAY = 86400000;
let now = Date.UTC(2026, 10, 11, 10);
const docs = {}, claims = new Set(), calls = [];
const store = {
  billing: async (u) => docs['b' + u] || null,
  entitlement: async (u) => docs['e' + u] || null,
  setBilling: async (u, d) => { docs['b' + u] = { ...(docs['b' + u] || {}), ...d }; },
  setEntitlement: async (u, d) => { docs['e' + u] = { ...(docs['e' + u] || {}), ...d }; },
  claim: async (u, id) => (claims.has(id) ? false : (claims.add(id), true)),
};
const payments = {}; let n = 0;
const mollie = {
  customer: async (email, uid) => { calls.push(['customer', email, uid]); return { id: 'cst_1' }; },
  payment: async (b) => { const id = 'tr_' + (++n); payments[id] = { id, status: 'open', ...b }; calls.push(['payment', b.sequenceType, b.amount.value]); return { id, _links: { checkout: { href: 'https://pay/' + id } } }; },
  getPayment: async (id) => payments[id],
  subscription: async (c, b) => { calls.push(['subscription', b.startDate, b.interval]); return { id: 'sub_1' }; },
  cancelSubscription: async (c, s) => { calls.push(['cancelSub', s]); return {}; },
  refund: async (id, v) => { calls.push(['refund', id, v]); return {}; },
};
const verify = async (t) => { if (t !== 'good') throw new Error('bad'); return { sub: 'u1', email: 'a@b.c', name: 'Nope' }; };
const h = createPayHandlers({ verify, store, mollie, env: { URL: 'https://app.test' }, clock: () => now });
const req = (method, body, auth = 'good') => new Request('https://x/', { method, headers: { authorization: 'Bearer ' + auth, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
const hook = (id) => h.webhook(new Request('https://x/', { method: 'POST', body: 'id=' + id }));
const plan = () => resolvePlan(docs.eu1, now);

assert.equal((await h.start(req('POST', { interval: 'month', consent: true }, 'bad'))).status, 401);
assert.equal((await h.start(req('POST', { interval: 'month' }))).status, 400, 'consent required');
let r = await (await h.start(req('POST', { interval: 'month', consent: true }))).json();
assert.equal(r.checkout, 'https://pay/tr_1');
assert.deepEqual(calls[0], ['customer', 'a@b.c', 'u1'], 'email only, no name');
assert.equal(plan(), 'free', 'no Plus before payment');

await hook('tr_1'); assert.equal(plan(), 'free', 'open payment grants nothing');
await hook('tr_999'); await hook('evil'); assert.equal(plan(), 'free');
payments.tr_1.status = 'paid'; payments.tr_1.customerId = 'cst_1';
await hook('tr_1'); await hook('tr_1');
assert.equal(plan(), 'plus');
assert.equal(calls.filter((c) => c[0] === 'subscription').length, 1, 'one subscription even on repeat webhook');
assert.equal(calls.find((c) => c[0] === 'subscription')[1], '2026-12-11');
assert.equal(docs.eu1.validUntil, addPeriod(now, 'month') + GRACE_DAYS * DAY);
assert.equal((await h.start(req('POST', { interval: 'year', consent: true }))).status, 409, 'no double plan');

let m = await (await h.manage(req('GET'))).json();
assert.equal(m.interval, 'month'); assert.ok(m.withdrawUntil);

// Renewal from the subscription
now += 30 * DAY;
payments.tr_r1 = { id: 'tr_r1', status: 'paid', amount: { value: '13.99' }, subscriptionId: 'sub_1', metadata: { uid: 'u1', interval: 'month', kind: 'renew' } };
await hook('tr_r1');
assert.equal(docs.bu1.periodEnd, addPeriod(addPeriod(Date.UTC(2026, 10, 11, 10), 'month'), 'month'));
assert.equal((await (await h.manage(req('POST', { action: 'withdraw' }))).json()).code, 'late');

// Cancel keeps access to the paid end, no grace
await h.manage(req('POST', { action: 'cancel' }));
assert.ok(calls.some((c) => c[0] === 'cancelSub'));
assert.equal(docs.eu1.validUntil, docs.bu1.periodEnd);
now = docs.bu1.periodEnd + 1; assert.equal(plan(), 'free', 'ends at period end');

// Yearly with withdrawal after 3 days
for (const k of Object.keys(docs)) delete docs[k];
now = Date.UTC(2027, 0, 1);
r = await (await h.start(req('POST', { interval: 'year', consent: true }))).json();
const yid = r.checkout.split('/').pop();
Object.assign(payments[yid], { status: 'paid', amount: { value: '89.99' } });
await hook(yid);
assert.equal(plan(), 'plus'); assert.equal(docs.eu1.validUntil, addPeriod(now, 'year'), 'yearly has no grace');
assert.ok(!calls.some((c) => c[0] === 'subscription' && c !== calls.find((x) => x[0] === 'subscription')), 'yearly makes no subscription');
now += 3 * DAY;
r = await (await h.manage(req('POST', { action: 'withdraw' }))).json();
assert.equal(r.refund, withdrawRefund('89.99', Date.UTC(2027, 0, 1), addPeriod(Date.UTC(2027, 0, 1), 'year'), now));
assert.equal(r.refund, '89.25'); assert.equal(plan(), 'free');

// Chargeback ends Plus
payments[yid].amountChargedBack = { value: '89.99' }; docs.eu1.tier = 'plus'; docs.eu1.validUntil = now + DAY * 100;
await hook(yid); assert.equal(plan(), 'free');

// Company accounts cannot buy Plus
for (const k of Object.keys(docs)) delete docs[k];
docs.eu1 = { product: 'b2b', validUntil: now + DAY };
assert.equal((await h.start(req('POST', { interval: 'month', consent: true }))).status, 409);

// Payments off without a key
const off = createPayHandlers({ verify, store, mollie: null, env: {}, clock: () => now });
assert.equal((await off.start(req('POST', { interval: 'month', consent: true }))).status, 503);
console.log('Payment tests passed.');
