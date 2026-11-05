// THE COACH CAP. Never remove or bypass it. See tool/check-coach-cap.mjs.
// To change a number on purpose, change it here and in LOCKED in that check.
// Only one call path exists: createCoachHandler in coach-gate.mjs.

export const CAPS = Object.freeze({
  free: Object.freeze({ day: 2, month: 20 }),
  plus: Object.freeze({ day: 20, month: 300 }),
  b2b: Object.freeze({ day: 20, month: 300 }),
  b2b_ended: Object.freeze({ day: 0, month: 0 }),
  probe: Object.freeze({ day: 0, month: 0 }),
});

export const LIMITS = Object.freeze({
  model: 'claude-opus-5-5',
  effort: 'medium',
  maxOutputTokens: 2500,    // thinking counts inside this, measured at 1,332 on feedback
  maxInputChars: 14000,      // about 4,000 tokens
  keepTailChars: 1000,       // the closing instructions of the prompt
  callsPerAssignment: 2,
  maxFreeRebuilds: 3,
  givebacksPerDay: 1,
  upstreamTimeoutMs: 50000,  // Netlify stops synchronous functions at 60 seconds
});

// Dollars per million tokens. Thinking is billed inside output tokens.
export const PRICES = Object.freeze({
  'claude-opus-5-5': Object.freeze({ input: 4, output: 20 }),
});

// Anthropic bills in dollars. This is the rate from the pricing model, 29 Oct 2026.
export const EUR_PER_USD = 0.8982;

// One billed call, for the cost ledger. It holds numbers only, never learner text.
export function ledgerEntry(reply, kind, incomplete, notAttempt) {
  const u = reply.usage || {};
  const input = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const output = u.output_tokens || 0;
  const price = PRICES[reply.model];
  const rate = price || PRICES[LIMITS.model];
  return {
    calls: 1,
    input,
    output,
    thinking: u.output_tokens_details?.thinking_tokens || 0,
    costEur: Number((((input * rate.input + output * rate.output) / 1e6) * EUR_PER_USD).toFixed(6)),
    incomplete: incomplete ? 1 : 0,
    unpriced: price ? 0 : 1,
    notAttempt: notAttempt ? 1 : 0,
    [`kind_${kind}`]: 1,
  };
}

const asMillis = (v) => {
  if (typeof v === 'number') return v;
  if (v && typeof v.toMillis === 'function') return v.toMillis();
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};

// A missing or unreadable field always lands on the lowest plan.
export function resolvePlan(entitlement, now) {
  const e = entitlement || {};
  if (e.tier === 'probe') return 'probe';
  const active = asMillis(e.validUntil) > now;
  if (e.product === 'b2b') return active ? 'b2b' : 'b2b_ended';
  if (e.product === 'b2c' && e.tier === 'plus' && active) return 'plus';
  return 'free';
}

const fits = (used, caps, need) => {
  if (used.month + need > caps.month) return 'month';
  if (used.day + need > caps.day) return 'day';
  return null;
};

// The server state decides what a call costs. The browser's key and fresh flag
// can only force a new deduction, never a free call.
//   new       deducts both calls of the assignment, so step 4 always fits
//   rebuild   free inside the open assignment, up to the hidden ceiling
//   feedback  already paid for by the open assignment
//   retry     step 4 again after it finished, on the daily giveback
//   orphan    step 4 with nothing open, costs 1 call
export function decideCall({ used, open, givebacks }, caps, { purpose, key, fresh }) {
  if (caps.month === 0) return { allowed: false, code: 'cap_reached', scope: 'month' };
  const isOpen = open && open.state === 'open';

  if (purpose === 'feedback') {
    if (isOpen) return { allowed: true, kind: 'feedback', charge: 0, open: { ...open, state: 'done' } };
    if (open && open.state === 'done' && givebacks < LIMITS.givebacksPerDay) {
      return { allowed: true, kind: 'retry', charge: 0, open, givebacks: givebacks + 1 };
    }
    const scope = fits(used, caps, 1);
    if (scope) return { allowed: false, code: 'cap_reached', scope };
    return { allowed: true, kind: 'orphan', charge: 1, open: open || { state: 'none' } };
  }

  if (isOpen && key && open.key === key && !fresh) {
    if (open.rebuilds >= LIMITS.maxFreeRebuilds) return { allowed: false, code: 'rebuild_limit' };
    return { allowed: true, kind: 'rebuild', charge: 0, open: { ...open, rebuilds: open.rebuilds + 1 } };
  }
  const scope = fits(used, caps, LIMITS.callsPerAssignment);
  if (scope) return { allowed: false, code: 'cap_reached', scope };
  return { allowed: true, kind: 'new', charge: LIMITS.callsPerAssignment, open: { state: 'open', key: key || '', rebuilds: 0 } };
}

// Reverses a call. outcome 'failed' was not billed, so it always reverses.
// 'incomplete' was billed and anyone can provoke it, so it uses the daily giveback.
// A new assignment that stays charged also stays open, so a rebuild repairs it.
export function undoCall(call, outcome, { used, open, givebacks }) {
  const spend = outcome === 'incomplete';
  if (call.kind === 'retry') return outcome === 'failed' ? { used, open, givebacks: givebacks - 1 } : null;
  if (spend && givebacks >= LIMITS.givebacksPerDay) return null;
  const next = {
    used: { day: Math.max(used.day - call.charge, 0), month: Math.max(used.month - call.charge, 0) },
    open,
    givebacks: givebacks + (spend ? 1 : 0),
  };
  if (call.kind === 'new') next.open = { state: 'none' };
  if (call.kind === 'rebuild') next.open = { ...open, rebuilds: Math.max(open.rebuilds - 1, 0) };
  if (call.kind === 'feedback') next.open = { ...open, state: 'open' };
  return next;
}

export function assignmentsLeft(used, caps) {
  const left = (cap, u) => Math.max(Math.floor((cap - u) / LIMITS.callsPerAssignment), 0);
  const month = left(caps.month, used.month);
  return { day: Math.min(left(caps.day, used.day), month), month };
}

export function periodKeys(now) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { day: `${p.year}${p.month}${p.day}`, month: `${p.year}${p.month}` };
}

export function refreshDate(monthKey) {
  const y = Number(monthKey.slice(0, 4));
  const m = Number(monthKey.slice(4));
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

// The tail holds the closing instructions, so learner text is cut from the middle.
export function trimUserText(user, systemLength) {
  const budget = LIMITS.maxInputChars - systemLength;
  if (user.length <= budget) return user;
  const marker = '\n[Text shortened]\n';
  return user.slice(0, budget - LIMITS.keepTailChars - marker.length) + marker + user.slice(-LIMITS.keepTailChars);
}

// Step 2 must be usable JSON, or the learner has received nothing.
export function readAssignment(text) {
  try {
    const b = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (b.off_task === true && typeof b.message === 'string' && b.message.trim()) return { offTask: b.message.trim() };
    const ok = ['learn', 'do', 'reflect'].every((k) => typeof b[k] === 'string' && b[k].trim())
      && Array.isArray(b.good) && b.good.length > 0;
    return { ok };
  } catch (e) {
    return { ok: false };
  }
}
