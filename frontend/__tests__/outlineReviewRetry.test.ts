import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const source = readFileSync(
  fileURLToPath(new URL('../components/OutlineReviewPanel.vue', import.meta.url)),
  'utf8',
)

function productionRetrySelector(jobs: any[], episodeId = 'EP001'): () => any | undefined {
  const match = source.match(/function terminalExpansionRetryJob\(\): any \| undefined \{([\s\S]*?)\n\}/)
  assert.ok(match, 'OutlineReviewPanel must expose the terminal retry selector')
  const executableBody = match[1]
    .replace(/\((job|entry|a|b): any\)/g, '($1)')
    .replace(/\((a|b): any, (a|b): any\)/g, '($1, $2)')
  return new Function('jobs', 'props', `return function () {${executableBody}\n}`)(
    { value: jobs },
    { episodeId },
  )
}

function expansionJob(input: {
  id: string
  finishedAt: string
  evidence: Array<{ id: unknown; state: string }>
}) {
  return {
    job_id: input.id,
    project_slug: 'history',
    episode_id: 'EP001',
    type: 'expand_chapters',
    status: 'error',
    created_at: input.finishedAt,
    finished_at: input.finishedAt,
    genstudio_jobs: input.evidence.map(entry => ({
      ...entry,
      operation: 'chat.response',
    })),
  }
}

test('Script Resume prioritizes unresolved terminal evidence before a newer settled failure', () => {
  const olderUnresolved = expansionJob({
    id: 'older-unresolved',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 'pending:story-chat-old', state: 'submitting' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderUnresolved, newerSettled])()?.job_id,
    'older-unresolved',
  )
})

test('Script Resume uses the newest terminal failure after all evidence resolves', () => {
  const olderSettled = expansionJob({
    id: 'older-settled',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 'job-old', state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderSettled, newerSettled])()?.job_id,
    'newer-settled',
  )
})

test('Script Resume treats a terminal chat without a real job id as unresolved', () => {
  const olderMissingId = expansionJob({
    id: 'older-missing-id',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: '', state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderMissingId, newerSettled])()?.job_id,
    'older-missing-id',
  )
})

test('Script Resume treats a malformed non-string job id as unresolved', () => {
  const olderMalformedId = expansionJob({
    id: 'older-malformed-id',
    finishedAt: '2026-08-11T09:00:00.000Z',
    evidence: [{ id: 123, state: 'failed' }],
  })
  const newerSettled = expansionJob({
    id: 'newer-settled',
    finishedAt: '2026-08-11T10:00:00.000Z',
    evidence: [{ id: 'job-new', state: 'failed' }],
  })

  assert.equal(
    productionRetrySelector([olderMalformedId, newerSettled])()?.job_id,
    'older-malformed-id',
  )
})

const chapterList = readFileSync(
  fileURLToPath(new URL('../components/ChapterListPanel.vue', import.meta.url)),
  'utf8',
)

test('Expand all becomes "Resume writing" while a stopped run blocks other expansions', () => {
  assert.match(source, /const resumableRun = computed\(/)
  assert.match(source, /resumableRun \? `▶ Resume writing \(\$\{pendingCount\}\)` : `▶ Expand all \(\$\{pendingCount\}\)`/)
  assert.match(source, /class="op-resume-hint"/, 'a visible one-line hint, not tooltip-only')
})

test('outline edits are saved to the episode they were made on, never dropped or misfiled', () => {
  // Reorder used to mark the outline changed without ever saving it.
  const reorder = source.slice(source.indexOf('function reorder('), source.indexOf('// ── Save / approve'))
  assert.match(reorder, /markDirtyAndAutosave\(\)/)
  // The target episode is captured at the first edit after a clean state.
  assert.match(source, /if \(!isDirty\.value \|\| !dirtyTarget\) \{\s*dirtyTarget = \{ projectSlug: props\.projectSlug, episodeId: props\.episodeId, title: props\.title \}/)
  // A late save never lands on another episode.
  assert.match(source, /if \(target\.episodeId !== props\.episodeId \|\| target\.projectSlug !== props\.projectSlug\) return/)
  // Pending edits are flushed (not cancelled) before any reload / switch and on leaving.
  assert.match(source, /async function reloadOutline\(\): Promise<void> \{\s*await flushPendingEdits\(\)\s*await loadOutline\(\)/)
  assert.match(source, /clearPreviewCache\(\)\s*\/\/[^\n]*\n\s*void reloadOutline\(\)/)
  assert.match(source, /onUnmounted\(\(\) => \{[\s\S]*?void flushPendingEdits\(\)/)
  assert.doesNotMatch(source, /onUnmounted\(\(\) => \{\s*if \(autosaveTimer\) clearTimeout\(autosaveTimer\)\s*\}\)/)
})

test('the outline hands scripts.vue its own episode direction', () => {
  assert.match(source, /episodeId,\s*totalChapters: data\.total_chapters,\s*chaptersDone: chaptersDone\.value\.length,\s*manualGuidance: data\.generation_params\?\.manual_guidance \?\? null,/)
})

test('a failed submit says plainly that clicking again is safe', () => {
  for (const file of [source, chapterList]) {
    assert.doesNotMatch(file, /submission was not confirmed/)
    assert.match(file, /Couldn't confirm the request arrived\. Click the same button again — it won't run twice\./)
    // ...which is true because the same click reuses its operation id.
    assert.match(file, /useFreshGenerationAction\(\)/)
  }
})

test('ChapterListPanel handles each finished job once and refreshes at most once per change', () => {
  assert.match(chapterList, /const handledTerminalJobs = new Set\(jobs\.value\.filter\(j => isTerminal\(j\.status\)\)\.map\(terminalKey\)\)/)
  assert.match(chapterList, /handledTerminalJobs\.has\(terminalKey\(job\)\)\) continue/)
  const watcher = chapterList.slice(chapterList.indexOf('watch(relevantJobsSignal'), chapterList.indexOf('// Declared BEFORE the immediate watcher'))
  assert.equal(watcher.match(/void refresh\(\)/g)?.length, 1)
  // The refresh sits after the loop, not inside it.
  assert.ok(watcher.indexOf('void refresh()') > watcher.lastIndexOf('for (const job of jobs.value)'))
  assert.match(watcher, /if \(landed\) \{/)
})
