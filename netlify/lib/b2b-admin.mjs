// Admin check for company.html (decided 19 Nov 2026). The first call after an admin's first sign-in
// binds the uid to the admin record. Every later call checks that the same uid comes back.
// adminGate is the check for every company function: it returns the company and the admin, or a refusal.
import { adminId, bindAdmin } from './b2b-orgs.mjs';

const json = (obj, status = 200) => Response.json(obj, { status });
const NOT_ADMIN = () => json({ code: 'not_admin', error: 'This account has no admin access.' }, 403);

export function adminGate({ verify, store, now = () => Date.now() }) {
  return async (req) => {
    if (req.method !== 'POST') return { refused: new Response('Method not allowed', { status: 405 }) };
    const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    let user;
    try { user = t && (await verify(t[1])); } catch { user = null; }
    if (!user || !user.uid) return { refused: json({ error: 'Please sign in first.' }, 401) };
    const org = await store.orgByTenant(user.firebase.tenant);
    if (!org) return { refused: NOT_ADMIN() };
    const id = adminId(user.email);
    const r = bindAdmin(org, await store.admin(org.orgId, id), user, now());
    if (r.error) return { refused: NOT_ADMIN() };
    if (r.changed) await store.setAdmin(org.orgId, id, { uid: r.admin.uid, firstSignInAt: r.admin.firstSignInAt });
    return { org, adminId: id, admin: r.admin };
  };
}

export function createB2bAdmin(deps) {
  const gate = adminGate(deps);
  return async (req) => {
    const g = await gate(req);
    if (g.refused) return g.refused;
    return json({ admin: true, orgId: g.org.orgId, name: g.org.name });
  };
}
