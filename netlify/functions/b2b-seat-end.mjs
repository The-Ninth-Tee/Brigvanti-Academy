// Daily B2B seat end job. Logic and order in lib/b2b-seat-end.mjs.
import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { runSeatEnd, firestoreSeatEndStore } from '../lib/b2b-seat-end.mjs';

export default async () => {
  const result = await runSeatEnd({ store: firestoreSeatEndStore(db, adminAuth), now: Date.now() });
  console.log('[b2b-seat-end]', JSON.stringify(result));
};

// Daily at 04:15 UTC, after account-sweep.
export const config = { schedule: '15 4 * * *' };
