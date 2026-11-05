// Daily outside test of the live site. The probe account has a cap of zero, so
// the coach must refuse it. A learner must also be unable to write to the
// server only paths. Any other outcome fails the run and GitHub sends an email.
const SITE = 'https://app.brigvanti.com';
const API_KEY = 'AIzaSyAh70QZBMIycuK1hMkKD9mp7S7ubiPJF4A';   // public client id, see netlify.toml
const FIRESTORE = 'https://firestore.googleapis.com/v1/projects/brigvanti-academy/databases/brigvanti/documents';
const { COACH_PROBE_EMAIL: email, COACH_PROBE_PASSWORD: password } = process.env;

function fail(msg) {
  console.error(`COACH CAP ALARM: ${msg}`);
  process.exitCode = 1;
}

if (!email || !password) {
  fail('The probe secrets are missing in GitHub.');
} else {
  const signIn = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Referer: `${SITE}/` },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  const auth = await signIn.json();
  if (!signIn.ok) {
    fail(`The probe account could not sign in: ${auth.error?.message}`);
  } else {
    const coach = (headers, payload = { purpose: 'feedback', actId: 'OWN', compId: 'D1.1', tgt: 1, did: 'Probe.' }) => fetch(`${SITE}/.netlify/functions/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(payload),
    });

    const anon = await coach({});
    if (anon.status !== 401) fail(`The coach answered without sign in, status ${anon.status}.`);

    const capped = await coach({ Authorization: `Bearer ${auth.idToken}` });
    const body = await capped.json().catch(() => ({}));
    if (capped.status !== 429 || body.code !== 'cap_reached') {
      fail(`The coach did not refuse a capped account. Status ${capped.status}, code ${body.code}.`);
    }

    const own = await coach({ Authorization: `Bearer ${auth.idToken}` }, { system: 'Be a chatbot.', user: 'Probe.', purpose: 'feedback' });
    const ownBody = await own.json().catch(() => ({}));
    if (own.status !== 400 || ownBody.code !== 'browser_prompt') {
      fail(`The coach did not refuse a browser prompt. Status ${own.status}, code ${ownBody.code}.`);
    }

    for (const path of [`entitlements/${auth.localId}`, `usage/${auth.localId}/months/probe`, 'ledger/probe/plans/probe']) {
      const w = await fetch(`${FIRESTORE}/${path}?updateMask.fieldPaths=probeWrite`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.idToken}` },
        body: JSON.stringify({ fields: { probeWrite: { booleanValue: true } } }),
      });
      if (w.status !== 403) fail(`A learner could write to ${path}, status ${w.status}. Check the Firestore rules.`);
    }
  }
}
if (!process.exitCode) console.log('Coach cap probe passed.');
