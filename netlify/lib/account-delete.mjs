// Deletes an account on the server. The browser cannot touch server-only data,
// so this is the only way plan and usage data leave with the account.
// Kept: billing records and payclaims, for the seven years Dutch tax law requires.
// The ledger holds totals per month, plan and day, never per person.
//
// The sign in is deleted first, here on the server, and the data after it.
// So the usage counters can never be cleared for an account that still works,
// which would hand out fresh coach caps.

const json = (obj, status = 200) => Response.json(obj, { status });

export function firestoreAccountStore(db, auth) {
  return {
    billing: async (uid) => { const s = await db.doc(`billing/${uid}`).get(); return s.exists ? s.data() : null; },
    markCancelled: (uid, at) => db.doc(`billing/${uid}`).set({ cancelled: true, cancelledAt: at, accountDeletedAt: at }, { merge: true }),
    deleteData: async (uid) => {
      for (const path of [`entitlements/${uid}`, `usage/${uid}`, `reminders/${uid}`, `users/${uid}`]) {
        await db.recursiveDelete(db.doc(path));
      }
    },
    deleteSignIn: (uid) => auth.deleteUser(uid),
  };
}

export function createAccountDelete({ verify, store, mollie, clock = Date.now }) {
  return async (req) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
    let uid;
    try { uid = t && (await verify(t[1])).sub; } catch { uid = null; }
    if (!uid) return json({ error: 'Please sign in first.' }, 401);
    const now = clock();
    try {
      // A running monthly plan is cancelled first. If that fails, nothing is deleted.
      const bill = await store.billing(uid);
      if (bill && bill.status === 'active' && bill.subscriptionId && !bill.cancelled) {
        if (!mollie) throw new Error('mollie off');
        await mollie.cancelSubscription(bill.customerId, bill.subscriptionId);
      }
      if (bill) await store.markCancelled(uid, now);
      await store.deleteSignIn(uid);
    } catch (e) {
      console.error('account delete failed', e);
      return json({ code: 'delete_failed', error: 'Your account could not be deleted. Please try again.' }, 502);
    }
    // The sign in is gone, so the account is deleted. If a data step fails here,
    // the daily account-sweep removes what is left.
    try { await store.deleteData(uid); }
    catch (e) { console.error('account data delete failed, sweep will retry', uid, e.message); }
    return json({ deleted: true });
  };
}
