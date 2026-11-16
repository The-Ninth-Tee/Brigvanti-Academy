// node tool/test-b2b.mjs  Tests for the B2B layer. Run before every push, next to the cap and payment tests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerOnly } from '../netlify/lib/consumer-only.mjs';
import { createPayHandlers } from '../netlify/lib/pay.mjs';
import { createAccountDelete } from '../netlify/lib/account-delete.mjs';
import * as O from '../netlify/lib/b2b-orgs.mjs';
import { learnerSummary, companyStats, HIDDEN } from '../netlify/lib/b2b-stats.mjs';
import { sweepOrphans } from '../netlify/lib/account-sweep.mjs';
import { runSeatEnd, DATA_ORDER } from '../netlify/lib/b2b-seat-end.mjs';
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
const ORG = { orgId: 'northwind', name: 'Northwind Logistics', tenantId: 'northwind-x1y2', domains: ['northwind.example'], departments: ['Customer service', 'Sales', 'Finance', 'HR', 'IT', 'Ops'], seats: 3, contractStart: T0, contractEnd: T0 + 365 * O.DAY, founding: true, source: 'invoice' };
const tok = (email, uid = 'u9', tenant = ORG.tenantId) => ({ uid, email, firebase: { tenant } });

check('a company record is validated', () => {
  assert.deepEqual(O.validateOrg({ ...ORG, seats: 20 }), []);
  assert.deepEqual(O.validateOrg({ ...ORG, seats: 19 }), ['seats'], 'no contract under 20 seats');
  assert.deepEqual(O.validateOrg({ ...ORG, orgId: 'X', domains: [], seats: 0, contractEnd: T0 }), ['orgId', 'domains', 'seats', 'contract']);
});

check('invites keep only email and department, and respect seats, domain and duplicates', () => {
  const r = O.planInvites(ORG, [], [
    { email: ' Sam@Northwind.example ', department: 'Customer service', jobTitle: 'never stored' },
    { email: 'sam@northwind.example', department: 'Sales' },
    { email: 'pat@gmail.com', department: 'Sales' },
    { email: 'not-an-email', department: 'Sales' },
    { email: 'a@northwind.example', department: 'sales ' }, { email: 'b@northwind.example', department: 'IT' }, { email: 'c@northwind.example', department: 'Ops' },
  ], T0 + O.DAY);
  assert.equal(r.add.length, 3);
  assert.equal(r.add[1].member.department, 'Sales', 'department stored as the company spells it');
  assert.deepEqual(Object.keys(r.add[0].member).sort(), ['deleteAfter', 'department', 'email', 'endedAt', 'firstSignInAt', 'invitedAt', 'status', 'uid']);
  assert.equal(r.add[0].member.email, 'sam@northwind.example');
  assert.deepEqual(r.refused.map((x) => x.reason), ['already_has_seat', 'wrong_domain', 'invalid_email', 'no_seats_left']);
  assert.equal(r.left, 0);
  assert.equal(O.planInvites(ORG, [], [{ email: 'a@northwind.example', department: 'Sales' }], T0 - O.DAY).refused[0].reason, 'contract_not_active');
});

check('departments come from the setup form and every seat picks one from it', () => {
  assert.deepEqual(O.cleanDepartments([' Sales ', 'Customer  service', '', 'Finance']), { departments: ['Sales', 'Customer service', 'Finance'] });
  assert.equal(O.cleanDepartments(['Sales', 'sales']).error, 'duplicate');
  assert.equal(O.cleanDepartments([]).error, 'empty');
  assert.equal(O.cleanDepartments(['x'.repeat(61)]).error, 'name_too_long');
  const none = O.planInvites({ ...ORG, departments: [] }, [], [{ email: 'a@northwind.example', department: 'Sales' }], T0);
  assert.equal(none.refused[0].reason, 'no_departments_set', 'no invites before the setup form');
  const typo = O.planInvites(ORG, [], [{ email: 'a@northwind.example', department: 'Sales team' }, { email: 'b@northwind.example' }], T0);
  assert.deepEqual(typo.refused.map((x) => x.reason), ['unknown_department', 'unknown_department']);
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
  const m = O.activate(ORG, O.planInvites(ORG, [], [{ email: 'sam@northwind.example', department: 'Sales' }], T0).add[0].member, tok('sam@northwind.example'), T0).member;
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
  const m = O.activate(ORG, O.planInvites(ORG, [], [{ email: 'sam@northwind.example', department: 'Sales' }], T0).add[0].member, tok('sam@northwind.example'), T0).member;
  assert.equal(resolvePlan(O.entitlementFor(ORG, m), ORG.contractEnd - 1), 'b2b');
  assert.equal(resolvePlan(O.entitlementFor(ORG, m), ORG.contractEnd), 'b2b_ended');
});

check('self deletion frees the seat for someone else', () => {
  const r1 = O.planInvites(ORG, [], [{ email: 'a@northwind.example', department: 'Sales' }, { email: 'b@northwind.example', department: 'Sales' }, { email: 'c@northwind.example', department: 'Sales' }], T0);
  const members = r1.add.map((x) => x.member);
  members[0] = O.freeSeat(members[0], T0 + O.DAY);
  const r2 = O.planInvites(ORG, members, [{ email: 'd@northwind.example', department: 'Sales' }], T0 + O.DAY);
  assert.equal(r2.add.length, 1);
  assert.equal(members[0].uid, null);
});

check('company data stays in server-only paths', () => {
  const rules = read('firestore.rules');
  assert.ok(!/match\s+\/orgs/.test(rules) && !/match\s+\/entitlements/.test(rules), 'no browser rule for orgs or entitlements');
  assert.ok(!/match\s+\/\{document=\*\*\}/.test(rules), 'no catch-all rule');
});

// Company totals and averages
const NOW = Date.UTC(2026, 11, 15, 12);
const NOV = Date.UTC(2026, 10, 10);
const state = (lv, reps = 0, t = NOW) => ({
  scan: { 'D1.1': { done: true, confirmed: lv }, 'D1.2': { done: true, confirmed: lv }, 'D2.1': { done: true, confirmed: lv }, 'D3.1': { done: false, confirmed: 4 }, 'D4.1': { done: true, skipped: true, confirmed: 4 } },
  reps: Array.from({ length: reps }, () => ({ c: 'D1.1', t })),
});
// people: [department, level, hand-ins this month]
function company(people, extra = []) {
  const members = [], summaries = {};
  people.forEach(([department, lv, reps], i) => {
    const uid = 'u' + i;
    members.push({ email: `p${i}@northwind.example`, department, status: 'active', uid, firstSignInAt: NOW - 9 * O.DAY });
    summaries[uid] = learnerSummary(state(lv, reps));
  });
  return companyStats({ org: { ...ORG, seats: 200 }, members: members.concat(extra), summaries, now: NOW });
}
const many = (dept, n, lv, reps = 1) => Array.from({ length: n }, () => [dept, lv, reps]);

check('a learner summary follows the app: lower median per area, unscanned and skipped skills left out', () => {
  const s = learnerSummary({ scan: { 'D1.1': { done: true, confirmed: 1 }, 'D1.2': { done: true, confirmed: 3 }, 'D1.3': { done: true, confirmed: 4 }, 'D2.1': { done: true, confirmed: 0 }, 'D3.1': { done: false, confirmed: 4 }, 'D4.1': { done: true, skipped: true } }, reps: [{ t: NOW }, { t: NOW }, { t: NOV }] });
  assert.deepEqual(s.areas, { D1: 3, D2: 0 });
  assert.equal(s.overall, 0);
  assert.deepEqual(s.handedIn, { 202612: 2, 202611: 1 });
});

check('nothing per person leaves: the output holds no email, uid or individual level', () => {
  const out = JSON.stringify(company([...many('Sales', 12, 2), ...many('Finance', 11, 3)]));
  assert.ok(!/@|"u\d+"|email|uid/.test(out));
  assert.ok(!/\d\.\d/.test(out), 'no precise averages');
});

check('a group under 5 shows no figure, and no count of 1 to 4 is shown', () => {
  const s = company(many('Sales', 4, 2));
  assert.deepEqual(s.companyLevel, HIDDEN);
  assert.deepEqual(s.activeThisMonth, HIDDEN);
  assert.deepEqual(s.assignmentsThisMonth, HIDDEN);
  assert.deepEqual(s.areas.D1, HIDDEN);
  const t = company([...many('Sales', 20, 2, 0), ...many('Sales', 3, 2, 1)]);
  assert.deepEqual(t.activeThisMonth, HIDDEN, '3 active of 23 is hidden');
  assert.deepEqual(t.assignmentsThisMonth, HIDDEN);
  const u = company(many('Sales', 6, 2, 2));
  assert.equal(u.activeThisMonth, 6);
  assert.equal(u.assignmentsThisMonth, 12);
});

check('the company level and area averages need 10 learners with a level', () => {
  const nine = company(many('Sales', 9, 2, 1));
  assert.deepEqual(nine.companyLevel, HIDDEN);
  assert.deepEqual(nine.areas.D1, HIDDEN);
  assert.equal(nine.activeThisMonth, 9, 'counts keep the 5 rule');
  const ten = company(many('Sales', 10, 2, 1));
  assert.deepEqual(ten.companyLevel, { level: 2 });
  assert.deepEqual(ten.areas.D1, { level: 2 });
});

check('departments show only on top of a shown company level', () => {
  // Sales has 12 seats and 7 learners with a level: its own rule is met, but the company level is hidden.
  const invited = Array.from({ length: 5 }, (_, i) => ({ email: `n${i}@northwind.example`, department: 'Sales', status: 'invited', uid: null }));
  const s = company(many('Sales', 7, 2), invited);
  assert.deepEqual(s.companyLevel, HIDDEN);
  assert.deepEqual(s.departments, [{ name: 'Sales', hidden: true }]);
  const t = company(many('Sales', 10, 2), invited);
  assert.deepEqual(t.departments, [{ name: 'Sales', people: 15, level: 2 }]);
});

check('a department needs 10 people with a seat and 5 placed learners', () => {
  const s = company([...many('Sales', 12, 2), ...many('Finance', 11, 3), ...many('HR', 6, 1), ...many('IT', 10, 4)]);
  const d = Object.fromEntries(s.departments.map((x) => [x.name, x]));
  assert.deepEqual(d.Sales, { name: 'Sales', people: 12, level: 2 });
  assert.deepEqual(d.HR, { name: 'HR', hidden: true }, 'no head count for a hidden department');
});

check('a hidden department can never be worked out from the company figure', () => {
  // HR (6) is hidden. Company minus Sales and Finance would reveal HR, so the smallest shown one hides too.
  const s = company([...many('Sales', 12, 2), ...many('Finance', 11, 3), ...many('HR', 6, 1)]);
  assert.ok(!s.companyLevel.hidden);
  const shown = s.departments.filter((x) => !x.hidden).map((x) => x.name);
  assert.deepEqual(shown, ['Sales']);
  // The rest behind the company figure is now Finance plus HR, 17 people: safe.
  const t = company([...many('Sales', 12, 2), ...many('Finance', 11, 3), ...many('HR', 6, 1), ...many('Ops', 6, 1)]);
  assert.deepEqual(t.departments.filter((x) => !x.hidden).map((x) => x.name).sort(), ['Finance', 'Sales'], '12 hidden people are safe');
  const u = company([...many('Sales', 12, 2), ...many('Finance', 11, 3)]);
  assert.equal(u.departments.filter((x) => !x.hidden).length, 2, 'nothing hidden, nothing to protect');
});

check('people without a department count in the hidden rest', () => {
  const s = company([...many('Sales', 12, 2), ...many('', 4, 1)]);
  assert.deepEqual(s.departments.filter((x) => !x.hidden).map((x) => x.name), []);
});

check('ended seats and invites without a sign-in are not counted as learners', () => {
  const ended = [{ email: 'x@northwind.example', department: 'Sales', status: 'ended', uid: 'gone', firstSignInAt: NOW }];
  const invited = Array.from({ length: 5 }, (_, i) => ({ email: `i${i}@northwind.example`, department: 'Sales', status: 'invited', uid: null, firstSignInAt: null }));
  const s = company(many('Sales', 6, 2), ended.concat(invited));
  assert.equal(s.seats.assigned, 11);
  assert.equal(s.seats.inUse, 6);
  assert.equal(s.activeThisMonth, 6);
});

check('company figures are marked self-reported until scoring runs on the server', () => {
  assert.equal(company(many('Sales', 10, 2)).selfReported, true);
});

// Consumer sweep and B2B seat end
check('the consumer sweep still removes orphaned consumer data, and never touches a company seat holder', async () => {
  const removed = [];
  const refsById = { c1: ['users/c1', 'usage/c1'], gone: ['users/gone', 'entitlements/gone'], seat: ['users/seat', 'entitlements/seat'], plusGone: ['entitlements/plusGone'] };
  const ents = { gone: null, seat: { product: 'b2b', orgId: 'northwind', validUntil: 0 }, plusGone: { product: 'b2c', tier: 'plus' } };
  const r = await sweepOrphans({
    refsById,
    getUsers: async (ids) => ({ notFound: ids.filter((u) => u !== 'c1') }),
    entitlement: async (uid) => ents[uid] || null,
    remove: async (ref) => removed.push(ref),
  });
  assert.deepEqual(removed.sort(), ['entitlements/gone', 'entitlements/plusGone', 'users/gone']);
  assert.deepEqual(r, { accounts: 4, removed: 2, companySkipped: 1 });
});

function seatStore(org, members, failSignIn = new Set()) {
  const log = [], ents = {};
  const mem = Object.fromEntries(members.map((m) => [m.seatId, { ...m }]));
  return {
    log, mem, ents,
    orgs: async () => [org],
    members: async () => Object.values(mem).map((m) => ({ ...m })),
    setMember: async (o, id, m) => { mem[id] = { ...mem[id], ...m }; log.push(['set', id, mem[id].status]); },
    deleteMember: async (o, id) => { delete mem[id]; log.push(['deleteMember', id]); },
    setEntitlement: async (uid, e) => { ents[uid] = e; },
    deleteSignIn: async (t, uid) => { if (failSignIn.has(uid)) throw new Error('auth down'); log.push(['deleteSignIn', t, uid]); },
    deleteData: async (path, uid) => log.push(['deleteData', path, uid]),
  };
}
const seat = (id, extra) => ({ seatId: id, email: id + '@northwind.example', department: 'Sales', status: 'active', uid: 'u-' + id, invitedAt: T0, firstSignInAt: T0, endedAt: null, deleteAfter: null, ...extra });

check('at contract end every seat ends, the coach stops, and nothing is deleted yet', async () => {
  const st = seatStore(ORG, [seat('a'), seat('b', { status: 'invited', uid: null, firstSignInAt: null })]);
  const r = await runSeatEnd({ store: st, now: ORG.contractEnd + O.DAY });
  assert.equal(r.ended, 2);
  assert.equal(st.mem.a.status, 'ended');
  assert.equal(st.mem.a.deleteAfter, ORG.contractEnd + 30 * O.DAY);
  assert.equal(resolvePlan(st.ents['u-a'], ORG.contractEnd + O.DAY), 'b2b_ended');
  assert.ok(!st.log.some((l) => l[0] === 'deleteSignIn'), 'no account deleted in the 30 days');
  assert.equal(r.invitesRemoved, 1, 'an unused invite has nothing to keep');
});

check('30 days after the seat ended the account goes: sign-in first, plan record last, then the seat', async () => {
  const st = seatStore(ORG, [seat('a', { status: 'ended', endedAt: T0, deleteAfter: T0 + 30 * O.DAY })]);
  await runSeatEnd({ store: st, now: T0 + 29 * O.DAY });
  assert.ok(st.mem.a, 'still there on day 29');
  const r = await runSeatEnd({ store: st, now: T0 + 30 * O.DAY });
  assert.equal(r.deleted, 1);
  const order = st.log.filter((l) => l[0] !== 'set').map((l) => l[0] === 'deleteData' ? l[1] : l[0]);
  assert.deepEqual(order, ['deleteSignIn', ...DATA_ORDER, 'deleteMember']);
  assert.equal(DATA_ORDER[DATA_ORDER.length - 1], 'entitlements');
  assert.equal(st.mem.a, undefined, 'the seat record with the email is gone');
  assert.deepEqual(st.log.find((l) => l[0] === 'deleteSignIn'), ['deleteSignIn', ORG.tenantId, 'u-a'], 'deleted in the company tenant');
});

check('a deletion that fails keeps all data, is marked and finishes on the next run', async () => {
  const fail = new Set(['u-a']);
  const st = seatStore(ORG, [seat('a', { status: 'ended', endedAt: T0, deleteAfter: T0 })], fail);
  const r1 = await runSeatEnd({ store: st, now: T0 + O.DAY });
  assert.equal(r1.failed, 1);
  assert.equal(st.mem.a.status, 'deleting');
  assert.ok(!st.log.some((l) => l[0] === 'deleteData'), 'no data deleted while the sign-in still works');
  fail.clear();
  const r2 = await runSeatEnd({ store: st, now: T0 + O.DAY });
  assert.equal(r2.deleted, 1);
  assert.equal(st.mem.a, undefined);
});

check('an active seat in a running contract is never touched', async () => {
  const st = seatStore(ORG, [seat('a')]);
  const r = await runSeatEnd({ store: st, now: T0 + 100 * O.DAY });
  assert.deepEqual(st.log, []);
  assert.equal(r.ended + r.deleted, 0);
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}
if (failed) { console.error(`\nB2B TESTS FAILED: ${failed}`); process.exit(1); }
console.log('\nB2B tests passed.');
