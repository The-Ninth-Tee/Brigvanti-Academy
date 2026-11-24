import { adminAuth, db } from '../lib/firebase-admin.mjs';
import { firestoreOrgStore } from '../lib/b2b-orgs.mjs';
import { createB2bSigninLink } from '../lib/b2b-signin-link.mjs';
import { appUrl, sendB2bMail } from '../lib/b2b-mail-env.mjs';

// Request times per address, keyed like seats. Server only: the rules deny every client read and write.
const requests = (id) => db.doc(`b2bLinkRequests/${id}`);
const store = {
  ...firestoreOrgStore(db),
  linkTimes: async (id) => { const s = await requests(id).get(); return s.exists ? s.data().times || [] : []; },
  setLinkTimes: (id, times) => requests(id).set({ times }),
};
const makeLink = (tenantId, email, url) =>
  adminAuth.tenantManager().authForTenant(tenantId).generateSignInWithEmailLink(email, { url, handleCodeInApp: true });

export default createB2bSigninLink({ store, makeLink, send: sendB2bMail, appUrl: appUrl() });
