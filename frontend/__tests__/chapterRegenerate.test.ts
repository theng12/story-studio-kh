import assert from 'node:assert/strict'
import test from 'node:test'
import { useChapterRegenerate } from '../composables/useChapterRegenerate.js'
import { useConfirm } from '../composables/useConfirm.js'
import { useJobs } from '../composables/useJobs.js'

test('Regenerate asks first, sends one chapter-only request, and stays busy while its job runs', async () => {
  const sent: Array<{ url: string; body: any }> = []
  ;(globalThis as any).$fetch = async (url: string, opts: any) => { sent.push({ url, body: opts?.body }); return { job_id: 'j1' } }
  const confirm = useConfirm()
  const regen = useChapterRegenerate()
  const input = { projectSlug: 'p', episodeId: 'EP0001', title: 'T', form: { model: 'm', words_per_chapter: 900 }, chapter: 3, words: 1200 }

  // Cancel → nothing is sent.
  let pending = regen.regenerate(input)
  assert.equal(confirm.state.visible, true)
  assert.match(confirm.state.options.title, /Regenerate chapter 3\?/)
  confirm.cancel()
  await pending
  assert.equal(sent.length, 0)

  // Confirm → one request with the row's word target.
  pending = regen.regenerate(input)
  confirm.confirm()
  await pending
  assert.equal(sent.length, 1)
  assert.match(sent[0]!.url, /\/projects\/p\/generate\/chapter-only$/)
  assert.equal(sent[0]!.body.chapter_number, 3)
  assert.equal(sent[0]!.body.words_per_chapter, 1200)

  // Busy for as long as the chapter's job is queued/running; a second click then does nothing.
  ;(globalThis as any).EventSource = class { addEventListener() {} close() {} }
  const queue = useJobs()
  queue.startPolling('p')
  try {
    const job = { job_id: 'j1', project_slug: 'p', type: 'chapter-only', episode_id: 'EP0001', status: 'running', params: { chapter_number: 3 } } as any
    queue.applyUpdate(job, 'p')
    assert.equal(regen.isRegenerating('EP0001', 3), true)
    assert.equal(regen.isRegenerating('EP0001', 4), false)
    await regen.regenerate(input)
    assert.equal(confirm.state.visible, false, 'no second confirm while it runs')
    assert.equal(sent.length, 1)
    queue.applyUpdate({ ...job, status: 'done' }, 'p')
    assert.equal(regen.isRegenerating('EP0001', 3), false)
  } finally { queue.stopPolling() }
})
