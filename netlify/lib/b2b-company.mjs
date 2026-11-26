// Company dashboard actions for company.html (B5). Every action runs behind the admin gate.
// What an admin may see (B2B privacy rules, board B2B26): totals and averages, and who holds a seat with
// their main department. Never who signed in, what anyone did, or anyone's level. So the seat list does not
// tell an invite from a used seat, and removing a seat gives the same answer for both.
// The one exception, approved for PR #30 (L11): a sign-in without a seat shows its work email and date.
import { adminGate } from './b2b-admin.mjs';
import {
  cleanDepartments, endSeat, entitlementFor, normEmail, parseSeatCsv, planAdmin, planInvites, planMerge,
  planRemoveDepartment, planRename, READ_ONLY_DAYS, adminId,
} from './b2b-orgs.mjs';
import { companyStats, learnerSummary } from './b2b-stats.mjs';
import { DATA_ORDER } from './b2b-seat-end.mjs';

const json = (obj, status = 200) => Response.json(obj, { status });
const no = (code, extra = {}) => json({ code, ...extra }, 400);
const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';
const BODY_MAX = 250000;

const companyCard = (org) => ({
  name: org.name, seats: org.seats, contractStart: org.contractStart, contractEnd: org.contractEnd,
  domains: org.domains || [], signIn: org.signIn || null, departments: org.departments || [],
});

async function writeSeats(store, org, add) {
  for (const { seatId: id, member } of add) {
    await store.setMember(org.orgId, id, member);
    if (member.uid) await store.setEntitlement(member.uid, entitlementFor(org, member));
  }
}

function invitePlan(org, members, rows, now) {
  const r = planInvites(org, members, rows, now);
  return { ...r, accepted: r.add.map((a) => ({ email: a.member.email, department: a.member.department })) };
}

const ACTIONS = {
  async overview({ org, store, now }) {
    const members = await store.members(org.orgId);
    const uids = members.filter((m) => m.status === 'active' && m.uid && !m.outOfAverages).map((m) => m.uid);
    const stats = companyStats({ org, members, summaries: await store.summaries(uids), now, since: org.contractStart });
    return { company: companyCard(org), stats };
  },

  async seats({ org, store }) {
    const members = await store.members(org.orgId);
    const seats = members.filter(holdsSeat)
      .map((m) => ({ id: m.seatId, email: m.email, department: m.department }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return { seats, bought: org.seats, left: org.seats - seats.length, seatEnds: org.contractEnd, readOnlyDays: READ_ONLY_DAYS };
  },

  async seatAdd({ org, store, now, body }) {
    const p = invitePlan(org, await store.members(org.orgId), [{ email: body.email, department: body.department }], now);
    if (!p.add.length) return no(p.refused[0].reason);
    await writeSeats(store, org, p.add);
    return { added: p.accepted[0], left: p.left };
  },

  async uploadPreview({ org, store, now, body }) {
    const csv = parseSeatCsv(body.csv);
    if (csv.error) return no(csv.error);
    const p = invitePlan(org, await store.members(org.orgId), csv.rows, now);
    return { accepted: p.accepted, refused: p.refused, left: p.left };
  },

  // The list is planned again against the seats as they are now, so a preview cannot go stale.
  async uploadCommit({ org, store, now, body }) {
    const csv = parseSeatCsv(body.csv);
    if (csv.error) return no(csv.error);
    const p = invitePlan(org, await store.members(org.orgId), csv.rows, now);
    await writeSeats(store, org, p.add);
    return { added: p.add.length, refused: p.refused, left: p.left };
  },

  async seatRemove({ org, store, now, body }) {
    const m = await store.member(org.orgId, String(body.id || ''));
    if (!m || !holdsSeat(m)) return no('no_seat');
    const next = endSeat(m, now);
    await store.setMember(org.orgId, m.seatId, next);
    if (next.uid) await store.setEntitlement(next.uid, entitlementFor(org, next));
    return { removed: true, readOnlyDays: READ_ONLY_DAYS };
  },

  async unseated({ org, store }) {
    const r = (await store.unseated(org.orgId)) || { people: [], total: 0, updatedAt: null };
    const people = (r.people || []).map(({ email, firstSignInAt, removeAfter, matchesInvite }) => ({ email, firstSignInAt, removeAfter, matchesInvite }));
    return { people, total: r.total || people.length, updatedAt: r.updatedAt || null };
  },

  // Give a seat to a sign-in without one: the account is bound at once, so the seat end job keeps it.
  async unseatedGive({ org, store, now, body }) {
    const { entry, report } = await unseatedEntry(store, org, body.email);
    if (!entry) return no('not_found');
    const members = await store.members(org.orgId);
    if (members.some((m) => m.uid === entry.uid)) return no('already_has_seat');
    const invite = members.find((m) => m.status === 'invited' && !m.uid && m.email === entry.email);
    let add;
    if (invite) {
      const p = invitePlan(org, members.filter((m) => m !== invite), [{ email: entry.email, department: body.department || invite.department }], now);
      if (!p.add.length) return no(p.refused[0].reason);
      add = p.add;
    } else {
      const p = invitePlan(org, members, [{ email: entry.email, department: body.department }], now);
      if (!p.add.length) return no(p.refused[0].reason);
      add = p.add;
    }
    const m = { ...add[0].member, status: 'active', uid: entry.uid, firstSignInAt: entry.firstSignInAt, invitedAt: (invite && invite.invitedAt) || now };
    await writeSeats(store, org, [{ seatId: add[0].seatId, member: m }]);
    await dropFromReport(store, org, report, entry.uid);
    return { given: true, email: m.email, department: m.department };
  },

  async unseatedRemove({ org, store, body }) {
    const { entry, report } = await unseatedEntry(store, org, body.email);
    if (!entry) return no('not_found');
    const members = await store.members(org.orgId);
    const admins = await store.admins(org.orgId);
    if (members.some((m) => m.uid === entry.uid) || admins.some((a) => a.uid === entry.uid || normEmail(a.email) === entry.email)) return no('not_unseated');
    await store.deleteSignIn(org.tenantId, entry.uid);
    for (const path of DATA_ORDER) await store.deleteData(path, entry.uid);
    await dropFromReport(store, org, report, entry.uid);
    return { removed: true };
  },

  async departments({ org, store }) {
    const seats = (await store.members(org.orgId)).filter(holdsSeat);
    return { departments: (org.departments || []).map((name) => ({ name, people: seats.filter((m) => m.department === name).length })) };
  },

  async departmentsAdd({ org, store, body }) {
    const names = Array.isArray(body.names) ? body.names : [body.name];
    const c = cleanDepartments([...(org.departments || []), ...names]);
    if (c.error) return no(c.error, c.name ? { name: c.name } : {});
    await store.setDepartments(org.orgId, c.departments);
    return { departments: c.departments };
  },

  async departmentRename({ org, store, body }) {
    const p = planRename(org, await store.members(org.orgId), body.from, body.to);
    if (p.error) return no(p.error);
    await store.setDepartments(org.orgId, p.departments);
    for (const m of p.moved) await store.setMember(org.orgId, m.seatId, { department: m.department });
    return { departments: p.departments };
  },

  async departmentMerge({ org, store, body }) {
    const p = planMerge(org, await store.members(org.orgId), body.from, body.into);
    if (p.error) return no(p.error);
    for (const m of p.moved) await store.setMember(org.orgId, m.seatId, { department: m.department });
    await store.setDepartments(org.orgId, p.departments);
    return { departments: p.departments, into: p.into, people: p.people };
  },

  async departmentRemove({ org, store, body }) {
    const p = planRemoveDepartment(org, await store.members(org.orgId), body.name);
    if (p.error) return no(p.error);
    await store.setDepartments(org.orgId, p.departments);
    return { departments: p.departments };
  },

  async admins({ org, store, me }) {
    const list = (await store.admins(org.orgId)).map((a) => ({ email: a.email, you: a.adminId === me })).sort((a, b) => a.email.localeCompare(b.email));
    return { admins: list };
  },

  async adminAdd({ org, store, now, body }) {
    const p = planAdmin(org, body.email, now);
    if (p.error) return no(p.error);
    if (await store.admin(org.orgId, p.adminId)) return no('already_admin');
    await store.setAdmin(org.orgId, p.adminId, p.admin);
    return { added: p.admin.email };
  },

  // An admin cannot remove themselves, so a company always keeps at least one admin.
  async adminRemove({ org, store, me, body }) {
    const id = adminId(body.email);
    if (id === me) return no('cannot_remove_self');
    if (!(await store.admin(org.orgId, id))) return no('not_admin');
    await store.deleteAdmin(org.orgId, id);
    return { removed: normEmail(body.email) };
  },
};

async function unseatedEntry(store, org, email) {
  const report = (await store.unseated(org.orgId)) || { people: [] };
  const e = normEmail(email);
  return { report, entry: e ? (report.people || []).find((p) => p.email === e) : null };
}
async function dropFromReport(store, org, report, uid) {
  const people = (report.people || []).filter((p) => p.uid !== uid);
  await store.setUnseated(org.orgId, { ...report, people, total: Math.max(0, (report.total || 0) - 1) });
}

export const COMPANY_ACTIONS = Object.keys(ACTIONS);

// Two admins at once (26 Nov 2026). Every change runs in one transaction on the company record, so two
// changes never interleave. The page sends the version it last saw. If another admin changed something
// since, the change is refused with 409 and the page reloads before the admin tries again.
export const MUTATIONS = new Set(['seatAdd', 'uploadCommit', 'seatRemove', 'unseatedGive', 'unseatedRemove',
  'departmentsAdd', 'departmentRename', 'departmentMerge', 'departmentRemove', 'adminAdd', 'adminRemove']);
const CHANGED = Symbol('changed');

export function createB2bCompany({ verify, store, now = () => Date.now() }) {
  const gate = adminGate({ verify, store, now });
  return async (req) => {
    const g = await gate(req);
    if (g.refused) return g.refused;
    let body;
    try {
      const text = await req.text();
      if (text.length > BODY_MAX) return json({ code: 'too_large' }, 413);
      body = JSON.parse(text || '{}');
    } catch { return no('bad_request'); }
    const name = body && typeof body.action === 'string' && Object.hasOwn(ACTIONS, body.action) ? body.action : null;
    if (!name) return no('unknown_action');
    try {
      if (!MUTATIONS.has(name)) {
        const out = await ACTIONS[name]({ org: g.org, me: g.adminId, store, now: now(), body });
        return out instanceof Response ? out : json({ ...out, rev: g.org.rev || 0 });
      }
      const result = await store.transaction(g.org.orgId, async (tx) => {
        const org = await tx.getOrg(g.org.orgId);
        const rev = (org && org.rev) || 0;
        if (body.rev !== undefined && body.rev !== rev) return CHANGED;
        const out = await ACTIONS[name]({ org, me: g.adminId, store: tx, now: now(), body });
        if (out instanceof Response) return out;
        await tx.setRev(g.org.orgId, rev + 1);
        return { ...out, rev: rev + 1 };
      });
      if (result === CHANGED) return json({ code: 'changed' }, 409);
      return result instanceof Response ? result : json(result);
    } catch (e) {
      console.error('[b2b-company] failed', g.org.orgId, name, String((e && e.message) || e));
      return json({ code: 'failed', error: 'Something went wrong. Try again.' }, 500);
    }
  };
}

// Reads the learners' own state from users/{uid}.blob and keeps only what the totals need.
export function firestoreCompanyStore(db, auth, orgStore) {
  const users = (uid) => db.doc(`users/${uid}`);
  return {
    ...orgStore,
    setDepartments: (orgId, departments) => db.doc(`orgs/${orgId}`).set({ departments }, { merge: true }),
    unseated: async (orgId) => { const s = await db.doc(`orgs/${orgId}/reports/unseated`).get(); return s.exists ? s.data() : null; },
    setUnseated: (orgId, report) => db.doc(`orgs/${orgId}/reports/unseated`).set(report),
    summaries: async (uids) => {
      const out = {};
      for (let i = 0; i < uids.length; i += 100) {
        const snaps = await db.getAll(...uids.slice(i, i + 100).map(users));
        for (const s of snaps) {
          if (!s.exists || typeof s.data().blob !== 'string') continue;
          try { out[s.id] = learnerSummary(JSON.parse(s.data().blob)); } catch { /* an unreadable state counts as no data */ }
        }
      }
      return out;
    },
    deleteSignIn: async (tenantId, uid) => {
      try { await auth.tenantManager().authForTenant(tenantId).deleteUser(uid); }
      catch (e) { if (e.code !== 'auth/user-not-found') throw e; }
    },
    deleteData: (path, uid) => db.recursiveDelete(db.doc(`${path}/${uid}`)),
    // All reads come before all writes in every action, as a Firestore transaction requires.
    // Deleting a sign-in and its data cannot be part of a transaction; both are safe to repeat on a retry.
    transaction(orgId, fn) {
      const outer = this;
      return db.runTransaction(async (t) => {
        const orgRef = db.doc(`orgs/${orgId}`);
        const members = orgRef.collection('members'), admins = orgRef.collection('admins');
        const report = db.doc(`orgs/${orgId}/reports/unseated`);
        return fn({
          getOrg: async (id) => { const s = await t.get(orgRef); return s.exists ? { orgId: id, ...s.data() } : null; },
          members: async () => (await t.get(members)).docs.map((d) => ({ seatId: d.id, ...d.data() })),
          member: async (o, sid) => { const s = await t.get(members.doc(sid)); return s.exists ? { seatId: sid, ...s.data() } : null; },
          admins: async () => (await t.get(admins)).docs.map((d) => ({ adminId: d.id, ...d.data() })),
          admin: async (o, aid) => { const s = await t.get(admins.doc(aid)); return s.exists ? { adminId: aid, ...s.data() } : null; },
          unseated: async () => { const s = await t.get(report); return s.exists ? s.data() : null; },
          setMember: (o, sid, m) => { t.set(members.doc(sid), m, { merge: true }); },
          setEntitlement: (uid, e) => { t.set(db.doc(`entitlements/${uid}`), e, { merge: true }); },
          setDepartments: (o, departments) => { t.set(orgRef, { departments }, { merge: true }); },
          setAdmin: (o, aid, a) => { t.set(admins.doc(aid), a, { merge: true }); },
          deleteAdmin: (o, aid) => { t.delete(admins.doc(aid)); },
          setUnseated: (o, r) => { t.set(report, r); },
          setRev: (o, rev) => { t.set(orgRef, { rev }, { merge: true }); },
          deleteSignIn: outer.deleteSignIn,
          deleteData: outer.deleteData,
        });
      });
    },
  };
}
