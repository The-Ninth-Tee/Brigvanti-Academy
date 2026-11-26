// Company totals and averages for the dashboard and the Article 4 report.
// Rules (B2B privacy rules, 5 Nov 2026; DPIA B2B section 6.3):
//   the company level and area averages need at least 10 learners with a level (D11, 16 Nov 2026),
//   a department figure needs at least 10 people with a seat in that department and 5 with a level,
//   every other figure needs at least 5 people behind it,
//   counts of 1 to 4 are never shown,
//   levels leave as a whole named level, never as a precise average,
//   and a hidden group may never be worked out from the figures that are shown.
// D4 (24 Nov 2026): active means a scan answer, a level-up answer or a handed-in assignment in the period.
// D8 (24 Nov 2026): a seat with outOfAverages set, after an objection to support, counts only as a seat.
// Nothing per person leaves this file.

export const MIN_DEPARTMENT = 10;
export const MIN_GROUP = 5;
export const MIN_LEVELS = 10;
export const INACTIVE_DAYS = 30;
export const HIDDEN = Object.freeze({ hidden: true });

const DAY = 86400000;
const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';
const monthKey = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const lowerMedian = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
// A level index: 0 No level yet, 1 Aware, 2 Explorer, 3 Integrator, 4 Creator. The page shows the name.
const named = (v) => Math.min(4, Math.max(0, Math.round(mean(v))));

// One learner's own state, reduced to what the totals need. Same area rule as domLevel() in index.html:
// the lower median of the confirmed levels of the scanned skills in that area.
export function learnerSummary(state) {
  const byArea = {}, active = {};
  let lastActive = null;
  const seen = (t) => {
    if (!Number.isFinite(t)) return;
    active[monthKey(t)] = true;
    if (lastActive == null || t > lastActive) lastActive = t;
  };
  for (const [id, r] of Object.entries((state && state.scan) || {})) {
    if (!r) continue;
    for (const a of Array.isArray(r.log) ? r.log : []) if (a) seen(a.t);
    if (!r.done || r.skipped) continue;
    const area = id.split('.')[0];
    (byArea[area] = byArea[area] || []).push(r.confirmed || 0);
  }
  const areas = Object.fromEntries(Object.entries(byArea).map(([a, v]) => [a, lowerMedian(v)]));
  const levels = Object.values(areas);
  const handedIn = {};
  for (const r of (state && state.reps) || []) {
    if (!r || !Number.isFinite(r.t)) continue;
    handedIn[monthKey(r.t)] = (handedIn[monthKey(r.t)] || 0) + 1;
    seen(r.t);
  }
  return { areas, overall: levels.length ? lowerMedian(levels) : null, handedIn, active, lastActive };
}

// A count is shown only when the group behind it has 5 people and the count is not 1 to 4.
const small = (n) => n > 0 && n < MIN_GROUP;
const count = (n, population) => (population < MIN_GROUP || small(n) ? HIDDEN : n);
// A count whose complement can be worked out from a shown total: the rest must not be 1 to 4 either.
const split = (n, population) => (population < MIN_GROUP || small(n) || small(population - n) ? HIDDEN : n);

export function companyStats({ org, members, summaries, now, months = 6, selfReported = true, since = null }) {
  const seats = members.filter(holdsSeat);
  const inUse = seats.filter((m) => m.firstSignInAt);
  // Objectors (D8) keep their seat, but nothing they did or know reaches a figure.
  const counted = inUse.filter((m) => !m.outOfAverages);
  const learners = counted.filter((m) => m.status === 'active' && m.uid && summaries[m.uid])
    .map((m) => ({ department: String(m.department || '').trim(), ...summaries[m.uid] }));
  const thisMonth = monthKey(now);

  const perMonth = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    const k = monthKey(d.getTime());
    const who = learners.filter((l) => l.handedIn[k] > 0);
    perMonth.push({
      month: k,
      active: count(learners.filter((l) => l.active[k]).length, learners.length),
      assignments: who.length < MIN_GROUP ? HIDDEN : who.reduce((a, l) => a + l.handedIn[k], 0),
    });
  }

  // D4: active this month, and inactive for 30 days. Both sit next to "seats in use", so each must
  // also leave a rest of 0 or at least 5. A pair is shown or hidden together.
  const activeNow = learners.filter((l) => l.active[thisMonth]).length;
  const recent = learners.filter((l) => l.lastActive != null && now - l.lastActive < INACTIVE_DAYS * DAY).length;
  const inactive = counted.length - recent;
  const pair = split(recent, counted.length).hidden || split(inactive, counted.length).hidden;
  const activeShown = split(activeNow, counted.length);

  const placed = learners.filter((l) => l.overall != null);
  const companyLevel = placed.length < MIN_LEVELS ? HIDDEN : { level: named(placed.map((l) => l.overall)) };

  const areaIds = [...new Set(learners.flatMap((l) => Object.keys(l.areas)))].sort();
  const areas = Object.fromEntries(areaIds.map((a) => {
    const v = learners.filter((l) => l.areas[a] != null).map((l) => l.areas[a]);
    return [a, v.length < MIN_LEVELS ? HIDDEN : { level: named(v) }];
  }));

  // Departments: shown only from 10 people with a seat, and 5 placed learners.
  const names = [...new Set(seats.map((m) => String(m.department || '').trim()).filter(Boolean))].sort();
  const dept = names.map((name) => {
    const people = seats.filter((m) => String(m.department || '').trim() === name).length;
    const v = placed.filter((l) => l.department === name).map((l) => l.overall);
    return { name, people, contributors: v.length, show: people >= MIN_DEPARTMENT && v.length >= MIN_GROUP, level: v.length ? named(v) : null };
  });
  // Complementary suppression: the company level minus the shown departments must not reveal a
  // group under 10. Hide the smallest shown department until the remainder is empty or large enough.
  if (!companyLevel.hidden) {
    for (;;) {
      const shown = dept.filter((d) => d.show);
      const rest = placed.length - shown.reduce((a, d) => a + d.contributors, 0);
      if (!shown.length || rest === 0 || rest >= MIN_DEPARTMENT) break;
      shown.sort((a, b) => a.contributors - b.contributors)[0].show = false;
    }
  }
  if (companyLevel.hidden) for (const d of dept) d.show = false;
  const departments = dept.map((d) => (d.show ? { name: d.name, people: d.people, level: d.level } : { name: d.name, ...HIDDEN }));

  // Totals since the contract start, for the Article 4 report. Assignments count whole months.
  let period = null;
  if (Number.isFinite(since)) {
    const from = monthKey(since);
    const per = learners.map((l) => Object.entries(l.handedIn).filter(([k]) => k >= from).reduce((a, [, n]) => a + n, 0));
    const who = per.filter((n) => n > 0);
    const areasCovered = areaIds.filter((a) => learners.filter((l) => l.areas[a] != null).length >= MIN_GROUP).length;
    period = { from: since, to: now, assignments: who.length < MIN_GROUP ? HIDDEN : who.reduce((a, b) => a + b, 0), areasCovered };
  }

  return {
    orgId: org.orgId,
    asOf: now,
    selfReported,
    seats: { bought: org.seats, assigned: seats.length, inUse: count(inUse.length, seats.length) },
    activeThisMonth: activeShown,
    inactive30: pair ? HIDDEN : inactive,
    assignmentsThisMonth: perMonth[perMonth.length - 1].assignments,
    perMonth,
    companyLevel,
    areas,
    departments,
    period,
  };
}
