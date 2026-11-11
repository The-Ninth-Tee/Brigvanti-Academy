// Push messages about a learner's plan. Only reaches devices where push is on.

const fmt = (ms, l, tz) => {
  const o = { day: 'numeric', month: 'long' };
  try { return new Date(ms).toLocaleDateString(l === 'nl' ? 'nl-NL' : 'en-GB', { ...o, timeZone: tz || 'Europe/Amsterdam' }); }
  catch { return new Date(ms).toLocaleDateString(l === 'nl' ? 'nl-NL' : 'en-GB', o); }
};
const COPY = {
  en: { payment_failed: (d) => ['Your Plus payment did not go through', `Mollie will try again. Check your bank account to keep Plus after ${d}.`] },
  nl: { payment_failed: (d) => ['Je Plus-betaling is niet gelukt', `Mollie probeert het opnieuw. Controleer je rekening om Plus na ${d} te houden.`] },
};

export function planMessage(lang, kind, data, tz) {
  const l = lang === 'nl' ? 'nl' : 'en';
  const [title, body] = COPY[l][kind](fmt(data.until, l, tz));
  return { title, body, url: '/?pay=status', tag: 'brigvanti-plan' };
}

export function pushNotifier(db, env = process.env) {
  return async (uid, kind, data) => {
    const rem = await db.doc(`reminders/${uid}`).get();
    if (!rem.exists) return 0;
    const devs = await rem.ref.collection('devices').where('on', '==', true).get();
    if (devs.empty) return 0;
    const { default: webpush } = await import('web-push');
    webpush.setVapidDetails(env.VAPID_SUBJECT || 'mailto:legal@theninthtee.eu', env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const r = rem.data();
    const payload = JSON.stringify(planMessage(r.lang, kind, data, r.tz));
    let sent = 0;
    await Promise.all(devs.docs.map(async (d) => {
      try { await webpush.sendNotification(d.get('sub'), payload, { TTL: 24 * 3600, urgency: 'normal' }); sent++; }
      catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete(); }
    }));
    return sent;
  };
}
