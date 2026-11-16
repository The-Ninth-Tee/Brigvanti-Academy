// Daily B2B seat end job (decided 12 Nov 2026).
//   1. When a contract has ended, every seat ends at the contract end. The coach stops (plan b2b_ended).
//   2. 30 days after a seat ended, the account is deleted: sign in first, then the data, the plan record last,
//      then the seat itself. An unused invite is removed straight away.
//   3. A deletion that stopped halfway is marked 'deleting' and is finished on the next run.
// The org record stays: it holds the contract, which tax law keeps for seven years.
import { endSeat, entitlementFor } from './b2b-orgs.mjs';

const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';
// The plan record goes last, because the consumer sweep skips an account while it says product 'b2b'.
export const DATA_ORDER = ['users', 'usage', 'reminders', 'entitlements'];

export async function runSeatEnd({ store, now, budgetMs = 24000, clock = Date.now }) {
  const t0 = clock();
  const out = { orgs: 0, ended: 0, deleted: 0, invitesRemoved: 0, failed: 0 };
  for (const org of await store.orgs()) {
    if (clock() - t0 > budgetMs) break;
    out.orgs++;
    for (const m of await store.members(org.orgId)) {
      try {
        let cur = m;
        if (holdsSeat(cur) && now >= org.contractEnd) {
          cur = { seatId: m.seatId, ...endSeat(cur, org.contractEnd) };
          await store.setMember(org.orgId, cur.seatId, cur);
          if (cur.uid) await store.setEntitlement(cur.uid, entitlementFor(org, cur));
          out.ended++;
        }
        const due = (cur.status === 'ended' || cur.status === 'removed') && cur.deleteAfter != null && now >= cur.deleteAfter;
        if (!due && cur.status !== 'deleting') continue;
        if (!cur.uid) { await store.deleteMember(org.orgId, cur.seatId); out.invitesRemoved++; continue; }
        if (cur.status !== 'deleting') await store.setMember(org.orgId, cur.seatId, { status: 'deleting' });
        await store.deleteSignIn(org.tenantId, cur.uid);
        for (const path of DATA_ORDER) await store.deleteData(path, cur.uid);
        await store.deleteMember(org.orgId, cur.seatId);
        out.deleted++;
      } catch (e) {
        out.failed++;
        console.error('[b2b-seat-end] seat failed, next run retries', org.orgId, m.seatId, e.message);
      }
    }
  }
  return out;
}

export function firestoreSeatEndStore(db, auth) {
  const members = (orgId) => db.doc(`orgs/${orgId}`).collection('members');
  return {
    orgs: async () => (await db.collection('orgs').get()).docs.map((d) => ({ orgId: d.id, ...d.data() })),
    members: async (orgId) => (await members(orgId).get()).docs.map((d) => ({ seatId: d.id, ...d.data() })),
    setMember: (orgId, seatId, m) => members(orgId).doc(seatId).set(m, { merge: true }),
    deleteMember: (orgId, seatId) => members(orgId).doc(seatId).delete(),
    setEntitlement: (uid, e) => db.doc(`entitlements/${uid}`).set(e, { merge: true }),
    deleteSignIn: async (tenantId, uid) => {
      try { await auth.tenantManager().authForTenant(tenantId).deleteUser(uid); }
      catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    },
    deleteData: (path, uid) => db.recursiveDelete(db.doc(`${path}/${uid}`)),
  };
}
