// Test project only: seeds one company for a seatgate run in brigvanti-tenant-proof.
//   node proof-seed.mjs seed     needs TENANT_ID, SIGN_IN (emailLink, microsoft or google), SEATS, ADMINS (optional),
//                                MS_TENANT_ID (for microsoft)
//   node proof-seed.mjs report
//   node proof-seed.mjs clean
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';
import { seatId, norm } from './core.mjs';

const mode = process.argv[2];
const { TENANT_ID, SIGN_IN, SEATS, ADMINS, MS_TENANT_ID } = process.env;
if (!['seed', 'report', 'clean'].includes(mode) || !TENANT_ID || !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error('Usage: node proof-seed.mjs seed|report|clean, with GOOGLE_APPLICATION_CREDENTIALS and TENANT_ID set.');
  process.exit(1);
}
if (JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')).project_id !== 'brigvanti-tenant-proof') {
  console.error('Wrong project. This runs only in brigvanti-tenant-proof.');
  process.exit(1);
}
const app = initializeApp({ credential: applicationDefault() });
const db = getFirestore(app);
const tauth = getAuth(app).tenantManager().authForTenant(TENANT_ID);
const list = (v) => String(v || '').split(',').map(norm).filter(Boolean);
const DAY = 86400000;

async function tenantUsers() {
  const all = [];
  let page;
  do { page = await tauth.listUsers(1000, page && page.pageToken); all.push(...page.users); } while (page.pageToken);
  return all;
}

if (mode === 'seed') {
  if (!['emailLink', 'microsoft', 'google'].includes(SIGN_IN)) { console.error('Set SIGN_IN to emailLink, microsoft or google.'); process.exit(1); }
  if (SIGN_IN === 'microsoft' && !MS_TENANT_ID) { console.error('Set MS_TENANT_ID for microsoft.'); process.exit(1); }
  const now = Date.now();
  await db.recursiveDelete(db.doc('orgs/proof-seatgate'));
  await db.doc('orgs/proof-seatgate').set({ name: 'Proof seatgate', tenantId: TENANT_ID, domains: [], departments: ['Proof'], seats: 20,
    contractStart: now - DAY, contractEnd: now + 30 * DAY, founding: false, source: 'proof', signIn: SIGN_IN,
    ...(SIGN_IN === 'microsoft' ? { microsoftTenantId: norm(MS_TENANT_ID) } : {}) });
  for (const email of list(SEATS)) {
    await db.doc(`orgs/proof-seatgate/members/${seatId(email)}`).set({ email, department: 'Proof', status: 'invited', uid: null,
      invitedAt: now, firstSignInAt: null, endedAt: null, deleteAfter: null });
  }
  for (const email of list(ADMINS)) {
    await db.doc(`orgs/proof-seatgate/admins/${seatId(email)}`).set({ email, uid: null, addedAt: now, firstSignInAt: null });
  }
  console.log(`Seeded: sign-in ${SIGN_IN}, ${list(SEATS).length} seats, ${list(ADMINS).length} admins.`);
}

if (mode === 'report') {
  const users = await tenantUsers();
  if (!users.length) console.log('No users in the tenant.');
  else console.table(users.map((u) => ({ email: u.email || '(none)', providers: u.providerData.map((p) => p.providerId).join(' '),
    created: u.metadata.creationTime })));
}

if (mode === 'clean') {
  const users = await tenantUsers();
  for (const u of users) await tauth.deleteUser(u.uid);
  await db.recursiveDelete(db.doc('orgs/proof-seatgate'));
  console.log(`Deleted ${users.length} tenant users and the seed data.`);
}
