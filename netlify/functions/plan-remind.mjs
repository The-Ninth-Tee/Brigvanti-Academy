import webpush from 'web-push';
import { db } from '../lib/firebase-admin.mjs';
import { MARKS, dueMark, planEndMessage } from '../lib/plan-remind.mjs';

const DAY = 864e5;

export default async () => {
  const now = Date.now();
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:legal@theninthtee.eu',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  // One range filter, so no composite index is needed. The rest is checked in code.
  const soon = await db.collection('billing')
    .where('periodEnd', '>', now).where('periodEnd', '<=', now + Math.max(...MARKS) * DAY).get();
  const tally = {};
  for (const doc of soon.docs) {
    const bill = doc.data();
    const mark = dueMark(bill, now);
    if (!mark) continue;
    // Marks that passed unsent are skipped too, so one late run sends one message.
    const passed = MARKS.filter((m) => m >= mark);
    try {
      const rem = await db.doc(`reminders/${doc.id}`).get();
      const devs = rem.exists ? await rem.ref.collection('devices').where('on', '==', true).get() : { docs: [] };
      const r = rem.exists ? rem.data() : {};
      const payload = JSON.stringify(planEndMessage(r.lang, bill.periodEnd, r.tz));
      let sent = 0;
      await Promise.all(devs.docs.map(async (d) => {
        try { await webpush.sendNotification(d.get('sub'), payload, { TTL: 24 * 3600, urgency: 'normal' }); sent++; }
        catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete(); }
      }));
      await doc.ref.set({ endReminded: [...new Set([...(bill.endReminded || []), ...passed])] }, { merge: true });
      tally[sent ? 'sent' : 'no-device'] = (tally[sent ? 'sent' : 'no-device'] || 0) + 1;
    } catch (e) {
      tally.error = (tally.error || 0) + 1;
      console.error('[plan-remind]', doc.id, e.message);
    }
  }
  console.log('[plan-remind]', JSON.stringify({ checked: soon.size, ...tally }));
};

// 09:30 UTC, which is 10:30 or 11:30 in Amsterdam.
export const config = { schedule: '30 9 * * *' };
