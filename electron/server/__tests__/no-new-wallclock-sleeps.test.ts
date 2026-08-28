/**
 * Guard against a defect class returning: a fixed-millisecond sleep in a test
 * file, followed by an assertion whose truth depends on that sleep having
 * been long enough.
 *
 * Such a test asserts that this machine will schedule it promptly, not that
 * the product is correct. It passes on an idle laptop and fails under
 * concurrent suites, and each false failure costs a fresh diagnosis. On
 * 2026-08-28 four separate instances cost four separate investigations; the
 * worst overshoot measured was 65x (a 40ms sleep taking 2,656ms).
 *
 * WHAT TO DO INSTEAD, in order of preference:
 *   1. Make the test control time rather than observe it. If the module under
 *      test reads the clock through an injectable seam, move the clock. See
 *      `_advanceGenStudioCatalogClockForTests` in
 *      `frontend/composables/useGenStudioCatalogCache.ts`. This removes the
 *      flake permanently AND makes two-sided windows exact.
 *   2. Poll for the condition with `waitFor` / `waitForValue` from
 *      `./_timing.js`, whose budget is scheduled time rather than wall time.
 *   3. Only where neither is possible, widen the constant and say why.
 *
 * HOW THIS GUARD WORKS — it is a ratchet, not a clean bill of health.
 * The baseline below records how many matches each file had when the guard
 * was introduced. The count may go DOWN freely. It may not go UP, and a file
 * not in the baseline may not have any. So the class cannot silently grow,
 * and every surviving instance stays listed and countable.
 *
 * To regenerate after legitimately removing instances:
 *   UPDATE_TIMING_BASELINE=1 npm run test:backend -- --only no-new-wallclock
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..', '..')
const BASELINE_FILE = path.join(HERE, '_timing-baseline.json')

const SCAN_ROOTS = [
  'electron/server/__tests__',
  'frontend/__tests__',
  'scripts/release/__tests__',
  'scripts/content-packs/__tests__',
]

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs|cts|mts)$/

/**
 * A sleep with a hardcoded duration. `setTimeout(r, pollMs)` and friends are
 * NOT matched — only a numeric literal is, because only a literal encodes an
 * assumption about the scheduler.
 */
const FIXED_SLEEP = [
  /setTimeout\s*\([^,]*,\s*(\d[\d_]*)\s*\)/,
  /\b(?:sleep|delay|pause|settle|sleepPastThreshold)\s*\(\s*(\d[\d_]*)\s*\)/,
]

/** An assertion. Both `node:assert` and expect-style, to be portable. */
const ASSERTION = /\bassert\s*[.(]|\bexpect\s*\(/

/**
 * Sleeps this short are event-loop yields (flush microtasks, let Vue tick),
 * not bets on wall-clock duration. Excluding them keeps the guard pointed at
 * the real class instead of drowning it.
 */
const YIELD_CEILING_MS = 2

/** How far after a sleep an assertion still counts as depending on it. */
const LOOKAHEAD_LINES = 15

interface Finding { file: string; line: number; text: string }

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'fixtures') continue
      walk(full, out)
    } else if (TEST_FILE.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function scanFile(absolute: string): Finding[] {
  // `errors: replace`-equivalent: never let one odd byte silently skip a file
  // and read as "no matches found".
  const source = fs.readFileSync(absolute).toString('utf-8')
  const lines = source.split('\n')
  const relative = path.relative(REPO_ROOT, absolute)
  const findings: Finding[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let ms: number | null = null
    for (const pattern of FIXED_SLEEP) {
      const match = pattern.exec(line)
      if (match) { ms = Number(match[1].replace(/_/g, '')); break }
    }
    if (ms === null || ms <= YIELD_CEILING_MS) continue

    const window = lines.slice(i + 1, i + 1 + LOOKAHEAD_LINES)
    if (!window.some(candidate => ASSERTION.test(candidate))) continue

    findings.push({ file: relative, line: i + 1, text: line.trim() })
  }
  return findings
}

function scanRepo(): Finding[] {
  const findings: Finding[] = []
  for (const root of SCAN_ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      findings.push(...scanFile(file))
    }
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function countByFile(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) counts[finding.file] = (counts[finding.file] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

test('no new fixed-ms sleep is followed by an assertion in a test file', () => {
  const findings = scanRepo()
  const actual = countByFile(findings)

  if (process.env.UPDATE_TIMING_BASELINE === '1') {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(actual, null, 2) + '\n')
    return
  }

  assert.ok(
    fs.existsSync(BASELINE_FILE),
    `Missing ${BASELINE_FILE}. Regenerate with UPDATE_TIMING_BASELINE=1.`,
  )
  const baseline: Record<string, number> = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf-8'))

  // Sanity: the scanner must still be finding things. A refactor that broke
  // the regexes would otherwise read as "the whole class is fixed".
  assert.ok(
    findings.length > 0,
    'The timing scanner found nothing at all, which almost certainly means the '
    + 'scanner is broken rather than that the repo is clean. Check SCAN_ROOTS '
    + 'and FIXED_SLEEP.',
  )

  const regressions: string[] = []
  for (const [file, count] of Object.entries(actual)) {
    const allowed = baseline[file] ?? 0
    if (count <= allowed) continue
    const offending = findings
      .filter(finding => finding.file === file)
      .map(finding => `      ${finding.file}:${finding.line}  ${finding.text}`)
      .join('\n')
    regressions.push(
      `  ${file}: ${count} fixed-ms sleeps before an assertion, baseline allows ${allowed}\n${offending}`,
    )
  }

  assert.equal(
    regressions.length,
    0,
    'New wall-clock timing assertions were added to the test suite.\n\n'
    + regressions.join('\n\n')
    + '\n\n  A fixed sleep before an assertion asserts that this machine will '
    + 'schedule the test promptly, which is false under concurrent suites.\n'
    + '  Prefer: (1) move a fake clock, (2) poll with waitFor() from '
    + '__tests__/_timing.ts, (3) widen the constant and say why.\n'
    + '  See the header of this file for the full rationale.',
  )
})
