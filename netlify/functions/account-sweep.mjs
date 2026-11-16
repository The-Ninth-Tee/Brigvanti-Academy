// Daily clean up: plan, usage, reminder and progress data whose sign in no longer
// exists. Catches a deletion that stopped halfway. Billing and payclaims stay,
// billing-purge handles those. Company seat holders are skipped: see lib/account-sweep.mjs.
import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { sweepOrphans, SWEEP_PATHS } from '../lib/account-sweep.mjs';

export default async () => {
  const refsById = {};
  // listDocuments also returns parents that only hold subcollections, such as usage/{uid}.
  for (const c of SWEEP_PATHS) for (const r of await db.collection(c).listDocuments()) (refsById[r.id] ||= []).push(r);
  const result = await sweepOrphans({
    refsById,
    getUsers: async (uids) => ({ notFound: (await adminAuth.getUsers(uids.map((uid) => ({ uid })))).notFound.map((n) => n.uid) }),
    entitlement: async (uid) => { const s = await db.doc(`entitlements/${uid}`).get(); return s.exists ? s.data() : null; },
    remove: (r) => db.recursiveDelete(r),
  });
  console.log('[account-sweep]', JSON.stringify(result));
};

// Daily at 03:45 UTC.
export const config = { schedule: '45 3 * * *' };
