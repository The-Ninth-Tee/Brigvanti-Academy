// Daily clean up of consumer data whose sign in no longer exists. Catches a deletion that stopped halfway.
// Company seat holders live in their own tenant, so a project-level lookup never finds them.
// Their data carries entitlements/{uid}.product 'b2b' and is left to the B2B seat end job.
export const SWEEP_PATHS = ['entitlements', 'usage', 'users', 'reminders'];

export async function sweepOrphans({ refsById, getUsers, entitlement, remove, budgetMs = 24000, clock = Date.now }) {
  const t0 = clock();
  const ids = Object.keys(refsById);
  let removed = 0, companySkipped = 0;
  for (let i = 0; i < ids.length && clock() - t0 < budgetMs; i += 100) {
    const res = await getUsers(ids.slice(i, i + 100));
    for (const uid of res.notFound) {
      const e = await entitlement(uid);
      if (e && e.product === 'b2b') { companySkipped++; continue; }
      for (const r of refsById[uid]) await remove(r);
      removed++;
    }
  }
  return { accounts: ids.length, removed, companySkipped };
}
