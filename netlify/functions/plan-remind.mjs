import { db } from '../lib/firebase-admin.mjs';
import { planActions, YEAR_MAIL_DAYS } from '../lib/plan-remind.mjs';
import { GRACE_DAYS, mollieClient } from '../lib/pay.mjs';
import { mailPlan } from '../lib/pay-mail-env.mjs';

const DAY = 864e5;

export default async () => {
  const now = Date.now();
  const key = process.env.MOLLIE_API_KEY;
  const mollie = key ? mollieClient(key) : null;
  // One range filter on periodEnd, so no composite index is needed.
  const docs = (await db.collection('billing')
    .where('periodEnd', '>', now - (GRACE_DAYS + 2) * DAY)
    .where('periodEnd', '<=', now + YEAR_MAIL_DAYS * DAY).get()).docs;
  const tally = {};
  for (const doc of docs) {
    const bill = doc.data(), uid = doc.id;
    for (const act of planActions(bill, now)) {
      try {
        if (act === 'yearly') {
          await mailPlan(uid, 'yearly', { lang: bill.lang, periodEnd: bill.periodEnd });
          await doc.ref.set({ yearMailedFor: bill.periodEnd }, { merge: true });
        }
        if (act === 'failed') {
          await mailPlan(uid, 'failed', { lang: bill.lang, until: bill.periodEnd + GRACE_DAYS * DAY });
          await doc.ref.set({ failMailedFor: bill.periodEnd }, { merge: true });
        }
        if (act === 'end') {
          // Stop the subscription first, so no later debit comes in after Plus ended.
          if (bill.subscriptionId) { if (!mollie) throw new Error('mollie off'); await mollie.cancelSubscription(bill.customerId, bill.subscriptionId); }
          await doc.ref.set({ status: 'ended', cancelled: true, endedAt: now, endReason: 'unpaid' }, { merge: true });
          await db.doc(`entitlements/${uid}`).set({ tier: 'free', validUntil: now }, { merge: true });
        }
        tally[act] = (tally[act] || 0) + 1;
      } catch (e) {
        tally.error = (tally.error || 0) + 1;
        console.error('[plan-remind]', act, uid, e.message);
      }
    }
  }
  console.log('[plan-remind]', JSON.stringify({ checked: docs.length, ...tally }));
};

// 09:30 UTC, which is 10:30 or 11:30 in Amsterdam.
export const config = { schedule: '30 9 * * *' };
