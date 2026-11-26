// B2B company data. Every path here is server-only: Firestore rules grant the browser nothing
// under orgs/ or entitlements/, so default deny covers them.
//
//   orgs/{orgId}                  name, tenantId, domains, departments, seats, contractStart, contractEnd, founding, source,
//                                 signIn ('microsoft' | 'google' | 'emailLink' | 'saml' | 'oidc'), microsoftTenantId (with 'microsoft')
//                                 seatgate (gcp/seatgate) refuses every sign-up in the tenant until signIn is set.
//   orgs/{orgId}/members/{seatId} email, department, status, uid, invitedAt, firstSignInAt, endedAt, deleteAfter,
//                                 outOfAverages, outOfAveragesAt   (D8: set by support after an objection; set only by the owner tool)
//   entitlements/{uid}            product 'b2b', orgId, tenantId, validUntil   (read by the coach gate)
//   orgs/{orgId}/admins/{adminId} email, uid, addedAt, firstSignInAt   (an admin needs no seat; adminId is seatId(email))
//   orgs/{orgId}/reports/unseated people: sign-ins without a seat, shown to the admin in Seats
//
// The employer sends only work email and department. Nothing else about a person is stored here.
import { createHash } from 'node:crypto';

export const DAY = 86400000;
export const READ_ONLY_DAYS = 30; // decided 12 Nov 2026: coach stops at once, account deleted 30 days later
export const MIN_SEATS = 20;      // decided 16 Nov 2026: no B2B contract under 20 seats; smaller companies get B2C Plus
export const MAX_DEPARTMENTS = 50;

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
  if (!Number.isInteger(o.seats) || o.seats < MIN_SEATS) errors.push('seats');
  if (!Number.isFinite(o.contractStart) || !Number.isFinite(o.contractEnd) || o.contractEnd <= o.contractStart) errors.push('contract');
  return errors;
}

// The employer admin sets the department list in the setup form before inviting anyone (decided 16 Nov 2026).
// Names are trimmed, unique regardless of case, and at most 60 characters.
export function cleanDepartments(list) {
  if (!Array.isArray(list)) return { error: 'not_a_list' };
  const out = [], seen = new Set();
  for (const raw of list) {
    const name = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (name.length > 60) return { error: 'name_too_long', name };
    if (seen.has(name.toLowerCase())) return { error: 'duplicate', name };
    seen.add(name.toLowerCase());
    out.push(name);
  }
  if (!out.length) return { error: 'empty' };
  if (out.length > MAX_DEPARTMENTS) return { error: 'too_many' };
  return { departments: out };
}
const departmentOf = (org, name) => {
  const key = String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return (org.departments || []).find((d) => d.toLowerCase() === key) || null;
};

// Merging departments (decided 16 Nov 2026). Two departments under 10 people may merge, and so may two of
// 10 or more. A department under 10 never merges into one of 10 or more: the new figure, compared with the
// figure the bigger department showed before, would reveal the hidden group.
export const DEPARTMENT_MIN = 10;
export function planMerge(org, members, from, into) {
  const a = departmentOf(org, from), b = departmentOf(org, into);
  if (!a || !b) return { error: 'unknown_department' };
  if (a === b) return { error: 'same_department' };
  const size = (d) => members.filter((m) => (m.status === 'invited' || m.status === 'active') && m.department === d).length;
  const small = (d) => size(d) < DEPARTMENT_MIN;
  if (small(a) !== small(b)) return { error: 'hidden_into_shown' };
  const moved = members.filter((m) => m.department === a).map((m) => ({ ...m, department: b }));
  return { departments: org.departments.filter((d) => d !== a), moved, into: b, people: size(a) + size(b) };
}

// Renaming keeps every person in place under the new name.
export function planRename(org, members, from, to) {
  const a = departmentOf(org, from);
  if (!a) return { error: 'unknown_department' };
  const c = cleanDepartments([to]);
  if (c.error) return { error: c.error === 'empty' ? 'name_missing' : c.error };
  const b = c.departments[0];
  if (b.toLowerCase() !== a.toLowerCase() && departmentOf(org, b)) return { error: 'duplicate', name: b };
  return {
    departments: org.departments.map((d) => (d === a ? b : d)),
    moved: members.filter((m) => m.department === a).map((m) => ({ ...m, department: b })),
  };
}

// A department goes only when nobody with a seat is in it. Merge moves people first.
export function planRemoveDepartment(org, members, name) {
  const a = departmentOf(org, name);
  if (!a) return { error: 'unknown_department' };
  if (members.some((m) => (m.status === 'invited' || m.status === 'active') && m.department === a)) return { error: 'not_empty' };
  return { departments: org.departments.filter((d) => d !== a) };
}

// A seat list from the admin (D12): work email and main department, with or without a header row.
// Accepts comma, semicolon (Dutch Excel) or tab, quoted cells and a byte order mark.
export const CSV_MAX_CHARS = 200000;
export const CSV_MAX_ROWS = 1000;
const cells = (line, sep) => {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
};
export function parseSeatCsv(text) {
  const s = String(text || '').replace(/^﻿/, '');
  if (s.length > CSV_MAX_CHARS) return { error: 'file_too_large' };
  const lines = s.split(/\r\n|\n|\r/).map((l, i) => ({ n: i + 1, l })).filter((x) => x.l.trim());
  if (!lines.length) return { error: 'empty' };
  const first = lines[0].l;
  const sep = ['\t', ';', ','].map((c) => [c, first.split(c).length]).sort((a, b) => b[1] - a[1])[0][0];
  let emailCol = 0, deptCol = 1, start = 0;
  const head = cells(first, sep).map((c) => c.toLowerCase());
  if (!head.some((c) => c.includes('@'))) {
    emailCol = head.findIndex((c) => /e-?mail/.test(c));
    deptCol = head.findIndex((c) => /department|afdeling/.test(c));
    if (emailCol < 0 || deptCol < 0) return { error: 'header_not_found' };
    start = 1;
  }
  const rows = lines.slice(start).map((x) => { const c = cells(x.l, sep); return { line: x.n, email: c[emailCol] || '', department: c[deptCol] || '' }; });
  if (!rows.length) return { error: 'empty' };
  if (rows.length > CSV_MAX_ROWS) return { error: 'too_many_rows' };
  return { rows };
}

export const contractActive =(org, now) => now >= org.contractStart && now < org.contractEnd;
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
    const no = (reason) => refused.push(row.line ? { line: row.line, email, reason, ...(reason === 'unknown_department' ? { department: String(row.department || '').trim().slice(0, 60) } : {}) } : { email, reason });
    if (!EMAIL.test(email)) { no('invalid_email'); continue; }
    if (!(org.departments || []).length) { no('no_departments_set'); continue; }
    const department = departmentOf(org, row.department);
    if (!department) { no('unknown_department'); continue; }
    if (!org.domains.includes(emailDomain(email))) { no('wrong_domain'); continue; }
    const id = seatId(email);
    const had = taken.get(id);
    if (had && holdsSeat(had)) { no('already_has_seat'); continue; }
    if (used >= org.seats) { no('no_seats_left'); continue; }
    if (!contractActive(org, now)) { no('contract_not_active'); continue; }
    if (had && had.status === 'deleting') { no('seat_ending'); continue; }
    // A seat given back within the 30 read-only days keeps the account, so the person loses nothing.
    const m = had && had.status === 'ended' && had.uid
      ? { ...had, department, status: 'active', endedAt: null, deleteAfter: null }
      : { email, department, status: 'invited', uid: null, invitedAt: now, firstSignInAt: null, endedAt: null, deleteAfter: null };
    delete m.seatId;
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
  tenantId: org.tenantId,
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

// Company admins (decided 19 Nov 2026). Keyed by email like seats, because the blocking sign-in function
// must recognise an admin before the account exists. The uid is bound at the first sign-in.
export const adminId = seatId;

export function planAdmin(org, email, now) {
  const e = normEmail(email);
  if (!EMAIL.test(e)) return { error: 'invalid_email' };
  if (!(org.domains || []).includes(emailDomain(e))) return { error: 'wrong_domain' };
  return { adminId: adminId(e), admin: { email: e, uid: null, addedAt: now, firstSignInAt: null } };
}

export function bindAdmin(org, admin, token, now) {
  if (!admin) return { error: 'not_admin' };
  if (!tenantMatches(token, org)) return { error: 'wrong_tenant' };
  if (normEmail(token.email) !== admin.email) return { error: 'wrong_email' };
  if (admin.uid && admin.uid !== token.uid) return { error: 'admin_bound' };
  if (admin.uid) return { admin, changed: false };
  return { admin: { ...admin, uid: token.uid, firstSignInAt: now }, changed: true };
}

export function firestoreOrgStore(db) {
  const org = (id) => db.doc(`orgs/${id}`);
  return {
    getOrg: async (id) => { const s = await org(id).get(); return s.exists ? { orgId: id, ...s.data() } : null; },
    setOrg: (o) => org(o.orgId).set(o, { merge: true }),
    members: async (id) => (await org(id).collection('members').get()).docs.map((d) => ({ seatId: d.id, ...d.data() })),
    member: async (id, sid) => { const s = await org(id).collection('members').doc(sid).get(); return s.exists ? { seatId: sid, ...s.data() } : null; },
    setMember: (id, sid, m) => org(id).collection('members').doc(sid).set(m, { merge: true }),
    setEntitlement: (uid, e) => db.doc(`entitlements/${uid}`).set(e, { merge: true }),
    orgByTenant: async (tenantId) => {
      const q = await db.collection('orgs').where('tenantId', '==', tenantId).limit(2).get();
      return q.size === 1 ? { orgId: q.docs[0].id, ...q.docs[0].data() } : null;
    },
    admins: async (id) => (await org(id).collection('admins').get()).docs.map((d) => ({ adminId: d.id, ...d.data() })),
    admin: async (id, aid) => { const s = await org(id).collection('admins').doc(aid).get(); return s.exists ? { adminId: aid, ...s.data() } : null; },
    setAdmin: (id, aid, a) => org(id).collection('admins').doc(aid).set(a, { merge: true }),
    deleteAdmin: (id, aid) => org(id).collection('admins').doc(aid).delete(),
  };
}
