import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { mollieClient } from '../lib/pay.mjs';
import { createAccountDelete, firestoreAccountStore } from '../lib/account-delete.mjs';

const key = process.env.MOLLIE_API_KEY;
export default createAccountDelete({
  verify: (t) => adminAuth.verifyIdToken(t).then((u) => ({ ...u, sub: u.uid })),
  store: firestoreAccountStore(db, adminAuth),
  mollie: key ? mollieClient(key) : null,
});
