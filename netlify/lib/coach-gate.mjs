// The only place that reaches Anthropic. Every call passes the cap first.
// Any failure before the reservation refuses the call. Never fail open.
import {
  CAPS, LIMITS, assignmentsLeft, decideCall, ledgerEntry, periodKeys, refreshDate,
  resolvePlan, trimUserText, undoCall, validAssignment,
} from './coach-caps.mjs';

const KEY_VAR = 'BRIGVANTI_COACH_KEY';
const RETIRED_KEY_VAR = 'ANTHROPIC_API_KEY';

const json = (obj, status) => new Response(JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json' },
});

export function firestoreUsageStore(db, increment) {
  const refs = (uid, keys) => ({
    day: db.doc(`usage/${uid}/days/${keys.day}`),
    month: db.doc(`usage/${uid}/months/${keys.month}`),
    open: db.doc(`usage/${uid}/assignment/open`),
  });
  const read = async (tx, r) => {
    const [d, m, o] = [await tx.get(r.day), await tx.get(r.month), await tx.get(r.open)];
    const day = d.exists ? d.data() : {};
    const month = m.exists ? m.data() : {};
    return {
      used: { day: Number(day.count) || 0, month: Number(month.count) || 0 },
      givebacks: Number(day.givebacks) || 0,
      rebuildsSeen: Number(month.rebuilds) || 0,
      open: o.exists ? o.data() : null,
    };
  };
  const write = (tx, r, s, rebuildsSeen) => {
    tx.set(r.day, { count: s.used.day, givebacks: s.givebacks }, { merge: true });
    tx.set(r.month, { count: s.used.month, rebuilds: rebuildsSeen }, { merge: true });
    if (s.open) tx.set(r.open, s.open);
  };
  return {
    async entitlement(uid) {
      const snap = await db.doc(`entitlements/${uid}`).get();
      return snap.exists ? snap.data() : null;
    },
    status(uid, keys) {
      const r = refs(uid, keys);
      return db.runTransaction((tx) => read(tx, r));
    },
    // A transaction, so parallel calls cannot slip past the cap.
    reserve(uid, keys, caps, request) {
      const r = refs(uid, keys);
      return db.runTransaction(async (tx) => {
        const s = await read(tx, r);
        const call = decideCall(s, caps, request);
        if (!call.allowed) return { call, used: s.used };
        const used = { day: s.used.day + call.charge, month: s.used.month + call.charge };
        write(tx, r, { used, open: call.open, givebacks: call.givebacks ?? s.givebacks },
          s.rebuildsSeen + (call.kind === 'rebuild' ? 1 : 0));
        return { call, used };
      });
    },
    // Increments, so these busy totals never need a transaction.
    record(uid, keys, plan, orgId, entry) {
      const fields = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, increment(v)]));
      const batch = db.batch();
      const paths = [
        `usage/${uid}/months/${keys.month}`,
        `ledger/${keys.month}/plans/${plan}`,
        `ledger/${keys.month}/days/${keys.day}`,
      ];
      if (orgId) paths.push(`ledger/${keys.month}/orgs/${orgId}`);
      paths.forEach((p) => batch.set(db.doc(p), fields, { merge: true }));
      return batch.commit();
    },
    release(uid, keys, call, outcome) {
      const r = refs(uid, keys);
      return db.runTransaction(async (tx) => {
        const s = await read(tx, r);
        const next = undoCall(call, outcome, s);
        if (next) write(tx, r, next, Math.max(s.rebuildsSeen - (call.kind === 'rebuild' ? 1 : 0), 0));
        return next ? next.used : s.used;
      });
    },
  };
}

export function createCoachHandler({ verify, store, fetchImpl = fetch, env = process.env, clock = Date.now }) {
  return async (req) => {
    if (req.method !== 'POST' && req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    if (!token) return json({ error: 'Please sign in to use the coach.' }, 401);
    let uid;
    try { uid = (await verify(token[1])).sub; }
    catch (e) { return json({ error: 'Please sign in to use the coach.' }, 401); }

    const now = clock();
    const keys = periodKeys(now);
    const summary = (plan, used) => ({ plan, left: assignmentsLeft(used, CAPS[plan]), refresh: refreshDate(keys.month) });
    const locked = (e) => {
      console.error('coach cap unavailable', e);
      return json({ code: 'coach_locked', error: 'The coach is not available.' }, 503);
    };

    if (req.method === 'GET') {
      try {
        const plan = resolvePlan(await store.entitlement(uid), now);
        return json(summary(plan, (await store.status(uid, keys)).used), 200);
      } catch (e) { return locked(e); }
    }

    const key = env[KEY_VAR];
    if (!key) return locked(`${KEY_VAR} missing`);
    // Netlify's AI Gateway injects its own key with a base URL. That key cannot
    // reach api.anthropic.com, so only a key without that URL is the retired one.
    if (env[RETIRED_KEY_VAR] && !env.ANTHROPIC_BASE_URL) return locked(`${RETIRED_KEY_VAR} still set`);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: 'Bad request.' }, 400); }
    const { system, user, purpose, assignmentKey, fresh } = body || {};
    if (typeof system !== 'string' || typeof user !== 'string' || !user.trim()
        || system.length > LIMITS.maxSystemChars) {
      return json({ error: 'Bad request.' }, 400);
    }

    let plan, spot, orgId;
    try {
      const entitlement = await store.entitlement(uid);
      plan = resolvePlan(entitlement, now);
      orgId = plan === 'b2b' && typeof entitlement.orgId === 'string' ? entitlement.orgId : null;
      spot = await store.reserve(uid, keys, CAPS[plan], {
        purpose,
        key: typeof assignmentKey === 'string' ? assignmentKey.slice(0, 80) : '',
        fresh: fresh === true,
      });
    } catch (e) { return locked(e); }
    if (!spot.call.allowed) {
      return json({ code: spot.call.code, scope: spot.call.scope, ...summary(plan, spot.used) }, 429);
    }

    const release = async (outcome) => {
      try { return await store.release(uid, keys, spot.call, outcome); }
      catch (e) { console.error('coach release failed', e); return spot.used; }
    };
    const refuse = async (code, outcome) => {
      const used = await release(outcome);
      return json({ code, error: 'The coach could not reply.', ...summary(plan, used) }, 502);
    };

    let r;
    try {
      r = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: AbortSignal.timeout(LIMITS.upstreamTimeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: env.COACH_MODEL || LIMITS.model,
          max_tokens: LIMITS.maxOutputTokens,
          output_config: { effort: LIMITS.effort },
          system,
          messages: [{ role: 'user', content: trimUserText(user, system.length) }],
        }),
      });
    } catch (e) {
      return refuse('upstream', 'failed');
    }
    if (!r.ok) {
      console.error('coach upstream', r.status, (await r.text()).slice(0, 300));
      return refuse('upstream', 'failed');
    }

    const d = await r.json();
    // Anthropic billed this reply, so it enters the ledger whatever happens next.
    const ledger = async (incomplete) => {
      try { await store.record(uid, keys, plan, orgId, ledgerEntry(d, spot.call.kind, incomplete)); }
      catch (e) { console.error('coach ledger failed', e); }
    };
    const content = (d.content || []).filter((b) => b.type === 'text' && b.text);
    const text = content.map((b) => b.text).join('\n');
    const isBuild = purpose !== 'feedback';
    if (!content.length || d.stop_reason === 'max_tokens' || d.stop_reason === 'refusal'
        || (isBuild && !validAssignment(text))) {
      console.error('coach incomplete', d.stop_reason, JSON.stringify(d.usage || {}));
      await ledger(true);
      return refuse('incomplete', 'incomplete');
    }
    await ledger(false);
    console.log('coach usage', JSON.stringify({
      kind: spot.call.kind,
      model: d.model,
      input: d.usage?.input_tokens,
      output: d.usage?.output_tokens,
      thinking: d.usage?.output_tokens_details?.thinking_tokens,
    }));
    return json({ content, ...summary(plan, spot.used) }, 200);
  };
}
