// Owner tool: add, remove or list company admins by hand (B9).
//   node tool/b2b-admin.mjs list   <orgId>
//   node tool/b2b-admin.mjs add    <orgId> <email>
//   node tool/b2b-admin.mjs remove <orgId> <email>
//   node tool/b2b-admin.mjs object   <orgId> <email>   D8: an objection by request to support keeps this seat out of every figure
//   node tool/b2b-admin.mjs unobject <orgId> <email>   the person withdrew the objection
// Needs the same Firebase credentials as the functions, in FIREBASE_SERVICE_ACCOUNT or the three separate variables.
// Removing an admin does not delete the sign-in. Without a seat, the seat end job removes it after 7 days.
const [cmd, orgId, email] = process.argv.slice(2);
if (!['list', 'add', 'remove', 'object', 'unobject'].includes(cmd) || !orgId || (cmd !== 'list' && !email)) {
  console.error('Usage: node tool/b2b-admin.mjs list <orgId> | add|remove|object|unobject <orgId> <email>');
  process.exit(1);
}
const { db } = await import('../netlify/lib/firebase-admin.mjs');
const { firestoreOrgStore, planAdmin, adminId, seatId } = await import('../netlify/lib/b2b-orgs.mjs');
const store = firestoreOrgStore(db);
const org = await store.getOrg(orgId);
if (!org) { console.error(`No company with id ${orgId}.`); process.exit(1); }

if (cmd === 'list') {
  const snap = await db.doc(`orgs/${orgId}`).collection('admins').get();
  if (!snap.size) console.log('No admins.');
  for (const d of snap.docs) {
    const a = d.data();
    console.log(`${a.email}  ${a.uid ? 'signed in ' + new Date(a.firstSignInAt).toISOString().slice(0, 10) : 'not signed in yet'}`);
  }
} else if (cmd === 'add') {
  const r = planAdmin(org, email, Date.now());
  if (r.error) { console.error(`Refused: ${r.error}. Allowed domains: ${(org.domains || []).join(', ')}`); process.exit(1); }
  if (await store.admin(orgId, r.adminId)) { console.log(`${r.admin.email} is already an admin of ${org.name}.`); process.exit(0); }
  await store.setAdmin(orgId, r.adminId, r.admin);
  console.log(`Added ${r.admin.email} as admin of ${org.name}.`);
} else if (cmd === 'object' || cmd === 'unobject') {
  const sid = seatId(email);
  const m = await store.member(orgId, sid);
  if (!m) { console.error(`${email} has no seat at ${org.name}.`); process.exit(1); }
  const out = cmd === 'object';
  await store.setMember(orgId, sid, { outOfAverages: out, outOfAveragesAt: out ? Date.now() : null });
  console.log(out ? `${m.email} is now left out of every company figure.` : `${m.email} counts in the company figures again.`);
} else {
  const id = adminId(email);
  if (!(await store.admin(orgId, id))) { console.error(`${email} is not an admin of ${org.name}.`); process.exit(1); }
  await store.deleteAdmin(orgId, id);
  console.log(`Removed ${email} as admin of ${org.name}.`);
}
