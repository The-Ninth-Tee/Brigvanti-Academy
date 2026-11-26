import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { companyVerifier } from '../lib/b2b-auth.mjs';
import { firestoreOrgStore } from '../lib/b2b-orgs.mjs';
import { createB2bActivate, firestoreActivateStore } from '../lib/b2b-activate.mjs';

export default createB2bActivate({ verify: companyVerifier(adminAuth), store: firestoreActivateStore(db, firestoreOrgStore(db)) });
