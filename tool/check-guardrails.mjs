// node tool/check-guardrails.mjs [--base origin/main]
// Proves that the coach cap and coach guardrails are untouched and still enforced.
// It fails when a protected file changes, disappears, or is no longer run by the deploy and the daily watch.
// A deliberate change needs Robbie's approval, then a new lock: node tool/check-guardrails.mjs --write-lock
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK = 'tool/guardrail-lock.json';
const PROTECTED = [
  'netlify/lib/coach-gate.mjs',
  'netlify/lib/coach-caps.mjs',
  'netlify/lib/coach-prompts.mjs',
  'netlify/lib/coach-content.mjs',
  'netlify/lib/content-window-en.mjs',
  'netlify/lib/content-window-nl.mjs',
  'netlify/functions/coach.mjs',
  'tool/check-coach-cap.mjs',
  'tool/probe-coach-cap.mjs',
  '.github/workflows/coach-cap.yml',
];
// Line endings are normalised, so an upload through the GitHub website does not trip the lock.
const hash = (p) => createHash('sha256').update(readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')).digest('hex');
const args = process.argv.slice(2);

if (args.includes('--write-lock')) {
  const lock = Object.fromEntries(PROTECTED.map((p) => [p, hash(p)]));
  writeFileSync(join(ROOT, LOCK), JSON.stringify(lock, null, 2) + '\n');
  console.log(`Wrote ${LOCK}. Commit it only with Robbie's approval.`);
  process.exit(0);
}

const problems = [];
const lock = existsSync(join(ROOT, LOCK)) ? JSON.parse(readFileSync(join(ROOT, LOCK), 'utf8')) : null;
if (!lock) problems.push(`${LOCK} is missing`);

for (const p of PROTECTED) {
  if (!existsSync(join(ROOT, p))) { problems.push(`${p} is deleted`); continue; }
  if (lock && !lock[p]) problems.push(`${p} has no entry in the lock`);
  else if (lock && lock[p] !== hash(p)) problems.push(`${p} changed`);
}
if (lock) for (const p of Object.keys(lock)) if (!PROTECTED.includes(p)) problems.push(`${p} was dropped from the protected list`);

const toml = existsSync(join(ROOT, 'netlify.toml')) ? readFileSync(join(ROOT, 'netlify.toml'), 'utf8') : '';
const command = (/^\s*command\s*=\s*"([^"]*)"/m.exec(toml) || [])[1] || '';
if (!command.includes('node tool/check-coach-cap.mjs')) problems.push('netlify.toml no longer runs the coach cap check on deploy');
if (!command.includes('node tool/check-guardrails.mjs')) problems.push('netlify.toml no longer runs this guardrail check on deploy');

const wf = existsSync(join(ROOT, '.github/workflows/coach-cap.yml')) ? readFileSync(join(ROOT, '.github/workflows/coach-cap.yml'), 'utf8') : '';
if (!wf.includes('node tool/check-coach-cap.mjs')) problems.push('the GitHub watch no longer runs the coach cap check');
if (!wf.includes('node tool/probe-coach-cap.mjs')) problems.push('the GitHub watch no longer runs the daily live probe');

// The coach cap check itself proves that only the gate reaches Anthropic.

// Optional: list protected files that differ from a base branch, for the pre-push report.
const bi = args.indexOf('--base');
if (bi >= 0) {
  const base = args[bi + 1] || 'origin/main';
  let changed;
  try {
    changed = execFileSync('git', ['-C', ROOT, 'diff', '--name-only', base, '--', ...PROTECTED, LOCK, 'netlify.toml', 'tool/check-guardrails.mjs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch {
    // A typing error in the branch name is not a guardrail problem. Say so, and check nothing.
    console.error(`Branch name not found: ${base}. Nothing was compared or checked. Try: --base origin/main`);
    process.exit(2);
  }
  console.log(changed.length ? `Guarded files changed against ${base}:\n  ${changed.join('\n  ')}` : `No guarded file changed against ${base}.`);
}

if (problems.length) {
  console.error('GUARDRAIL CHECK FAILED. Deploy blocked.');
  for (const p of problems) console.error(`  ${p}`);
  console.error('A deliberate change needs Robbie\'s approval and a new lock.');
  process.exit(1);
}
console.log(`Guardrail check passed: ${PROTECTED.length} protected files unchanged, deploy and daily watch still run the checks.`);
