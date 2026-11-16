// Sign-in check for B2B functions. A company token is verified inside its own tenant,
// so a consumer token, or a token from another company, never passes.
export function tenantOf(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return null;
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))?.firebase?.tenant || null; }
  catch { return null; }
}

export const companyVerifier = (auth) => async (token) => {
  const tenant = tenantOf(token);
  if (!tenant) throw new Error('not a company sign-in');
  const user = await auth.tenantManager().authForTenant(tenant).verifyIdToken(token);
  if (!user.firebase || user.firebase.tenant !== tenant) throw new Error('tenant mismatch');
  return user;
};
