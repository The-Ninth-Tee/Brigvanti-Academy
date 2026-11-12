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
const notes = [];
const h = createPayHandlers({ verify, store, mollie, mail: async (u, k, d) => notes.push([u, k, d]), env: { URL: 'https://app.test' }, clock: () => now });
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

assert.deepEqual(notes.map((n) => n[1]), ['welcome', 'paid'], 'welcome on start, receipt on renewal');
assert.equal(notes[0][2].lang, 'en');

// A failed monthly debit is recorded without a message. Pay now catches up from the old due date.
const due = docs.bu1.periodEnd;
payments.tr_f1 = { id: 'tr_f1', status: 'failed', amount: { value: '13.99' }, metadata: { uid: 'u1', interval: 'month', kind: 'renew' } };
await hook('tr_f1'); await hook('tr_f1');
assert.equal(notes.length, 2, 'no mail from the webhook');
let gv = await (await h.manage(req('GET'))).json();
assert.equal(gv.failedUntil, due + GRACE_DAYS * DAY); assert.equal(gv.canPayNow, true);
r = await (await h.manage(req('POST', { action: 'paynow' }))).json();
const cid = r.checkout.split('/').pop();
assert.equal(payments[cid].metadata.kind, 'catchup');
Object.assign(payments[cid], { status: 'paid', amount: { value: '13.99' } });
now = due + 2 * DAY; await hook(cid);
assert.equal(docs.bu1.periodEnd, addPeriod(due, 'month'), 'catch-up keeps the subscription schedule');
assert.equal((await (await h.manage(req('GET'))).json()).failedUntil, null);
assert.equal(plan(), 'plus');
now = due - 2 * DAY;

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

// Yearly renewal in the last 30 days keeps the paid days, withdrawing it keeps the old year
for (const k of Object.keys(docs)) delete docs[k]; claims.clear();
now = Date.UTC(2028, 0, 1);
r = await (await h.start(req('POST', { interval: 'year', consent: true }))).json();
let y1 = r.checkout.split('/').pop(); Object.assign(payments[y1], { status: 'paid', amount: { value: '89.99' } }); await hook(y1);
const end1 = docs.bu1.periodEnd;
now = end1 - 40 * DAY;
assert.equal((await h.start(req('POST', { interval: 'year', consent: true }))).status, 409, 'too early to renew');
now = end1 - 10 * DAY;
assert.equal((await (await h.manage(req('GET'))).json()).canRenew, true);
r = await (await h.start(req('POST', { interval: 'year', consent: true }))).json();
assert.equal(docs.bu1.interval, 'year'); assert.equal(docs.bu1.periodEnd, end1, 'nothing changes before payment');
let y2 = r.checkout.split('/').pop(); Object.assign(payments[y2], { status: 'paid', amount: { value: '89.99' } }); await hook(y2);
assert.equal(docs.bu1.periodEnd, addPeriod(end1, 'year'), 'renewal starts at the old end');
now += 2 * DAY;
r = await (await h.manage(req('POST', { action: 'withdraw' }))).json();
assert.equal(r.refund, '89.99', 'full refund, the renewal had not started');
assert.equal(docs.bu1.periodEnd, end1); assert.equal(plan(), 'plus', 'old year still runs');
now = end1 + 1; assert.equal(plan(), 'free');

// Company accounts cannot buy Plus
for (const k of Object.keys(docs)) delete docs[k];
docs.eu1 = { product: 'b2b', validUntil: now + DAY };
assert.equal((await h.start(req('POST', { interval: 'month', consent: true }))).status, 409);

// Payments off without a key
const off = createPayHandlers({ verify, store, mollie: null, env: {}, clock: () => now });
assert.equal((await off.start(req('POST', { interval: 'month', consent: true }))).status, 503);
// A test-mode customer is not reused once the live key is in
{
  const made = [];
  const liveM = { ...mollie, customer: async (e, u) => { made.push(u); return { id: 'cst_live' }; } };
  const store2 = { ...store, billing: async () => ({ status: 'withdrawn', customerId: 'cst_test_old' }), entitlement: async () => null, setBilling: async () => {} };
  const hl = createPayHandlers({ verify, store: store2, mollie: liveM, env: { URL: 'https://app.test', MOLLIE_API_KEY: 'live_x' }, clock: () => now });
  await hl.start(req('POST', { interval: 'year', consent: true }));
  assert.equal(made.length, 1, 'new live customer');
  const ht = createPayHandlers({ verify, store: store2, mollie: liveM, env: { URL: 'https://app.test', MOLLIE_API_KEY: 'test_x' }, clock: () => now });
  await ht.start(req('POST', { interval: 'year', consent: true }));
  assert.equal(made.length, 1, 'test customer reused in test mode');
}
console.log('Payment tests passed.');

// Daily plan job: yearly email at 30 days, failed email on day 3, contract ends on day 5
const { planActions } = await import('../netlify/lib/plan-remind.mjs');
const T = Date.UTC(2029, 5, 1), D = 864e5;
const yb = { status: 'active', interval: 'year', periodEnd: T };
assert.deepEqual(planActions(yb, T - 40 * D), []);
assert.deepEqual(planActions(yb, T - 29 * D), ['yearly']);
assert.deepEqual(planActions({ ...yb, yearMailedFor: T }, T - 10 * D), [], 'once per year');
const mb = { status: 'active', interval: 'month', periodEnd: T, failedAt: T + D };
assert.deepEqual(planActions(mb, T + 2 * D), []);
assert.deepEqual(planActions(mb, T + 3 * D), ['failed']);
assert.deepEqual(planActions({ ...mb, failMailedFor: T }, T + 4 * D), [], 'one email only');
assert.deepEqual(planActions({ ...mb, failMailedFor: T }, T + 5 * D), ['end']);
assert.deepEqual(planActions({ ...mb, failedAt: null }, T + 6 * D), [], 'no failure, nothing to end');
const { planMail } = await import('../netlify/lib/pay-mail.mjs');
for (const k of ['welcome', 'paid', 'cancelled', 'withdrawn', 'yearly', 'failed']) for (const l of ['en', 'nl']) {
  const m = planMail(k, { lang: l, interval: 'month', amount: '13.99', startedAt: T, periodStart: T, periodEnd: T, withdrawUntil: T, paidAt: T, refund: '1.00', keepUntil: null, until: T }, 'https://app.test');
  assert.ok(m.subject && m.text.includes('legal@theninthtee.eu') && !m.text.includes('undefined') && !m.text.includes('Invalid'), k + l);
}
assert.ok(planMail('welcome', { lang: 'nl', interval: 'month', amount: '13.99', startedAt: T, periodEnd: T, withdrawUntil: T }, '').text.includes('€ 13,99'));
console.log('Reminder tests passed.');

// Seven year retention of payment records
const { decide: purge, purgeFrom, cutoff: purgeCutoff } = await import('../netlify/lib/billing-purge.mjs');
const paid2026 = Date.UTC(2026, 10, 11);
assert.equal(purgeFrom(paid2026), Date.UTC(2034, 0, 1), 'seven years after the year of payment');
assert.equal(purge({ status: 'withdrawn', lastPaidAt: paid2026 }, Date.UTC(2033, 11, 31)), 'keep');
assert.equal(purge({ status: 'withdrawn', lastPaidAt: paid2026 }, Date.UTC(2034, 0, 1)), 'delete');
assert.equal(purge({ status: 'active', periodEnd: Date.UTC(2035, 0, 1), lastPaidAt: paid2026 }, Date.UTC(2034, 5, 1)), 'keep', 'never while a plan runs');
assert.equal(purge({ status: 'pending', consent: { at: paid2026 } }, paid2026 + 10 * 864e5), 'keep');
assert.equal(purge({ status: 'pending', consent: { at: paid2026 } }, paid2026 + 31 * 864e5), 'delete', 'unpaid checkout after 30 days');
assert.equal(purge({ status: 'pending', consent: { at: paid2026 }, firstPaymentId: 'tr_1', lastPaidAt: paid2026 }, paid2026 + 31 * 864e5), 'keep', 'paid before, new checkout pending');
assert.equal(purgeCutoff(Date.UTC(2034, 3, 1)), Date.UTC(2027, 0, 1));
console.log('Retention tests passed.');

// Account deletion removes plan and usage data and the sign in, keeps payment records
const { createAccountDelete } = await import('../netlify/lib/account-delete.mjs');
const acct = (bill, failCancel) => {
  const log = [];
  const del = createAccountDelete({
    verify, mollie: { cancelSubscription: async (c, s) => { if (failCancel) throw new Error('down'); log.push(['cancel', s]); } },
    store: {
      billing: async () => bill, markCancelled: async () => log.push(['mark']),
      deleteData: async (u) => log.push(['data', u]), deleteSignIn: async (u) => log.push(['signin', u]),
    },
  });
  return { del, log };
};
let a1 = acct({ status: 'active', subscriptionId: 'sub_9', customerId: 'cst_1', cancelled: false });
assert.equal((await a1.del(req('POST'))).status, 200);
assert.deepEqual(a1.log.map((x) => x[0]), ['cancel', 'mark', 'signin', 'data'], 'cancel first, sign in before data');
let a2 = acct({ status: 'active', subscriptionId: 'sub_9', customerId: 'cst_1', cancelled: false }, true);
assert.equal((await a2.del(req('POST'))).status, 502); assert.equal(a2.log.length, 0, 'nothing deleted when cancel fails');
let a3 = acct(null);
assert.equal((await a3.del(req('POST'))).status, 200); assert.deepEqual(a3.log.map((x) => x[0]), ['signin', 'data']);
assert.equal((await a3.del(req('POST', null, 'bad'))).status, 401);
console.log('Account delete tests passed.');
