// Deploy blocker for the coach cap. Runs on every Netlify build and in GitHub.
// Any failure stops the deploy, so the live version stays up.
// To change a cap on purpose, change it in coach-caps.mjs and in LOCKED below.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const GATE = 'netlify/lib/coach-gate.mjs';

const LOCKED = {
  caps: {
    free: { day: 2, month: 20 }, plus: { day: 20, month: 300 }, b2b: { day: 20, month: 300 },
    b2b_ended: { day: 0, month: 0 }, probe: { day: 0, month: 0 },
  },
  model: 'claude-opus-5-5', effort: 'medium', maxOutputTokens: 2500, maxInputChars: 14000,
  callsPerAssignment: 2, maxFreeRebuilds: 3, givebacksPerDay: 1,
};

const checks = [];
const check = (name, fn) => checks.push([name, fn]);

function walk(dir) {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f.startsWith('.')) return [];
    return statSync(join(ROOT, p)).isDirectory() ? walk(p) : [p];
  });
}

// Fakes for Firestore, Anthropic and sign in. The real gate code runs on them.
function fakeDb(seed = {}) {
  const docs = new Map(Object.entries(seed));
  let queue = Promise.resolve();
  const snap = (path) => ({ exists: docs.has(path), data: () => docs.get(path) });
  const ref = (path) => ({ path, get: async () => snap(path) });
  return {
    docs,
    doc: ref,
    runTransaction(fn) {
      const run = queue.then(() => fn({
        get: async (r) => snap(r.path),
        set: (r, data) => docs.set(r.path, { ...(docs.get(r.path) || {}), ...data }),
      }));
      queue = run.catch(() => {});
      return run;
    },
    batch() {
      const ops = [];
      return {
        set: (r, data) => ops.push([r.path, data]),
        commit: async () => {
          for (const [p, data] of ops) {
            const doc = { ...(docs.get(p) || {}) };
            for (const [k, v] of Object.entries(data)) doc[k] = (doc[k] || 0) + v;
            docs.set(p, doc);
          }
        },
      };
    },
  };
}

const BRIEF = JSON.stringify({ learn: 'l', do: 'd', good: ['g'], reflect: 'r' });
const reply = (text, stop = 'end_turn') => new Response(JSON.stringify({ content: [{ type: 'text', text }], stop_reason: stop }));
const okReply = () => reply(BRIEF);
const ENV = { BRIGVANTI_COACH_KEY: 'k' };
const NOW = Date.UTC(2026, 10, 2, 12);
const DAY = 'usage/u1/days/20261102';
const MONTH = 'usage/u1/months/202611';

async function harness({ seed, env = ENV, reply = okReply, store } = {}) {
  const { createCoachHandler, firestoreUsageStore } = await import(join(ROOT, GATE));
  const db = fakeDb(seed);
  const sent = [];
  const handler = createCoachHandler({
    verify: async (t) => { if (t !== 'good') throw new Error('bad'); return { sub: 'u1' }; },
    store: store || firestoreUsageStore(db, (n) => n),
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return reply(); },
    env, clock: () => NOW,
  });
  const call = (purpose, extra = {}, token = 'good') => handler(new Request('https://x/', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ system: 'rules', user: 'hello', purpose, assignmentKey: 'a1', ...extra }),
  }));
  const status = () => handler(new Request('https://x/', { headers: { authorization: 'Bearer good' } }));
  return { call, status, sent, db, used: () => [(db.docs.get(DAY) || {}).count || 0, (db.docs.get(MONTH) || {}).count || 0] };
}

const FUTURE = NOW + 864e5;
const seedFor = (ent) => ({ 'entitlements/u1': ent });

check('required files exist', () => {
  for (const f of ['netlify/functions/coach.mjs', 'netlify/lib/coach-caps.mjs', GATE,
    '.github/workflows/coach-cap.yml', 'tool/probe-coach-cap.mjs']) assert.ok(existsSync(join(ROOT, f)), f);
});

check('netlify.toml runs this check on every build', () => {
  assert.match(read('netlify.toml'), /command\s*=\s*"[^"]*node tool\/check-coach-cap\.mjs/);
});

check('GitHub runs this check on every push and probes the live coach daily', () => {
  const y = read('.github/workflows/coach-cap.yml');
  for (const s of ['push:', 'schedule:', 'tool/check-coach-cap.mjs', 'tool/probe-coach-cap.mjs']) assert.ok(y.includes(s), s);
});

check('cap numbers and token limits match the locked values', async () => {
  const { CAPS, LIMITS } = await import(join(ROOT, 'netlify/lib/coach-caps.mjs'));
  assert.deepEqual(JSON.parse(JSON.stringify(CAPS)), LOCKED.caps);
  for (const k of ['model', 'effort', 'maxOutputTokens', 'maxInputChars', 'callsPerAssignment', 'maxFreeRebuilds', 'givebacksPerDay']) assert.equal(LIMITS[k], LOCKED[k], k);
});

check('the coach function goes through the gate', () => {
  const c = read('netlify/functions/coach.mjs');
  assert.match(c, /export default createCoachHandler\(\{/);
  assert.match(c, /store: firestoreUsageStore\(db, FieldValue\.increment\)/);
  assert.equal((c.match(/export default/g) || []).length, 1);
  assert.ok(!/export const config/.test(c) || !/path:/.test(c), 'no alternate route on coach');
});

check('only the gate can reach Anthropic or hold the key', () => {
  const banned = /api\.anthropic\.com|x-api-key|BRIGVANTI_COACH_KEY|@anthropic-ai\/sdk|ANTHROPIC_BASE_URL|NETLIFY_AI_GATEWAY/;
  const self = 'tool/check-coach-cap.mjs';
  const offenders = walk('.').map((p) => relative('.', p)).filter((p) => /\.(mjs|js|cjs|ts|html|json|toml)$/.test(p))
    .filter((p) => p !== GATE && p !== self && banned.test(read(p)));
  assert.deepEqual(offenders, []);
  assert.ok(!/ANTHROPIC_API_KEY/.test(read('netlify/functions/coach.mjs')));
});

check('the browser does not choose a model, a token limit or a free call', () => {
  const h = read('index.html');
  assert.ok(!/claude-sonnet|claude-opus|max_tokens/.test(h));
  assert.ok(h.includes("d.code==='cap_reached'"));
  assert.ok(/'brief',true,meta\)/.test(h) && /,'feedback'\)/.test(h));
});

check('free: one assignment per day, both calls deducted at the build', async () => {
  const { call, sent, used } = await harness();
  assert.equal((await call('brief')).status, 200);
  assert.deepEqual(used(), [2, 2]);
  assert.equal((await call('feedback')).status, 200, 'step 4 is already paid');
  assert.deepEqual(used(), [2, 2]);
  const r = await call('brief', { assignmentKey: 'a2' });
  assert.equal(r.status, 429);
  const b = await r.json();
  assert.equal(b.code, 'cap_reached');
  assert.equal(b.scope, 'day');
  assert.equal(sent.length, 2);
});

check('free: the month cap is 20 calls, 10 assignments', async () => {
  const { call, sent } = await harness({ seed: { [MONTH]: { count: 18 } } });
  assert.equal((await call('brief')).status, 200);
  assert.equal((await call('feedback')).status, 200);
  const r = await call('brief', { assignmentKey: 'a2' });
  const b = await r.json();
  assert.equal(b.scope, 'month');
  assert.equal(b.refresh, '2026-12-01');
  assert.equal(sent.length, 2);
});

check('step 4 always fits: a build needs room for both calls', async () => {
  const { call, sent } = await harness({ seed: { [MONTH]: { count: 19 } } });
  assert.equal((await call('brief')).status, 429);
  assert.equal(sent.length, 0);
});

check('Plus and B2B: 20 calls per day, 300 per month', async () => {
  for (const ent of [{ product: 'b2c', tier: 'plus', validUntil: FUTURE }, { product: 'b2b', validUntil: FUTURE }]) {
    const { call, sent } = await harness({ seed: seedFor(ent) });
    for (let i = 0; i < 10; i++) {
      assert.equal((await call('brief', { assignmentKey: `a${i}` })).status, 200);
      assert.equal((await call('feedback')).status, 200);
    }
    assert.equal((await call('brief', { assignmentKey: 'x' })).status, 429);
    assert.equal(sent.length, 20);
    const full = await harness({ seed: { ...seedFor(ent), [MONTH]: { count: 299 } } });
    assert.equal((await full.call('brief')).status, 429);
  }
});

check('rebuilds are free inside an open assignment, up to 3', async () => {
  const { call, sent, used, db } = await harness();
  assert.equal((await call('brief')).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call('brief')).status, 200);
  assert.deepEqual(used(), [2, 2]);
  assert.equal(db.docs.get(MONTH).rebuilds, 3, 'rebuilds are measured');
  const r = await call('brief');
  assert.equal(r.status, 429);
  assert.equal((await r.json()).code, 'rebuild_limit');
  assert.equal(sent.length, 4);
});

check('after feedback a build is a new assignment, whatever the browser sends', async () => {
  const { call, used } = await harness({ seed: seedFor({ product: 'b2b', validUntil: FUTURE }) });
  await call('brief');
  await call('feedback');
  await call('brief', { rebuild: true, free: true, fresh: false });
  assert.deepEqual(used(), [4, 4]);
});

check('the browser can only add a deduction, never remove one', async () => {
  const seed = seedFor({ product: 'b2b', validUntil: FUTURE });
  const a = await harness({ seed });
  await a.call('brief');
  await a.call('brief', { fresh: true });
  assert.deepEqual(a.used(), [4, 4]);
  const b = await harness({ seed });
  await b.call('brief');
  await b.call('brief', { assignmentKey: 'other' });
  assert.deepEqual(b.used(), [4, 4]);
  const c = await harness();
  assert.equal((await c.call('feedback')).status, 200, 'step 4 with nothing open costs one call');
  assert.deepEqual(c.used(), [1, 1]);
});

check('a dropped reply gets one free retry per day, then costs a call', async () => {
  const { call, used } = await harness({ seed: seedFor({ product: 'b2b', validUntil: FUTURE }) });
  await call('brief');
  await call('feedback');
  assert.equal((await call('feedback')).status, 200);
  assert.deepEqual(used(), [2, 2]);
  assert.equal((await call('feedback')).status, 200);
  assert.deepEqual(used(), [3, 3]);
});

check('broken JSON in step 2 is given back', async () => {
  const { call, used } = await harness({ reply: () => reply('not json') });
  const r = await call('brief');
  assert.equal(r.status, 502);
  assert.equal((await r.json()).code, 'incomplete');
  assert.deepEqual(used(), [0, 0]);
});

check('a second broken step 2 stays charged but can be rebuilt for free', async () => {
  let good = false;
  const { call, used, sent } = await harness({
    seed: { ...seedFor({ product: 'b2b', validUntil: FUTURE }), [DAY]: { givebacks: 1 } },
    reply: () => (good ? okReply() : reply('not json')),
  });
  assert.equal((await call('brief')).status, 502);
  assert.deepEqual(used(), [2, 2]);
  good = true;
  assert.equal((await call('brief')).status, 200);
  assert.deepEqual(used(), [2, 2]);
  assert.equal(sent.length, 2);
});

check('a lapsed or malformed entitlement never raises the cap', async () => {
  for (const ent of [{ product: 'b2c', tier: 'plus', validUntil: NOW - 1 }, { product: 'b2c', tier: 'plus' },
    { tier: 'unlimited' }, { plan: 'plus' }]) {
    const { call } = await harness({ seed: { ...seedFor(ent), [DAY]: { count: 2 } } });
    assert.equal((await call('brief')).status, 429, JSON.stringify(ent));
  }
  const ended = await (await harness({ seed: seedFor({ product: 'b2b', validUntil: NOW - 1 }) })).call('feedback');
  assert.equal(ended.status, 429);
  assert.equal((await ended.json()).plan, 'b2b_ended');
});

check('zero cap plans get nothing, even with an open assignment', async () => {
  for (const ent of [{ tier: 'probe' }, { product: 'b2b', validUntil: NOW - 1 }]) {
    const { call, sent } = await harness({ seed: { ...seedFor(ent), 'usage/u1/assignment/open': { state: 'open', key: 'a1', rebuilds: 0 } } });
    assert.equal((await call('feedback')).status, 429);
    assert.equal((await call('brief')).status, 429);
    assert.equal(sent.length, 0);
  }
});

check('parallel calls cannot pass the cap', async () => {
  const { call, sent } = await harness();
  const r = await Promise.all(Array.from({ length: 8 }, (_, i) => call('brief', { assignmentKey: `a${i}` })));
  assert.equal(r.filter((x) => x.status === 200).length, 1);
  assert.equal(sent.length, 1);
});

check('fails closed: no key, retired key or broken store never reaches Anthropic', async () => {
  for (const env of [{}, { ...ENV, ANTHROPIC_API_KEY: 'old' }]) {
    const { call, sent } = await harness({ env });
    assert.equal((await call('feedback')).status, 503);
    assert.equal(sent.length, 0);
  }
  const broken = { entitlement: async () => { throw new Error('down'); }, reserve: async () => ({ call: { allowed: true } }) };
  const a = await harness({ store: broken });
  assert.equal((await a.call('feedback')).status, 503);
  const brokenReserve = { entitlement: async () => null, reserve: async () => { throw new Error('down'); } };
  const b = await harness({ store: brokenReserve });
  assert.equal((await b.call('feedback')).status, 503);
  assert.equal(a.sent.length + b.sent.length, 0);
});

check('the key injected by the Netlify AI Gateway does not lock the coach', async () => {
  const { call, sent } = await harness({ env: { ...ENV, ANTHROPIC_API_KEY: 'gateway', ANTHROPIC_BASE_URL: 'https://gateway' } });
  assert.equal((await call('brief')).status, 200);
  assert.equal(sent.length, 1);
});

const LEDGER_PLAN = 'ledger/202611/plans/b2b';
const measured = (stop = 'end_turn') => new Response(JSON.stringify({
  model: 'claude-opus-5-5', stop_reason: stop, content: [{ type: 'text', text: BRIEF }],
  usage: { input_tokens: 1000, output_tokens: 2000, output_tokens_details: { thinking_tokens: 1500 } },
}));

check('the ledger records tokens and cost per person, plan, day and company', async () => {
  const { call, db } = await harness({ seed: seedFor({ product: 'b2b', orgId: 'acme', validUntil: FUTURE }), reply: measured });
  await call('brief');
  await call('brief');
  for (const p of [LEDGER_PLAN, 'ledger/202611/days/20261102', 'ledger/202611/orgs/acme', MONTH]) {
    const d = db.docs.get(p);
    assert.equal(d.calls, 2, p);
    assert.equal(d.input, 2000, p);
    assert.equal(d.output, 4000, p);
    assert.equal(d.thinking, 3000, p);
    assert.ok(Math.abs(d.costEur - 0.079042) < 0.000002, p);
    assert.equal(d.kind_new, 1, p);
    assert.equal(d.kind_rebuild, 1, p);
  }
});

check('the ledger holds numbers only', async () => {
  const { call, db } = await harness({ reply: measured });
  await call('brief', { user: 'SECRET TEXT', system: 'SECRET RULES' });
  const all = JSON.stringify([...db.docs.entries()].filter(([k]) => k.startsWith('ledger/')));
  assert.ok(all.includes('calls') && !all.includes('SECRET'));
});

check('billed failures enter the ledger, unbilled failures do not', async () => {
  const seed = seedFor({ product: 'b2b', validUntil: FUTURE });
  const cut = await harness({ seed, reply: () => measured('max_tokens') });
  await cut.call('brief');
  assert.equal(cut.db.docs.get(LEDGER_PLAN).incomplete, 1);
  assert.equal(cut.db.docs.get(LEDGER_PLAN).calls, 1);
  const down = await harness({ seed, reply: () => new Response('no', { status: 500 }) });
  await down.call('brief');
  assert.equal(down.db.docs.get(LEDGER_PLAN), undefined);
});

check('a free user never writes to a company, and a broken ledger keeps the reply', async () => {
  const free = await harness({ seed: seedFor({ orgId: 'acme' }), reply: measured });
  await free.call('brief');
  assert.equal(free.db.docs.get('ledger/202611/orgs/acme'), undefined);
  assert.equal(free.db.docs.get('ledger/202611/plans/free').calls, 1);
  const { firestoreUsageStore } = await import(join(ROOT, GATE));
  const store = { ...firestoreUsageStore(fakeDb(), (n) => n), record: async () => { throw new Error('down'); } };
  const broken = await harness({ store });
  assert.equal((await broken.call('brief')).status, 200);
});

check('no sign in, no call', async () => {
  const { call, sent } = await harness();
  assert.equal((await call('feedback', {}, 'bad')).status, 401);
  assert.equal(sent.length, 0);
});

check('the browser cannot steer the request', async () => {
  const { call, sent } = await harness();
  await call('brief', { model: 'claude-fable-5-1', max_tokens: 64000, tools: [{}], stream: true });
  assert.deepEqual(Object.keys(sent[0]).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(sent[0].model, LOCKED.model);
  assert.equal(sent[0].max_tokens, LOCKED.maxOutputTokens);
  assert.deepEqual(sent[0].output_config, { effort: LOCKED.effort });
});

check('long input is trimmed and keeps the closing instructions', async () => {
  const { call, sent } = await harness();
  await call('brief', { user: `${'x'.repeat(50000)}END OF PROMPT` });
  const text = sent[0].messages[0].content;
  assert.ok(text.length + 'rules'.length <= LOCKED.maxInputChars);
  assert.ok(text.endsWith('END OF PROMPT'));
  const big = await harness();
  assert.equal((await big.call('brief', { system: 'x'.repeat(5000) })).status, 400);
});

check('failed calls are given back, and incomplete replies only once a day', async () => {
  const down = await harness({ reply: () => new Response('no', { status: 500 }) });
  assert.equal((await down.call('brief')).status, 502);
  assert.deepEqual(down.used(), [0, 0]);
  const open = await harness({ reply: () => new Response('no', { status: 500 }), seed: { 'usage/u1/assignment/open': { state: 'open', key: 'a1', rebuilds: 0 } } });
  await open.call('feedback');
  assert.equal(open.db.docs.get('usage/u1/assignment/open').state, 'open', 'finished work can still get feedback');
  const cut = () => reply('par', 'max_tokens');
  const { call, sent, used } = await harness({ seed: seedFor({ product: 'b2b', validUntil: FUTURE }), reply: cut });
  for (let i = 0; i < 12; i++) await call('feedback');
  assert.equal(sent.length, 12);
  assert.deepEqual(used(), [11, 11], 'an overlong prompt cannot get unlimited calls');
});

check('the counter shows assignments left', async () => {
  const { call, status } = await harness({ seed: { [MONTH]: { count: 4 } } });
  await call('brief');
  const b = await (await status()).json();
  assert.deepEqual(b.left, { day: 0, month: 7 });
  assert.equal(b.plan, 'free');
});

let failed = 0;
for (const [name, fn] of checks) {
  try { await fn(); console.log(`ok    ${name}`); }
  catch (e) { failed++; console.error(`FAIL  ${name}\n      ${e.message}`); }
}

if (process.env.NETLIFY && process.env.ANTHROPIC_API_KEY) {
  failed++;
  console.error('FAIL  ANTHROPIC_API_KEY is still set in Netlify. Remove it. The coach only reads BRIGVANTI_COACH_KEY.');
}

if (failed) {
  console.error(`\nCOACH CAP CHECK FAILED: ${failed} problem(s). Deploy blocked.`);
  process.exit(1);
}
console.log('\nCoach cap check passed.');
