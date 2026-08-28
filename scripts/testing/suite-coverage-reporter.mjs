/**
 * Records which test FILES actually finished, so the harness can prove the run
 * covered everything it discovered.
 *
 * WHY THIS EXISTS. The spec reporter names describe blocks, never files. So a
 * file whose process ends early — a stray `process.exit`, an abort, a crash
 * that happens to carry status 0 — simply stops producing output, and nothing
 * downstream notices. Reduced to its smallest form, that is:
 *
 *     describe('delta', () => { test('d1', () => { process.exit(0) }) })
 *
 * Node reports `test:pass` for the FILE, counts none of its tests, and settles
 * `success: true` with `failed: 0`. The run is green and a whole file is gone.
 * That is how three suites disappeared from a passing run this week.
 *
 * Measured behaviour of the file-scoped `test:summary` this reporter records:
 * a file with failing tests emits one (success:false), a file whose only test
 * is skipped emits one, and a file that dies mid-run emits none. A file
 * defining NO tests also emits none — which reads the same to the floor, and
 * should: a test file that verified nothing is a problem either way.
 *
 * The fix is to reconcile against something a truncated file cannot fake.
 * Node emits a file-scoped `test:summary` only when a file runs to completion;
 * the dying file above emits none. So this reporter records one line per file
 * that genuinely finished, and the harness diffs that against the files it
 * discovered. Nothing here is a threshold or an expected total — the floor is
 * the discovery list itself, so adding tests never needs a constant bumped.
 */

/** One JSON line per FILE that reached its own summary. */
export default async function* suiteCoverageReporter(source) {
  for await (const event of source) {
    // The run-wide summary carries no `file` and is not evidence about any
    // single file — only the file-scoped ones count.
    if (event.type !== 'test:summary' || !event.data?.file) continue
    const counts = event.data.counts ?? {}
    yield `${JSON.stringify({
      file: event.data.file,
      success: event.data.success === true,
      tests: counts.tests ?? 0,
      suites: counts.suites ?? 0,
      failed: counts.failed ?? 0,
    })}\n`
  }
}
