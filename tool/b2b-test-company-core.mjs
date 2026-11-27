// Logic for the test company tool (step 4). The script around it is tool/b2b-test-company.mjs.
// Two fake companies for the full test on live (handover of 26 Nov 2026, section 6):
//   a: 20 seats, email link      b: 50 seats, Microsoft
// Everything written carries test: true. remove refuses any company without it.
import { DAY, normEmail, seatId, validateOrg, planAdmin, entitlementFor } from '../netlify/lib/b2b-orgs.mjs';
import { DATA_ORDER } from '../netlify/lib/b2b-seat-end.mjs';

export const PRESETS = {
  a: { orgId: 'test-a-20', name: 'Fake company A', displayName: 'Test-A-20', seats: 20, signIn: 'emailLink', seed: 10 },
  b: { orgId: 'test-b-50', name: 'Fake company B', displayName: 'Test-B-50', seats: 50, signIn: 'microsoft', seed: 36 },
};
export const CONTRACT_DAYS = 365;
export const PASSWORD_MIN = 8;      // P1.13
export const DEPARTMENT_BLOCK = 10; // a department figure shows from 10 seats (D11)
const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

export const isTestOrg = (org) => !!org && org.test === true && /^test-/.test(org.orgId || '');
export const isSeedUid = (uid) => /^seed-/.test(String(uid || ''));

// One sign-in method per tenant (proof of 19 Nov 2026). Email link needs email sign-in without a required
// password, so an employee can add a password later (D13). P1.16 and P1.13 are set at creation.
export function tenantOptions(preset) {
  return {
    displayName: preset.displayName,
    emailSignInConfig: preset.signIn === 'emailLink' ? { enabled: true, passwordRequired: false } : { enabled: false },
    emailPrivacyConfig: { enableImprovedEmailPrivacy: true },
    passwordPolicyConfig: { enforcementState: 'ENFORCE', constraints: { minLength: PASSWORD_MIN } },
  };
}

export function planCompany({ preset, tenantId, domain, adminEmail, msTenantId, now }) {
  const d = normEmail(domain);
  if (!DOMAIN.test(d)) return { error: 'domain' };
  if (preset.signIn === 'microsoft' && !String(msTenantId || '').trim()) return { error: 'ms_tenant' };
  const org = {
    orgId: preset.orgId, name: preset.name, tenantId, domains: [d], departments: [], seats: preset.seats,
    contractStart: now, contractEnd: now + CONTRACT_DAYS * DAY, founding: false, source: 'test', test: true,
    signIn: preset.signIn,
    ...(preset.signIn === 'microsoft' ? { microsoftTenantId: String(msTenantId).trim().toLowerCase() } : {}),
  };
  const errors = validateOrg(org);
  if (errors.length) return { error: 'org', fields: errors };
  const a = planAdmin(org, adminEmail, now);
  if (a.error) return { error: 'admin_' + a.error };
  return { org, adminId: a.adminId, admin: a.admin };
}

// Fills departments in blocks of 10, so some figures show, and puts the rest in a small group, so a hidden
// department shows too. With one department, everyone goes there.
export function spread(count, departments) {
  const out = [];
  let left = count;
  for (let i = 0; i < departments.length && left > 0; i++) {
    const n = i === departments.length - 1 || left <= DEPARTMENT_BLOCK ? left : DEPARTMENT_BLOCK;
    for (let j = 0; j < n; j++) out.push(departments[i]);
    left -= n;
  }
  return out;
}

// Repeatable random numbers, so a reseed gives the same figures.
export function rng(seedText) {
  let a = [...String(seedText)].reduce((h, c) => (Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0), 2166136261);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';

// Fake learners with levels and activity, so the dashboard figures show. Not real sign-ins:
// the uid starts with seed- and the address ends in .invalid, so no sign-in can ever bind to one.
export function planSeed({ org, members, comps, count, now }) {
  if (!isTestOrg(org)) return { error: 'not_a_test_company' };
  if (!(org.departments || []).length) return { error: 'no_departments' };
  const real = members.filter((m) => !m.seeded);
  const free = org.seats - real.filter(holdsSeat).length;
  if (!Number.isInteger(count) || count < 1) return { error: 'count' };
  if (count > free) return { error: 'no_seats_left', free };
  const rand = rng(org.orgId);
  const pick = (n) => Math.floor(rand() * n);
  const areas = [...new Set(comps.map((c) => c.d))].sort();
  const depts = spread(count, org.departments);
  // D4 hides active and inactive together when either is 1 to 4, so quiet learners appear only from 25,
  // one in five. Everyone else was active this calendar month, so "Active this month" shows too.
  const quietOn = count >= 25;
  const monthStart = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), 1);
  const recentDays = Math.min(20, Math.floor((now - monthStart) / DAY));
  const seeds = [];
  for (let i = 0; i < count; i++) {
    const nn = String(i + 1).padStart(2, '0');
    const uid = `seed-${org.orgId}-${nn}`;
    const email = `seed-${nn}@${org.orgId}.invalid`;
    const quiet = quietOn && i % 5 === 4;
    const last = quiet ? now - (35 + pick(55)) * DAY : Math.max(monthStart, now - pick(recentDays + 1) * DAY - pick(3600000));
    const start = last - (20 + pick(100)) * DAY;
    const firstSignInAt = start - pick(3) * DAY;
    const scan = {};
    const mine = areas.filter(() => rand() < 0.7);
    if (!mine.length) mine.push(areas[pick(areas.length)]);
    const base = 1 + pick(3);
    for (const d of mine) {
      for (const c of comps.filter((x) => x.d === d)) {
        const lv = Math.max(1, Math.min(4, base + pick(3) - 1));
        scan[c.id] = { done: true, confirmed: lv, log: [{ q: 1, t: start + pick(5) * DAY }] };
      }
    }
    const cids = Object.keys(scan);
    const reps = [];
    const n = quiet ? pick(8) : 1 + pick(12);
    for (let k = 0; k < n; k++) reps.push({ c: cids[pick(cids.length)], t: start + Math.floor(((last - start) * (k + 1)) / n) });
    if (n) reps[n - 1].t = last;
    else scan[cids[0]].log[0].t = last;
    const member = { email, department: depts[i], status: 'active', uid, invitedAt: firstSignInAt - DAY, firstSignInAt,
      endedAt: null, deleteAfter: null, seeded: true };
    seeds.push({
      seatId: seatId(email), member, uid,
      user: { blob: JSON.stringify({ name: `Seed ${nn}`, scan, reps, seeded: true }), seeded: true },
      entitlement: { ...entitlementFor(org, member), seeded: true },
    });
  }
  return { seeds, replaced: members.filter((m) => m.seeded).length };
}

// Removes earlier seeded learners, then writes the new ones. The seat is written last, so the dashboard
// never counts a seat whose data is missing.
export async function runSeed(store, plan, org, members) {
  for (const m of members.filter((x) => x.seeded)) {
    for (const path of DATA_ORDER) await store.deleteData(path, m.uid);
    await store.deleteMember(org.orgId, m.seatId);
  }
  for (const s of plan.seeds) {
    await store.setUser(s.uid, s.user);
    await store.setEntitlement(s.uid, s.entitlement);
    await store.setMember(org.orgId, s.seatId, s.member);
  }
}

// What remove would delete. Shown in full before anything goes, and again with --yes.
export function planRemove(org, members, admins, tenantUsers) {
  if (!isTestOrg(org)) return { error: 'not_a_test_company' };
  const uids = new Set([...tenantUsers.map((u) => u.uid), ...members.map((m) => m.uid), ...admins.map((a) => a.uid)].filter(Boolean));
  return {
    orgId: org.orgId, tenantId: org.tenantId, signIns: tenantUsers.map((u) => u.uid),
    accounts: [...uids], seats: members.length, seeded: members.filter((m) => m.seeded).length, admins: admins.length,
  };
}

// Sign-ins first, so nobody can sign in while the data goes. The company record goes last,
// so a run that stops halfway can be started again and finds what is left.
export async function runRemove(store, plan) {
  for (const uid of plan.signIns) await store.deleteSignIn(plan.tenantId, uid);
  for (const uid of plan.accounts) for (const path of DATA_ORDER) await store.deleteData(path, uid);
  await store.deleteTenant(plan.tenantId);
  await store.deleteOrg(plan.orgId);
}

