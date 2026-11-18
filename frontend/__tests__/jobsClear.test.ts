/**
 * Clear vs Hide (owner, 2026-11-18): Hide keeps its meaning — the record stays
 * and the Hidden filter restores the row. Clear is a real removal: the job
 * record leaves the list and the record store, its files stay on disk, and
 * Recently cleared can put it back. These checks read the page source, the
 * same way jobsHide.test.ts and jobsControls.test.ts do, so the whole 4,800-line
 * page need not be mounted.
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
  assert.match(clear, /You can put it back from Recently cleared\. Its files stay on disk\./)
  assert.match(clear, /confirmLabel: 'Clear'/)
  assert.match(clear, /danger: true/)
  assert.match(clear, /await post\(`\/jobs\/all\/\$\{job\.job_id\}\/clear`, \{\}\)/)
  assert.match(clear, /await loadJobHistory\(\)/)
  assert.match(clear, /await refreshVisibleJobs\(\)/)
  // A 404 is the goal already holding, not a refusal.
  assert.match(clear, /if \(isMissingJobError\(e\)\)/)
  // The row button sits beside Hide, only where the row can be hidden today.
  const hideButton = jobs.indexOf('@click="hideJob(job)"')
  const clearButton = jobs.indexOf('@click="clearJob(job)"')
  assert.ok(hideButton > -1 && clearButton > hideButton, 'Clear sits beside Hide')
  assert.match(jobs, /v-if="canHideJob\(job\)"[\s\S]{0,400}?@click="clearJob\(job\)"/)
})

test('bulk Clear previews the measured counts, asks, and posts expected_count/expected_bytes', () => {
  const clear = body('clearBucket')
  assert.match(clear, /get<\{ count: number; ids: string\[\]; bytes: number; media_bytes: number \}>\(/)
  assert.match(clear, /`\/jobs\/clear-preview\?status=\$\{status\}`, \{ cache: 'no-store' \}/)
  // Counts and sizes come from the response, never a constant.
  assert.match(clear, /Clear \$\{preview\.count\} \$\{status\} job\$\{preview\.count === 1 \? '' : 's'\}\?/)
  assert.match(clear, /\(\$\{formatBytes\(preview\.bytes\)\}\)/)
  assert.match(clear, /\(\$\{formatBytes\(preview\.media_bytes\)\}\) stays on disk/)
  assert.match(clear, /await post<\{ ok: boolean; cleared: number; bytes: number \}>\('\/jobs\/all\/clear', \{/)
  assert.match(clear, /expected_count: preview\.count/)
  assert.match(clear, /expected_bytes: preview\.bytes/)
  // Cancel does nothing: the refusal guard runs before any POST.
  const askAt = clear.indexOf('if (!await useConfirm().ask({')
  const postAt = clear.indexOf("await post<{ ok: boolean; cleared: number; bytes: number }>('/jobs/all/clear'")
  assert.ok(askAt > -1 && postAt > askAt, 'the POST only runs after the owner confirms')
  assert.match(clear, /showError\(e\?\.data\?\.detail \|\| `Failed to clear \$\{status\} jobs`\)/)

  assert.match(jobs, /@click="clearBucket\('finished'\)"/)
  assert.match(jobs, /@click="clearBucket\('failed'\)"/)
  assert.match(jobs, /Clear Finished…/)
  assert.match(jobs, /Clear Failed…/)
  assert.match(hints, /clearJobsFinished: 'Removes finished job records/)
  assert.match(hints, /clearJobsFailed: 'Removes settled failed job records/)
})

test('no native dialog appears anywhere in the clear path', () => {
  const stripped = jobs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(stripped, /(^|[^.\w$])(confirm|alert|prompt)\(/m)
  for (const name of ['clearJob', 'clearBucket']) {
    assert.match(body(name), /useConfirm\(\)\.ask\(\{/, `${name} uses the in-app dialog`)
  }
})

test('Recently cleared lists the bucket and Restore posts to its own endpoint', () => {
  assert.match(jobs, /\{ key: 'cleared', label: 'Recently cleared' \}/)
  assert.match(jobs, /clearedRows\.value\.length/)
  assert.match(jobs, /get<\{ items\?: ClearedJobRow\[\]; bytes\?: number \}>\('\/jobs\/cleared', \{ cache: 'no-store' \}\)/)

  const restore = body('restoreClearedJob')
  assert.match(restore, /await post<\{ ok: boolean; already_present\?: boolean \}>\(`\/jobs\/cleared\/\$\{row\.id\}\/restore`, \{\}\)/)
  assert.match(restore, /await loadCleared\(\)/)
  assert.match(restore, /await loadJobHistory\(\)/)
  assert.match(restore, /showError\(e\?\.data\?\.detail \|\| 'Failed to restore this job\.'\)/)

  // The panel reuses the History table markup, with the measured record size.
  assert.match(jobs, /<h2>Recently cleared<\/h2>/)
  assert.match(jobs, /\{\{ formatBytes\(row\.record_bytes\) \}\}/)
  assert.match(jobs, /@click="restoreClearedJob\(row\)"/)
  assert.match(jobs, /v-else class="text-muted mt-1">\{\{ clearedLoading \? 'Reading cleared jobs…' : 'Nothing has been cleared\.' \}\}/)
})

test('Hide is unchanged: the row and bulk Hide still post /hide with the same copy', () => {
  const hide = body('hideJob')
  assert.match(hide, /await post\(`\$\{jobQueuePath\(job\)\}\/hide`, \{\}\)/)
  assert.match(hide, /success\('Hidden from the list\. Open Hidden to Restore it\.'\)/)

  const bulkHide = jobs.slice(jobs.indexOf('async function clearHistory('), jobs.indexOf('function clearFinished()'))
  assert.match(bulkHide, /await post<\{ hidden: number \}>\(`\$\{endpoint\}\/hide\?status=\$\{status\}`\)/)
  assert.match(bulkHide, /Hide failed jobs from the list\?/)
  assert.doesNotMatch(bulkHide, /\/jobs\/all\/clear/)

  // Clear and Hide remain two differently worded actions on the page.
  assert.match(jobs, /Hide from list · keeps the record/)
  assert.match(jobs, /Clear · removes the job record, not its files/)
})
