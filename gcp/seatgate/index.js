// seatgate: blocking function before account creation (measure A). Runs for every sign-up in the project,
// B2C included. A consumer sign-up returns before any import or read. For a company tenant, any failure
// refuses the sign-up, so a fault never lets a stranger in.
import { beforeUserCreated, HttpsError } from 'firebase-functions/v2/identity';
import { decide, methodOf } from './core.mjs';

const MESSAGE = 'This account cannot be created. Ask your company for an invite.';

let db = null;
async function database() {
  if (!db) {
    const { initializeApp, getApps, getApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    // firebase-functions creates its own named app, so look for the default app by name.
    const app = getApps().some((a) => a.name === '[DEFAULT]') ? getApp() : initializeApp();
    // The app's data lives in the named database "brigvanti", not "(default)".
    db = getFirestore(app, process.env.SEATGATE_DATABASE || 'brigvanti');
  }
  return db;
}

// The database loads on the first read only, so a refusal that needs no read costs nothing.
const store = {
  orgsByTenant: async (t) => (await (await database()).collection('orgs').where('tenantId', '==', t).limit(2).get())
    .docs.map((d) => ({ orgId: d.id, ...d.data() })),
  admin: async (o, id) => { const s = await (await database()).doc(`orgs/${o}/admins/${id}`).get(); return s.exists ? s.data() : null; },
  seat: async (o, id) => { const s = await (await database()).doc(`orgs/${o}/members/${id}`).get(); return s.exists ? s.data() : null; },
};

// Identity Platform waits 7 seconds at most. A slow database refuses the company sign-up within that time.
const LIMIT_MS = 4000;
const withinLimit = (p) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), LIMIT_MS).unref())]);

const log = (entry) => console.log(JSON.stringify(entry));

export const seatgate = beforeUserCreated({ region: 'europe-west1', memory: '256MiB', idToken: true }, async (event) => {
  const t0 = Date.now();
  const method = methodOf(event.eventType);
  const user = event.data || {};
  if (!user.tenantId) {
    log({ result: 'pass', reason: 'consumer_pass', method, ms: Date.now() - t0 });
    return;
  }
  let r;
  try {
    r = await withinLimit(decide({ tenantId: user.tenantId, method, email: user.email, idToken: event.credential?.idToken },
      store, Date.now()));
  } catch (e) {
    console.error(JSON.stringify({ result: 'refused', reason: 'error', method, error: String(e && e.message || e) }));
    throw new HttpsError('permission-denied', MESSAGE);
  }
  log({ result: r.ok ? 'pass' : 'refused', reason: r.reason, method, tenant: user.tenantId, ms: Date.now() - t0 });
  if (!r.ok) throw new HttpsError('permission-denied', MESSAGE);
});
