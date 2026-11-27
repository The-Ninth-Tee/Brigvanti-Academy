// Owner tool: the two fake companies for the full test on live (step 4).
//   node tool/b2b-test-company.mjs create a --domain <domain> --admin <email>
//   node tool/b2b-test-company.mjs create b --domain <domain> --admin <email> --ms-tenant <id>
//        needs MS_CLIENT_ID and MS_CLIENT_SECRET in the environment, never on the command line
//   node tool/b2b-test-company.mjs seed   a|b [--count n] [--departments "A,B"]   fake learners with levels, replaces earlier ones.
//        --departments sets the list only while the company has none, for a run without the dashboard.
//   node tool/b2b-test-company.mjs remove a|b [--yes]       without --yes it only shows what would go
//   node tool/b2b-test-company.mjs list
// Credentials: GOOGLE_APPLICATION_CREDENTIALS (a key file), FIREBASE_SERVICE_ACCOUNT, or the three
// FIREBASE_* variables. Runs only in brigvanti-academy or brigvanti-tenant-proof.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { cleanDepartments } from '../netlify/lib/b2b-orgs.mjs';
import * as T from './b2b-test-company-core.mjs';

const DATABASES = { 'brigvanti-academy': 'brigvanti', 'brigvanti-tenant-proof': '(default)' };
const APP = 'https://app.brigvanti.com';

const argv = process.argv.slice(2);
const [cmd, which] = argv;
const opt = (name) => { const i = argv.indexOf('--' + name); return i > 0 ? argv[i + 1] : undefined; };
const flag = (name) => argv.includes('--' + name);
const stop = (msg) => { console.error(msg); process.exit(1); };

if (!['create', 'seed', 'remove', 'list'].includes(cmd)) stop('Usage: node tool/b2b-test-company.mjs create|seed|remove a|b, or list. See the top of the file.');
const preset = T.PRESETS[which];
if (cmd !== 'list' && !preset) stop('Name the company: a or b.');

function serviceAccount() {
  const e = process.env;
  if (e.GOOGLE_APPLICATION_CREDENTIALS) {
    try { return JSON.parse(readFileSync(e.GOOGLE_APPLICATION_CREDENTIALS, 'utf8')); }
    catch { return stop(`The key file ${e.GOOGLE_APPLICATION_CREDENTIALS} could not be read.`); }
  }
  if (e.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(e.FIREBASE_SERVICE_ACCOUNT);
  if (e.FIREBASE_PROJECT_ID) return { project_id: e.FIREBASE_PROJECT_ID, client_email: e.FIREBASE_CLIENT_EMAIL, private_key: (e.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n') };
  return stop('No credentials. Set GOOGLE_APPLICATION_CREDENTIALS to the key file.');
}
const sa = serviceAccount();
const projectId = sa.project_id || sa.projectId;
if (!DATABASES[projectId]) stop(`Refused: project ${projectId}. This tool runs only in ${Object.keys(DATABASES).join(' or ')}.`);
const credential = cert(sa);
const app = initializeApp({ credential, projectId });
const db = getFirestore(app, DATABASES[projectId]);
const auth = getAuth(app);
const live = projectId === 'brigvanti-academy';
console.log(`Project: ${projectId}${live ? ' (live)' : ''}`);

const store = {
  getOrg: async (id) => { const s = await db.doc(`orgs/${id}`).get(); return s.exists ? { orgId: id, ...s.data() } : null; },
  members: async (id) => (await db.collection(`orgs/${id}/members`).get()).docs.map((d) => ({ seatId: d.id, ...d.data() })),
  admins: async (id) => (await db.collection(`orgs/${id}/admins`).get()).docs.map((d) => ({ adminId: d.id, ...d.data() })),
  setMember: (id, sid, m) => db.doc(`orgs/${id}/members/${sid}`).set(m),
  deleteMember: (id, sid) => db.doc(`orgs/${id}/members/${sid}`).delete(),
  setUser: (uid, u) => db.doc(`users/${uid}`).set(u),
  setEntitlement: (uid, e) => db.doc(`entitlements/${uid}`).set(e),
  deleteData: (path, uid) => db.recursiveDelete(db.doc(`${path}/${uid}`)),
  deleteOrg: (id) => db.recursiveDelete(db.doc(`orgs/${id}`)),
  tenantUsers: async (tenantId) => {
    const users = [];
    let page;
    try {
      do { const r = await auth.tenantManager().authForTenant(tenantId).listUsers(1000, page); users.push(...r.users); page = r.pageToken; } while (page);
    } catch (e) { if (!/not-found|TENANT_NOT_FOUND/i.test(`${e.code} ${e.message}`)) throw e; }
    return users.map((u) => ({ uid: u.uid, email: u.email || '' }));
  },
  deleteSignIn: async (tenantId, uid) => {
    try { await auth.tenantManager().authForTenant(tenantId).deleteUser(uid); }
    catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
  },
  deleteTenant: async (tenantId) => {
    try { await auth.tenantManager().deleteTenant(tenantId); }
    catch (e) { if (!/not-found|TENANT_NOT_FOUND/i.test(`${e.code} ${e.message}`)) throw e; }
  },
};

// The Admin SDK adds only SAML and OIDC providers, so Microsoft goes through the Identity Platform API.
async function enableMicrosoft(tenantId) {
  const { MS_CLIENT_ID: clientId, MS_CLIENT_SECRET: clientSecret } = process.env;
  const { access_token: token } = await credential.getAccessToken();
  const url = `https://identitytoolkit.googleapis.com/v2/projects/${projectId}/tenants/${tenantId}/defaultSupportedIdpConfigs?idpId=microsoft.com`;
  const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, clientId, clientSecret }) });
  if (!r.ok) throw new Error(`The Microsoft provider was refused: ${r.status} ${(await r.text()).slice(0, 300)}`);
}

function comps() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sandbox = { window: {} };
  runInNewContext(readFileSync(join(root, 'content/brigvanti-content.js'), 'utf8'), sandbox);
  return sandbox.window.BRIG_CONTENT.comps;
}

if (cmd === 'create') {
  if (await store.getOrg(preset.orgId)) stop(`${preset.orgId} already exists. Remove it first.`);
  if (preset.signIn === 'microsoft' && (!process.env.MS_CLIENT_ID || !process.env.MS_CLIENT_SECRET)) stop('Set MS_CLIENT_ID and MS_CLIENT_SECRET first.');
  const check = T.planCompany({ preset, tenantId: 'pending', domain: opt('domain'), adminEmail: opt('admin'), msTenantId: opt('ms-tenant'), now: Date.now() });
  if (check.error) stop(`Refused: ${check.error}${check.fields ? ' (' + check.fields.join(', ') + ')' : ''}.`);
  const tenant = await auth.tenantManager().createTenant(T.tenantOptions(preset));
  try {
    if (preset.signIn === 'microsoft') await enableMicrosoft(tenant.tenantId);
    const plan = T.planCompany({ preset, tenantId: tenant.tenantId, domain: opt('domain'), adminEmail: opt('admin'), msTenantId: opt('ms-tenant'), now: Date.now() });
    const { orgId, ...rest } = plan.org;
    await db.doc(`orgs/${orgId}`).set(rest);
    await db.doc(`orgs/${orgId}/admins/${plan.adminId}`).set(plan.admin);
  } catch (e) {
    await store.deleteTenant(tenant.tenantId);
    await store.deleteOrg(preset.orgId);
    stop(`Stopped, and the new tenant was deleted again: ${e.message}`);
  }
  console.log(`Created ${preset.name}: ${preset.seats} seats, sign-in ${preset.signIn}, tenant ${tenant.tenantId}.`);
  console.log(`Admin: ${opt('admin')}. No departments yet, so the dashboard opens on First setup.`);
  if (live) {
    console.log(`Dashboard:     ${APP}/company.html?b2b=${tenant.tenantId}`);
    console.log(`Learner link:  ${APP}/?b2b=${tenant.tenantId}`);
  } else console.log('This is the test project, so the app links do not apply.');
}

if (cmd === 'seed') {
  const org = await store.getOrg(preset.orgId);
  if (!org) stop(`${preset.orgId} does not exist.`);
  if (opt('departments')) {
    if ((org.departments || []).length) stop('Refused: the company already has departments. Leave out --departments.');
    const c = cleanDepartments(opt('departments').split(','));
    if (c.error) stop(`Refused: departments ${c.error}.`);
    if (!T.isTestOrg(org)) stop('Refused: this company is not marked as a test company.');
    await db.doc(`orgs/${org.orgId}`).set({ departments: c.departments }, { merge: true });
    org.departments = c.departments;
  }
  const members = await store.members(org.orgId);
  const count = opt('count') ? Number(opt('count')) : preset.seed;
  const plan = T.planSeed({ org, members, comps: comps(), count, now: Date.now() });
  if (plan.error === 'no_departments') stop('Refused: the company has no departments yet. Run First setup on the dashboard first.');
  if (plan.error === 'no_seats_left') stop(`Refused: only ${plan.free} seats are free for fake learners.`);
  if (plan.error) stop(`Refused: ${plan.error}.`);
  await T.runSeed(store, plan, org, members);
  const per = {};
  for (const s of plan.seeds) per[s.member.department] = (per[s.member.department] || 0) + 1;
  console.log(`Seeded ${plan.seeds.length} fake learners${plan.replaced ? `, replacing ${plan.replaced}` : ''}:`);
  for (const [d, n] of Object.entries(per)) console.log(`  ${d}: ${n}${n < T.DEPARTMENT_BLOCK ? ' (hidden on the dashboard)' : ''}`);
}

if (cmd === 'remove') {
  const org = await store.getOrg(preset.orgId);
  if (!org) stop(`${preset.orgId} does not exist. Nothing to remove.`);
  const plan = T.planRemove(org, await store.members(org.orgId), await store.admins(org.orgId), await store.tenantUsers(org.tenantId));
  if (plan.error) stop('Refused: this company is not marked as a test company.');
  console.log(`${org.name}, tenant ${plan.tenantId}: ${plan.signIns.length} sign-ins, ${plan.accounts.length} accounts with data, ${plan.seats} seats (${plan.seeded} fake), ${plan.admins} admins.`);
  if (!flag('yes')) { console.log('Nothing was deleted. Run again with --yes to delete all of it.'); process.exit(0); }
  await T.runRemove(store, plan);
  console.log(`Removed ${org.name}: the tenant, its sign-ins, the company record, seats, admins, reports, entitlements and learner data.`);
}

if (cmd === 'list') {
  const snap = await db.collection('orgs').where('test', '==', true).get();
  if (!snap.size) console.log('No test companies.');
  for (const d of snap.docs) {
    const o = d.data();
    const members = await store.members(d.id);
    console.log(`${d.id}  ${o.name}  tenant ${o.tenantId}  ${o.signIn}  ${o.seats} seats  ${members.filter((m) => !m.seeded).length} real, ${members.filter((m) => m.seeded).length} fake  departments ${(o.departments || []).length}`);
  }
}

process.exit(0);
