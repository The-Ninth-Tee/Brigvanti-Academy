// Daily clean up: plan, usage, reminder and progress data whose sign in no longer
// exists. Catches a deletion that stopped halfway. Billing and payclaims stay,
// billing-purge handles those.
import { adminAuth, db } from '../lib/firebase-admin.mjs';

const BUDGET_MS = 24000;
const PATHS = ['entitlements', 'usage', 'users', 'reminders'];

export default async () => {
  const t0 = Date.now();
  const refs = {};
  // listDocuments also returns parents that only hold subcollections, such as usage/{uid}.
  for (const c of PATHS) for (const r of await db.collection(c).listDocuments()) (refs[r.id] ||= []).push(r);
  const ids = Object.keys(refs);
  let removed = 0;
  for (let i = 0; i < ids.length && Date.now() - t0 < BUDGET_MS; i += 100) {
    const batch = ids.slice(i, i + 100);
    const res = await adminAuth.getUsers(batch.map((uid) => ({ uid })));
    for (const nf of res.notFound) {
      for (const r of refs[nf.uid]) await db.recursiveDelete(r);
      removed++;
    }
  }
  console.log('[account-sweep]', JSON.stringify({ accounts: ids.length, removed }));
};

// Daily at 03:45 UTC.
export const config = { schedule: '45 3 * * *' };
