// Brigvanti Plus payments through Mollie. The server sets prices and writes
// entitlements. The browser only asks to start, cancel or withdraw.
// Monthly: a first iDEAL payment creates a mandate, then a Mollie subscription.
// Yearly: one payment, no mandate and no automatic renewal.

export const PRICES = {
  month: { value: '13.99', label: 'Brigvanti Plus, monthly' },
  year: { value: '89.99', label: 'Brigvanti Plus, yearly' },
};
// Mollie retries a failed debit up to 5 times, about once a day.
export const GRACE_DAYS = 7;
export const WITHDRAW_DAYS = 14;
export const CONSENT_VERSION = '2026-11-11';
// A yearly plan can be renewed in its last 30 days. A cancelled monthly plan can restart before it ends.
export const RENEW_DAYS = 30;
export const canRenew = (b, now) => !!b && b.status === 'active' && b.periodEnd > now &&
  (b.interval === 'year' ? b.periodEnd - now <= RENEW_DAYS * DAY : !!b.cancelled);

const DAY = 86400000;
const MOLLIE = 'https://api.mollie.com/v2';

export function addPeriod(ms, interval) {
  const d = new Date(ms);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const json = (obj, status = 200) => Response.json(obj, { status });

// Monthly access runs to the paid period end plus grace. Yearly has no retries.
export function accessUntil(periodEnd, interval, cancelled) {
  return interval === 'month' && !cancelled ? periodEnd + GRACE_DAYS * DAY : periodEnd;
}

// Refund for a withdrawal: the learner pays for the days used, rounded up.
// A renewal bought before the old period ends has no used days yet.
export function withdrawRefund(amount, periodStart, periodEnd, now) {
  const total = Math.max(1, Math.round((periodEnd - periodStart) / DAY));
  const used = now < periodStart ? 0 : Math.min(total, Math.max(1, Math.ceil((now - periodStart) / DAY)));
  const cents = Math.round(Number(amount) * 100);
  return ((cents - Math.ceil(cents * used / total)) / 100).toFixed(2);
}

export function mollieClient(key, fetchImpl = fetch) {
  const call = async (method, path, body) => {
    const res = await fetchImpl(MOLLIE + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`mollie ${method} ${path} ${res.status} ${data.detail || ''}`);
    return data;
  };
  return {
    // Only the email goes to Mollie, for its payment receipts. No name.
    customer: (email, uid) => call('POST', '/customers', { email, metadata: { uid } }),
    payment: (body) => call('POST', '/payments', body),
    getPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}`),
    subscription: (cst, body) => call('POST', `/customers/${cst}/subscriptions`, body),
    cancelSubscription: (cst, sub) => call('DELETE', `/customers/${cst}/subscriptions/${sub}`),
    refund: (id, value) => call('POST', `/payments/${id}/refunds`, {
      amount: { currency: 'EUR', value }, description: 'Brigvanti Plus withdrawal',
    }),
  };
}

// billing/{uid} holds Mollie ids and the paid period. entitlements/{uid} holds
// the plan the coach reads. Both are server only.
export function firestorePayStore(db) {
  return {
    billing: async (uid) => { const s = await db.doc(`billing/${uid}`).get(); return s.exists ? s.data() : null; },
    entitlement: async (uid) => { const s = await db.doc(`entitlements/${uid}`).get(); return s.exists ? s.data() : null; },
    setBilling: (uid, data) => db.doc(`billing/${uid}`).set(data, { merge: true }),
    setEntitlement: (uid, data) => db.doc(`entitlements/${uid}`).set(data, { merge: true }),
    // True once per payment id, so a repeated webhook changes nothing.
    claim: (uid, paymentId) => db.runTransaction(async (tx) => {
      // Top level, so the seven year clean up can find old entries with a plain query.
      const ref = db.doc(`payclaims/${paymentId}`);
      if ((await tx.get(ref)).exists) return false;
      tx.set(ref, { uid, at: Date.now() });
      return true;
    }),
  };
}

async function signedIn(req, verify) {
  const t = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '');
  if (!t) return null;
  try { return await verify(t[1]); } catch { return null; }
}

const blockedByB2B = (e) => e && e.product === 'b2b';

export function createPayHandlers({ verify, store, mollie, notify = async () => {}, env = process.env, clock = Date.now }) {
  // APP_URL pins Mollie's webhook and return address to the app domain.
  // brigvanti.com moves to the website later, and a subscription keeps the webhook it was created with.
  const site = () => (env.APP_URL || env.URL || '').replace(/\/$/, '');
  const hook = () => `${site()}/.netlify/functions/pay-webhook`;

  // POST { interval: 'month'|'year', consent: true }
  async function start(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const user = await signedIn(req, verify);
    if (!user) return json({ error: 'Please sign in first.' }, 401);
    if (!mollie) return json({ code: 'pay_off', error: 'Payments are not open yet.' }, 503);
    const body = await req.json().catch(() => ({}));
    const interval = body.interval === 'year' ? 'year' : body.interval === 'month' ? 'month' : null;
    if (!interval) return json({ error: 'Choose monthly or yearly.' }, 400);
    if (body.consent !== true) return json({ code: 'consent', error: 'Please confirm the start of Plus first.' }, 400);

    const uid = user.sub, now = clock();
    const [ent, bill] = [await store.entitlement(uid), await store.billing(uid)];
    if (blockedByB2B(ent)) return json({ code: 'b2b', error: 'Your company account already has full access.' }, 409);
    const active = bill && bill.status === 'active' && bill.periodEnd > now;
    if (active && !canRenew(bill, now)) return json({ code: 'active', error: 'You already have Plus.' }, 409);

    let cst = bill && bill.customerId;
    if (!cst) cst = (await mollie.customer(user.email || undefined, uid)).id;
    const price = PRICES[interval];
    const pay = await mollie.payment({
      amount: { currency: 'EUR', value: price.value },
      description: price.label,
      customerId: cst,
      sequenceType: interval === 'month' ? 'first' : 'oneoff',
      redirectUrl: `${site()}/?pay=return`,
      webhookUrl: hook(),
      metadata: { uid, interval, kind: 'start' },
    });
    // The current plan stays as it is until the new payment is paid.
    await store.setBilling(uid, active
      ? { customerId: cst, pendingPaymentId: pay.id, consent: { version: CONSENT_VERSION, at: now, interval } }
      : { customerId: cst, interval, pendingPaymentId: pay.id, subscriptionId: null, cancelled: false, status: 'pending',
          consent: { version: CONSENT_VERSION, at: now, interval } });
    return json({ checkout: pay._links && pay._links.checkout && pay._links.checkout.href });
  }

  // Mollie posts id=tr_... only. The payment is read back from Mollie, so a forged call changes nothing.
  async function webhook(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!mollie) return new Response('off', { status: 503 });
    const form = new URLSearchParams(await req.text());
    const id = form.get('id') || '';
    if (!/^tr_\w+$/.test(id)) return new Response('ok');
    const p = await mollie.getPayment(id);
    const uid = p && p.metadata && p.metadata.uid;
    if (!uid) return new Response('ok');
    const now = clock();
    const bill = (await store.billing(uid)) || {};

    const charged = p.amountChargedBack && Number(p.amountChargedBack.value) > 0;
    if (charged) {
      await store.setBilling(uid, { status: 'chargeback', periodEnd: now });
      await store.setEntitlement(uid, { product: 'b2c', tier: 'free', validUntil: now, source: 'mollie' });
      return new Response('ok');
    }
    // A failed monthly debit: Mollie retries, Plus runs on through the grace days.
    // The learner hears about it once per period, by push and in the app.
    if (p.status === 'failed' && p.metadata.kind === 'renew' && bill.status === 'active') {
      if (bill.failNotified !== bill.periodEnd) {
        await store.setBilling(uid, { failedAt: now, failNotified: bill.periodEnd });
        try { await notify(uid, 'payment_failed', { until: accessUntil(bill.periodEnd, 'month', false) }); }
        catch (e) { console.warn('pay notify failed', e.message); }
      }
      return new Response('ok');
    }
    if (p.status !== 'paid') return new Response('ok');
    if (!(await store.claim(uid, id))) return new Response('ok');

    const interval = p.metadata.interval === 'year' ? 'year' : 'month';
    const isStart = p.metadata.kind === 'start';
    // A renewal starts where the paid period ends, so no paid day is lost.
    const renewing = isStart && bill.status === 'active' && (bill.periodEnd || 0) > now;
    const from = isStart && !renewing ? now : Math.max(bill.periodEnd || 0, now);
    const periodEnd = addPeriod(from, interval);
    const upd = { status: 'active', interval, periodEnd, lastPaymentId: id, lastAmount: p.amount.value, lastPaidAt: now, failedAt: null };
    if (isStart) Object.assign(upd, {
      startedAt: now, periodStart: from, firstPaymentId: id, cancelled: false, pendingPaymentId: null, endReminded: [],
      prev: renewing ? { interval: bill.interval, periodEnd: bill.periodEnd } : null,
    });

    if (isStart && interval === 'month') {
      const sub = await mollie.subscription(bill.customerId || p.customerId, {
        amount: { currency: 'EUR', value: PRICES.month.value },
        interval: '1 month',
        startDate: ymd(periodEnd),
        description: PRICES.month.label,
        webhookUrl: hook(),
        metadata: { uid, interval: 'month', kind: 'renew' },
      });
      upd.subscriptionId = sub.id;
    }
    await store.setBilling(uid, upd);
    await store.setEntitlement(uid, {
      product: 'b2c', tier: 'plus', source: 'mollie', interval,
      validUntil: accessUntil(periodEnd, interval, isStart ? false : !!bill.cancelled),
    });
    return new Response('ok');
  }

  // GET: plan details for Account. POST { action: 'cancel'|'withdraw' }.
  async function manage(req) {
    const user = await signedIn(req, verify);
    if (!user) return json({ error: 'Please sign in first.' }, 401);
    const uid = user.sub, now = clock();
    const bill = await store.billing(uid);
    const view = (b) => {
      if (!b || !['active', 'withdrawn'].includes(b.status)) return { status: b ? b.status : 'none' };
      const canWithdraw = b.status === 'active' && b.startedAt && now - b.startedAt < WITHDRAW_DAYS * DAY;
      return {
        status: b.status, interval: b.interval, periodEnd: b.periodEnd, cancelled: !!b.cancelled,
        withdrawUntil: canWithdraw ? b.startedAt + WITHDRAW_DAYS * DAY : null,
        canRenew: canRenew(b, now), renewed: !!b.prev,
        failedUntil: b.failedAt && b.interval === 'month' ? accessUntil(b.periodEnd, 'month', false) : null,
      };
    };
    if (req.method === 'GET') return json(view(bill));
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    if (!mollie) return json({ code: 'pay_off', error: 'Payments are not open yet.' }, 503);
    if (!bill || bill.status !== 'active') return json({ code: 'none', error: 'You have no active Plus plan.' }, 409);
    const { action } = await req.json().catch(() => ({}));

    if (action === 'cancel') {
      if (bill.subscriptionId && !bill.cancelled) await mollie.cancelSubscription(bill.customerId, bill.subscriptionId);
      await store.setBilling(uid, { cancelled: true, cancelledAt: now });
      await store.setEntitlement(uid, { validUntil: bill.periodEnd });
      return json(view({ ...bill, cancelled: true }));
    }
    if (action === 'withdraw') {
      if (!(bill.startedAt && now - bill.startedAt < WITHDRAW_DAYS * DAY)) {
        return json({ code: 'late', error: 'The 14 days to withdraw have passed. You can still cancel.' }, 409);
      }
      if (bill.subscriptionId && !bill.cancelled) await mollie.cancelSubscription(bill.customerId, bill.subscriptionId);
      const value = withdrawRefund(bill.lastAmount || PRICES[bill.interval].value, bill.periodStart || bill.startedAt, bill.periodEnd, now);
      if (Number(value) > 0) await mollie.refund(bill.firstPaymentId, value);
      // Withdrawing a renewal keeps the period that was already paid before it.
      if (bill.prev && bill.prev.periodEnd > now) {
        const back = { interval: bill.prev.interval, periodEnd: bill.prev.periodEnd, cancelled: true, prev: null, withdrawnAt: now, refund: value, subscriptionId: null };
        await store.setBilling(uid, back);
        await store.setEntitlement(uid, { interval: back.interval, validUntil: back.periodEnd });
        return json({ ...view({ ...bill, ...back }), refund: value });
      }
      await store.setBilling(uid, { status: 'withdrawn', cancelled: true, withdrawnAt: now, refund: value, periodEnd: now });
      await store.setEntitlement(uid, { tier: 'free', validUntil: now });
      return json({ ...view({ ...bill, status: 'withdrawn' }), refund: value });
    }
    return json({ error: 'Unknown action.' }, 400);
  }

  // A Mollie or storage failure never grants Plus. The webhook throws, so Mollie retries it.
  const safe = (fn) => async (req) => {
    try { return await fn(req); } catch (e) {
      console.error('pay failed', e);
      return json({ code: 'pay_error', error: 'Something went wrong with the payment service. Please try again.' }, 502);
    }
  };
  return { start: safe(start), webhook, manage: safe(manage) };
}
