// The company link (P1.14): company.html?b2b=<tenantId> and /?b2b=<tenantId> ask this function which
// sign-in to show. It answers with the company name and sign-in method only, and needs no sign-in.
// An unknown tenant gets the same 404 as a malformed one.
const TENANT = /^[A-Za-z0-9-]{1,128}$/;
const json = (obj, status = 200) => Response.json(obj, { status, headers: { 'cache-control': 'no-store' } });

export function createB2bCompanyInfo({ store }) {
  return async (req) => {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const tenant = new URL(req.url).searchParams.get('tenant') || '';
    if (!TENANT.test(tenant)) return json({ code: 'unknown' }, 404);
    const org = await store.orgByTenant(tenant);
    if (!org || !org.signIn) return json({ code: 'unknown' }, 404);
    return json({ name: org.name, signIn: org.signIn });
  };
}
