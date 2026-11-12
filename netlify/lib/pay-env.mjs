import { adminAuth, db } from './firebase-admin.mjs';
import { createPayHandlers, firestorePayStore, mollieClient } from './pay.mjs';
import { mailPlan } from './pay-mail-env.mjs';

// MOLLIE_API_KEY lives in Netlify only. A test_ key runs in Mollie test mode.
const key = process.env.MOLLIE_API_KEY;
export const pay = createPayHandlers({
  verify: (t) => adminAuth.verifyIdToken(t).then((u) => ({ ...u, sub: u.uid })),
  store: firestorePayStore(db),
  mollie: key ? mollieClient(key) : null,
  mail: mailPlan,
});
