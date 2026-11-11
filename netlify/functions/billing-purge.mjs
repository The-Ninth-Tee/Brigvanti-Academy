import { db } from '../lib/firebase-admin.mjs';
import { cutoff, decide, PENDING_DAYS } from '../lib/billing-purge.mjs';

const DAY = 864e5;
const BUDGET_MS = 24000;

export default async () => {
  const now = Date.now(), t0 = Date.now();
  const tally = { deleted: 0, oldPayments: 0, kept: 0 };
  // Whole records: last payment before the cutoff, or a checkout never paid.
  const old = await db.collection('billing').where('lastPaidAt', '<', cutoff(now)).limit(200).get();
  const pending = await db.collection('billing').where('status', '==', 'pending').limit(200).get();
  for (const doc of [...old.docs, ...pending.docs]) {
    if (Date.now() - t0 > BUDGET_MS) break;
    if (decide(doc.data(), now) === 'delete') { await db.recursiveDelete(doc.ref); tally.deleted++; }
    else tally.kept++;
  }
  // Single payment entries past retention, for learners who still pay.
  const stale = await db.collection('payclaims').where('at', '<', cutoff(now)).limit(300).get();
  for (const p of stale.docs) {
    if (Date.now() - t0 > BUDGET_MS) break;
    await p.ref.delete(); tally.oldPayments++;
  }
  console.log('[billing-purge]', JSON.stringify({ pendingAfterDays: PENDING_DAYS, ...tally }));
};

// Daily at 03:15 UTC.
export const config = { schedule: '15 3 * * *' };
