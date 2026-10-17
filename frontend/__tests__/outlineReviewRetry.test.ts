import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { reactive } from 'vue'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction'

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

function productionExpansionRetry(
  sameTarget: boolean,
  calls: { submit: unknown[]; errors: string[] },
): (submission: unknown) => void {
  const match = source.match(/function retryExpansionSubmission\(submission: ExpansionSubmission\): void \{([\s\S]*?)\n\}/)
  assert.ok(match, 'OutlineReviewPanel must expose the production expansion retry guard')
  const executableBody = match[1].replace(/\(submission: ExpansionSubmission\)/g, '(submission)')
  return new Function(
    'expansionSubmissionMatchesCurrentTarget',
    'showError',
    'submitExpansion',
    `return function (submission) {${executableBody}\n}`,
  )(
    () => sameTarget,
    (message: string) => calls.errors.push(message),
    (submission: unknown) => calls.submit.push(submission),
  )
}

function productionBeginExpansion(
  action: ReturnType<typeof useFreshGenerationAction>,
  submit: (submission: any) => Promise<void>,
  errors: string[],
): (draft: any) => Promise<void> {
  const match = source.match(/async function beginExpansionSubmission\(draft: ExpansionSubmissionDraft\): Promise<void> \{([\s\S]*?)\n\}/)
  assert.ok(match, 'OutlineReviewPanel must expose the production expansion preparation boundary')
  const executableBody = match[1].replace(/catch \(e: any\)/g, 'catch (e)')
  return new Function(
    'freshOutlineExpansionAction',
    'submitExpansion',
    'showError',
    `return async function (draft) {${executableBody}\n}`,
  )(
    action,
    submit,
    (message: string) => errors.push(message),
  )
}

async function withBrowserCrypto<T>(value: Crypto, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value })
  try { return await run() }
  finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original)
    else Reflect.deleteProperty(globalThis, 'crypto')
  }
}

function productionExpansionSubmit(action: ReturnType<typeof useFreshGenerationAction>) {
  const match = source.match(/async function submitExpansion\(submission: ExpansionSubmission\): Promise<void> \{([\s\S]*?)\n\}/)
  assert.ok(match, 'OutlineReviewPanel must expose the production captured submission path')
  const executableBody = match[1]
    .replace(/post<\{ job_id: string \}>/g, 'post')
    .replace(/catch \(e: any\)/g, 'catch (e)')
  const posts: Array<{ path: string; body: any }> = []
  const actions: Array<() => void> = []
  const errors: string[] = []
  let submit: (submission: any) => Promise<void>
  submit = new Function(
    'expansionSubmissionMatchesCurrentTarget', 'postingExpand', 'post', 'freshOutlineExpansionAction',
    'success', 'resumeExpandNotice', 'emit', 'selectedNs', 'showError', 'showAction',
    'UNCONFIRMED_SUBMISSION', 'retryExpansionSubmission',
    `return async function (submission) {${executableBody}\n}`,
  )(
    () => true,
    { value: false },
    async (path: string, body: any) => { posts.push({ path, body: JSON.parse(JSON.stringify(body)) }); throw new Error('response lost') },
    action,
    () => assert.fail('unknown response cannot report success'),
    () => '',
    () => assert.fail('unknown response cannot emit success'),
    { value: [] },
    (message: string) => errors.push(message),
    (_message: string, _label: string, callback: () => void) => actions.push(callback),
    'unconfirmed',
    (submission: any) => { void submit(submission) },
  )
  return { submit, posts, actions, errors }
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
  assert.match(source, /if \(!isDirty\.value \|\| !dirtyTarget\) \{\s*dirtyTarget = \{ projectSlug: props\.projectSlug, episodeId: props\.episodeId, title: props\.title, completedAt: completedAt\.value \}/)
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

test('a failed submit says plainly that Retry is safe, and offers a Retry button', () => {
  const shared = readFileSync(fileURLToPath(new URL('../composables/useChapterRegenerate.ts', import.meta.url)), 'utf8')
  for (const file of [source, chapterList]) assert.doesNotMatch(file, /submission was not confirmed/)
  assert.match(shared, /showAction\(UNCONFIRMED_SUBMISSION, 'Retry', \(\) => regenerate\(input, true\), 'error'\)/)
  // ...which is true because the same click reuses its operation id.
  assert.match(shared, /useFreshGenerationAction\(\)/)
})

test('outline expansion shows structured response detail before generic recovery', () => {
  assert.match(source, /const detail = e\?\.data\?\.detail \|\| e\?\.response\?\._data\?\.detail/)
  assert.match(source, /if \(detail\) showError\(detail\)/)
})

test('manual chapter redo is preference-gated, one-shot, and carries only its source intent', () => {
  assert.match(source, /get<ManualRedoSetting>\('\/app-settings\/manual-generation-redo'/)
  assert.match(source, /v-if="manualRedoEligible"/)
  assert.match(source, /v-model="manualRedoChecked"/)
  assert.match(source, /body\.manual_redo\s*=\s*\{\s*intent:\s*'replace_unresolved',\s*source_job_id:/)
  assert.match(source, /if \(manualRedoChecked\.value && terminalRetry\)/)
  assert.match(source, /else if \(terminalRetry\) body\.terminal_retry_job_id/)
  assert.match(source, /manualRedoChecked\.value = false/g)
  assert.match(source, /describeChatRate\(findChatModel\(currentModel\.value\)\)\.text/)
  assert.match(source, /Price not published/)
  assert.match(source, /earlier Gateway request may still finish/i)
})

test('unconfirmed outline expansion retries the captured request only while its episode is current', () => {
  assert.match(source, /else showAction\(UNCONFIRMED_SUBMISSION, 'Retry', \(\) => retryExpansionSubmission\(submission\), 'error'\)/)
  const submit = source.slice(source.indexOf('async function submitExpansion'), source.indexOf('async function postExpand'))
  assert.match(submit, /freshOutlineExpansionAction\.complete\(submission\.operationId\)[\s\S]*?\} catch/, 'the pending action clears only after a confirmed response')
  assert.doesNotMatch(submit.match(/\} catch \(e: any\) \{([\s\S]*?)\n  \} finally/)?.[1] || '', /freshOutlineExpansionAction\.complete/)

  const captured = { projectSlug: 'project-a', episodeId: 'EP0001', body: { chapters_to_expand: [10] }, operationId: 'operation-a' }
  const switched = { submit: [] as unknown[], errors: [] as string[] }
  productionExpansionRetry(false, switched)(captured)
  assert.deepEqual(switched.submit, [], 'switching episodes cannot POST or mint a new action identity')
  assert.match(switched.errors[0] || '', /another episode/i)

  const current = { submit: [] as unknown[], errors: [] as string[] }
  productionExpansionRetry(true, current)(captured)
  assert.deepEqual(current.submit, [captured], 'the same immutable request and operation id are replayed')
})

test('expansion preparation detaches real reactive cast arrays and keeps the captured request stable', async () => {
  for (const ids of [[], ['character-a', 'character-b']]) {
    const form = reactive({ character_ids: [...ids] })
    const action = useFreshGenerationAction()
    const runtime = productionExpansionSubmit(action)
    const begin = productionBeginExpansion(action, runtime.submit, runtime.errors)
    await begin({
      projectSlug: 'project-a', episodeId: 'EP0001', chapters: [10],
      body: { episode_id: 'EP0001', character_ids: form.character_ids },
      resumingForRows: false, terminalRetryChapters: undefined, pendingCount: 6,
    })

    assert.equal(runtime.errors.length, 0)
    assert.equal(runtime.posts.length, 1, 'the detached request reaches the mocked POST')
    assert.equal(runtime.posts[0].path, '/projects/project-a/generate/expand-chapters')
    assert.deepEqual(runtime.posts[0].body.character_ids, ids)
    const firstOperationId = runtime.posts[0].body.operation_id
    form.character_ids.push('later-edit')
    runtime.actions[0]()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(runtime.posts.length, 2)
    assert.deepEqual(runtime.posts[1].body.character_ids, ids, 'later reactive form edits cannot change Retry')
    assert.equal(runtime.posts[1].body.operation_id, firstOperationId, 'Retry retains the captured operation identity')
    assert.equal(action.hasPending.value, true)
  }
})

test('missing secure entropy is shown as a preparation error without POST or pending identity', async () => {
  await withBrowserCrypto({} as Crypto, async () => {
    const action = useFreshGenerationAction()
    const submissions: any[] = []
    const errors: string[] = []
    const begin = productionBeginExpansion(action, async submission => { submissions.push(submission) }, errors)

    await begin({
      projectSlug: 'project-a', episodeId: 'EP0001', chapters: null,
      body: { episode_id: 'EP0001', character_ids: reactive([]) },
      resumingForRows: false, terminalRetryChapters: undefined, pendingCount: 6,
    })

    assert.deepEqual(submissions, [], 'preparation failure cannot reach POST')
    assert.equal(action.hasPending.value, false)
    assert.equal(errors[0], 'This browser cannot create a secure request identity, so nothing was sent.')
  })
})

test('Outline and Script tabs share one Regenerate: same action, confirm, wording', () => {
  for (const file of [source, chapterList]) {
    assert.match(file, /useChapterRegenerate\(\)/)
    assert.match(file, /REGENERATING_LABEL : REGENERATE_LABEL/)
    assert.match(file, /:title="[^"]*REGENERATE_HINT"/)
    assert.doesNotMatch(file, /post\(`[^`]*generate\/chapter-only/, 'only the shared action posts the request')
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

test('every outline save names the build it was made on, and a 409 drops the stale edits', () => {
  // Without this, unsaved edits flushed after "Create outline" + Force would
  // overwrite (and with approved:true, approve) the freshly rebuilt outline.
  assert.match(source, /completedAt\.value = data\.outline_completed_at \|\| ''/)
  assert.match(source, /completedAt: completedAt\.value \}/, 'captured with the edit target')
  assert.equal(source.match(/outline_completed_at: (target\.completedAt|completedAt\.value) \|\| undefined/g)?.length, 3,
    'flush, save and approve all send it')
  assert.match(source, /if \(e\?\.status === 409\) discardAndShowCurrentOutline\(\)/)
})

test('row Expand while a run is stopped part-way resumes that run instead of dead-ending on a 409', async () => {
  assert.match(source, /const resumingForRows = chapters !== null && resumableRun\.value/)
  assert.match(source, /chapters === null \|\| resumingForRows \? terminalExpansionRetryJob\(\) : undefined/)
  assert.doesNotMatch(source, /before other chapters can be expanded/)
  const { resumeExpandNotice } = await import('../utils/outline-expand-resume.js')
  assert.match(resumeExpandNotice([4], undefined), /only the chapters still missing, including 4/)
  assert.match(resumeExpandNotice([4], [1, 2, 4]), /including 4/)
  assert.match(resumeExpandNotice([7], [1, 2]), /Then press Expand on 7 again/)
})

test('Script Resume reads a streamed job: unsettled entries plus the operations its full evidence covers', () => {
  const settledOnly = { ...expansionJob({ id: 'settled', finishedAt: '2026-10-06T00:00:02.000Z', evidence: [] }),
    genstudio_jobs: undefined, genstudio_jobs_count: 3, genstudio_jobs_operations: ['chat.response'], genstudio_jobs_active: [] }
  const unresolved = { ...expansionJob({ id: 'unresolved', finishedAt: '2026-10-06T00:00:01.000Z', evidence: [] }),
    genstudio_jobs: undefined, genstudio_jobs_count: 3, genstudio_jobs_operations: ['chat.response'],
    genstudio_jobs_active: [{ id: 'pending:key', operation: 'chat.response', state: 'submitting' }] }
  const noChat = { ...expansionJob({ id: 'no-chat', finishedAt: '2026-10-06T00:00:03.000Z', evidence: [] }),
    genstudio_jobs: undefined, genstudio_jobs_count: 1, genstudio_jobs_operations: ['voice.tts'], genstudio_jobs_active: [] }
  assert.equal(productionRetrySelector([settledOnly, unresolved, noChat])()?.job_id, 'unresolved')
  assert.equal(productionRetrySelector([settledOnly, noChat])()?.job_id, 'settled', 'settled chat evidence still identifies the run')
})
