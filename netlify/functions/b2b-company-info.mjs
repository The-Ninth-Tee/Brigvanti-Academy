import { db } from '../lib/firebase-admin.mjs';
import { firestoreOrgStore } from '../lib/b2b-orgs.mjs';
import { createB2bCompanyInfo } from '../lib/b2b-company-info.mjs';

export default createB2bCompanyInfo({ store: firestoreOrgStore(db) });
