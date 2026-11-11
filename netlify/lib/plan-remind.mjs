// Tells a learner by push that a yearly Plus plan ends soon. The yearly plan never
// renews by itself, so this is the only nudge. Sent 14 days and 3 days before the end.
export const MARKS = [14, 3];
const DAY = 864e5;

const COPY = {
  en: (d) => ['Your Plus year ends soon', `Plus ends on ${d}. Renew it in Account to keep all 7 areas.`],
  nl: (d) => ['Je Plus-jaar loopt bijna af', `Plus stopt op ${d}. Verleng het in de accountinstellingen om alle 7 gebieden te houden.`],
};

export function planEndMessage(lang, periodEnd, tz) {
  const l = lang === 'nl' ? 'nl' : 'en';
  let d;
  try { d = new Date(periodEnd).toLocaleDateString(l === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long', timeZone: tz || 'Europe/Amsterdam' }); }
  catch { d = new Date(periodEnd).toLocaleDateString(l === 'nl' ? 'nl-NL' : 'en-GB', { day: 'numeric', month: 'long' }); }
  const [title, body] = COPY[l](d);
  return { title, body, url: '/?pay=renew', tag: 'brigvanti-plan' };
}

// The mark that is due now and not sent yet, or null.
export function dueMark(bill, now) {
  if (!bill || bill.status !== 'active' || bill.interval !== 'year') return null;
  const left = bill.periodEnd - now;
  if (left <= 0) return null;
  const sent = bill.endReminded || [];
  const due = MARKS.filter((m) => left <= m * DAY && !sent.includes(m));
  return due.length ? Math.min(...due) : null;
}
