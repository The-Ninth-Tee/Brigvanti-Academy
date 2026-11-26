import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { companyVerifier } from '../lib/b2b-auth.mjs';
import { firestoreOrgStore } from '../lib/b2b-orgs.mjs';
import { createB2bCompany, firestoreCompanyStore } from '../lib/b2b-company.mjs';

export default createB2bCompany({ verify: companyVerifier(adminAuth), store: firestoreCompanyStore(db, adminAuth, firestoreOrgStore(db)) });
