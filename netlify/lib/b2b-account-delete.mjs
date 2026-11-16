// Delete my account for a company seat holder (decided 12 Nov 2026).
// It deletes the account in the company tenant and frees the seat at once.
import { seatId } from './b2b-orgs.mjs';
import { deleteSeatAccount } from './b2b-seat-end.mjs';

const json = (obj, status = 200) => Response.json(obj, { status });

export function createB2bAccountDelete({ verify, store }) {
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    let user;
    try { user = t && (await verify(t[1])); } catch { user = null; }
    if (!user || !user.uid) return json({ error: 'Please sign in first.' }, 401);
    const ent = await store.entitlement(user.uid);
    if (!ent || ent.product !== 'b2b' || !ent.orgId) return json({ code: 'no_seat', error: 'No company seat found for this account.' }, 404);
    const org = await store.getOrg(ent.orgId);
    if (!org || org.tenantId !== user.firebase.tenant) return json({ code: 'wrong_company', error: 'This account does not belong to this company.' }, 403);
    const member = await store.member(org.orgId, seatId(user.email));
    if (!member || member.uid !== user.uid) return json({ code: 'no_seat', error: 'No company seat found for this account.' }, 404);
    try {
      await deleteSeatAccount(store, org, member);
    } catch (e) {
      // The seat is marked 'deleting'. The daily seat end job finishes the deletion.
      console.error('[b2b-account-delete] failed, seat end job retries', org.orgId, member.seatId, e.message);
      return json({ code: 'delete_failed', error: 'Your account could not be deleted completely. It will be finished within a day.' }, 502);
    }
    return json({ deleted: true });
  };
}
