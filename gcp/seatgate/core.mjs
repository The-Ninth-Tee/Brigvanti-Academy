// seatgate decision logic (measure A). No dependencies, so tool/test-b2b.mjs can test every path.
// The Cloud Function in index.js only collects the event fields and the database reads.
//
// Rules for a sign-up inside a company tenant, in this order:
//   1. No account is ever created with a password (decided 19 Nov 2026).
//   2. The company exists, once, for this tenant, and its contract is running.
//   3. The sign-in method is the company's own method (orgs/{orgId}.signIn).
//   4. Microsoft: the account comes from the company's own Microsoft tenant (orgs/{orgId}.microsoftTenantId).
//   5. The address holds an admin record, or a seat that is invited or active.
// A consumer sign-up (no tenant) always passes, before any of this.
import { createHash } from 'node:crypto';

export const norm = (e) => String(e || '').trim().toLowerCase();
// Must stay identical to seatId() in netlify/lib/b2b-orgs.mjs. tool/test-b2b.mjs checks this.
export const seatId = (e) => createHash('sha256').update(norm(e)).digest('hex').slice(0, 32);

// Company sign-in setting -> the sign-in methods Identity Platform reports for it.
export const METHODS = {
  microsoft: (m) => m === 'microsoft.com',
  google: (m) => m === 'google.com',
  emailLink: (m) => m === 'emailLink',
  saml: (m) => m.startsWith('saml.'),
  oidc: (m) => m.startsWith('oidc.'),
};

// The method is the part after the colon in the event type, for example ...beforeCreate:emailLink.
export const methodOf = (eventType) => {
  const i = String(eventType || '').lastIndexOf(':');
  return i < 0 ? 'unknown' : String(eventType).slice(i + 1);
};

// Reads the Microsoft tenant (tid) from the ID token that Identity Platform received from Microsoft.
// The token reaches the function inside the event that Google signed, so it is not verified again here.
export function microsoftTenantOf(idToken) {
  try {
    const part = String(idToken || '').split('.')[1];
    const claims = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof claims.tid === 'string' ? claims.tid.toLowerCase() : null;
  } catch {
    return null;
  }
}

const pass = (reason) => ({ ok: true, reason });
const refuse = (reason) => ({ ok: false, reason });

// input: { tenantId, method, email, idToken }
// store: { orgsByTenant(tenantId) -> [org], admin(orgId, id) -> record|null, seat(orgId, id) -> record|null }
export async function decide(input, store, now) {
  if (!input.tenantId) return pass('consumer_pass');
  if (input.method === 'password') return refuse('password_signup');
  const email = norm(input.email);
  if (!email) return refuse('no_email');

  const orgs = await store.orgsByTenant(input.tenantId);
  if (orgs.length !== 1) return refuse(orgs.length ? 'tenant_ambiguous' : 'tenant_unknown');
  const org = orgs[0];
  if (!(now >= org.contractStart && now < org.contractEnd)) return refuse('contract_not_active');

  const allowed = METHODS[org.signIn];
  if (!allowed) return refuse('signin_not_set');
  if (!allowed(input.method)) return refuse('wrong_method');

  if (org.signIn === 'microsoft') {
    const want = norm(org.microsoftTenantId);
    if (!want) return refuse('microsoft_tenant_not_set');
    const got = microsoftTenantOf(input.idToken);
    if (!got) return refuse('microsoft_tenant_missing');
    if (got !== want) return refuse('microsoft_tenant_mismatch');
  }

  const id = seatId(email);
  if (await store.admin(org.orgId, id)) return pass('admin_pass');
  const seat = await store.seat(org.orgId, id);
  if (!seat) return refuse('not_on_seat_list');
  if (seat.status !== 'invited' && seat.status !== 'active') return refuse('seat_' + seat.status);
  return pass('seat_pass');
}
