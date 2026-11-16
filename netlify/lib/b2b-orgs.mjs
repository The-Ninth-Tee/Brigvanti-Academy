// B2B company data. Every path here is server-only: Firestore rules grant the browser nothing
// under orgs/ or entitlements/, so default deny covers them.
//
//   orgs/{orgId}                  name, tenantId, domains, seats, contractStart, contractEnd, founding, source
//   orgs/{orgId}/members/{seatId} email, department, status, uid, invitedAt, firstSignInAt, endedAt, deleteAfter
//   entitlements/{uid}            product 'b2b', orgId, validUntil   (read by the coach gate)
//
// The employer sends only work email and department. Nothing else about a person is stored here.
import { createHash } from 'node:crypto';

export const DAY = 86400000;
export const READ_ONLY_DAYS = 30; // decided 12 Nov 2026: coach stops at once, account deleted 30 days later

export const normEmail = (e) => String(e || '').trim().toLowerCase();
export const emailDomain = (e) => normEmail(e).split('@')[1] || '';
// The seat id is a hash of the email, so the same person can never hold two seats in one company.
export const seatId = (email) => createHash('sha256').update(normEmail(email)).digest('hex').slice(0, 32);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORG_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

export function validateOrg(o) {
  const errors = [];
  if (!o || typeof o !== 'object') return ['missing'];
  if (!ORG_ID.test(o.orgId || '')) errors.push('orgId');
  if (!String(o.name || '').trim()) errors.push('name');
  if (!String(o.tenantId || '').trim()) errors.push('tenantId');
  if (!Array.isArray(o.domains) || !o.domains.length || o.domains.some((d) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d))) errors.push('domains');
  if (!Number.isInteger(o.seats) || o.seats < 1) errors.push('seats');
  if (!Number.isFinite(o.contractStart) || !Number.isFinite(o.contractEnd) || o.contractEnd <= o.contractStart) errors.push('contract');
  return errors;
}

export const contractActive = (org, now) => now >= org.contractStart && now < org.contractEnd;
export const tenantMatches = (token, org) => !!(token && token.firebase && org && token.firebase.tenant === org.tenantId);

// A seat counts against the contract until it is removed or ended.
const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';

// Plans additions to the seat list. Returns what to write and why anything was refused.
export function planInvites(org, members, list, now) {
  const taken = new Map(members.map((m) => [seatId(m.email), m]));
  let used = members.filter(holdsSeat).length;
  const add = [], refused = [];
  for (const row of list) {
    const email = normEmail(row.email);
    const department = String(row.department || '').trim().slice(0, 60);
    if (!EMAIL.test(email)) { refused.push({ email, reason: 'invalid_email' }); continue; }
    if (!org.domains.includes(emailDomain(email))) { refused.push({ email, reason: 'wrong_domain' }); continue; }
    const id = seatId(email);
    const had = taken.get(id);
    if (had && holdsSeat(had)) { refused.push({ email, reason: 'already_has_seat' }); continue; }
    if (used >= org.seats) { refused.push({ email, reason: 'no_seats_left' }); continue; }
    if (!contractActive(org, now)) { refused.push({ email, reason: 'contract_not_active' }); continue; }
    const m = { email, department, status: 'invited', uid: null, invitedAt: now, firstSignInAt: null, endedAt: null, deleteAfter: null };
    add.push({ seatId: id, member: m });
    taken.set(id, m);
    used++;
  }
  return { add, refused, used, left: org.seats - used };
}

// The coach gate reads this. validUntil is the contract end, or the moment the seat ended.
export const entitlementFor = (org, member) => ({
  product: 'b2b',
  orgId: org.orgId,
  validUntil: member.status === 'ended' ? member.endedAt : org.contractEnd,
});

// First sign-in through the company tenant binds the seat to the account.
export function activate(org, member, token, now) {
  if (!tenantMatches(token, org)) return { error: 'wrong_tenant' };
  if (normEmail(token.email) !== member.email) return { error: 'wrong_email' };
  if (member.status === 'ended' || member.status === 'removed') return { error: 'seat_ended' };
  if (!contractActive(org, now)) return { error: 'contract_not_active' };
  if (member.uid && member.uid !== token.uid) return { error: 'seat_bound' };
  const next = { ...member, status: 'active', uid: token.uid, firstSignInAt: member.firstSignInAt || now };
  return { member: next, entitlement: entitlementFor(org, next) };
}

// Seat removed by the employer, or the contract ended. The coach stops at once; deletion follows after 30 days.
export function endSeat(member, at) {
  if (member.status === 'ended') return member;
  if (member.status === 'invited' && !member.uid) {
    return { ...member, status: 'removed', endedAt: at, deleteAfter: at };
  }
  return { ...member, status: 'ended', endedAt: at, deleteAfter: at + READ_ONLY_DAYS * DAY };
}

// The learner deleted their own account: the seat frees up at once.
export const freeSeat = (member, at) => ({ ...member, status: 'removed', uid: null, endedAt: at, deleteAfter: at });

export function firestoreOrgStore(db) {
  const org = (id) => db.doc(`orgs/${id}`);
  return {
    getOrg: async (id) => { const s = await org(id).get(); return s.exists ? { orgId: id, ...s.data() } : null; },
    setOrg: (o) => org(o.orgId).set(o, { merge: true }),
    members: async (id) => (await org(id).collection('members').get()).docs.map((d) => ({ seatId: d.id, ...d.data() })),
    member: async (id, sid) => { const s = await org(id).collection('members').doc(sid).get(); return s.exists ? { seatId: sid, ...s.data() } : null; },
    setMember: (id, sid, m) => org(id).collection('members').doc(sid).set(m, { merge: true }),
    setEntitlement: (uid, e) => db.doc(`entitlements/${uid}`).set(e, { merge: true }),
  };
}
