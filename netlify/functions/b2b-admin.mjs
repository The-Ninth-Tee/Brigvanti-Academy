import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { companyVerifier } from '../lib/b2b-auth.mjs';
import { firestoreOrgStore } from '../lib/b2b-orgs.mjs';
import { createB2bAdmin } from '../lib/b2b-admin.mjs';

export default createB2bAdmin({ verify: companyVerifier(adminAuth), store: firestoreOrgStore(db) });
