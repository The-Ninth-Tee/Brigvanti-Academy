// Seat activation for the learner app (B2). The learner app calls this after every sign-in through the
// company link. The first call binds the seat to the account and writes the entitlement the coach gate
// reads (P1.4). Without it the coach gives 0 assignments, and the seat end job removes the account after
// 7 days as a sign-in without a seat. Later calls change nothing unless the entitlement went missing.
// Every refusal gets the same answer, so the reply never says why an address has no seat.
import { activate, seatId } from './b2b-orgs.mjs';

const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'cache-control': 'no-store' } });
const NO_SEAT = () => json({ code: 'no_seat' }, 403);
const sameEntitlement = (a, b) => !!a && ['product', 'orgId', 'tenantId', 'validUntil'].every((k) => a[k] === b[k]);

export function createB2bActivate({ verify, store, now = () => Date.now() }) {
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    let user;
    try { user = t && (await verify(t[1])); } catch { user = null; }
    if (!user || !user.uid) return json({ error: 'Please sign in first.' }, 401);
    const org = await store.orgByTenant(user.firebase.tenant);
    if (!org || !user.email) return NO_SEAT();
    const id = seatId(user.email);
    const at = now();

    // One transaction, all reads first. A seat the admin removes at the same moment is never set back to active.
    const r = await store.transaction(org.orgId, async (tx) => {
      const m = await tx.member(id);
      if (!m) return null;
      if (m.status === 'ended') return m.uid === user.uid ? { status: 'ended', deleteAfter: m.deleteAfter } : null;
      if (m.status !== 'invited' && m.status !== 'active') return null;
      const a = activate(org, m, user, at);
      if (a.error) return null;
      const had = await tx.entitlement(user.uid);
      if (m.status !== 'active' || m.uid !== user.uid) {
        tx.setMember(id, { status: a.member.status, uid: a.member.uid, firstSignInAt: a.member.firstSignInAt });
      }
      if (!sameEntitlement(had, a.entitlement)) tx.setEntitlement(user.uid, a.entitlement);
      return { status: 'active', until: a.entitlement.validUntil };
    });
    if (!r) return NO_SEAT();
    return json({ ...r, company: org.name });
  };
}

export function firestoreActivateStore(db, orgStore) {
  return {
    orgByTenant: orgStore.orgByTenant,
    transaction(orgId, fn) {
      return db.runTransaction(async (t) => {
        const memberRef = (sid) => db.doc(`orgs/${orgId}/members/${sid}`);
        const entRef = (uid) => db.doc(`entitlements/${uid}`);
        return fn({
          member: async (sid) => { const s = await t.get(memberRef(sid)); return s.exists ? { seatId: sid, ...s.data() } : null; },
          entitlement: async (uid) => { const s = await t.get(entRef(uid)); return s.exists ? s.data() : null; },
          setMember: (sid, m) => { t.set(memberRef(sid), m, { merge: true }); },
          setEntitlement: (uid, e) => { t.set(entRef(uid), e, { merge: true }); },
        });
      });
    },
  };
}
