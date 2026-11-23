// Admin check for company.html (decided 19 Nov 2026). The first call after an admin's first sign-in
// binds the uid to the admin record. Every later call checks that the same uid comes back.
import { adminId, bindAdmin } from './b2b-orgs.mjs';

const json = (obj, status = 200) => Response.json(obj, { status });

export function createB2bAdmin({ verify, store, now = () => Date.now() }) {
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    let user;
    try { user = t && (await verify(t[1])); } catch { user = null; }
    if (!user || !user.uid) return json({ error: 'Please sign in first.' }, 401);
    const org = await store.orgByTenant(user.firebase.tenant);
    if (!org) return json({ code: 'not_admin', error: 'This account has no admin access.' }, 403);
    const id = adminId(user.email);
    const r = bindAdmin(org, await store.admin(org.orgId, id), user, now());
    if (r.error) return json({ code: 'not_admin', error: 'This account has no admin access.' }, 403);
    if (r.changed) await store.setAdmin(org.orgId, id, { uid: r.admin.uid, firstSignInAt: r.admin.firstSignInAt });
    return json({ admin: true, orgId: org.orgId, name: org.name });
  };
}
