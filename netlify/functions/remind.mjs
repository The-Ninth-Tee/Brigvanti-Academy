import webpush from 'web-push';
import { db, adminAuth } from '../lib/firebase-admin.mjs';
import { reminderMessage } from '../lib/reminder-copy.mjs';

const DAY = 864e5;
const BUDGET_MS = 24000;          // Netlify stops scheduled functions at 30 seconds
const SEND_FROM_HOUR = 9;
const SEND_UNTIL_HOUR = 21;
const MAX_PER_WEEK = 3;
const MAX_UNANSWERED = 3;
const FOLLOW_UP_DAYS = 7;

function localParts(tz, t) {
  const zone = tz || 'Europe/Amsterdam';
  let f;
  try {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  } catch (e) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function removeAll(ref) {
  const devs = await ref.collection('devices').get();
  await Promise.all(devs.docs.map((d) => d.ref.delete()));
  await ref.delete();
}

async function handle(doc, now) {
  const r = doc.data();
  const ref = doc.ref;
  const here = localParts(r.tz, now);
  if (here.hour < SEND_FROM_HOUR || here.hour >= SEND_UNTIL_HOUR) return 'quiet';

  const lastSent = r.lastSentAt || 0;
  const answered = (r.lastRepAt || 0) > lastSent;
  const unanswered = answered ? 0 : (r.unanswered || 0);
  if (unanswered >= MAX_UNANSWERED) { await ref.update({ nextNudgeAt: null }); return 'paused'; }
  if (lastSent && localParts(r.tz, lastSent).day === here.day) return 'sent-today';
  const week = (r.sentLog || []).filter((t) => now - t < 7 * DAY);
  if (week.length >= MAX_PER_WEEK) return 'week-cap';

  try { await adminAuth.getUser(doc.id); }
  catch (e) {
    if (e.code === 'auth/user-not-found') { await removeAll(ref); return 'orphan'; }
    throw e;
  }

  const devs = await ref.collection('devices').where('on', '==', true).get();
  if (devs.empty) { await ref.update({ nextNudgeAt: null, active: false }); return 'no-device'; }

  const kind = lastSent && !answered ? 'followup' : r.kind;
  const payload = JSON.stringify(reminderMessage(r.lang, kind, r.skillName));
  let delivered = 0;
  await Promise.all(devs.docs.map(async (d) => {
    try {
      await webpush.sendNotification(d.get('sub'), payload, { TTL: 12 * 3600, urgency: 'normal' });
      delivered++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete();
      else console.warn('[remind] push failed', doc.id, e.statusCode || e.message);
    }
  }));

  if (!delivered) {
    const left = await ref.collection('devices').where('on', '==', true).limit(1).get();
    if (left.empty) await ref.update({ nextNudgeAt: null, active: false });
    return 'not-delivered';
  }
  await ref.update({
    lastSentAt: now,
    unanswered: unanswered + 1,
    sentLog: [...week, now],
    nextNudgeAt: now + FOLLOW_UP_DAYS * DAY,
  });
  return 'sent';
}

export default async () => {
  const now = Date.now();
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:legal@theninthtee.eu',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
  const due = await db.collection('reminders')
    .where('nextNudgeAt', '<=', now).orderBy('nextNudgeAt').limit(300).get();
  const tally = {};
  for (const doc of due.docs) {
    if (Date.now() - now > BUDGET_MS) { tally.deferred = (tally.deferred || 0) + 1; continue; }
    try {
      const out = await handle(doc, now);
      tally[out] = (tally[out] || 0) + 1;
    } catch (e) {
      tally.error = (tally.error || 0) + 1;
      console.error('[remind]', doc.id, e.message);
    }
  }
  console.log('[remind]', JSON.stringify({ due: due.size, ...tally }));
};

export const config = { schedule: '@hourly' };
