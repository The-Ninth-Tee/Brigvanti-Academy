// Company totals and averages for the dashboard and the Article 4 report.
// Rules (B2B privacy rules, 5 Nov 2026; DPIA B2B section 6.3):
//   the company level and area averages need at least 10 learners with a level (D11, 16 Nov 2026),
//   a department figure needs at least 10 people with a seat in that department and 5 with a level,
//   every other figure needs at least 5 people behind it,
//   counts of 1 to 4 are never shown,
//   levels leave as a whole named level, never as a precise average,
//   and a hidden group may never be worked out from the figures that are shown.
// Nothing per person leaves this file.

export const MIN_DEPARTMENT = 10;
export const MIN_GROUP = 5;
export const MIN_LEVELS = 10;
export const HIDDEN = Object.freeze({ hidden: true });

const holdsSeat = (m) => m.status === 'invited' || m.status === 'active';
const monthKey = (t) => { const d = new Date(t); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };
const lowerMedian = (v) => { const s = [...v].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
// A level index: 0 No level yet, 1 Aware, 2 Explorer, 3 Integrator, 4 Creator. The page shows the name.
const named = (v) => Math.min(4, Math.max(0, Math.round(mean(v))));

// One learner's own state, reduced to what the totals need. Same area rule as domLevel() in index.html:
// the lower median of the confirmed levels of the scanned skills in that area.
export function learnerSummary(state) {
  const byArea = {};
  for (const [id, r] of Object.entries((state && state.scan) || {})) {
    if (!r || !r.done || r.skipped) continue;
    const area = id.split('.')[0];
    (byArea[area] = byArea[area] || []).push(r.confirmed || 0);
  }
  const areas = Object.fromEntries(Object.entries(byArea).map(([a, v]) => [a, lowerMedian(v)]));
  const levels = Object.values(areas);
  const handedIn = {};
  for (const r of (state && state.reps) || []) if (r && Number.isFinite(r.t)) handedIn[monthKey(r.t)] = (handedIn[monthKey(r.t)] || 0) + 1;
  return { areas, overall: levels.length ? lowerMedian(levels) : null, handedIn };
}

// A count is shown only when the group behind it has 5 people and the count is not 1 to 4.
const count = (n, population) => (population < MIN_GROUP || (n > 0 && n < MIN_GROUP) ? HIDDEN : n);

export function companyStats({ org, members, summaries, now, months = 6, selfReported = true }) {
  const seats = members.filter(holdsSeat);
  const learners = seats.filter((m) => m.status === 'active' && m.uid && summaries[m.uid])
    .map((m) => ({ department: String(m.department || '').trim(), ...summaries[m.uid] }));
  const thisMonth = monthKey(now);

  const perMonth = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - i);
    const k = monthKey(d.getTime());
    const who = learners.filter((l) => l.handedIn[k] > 0);
    perMonth.push({ month: k, assignments: who.length < MIN_GROUP ? HIDDEN : who.reduce((a, l) => a + l.handedIn[k], 0) });
  }
  const activeNow = learners.filter((l) => l.handedIn[thisMonth] > 0).length;

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

  return {
    orgId: org.orgId,
    asOf: now,
    selfReported,
    seats: { bought: org.seats, assigned: seats.length, inUse: count(seats.filter((m) => m.firstSignInAt).length, seats.length) },
    activeThisMonth: count(activeNow, learners.length),
    assignmentsThisMonth: perMonth[perMonth.length - 1].assignments,
    perMonth,
    companyLevel,
    areas,
    departments,
  };
}
