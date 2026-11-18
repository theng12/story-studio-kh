/**
 * Clear vs everything else (owner, 2026-11-18): Hide and Discard are gone.
 * Clear is the one way a finished row leaves the list. It is recoverable —
 * the record is kept in Recently cleared — its files stay on disk, and a
 * failure is logged and shown, never swallowed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const jobs = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url)),
  'utf8',
)
const hints = readFileSync(
  fileURLToPath(new URL('../utils/job-actions-bar.ts', import.meta.url)),
  'utf8',
)

/** Body of `async function <name>` up to the next top-level function. */
const body = (name: string) => {
  const start = jobs.indexOf(`async function ${name}(`)
  assert.ok(start >= 0, `${name} exists`)
  const next = jobs.indexOf('\nasync function', start + 10)
  const fallback = jobs.indexOf('\nfunction ', start + 10)
  const end = [next, fallback].filter(i => i > -1).sort((a, b) => a - b)[0] ?? jobs.length
  return jobs.slice(start, end)
}

test('a row Clear asks, posts /clear and reloads the list', () => {
  const clear = body('clearJob')
  assert.match(clear, /useConfirm\(\)\.ask\(\{/)
  assert.match(clear, /title: 'Clear this job\?'/)
  assert.match(clear, /kept in Recently cleared, restorable/)
  assert.match(clear, /confirmLabel: 'Clear'/)
  assert.match(clear, /danger: true/)
  assert.match(clear, /await post\(`\/jobs\/all\/\$\{job\.job_id\}\/clear`, \{\}\)/)
  assert.match(clear, /await loadJobHistory\(\)/)
  assert.match(clear, /await refreshVisibleJobs\(\)/)
  assert.match(clear, /logClearFailure\(`POST \/jobs\/all\/\$\{job\.job_id\}\/clear`/)
  // A 404 is the goal already holding, not a refusal.
  assert.match(clear, /if \(isMissingJobError\(e\)\)/)
  // The row button is Clear only, beside where Hide used to be.
  assert.match(jobs, /v-if="canClearJob\(job\)"[\s\S]{0,320}?@click="clearJob\(job\)"/)
})

test('bulk Clear previews measured counts, is scoped, and posts expected_count/expected_bytes', () => {
  const clear = body('clearBucket')
  assert.match(clear, /status: 'finished' \| 'failed' \| 'all'/)
  assert.match(clear, /`\/jobs\/clear-preview\?status=\$\{status\}\$\{bulkClearScope\(\)\}`/)
  assert.match(clear, /const project = clearProject\.value/)
  assert.match(clear, /get<\{ count: number; ids: string\[\]; bytes: number; media_bytes: number \}>\(/)
  assert.match(clear, /\{ cache: 'no-store' \}/)
  assert.match(clear, /Clear \$\{preview\.count\} \$\{what\} job\$\{preview\.count === 1 \? '' : 's'\}\?/)
  assert.match(clear, /\(\$\{formatBytes\(preview\.bytes\)\}\)/)
  assert.match(clear, /\(\$\{formatBytes\(preview\.media_bytes\)\}\) stays on disk/)
  assert.match(clear, /Cleared jobs are kept in Recently cleared, and Restore puts them back\./)
  assert.match(clear, /await post<\{ ok: boolean; cleared: number; bytes: number \}>\('\/jobs\/all\/clear', \{/)
  assert.match(clear, /expected_count: preview\.count/)
  assert.match(clear, /expected_bytes: preview\.bytes/)
  assert.match(clear, /project \? \{ project \} : \{\}/)
  // Cancel does nothing: the refusal guard runs before any POST.
  const askAt = clear.indexOf('if (!await useConfirm().ask({')
  const postAt = clear.indexOf("await post<{ ok: boolean; cleared: number; bytes: number }>('/jobs/all/clear'")
  assert.ok(askAt > -1 && postAt > askAt, 'the POST only runs after the owner confirms')
  assert.match(clear, /logClearFailure\(attempt, e\)/)
  assert.match(clear, /showError\(e\?\.data\?\.detail \|\| `Failed to clear \$\{status\} jobs`\)/)

  assert.match(jobs, /@click="clearBucket\('finished'\)"/)
  assert.match(jobs, /@click="clearBucket\('failed'\)"/)
  assert.match(jobs, /@click="clearBucket\('all'\)"/)
  assert.match(jobs, /Clear Finished…/)
  assert.match(jobs, /Clear Failed…/)
  assert.match(jobs, /Clear All…/)
  assert.match(hints, /clearJobsFinished: 'Removes finished job records/)
  assert.match(hints, /clearJobsFailed: 'Removes settled failed job records/)
  assert.match(hints, /clearAll: 'Removes finished and settled failed job records/)
})

test('no native dialog appears anywhere in the clear path, and every failure logs one line', () => {
  const stripped = jobs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(stripped, /(^|[^.\w$])(confirm|alert|prompt)\(/m)
  for (const name of ['clearJob', 'clearBucket', 'restoreClearedJob']) {
    assert.match(body(name), /useConfirm\(\)\.ask\(\{|logClearFailure\(/, `${name} is in-app and logs failures`)
  }
  const log = jobs.slice(jobs.indexOf('function logClearFailure('), jobs.indexOf('async function loadCleared('))
  assert.match(log, /console\.error\('\[jobs\] clear failed', action,/)
  assert.match(log, /error\?\.status \?\? error\?\.statusCode \?\? error\?\.response\?\.status/)
  assert.match(log, /error\?\.data\?\.detail \?\? error\?\.message/)
})

test('Recently cleared lists the bucket and Restore posts to its own endpoint', () => {
  assert.match(jobs, /\{ key: 'cleared', label: 'Recently cleared' \}/)
  assert.match(jobs, /clearedRows\.value\.length/)
  assert.match(jobs, /get<\{ items\?: ClearedJobRow\[\]; bytes\?: number \}>\(`\/jobs\/cleared\$\{scope\}`, \{ cache: 'no-store' \}\)/)

  const restore = body('restoreClearedJob')
  assert.match(restore, /await post<\{ ok: boolean; already_present\?: boolean \}>\(`\/jobs\/cleared\/\$\{row\.id\}\/restore`, \{\}\)/)
  assert.match(restore, /await loadCleared\(\)/)
  assert.match(restore, /await loadJobHistory\(\)/)
  assert.match(restore, /logClearFailure\(/)
  assert.match(restore, /showError\(e\?\.data\?\.detail \|\| 'Failed to restore this job\.'\)/)

  // The panel reuses the History table markup, with the measured record size.
  assert.match(jobs, /<h2>Recently cleared<\/h2>/)
  assert.match(jobs, /\{\{ formatBytes\(row\.record_bytes\) \}\}/)
  assert.match(jobs, /@click="restoreClearedJob\(row\)"/)
})

test('Hide and Discard are absent, so a later change cannot bring them back', () => {
  assert.doesNotMatch(jobs, /Hide From Jobs|Hide Finished From List|Hide Failed From List/)
  assert.doesNotMatch(jobs, /statusFilter === 'hidden'|key: 'hidden'|hiddenHistory|hiddenScopedJobs/)
  assert.doesNotMatch(jobs, /\/hide|\/unhide/)
  assert.doesNotMatch(jobs, /Discard/)
  assert.doesNotMatch(jobs, /cannot be undone|for good|permanently/i)
  // The server's own clear-history control is filtered out of the cards.
  assert.match(jobs, /control\.action !== 'none' && control\.action !== 'clear-history'/)
})
