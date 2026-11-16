import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { firestoreSeatEndStore } from '../lib/b2b-seat-end.mjs';
import { companyVerifier } from '../lib/b2b-auth.mjs';
import { createB2bAccountDelete } from '../lib/b2b-account-delete.mjs';

export default createB2bAccountDelete({ verify: companyVerifier(adminAuth), store: firestoreSeatEndStore(db, adminAuth) });
