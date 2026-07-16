/**
 * Concurrency tests for the shared LLM-text job group (v1.0.335).
 *
 * Verifies the `llmConcurrency` budget is shared across the text generators
 * (outline / expand / metadata / image_prompts / scene_plan) and that non-LLM
 * types stay strictly serial regardless of the LLM budget.
 *
 * Executors block on a release promise so we observe how many run at once
 * deterministically — no timing guesses.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')
let pm: typeof import('../services/project-manager.js')

before(async () => {
  const t = await useTempDataDir()
  cleanup = t.cleanup
  pm = await import('../services/project-manager.js')
  jq = await import('../services/job-queue.js')
})

after(async () => {
  jq.setLlmConcurrency(3)   // restore default so other files aren't affected
  jq.setSubtitleTranscribeConcurrency(1)
  await cleanup()
})

interface Blocker {
  active: number
  peak: number
  done: number
  releases: Array<() => void>
  executor: () => Promise<void>
}
function makeBlocker(): Blocker {
  const b: Blocker = { active: 0, peak: 0, done: 0, releases: [], executor: null as any }
  b.executor = async () => {
    b.active++
    b.peak = Math.max(b.peak, b.active)
    await new Promise<void>(res => b.releases.push(res))
    b.active--
    b.done++
  }
  return b
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}
// Let the finally{releaseSlot} of finished jobs settle (groupActive--).
const settle = () => new Promise(r => setTimeout(r, 40))

describe('LLM-group concurrency', () => {
  test('accepts a text concurrency ceiling of 50', () => {
    jq.setLlmConcurrency(50)
    assert.equal(jq.getLlmConcurrency(), 50)
  })

  test('limit=2 runs two different-episode text jobs at once; 3rd waits', async () => {
    const proj = await pm.createProject({ name: 'JQCC1' })
    const b = makeBlocker()
    jq.registerExecutor('outline_only', b.executor)
    jq.setLlmConcurrency(2)
    for (const ep of ['EP001', 'EP002', 'EP003']) {
      jq.enqueue({ project_slug: proj.slug, type: 'outline_only', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 2)
    await settle()
    assert.equal(b.active, 2, 'budget caps concurrent text jobs at 2 (3rd held)')
    b.releases.shift()!()
    b.releases.shift()!()
    await waitFor(() => b.done === 2 && b.active === 1)   // freed slot pulls the 3rd
    b.releases.shift()!()
    await waitFor(() => b.done === 3)
    await settle()
    assert.equal(b.peak, 2, 'never exceeded the budget')
  })

  test('limit=1 serializes text jobs', async () => {
    const proj = await pm.createProject({ name: 'JQCC2' })
    const b = makeBlocker()
    jq.registerExecutor('metadata', b.executor)
    jq.setLlmConcurrency(1)
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueue({ project_slug: proj.slug, type: 'metadata', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 1)
    await settle()
    assert.equal(b.active, 1, 'only one runs when limit=1')
    b.releases.shift()!()
    await waitFor(() => b.done === 1 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 2)
    await settle()
    assert.equal(b.peak, 1)
  })

  test('local Chat Studio jobs bypass the cloud text-job limit', async () => {
    const proj = await pm.createProject({ name: 'JQCC-LOCAL' })
    const b = makeBlocker()
    jq.registerExecutor('metadata', b.executor)
    jq.setLlmConcurrency(1)
    for (const ep of ['EP001', 'EP002', 'EP003']) {
      jq.enqueue({
        project_slug: proj.slug,
        type: 'metadata',
        episode_id: ep,
        title: ep,
        params: { model: 'chatstudio:mlx-community/Qwen3-8B-4bit' },
      })
    }
    await waitFor(() => b.active === 3)
    assert.equal(b.peak, 3, 'local work is admitted to the Studio fleet immediately')
    b.releases.splice(0, 3).forEach(release => release())
    await waitFor(() => b.done === 3)
    await settle()
  })

  test('cloud models proxied through Chat Studio still obey the saved limit', async () => {
    const proj = await pm.createProject({ name: 'JQCC-CLOUD-PROXY' })
    const b = makeBlocker()
    jq.registerExecutor('metadata', b.executor)
    jq.setLlmConcurrency(1)
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueue({
        project_slug: proj.slug,
        type: 'metadata',
        episode_id: ep,
        title: ep,
        params: { model: 'chatstudio:provider:openrouter:openai/gpt-4o-mini' },
      })
    }
    await waitFor(() => b.active === 1)
    assert.equal(b.active, 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 1 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 2)
    await settle()
    assert.equal(b.peak, 1)
  })

  test('adjacent local and cloud text jobs enter their independent lanes', async () => {
    const proj = await pm.createProject({ name: 'JQCC-MIXED' })
    const b = makeBlocker()
    jq.registerExecutor('metadata', b.executor)
    jq.setLlmConcurrency(1)
    const rows = [
      ['EP001', 'chatstudio:local/model-a'],
      ['EP002', 'chatstudio:provider:openrouter:model-b'],
      ['EP003', 'chatstudio:local/model-c'],
    ]
    for (const [episode_id, model] of rows) {
      jq.enqueue({ project_slug: proj.slug, type: 'metadata', episode_id, title: episode_id, params: { model } })
    }
    await waitFor(() => b.active === 3)
    assert.equal(b.peak, 3)
    b.releases.splice(0, 3).forEach(release => release())
    await waitFor(() => b.done === 3)
    await settle()
  })

  test('budget is SHARED across different text types (outline + metadata)', async () => {
    const proj = await pm.createProject({ name: 'JQCC3' })
    const b = makeBlocker()              // one closure-state both types share
    jq.registerExecutor('outline_only', b.executor)
    jq.registerExecutor('metadata', b.executor)
    jq.setLlmConcurrency(2)
    jq.enqueue({ project_slug: proj.slug, type: 'outline_only', episode_id: 'EP001', title: 'o1', params: {} })
    jq.enqueue({ project_slug: proj.slug, type: 'metadata', episode_id: 'EP001', title: 'm1', params: {} })
    jq.enqueue({ project_slug: proj.slug, type: 'outline_only', episode_id: 'EP002', title: 'o2', params: {} })
    await waitFor(() => b.active === 2)
    await settle()
    assert.equal(b.active, 2, 'outline + metadata together obey ONE shared budget')
    b.releases.shift()!()
    b.releases.shift()!()
    await waitFor(() => b.done === 2 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 3)
    await settle()
    assert.equal(b.peak, 2)
  })

  test('non-LLM types stay serial even with a high LLM budget', async () => {
    const proj = await pm.createProject({ name: 'JQCC4' })
    const b = makeBlocker()
    jq.registerExecutor('video', b.executor)
    jq.setLlmConcurrency(4)              // must NOT affect the video queue
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueue({ project_slug: proj.slug, type: 'video', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 1)
    await settle()
    assert.equal(b.active, 1, 'video runs one-at-a-time regardless of llmConcurrency')
    b.releases.shift()!()
    await waitFor(() => b.done === 1 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 2)
    await settle()
    assert.equal(b.peak, 1)
  })

  test('subtitle transcription has its own bounded concurrency group', async () => {
    const proj = await pm.createProject({ name: 'JQCC5' })
    const b = makeBlocker()
    jq.registerExecutor('subtitles_transcribe', b.executor)
    jq.setLlmConcurrency(1)
    jq.setSubtitleTranscribeConcurrency(3)
    for (const ep of ['EP001', 'EP002', 'EP003', 'EP004']) {
      jq.enqueue({ project_slug: proj.slug, type: 'subtitles_transcribe', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 3)
    await settle()
    assert.equal(b.active, 3, 'subtitle jobs use their own pool, not the LLM budget')
    b.releases.shift()!()
    b.releases.shift()!()
    b.releases.shift()!()
    await waitFor(() => b.done === 3 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 4)
    await settle()
    assert.equal(b.peak, 3)
  })

  test('remote final renders submit several episodes to Render Studio workers', async () => {
    const proj = await pm.createProject({ name: 'JQCC6' })
    const b = makeBlocker()
    jq.registerExecutor('video_assembly', b.executor)
    for (const ep of ['EP001', 'EP002', 'EP003', 'EP004', 'EP005']) {
      jq.enqueue({ project_slug: proj.slug, type: 'video_assembly', episode_id: ep, title: ep, params: { render_target: 'remote' } })
    }
    await waitFor(() => b.active === 4)
    assert.equal(b.peak, 4, 'four remote assemblies may submit to different Render Studio workers')
    b.releases.splice(0, 4).forEach(release => release())
    await waitFor(() => b.done === 4 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 5)
  })

  test('an explicit This Mac final-render preset stays serial', async () => {
    const proj = await pm.createProject({ name: 'JQCC7' })
    const b = makeBlocker()
    jq.registerExecutor('video_assembly', b.executor)
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueue({ project_slug: proj.slug, type: 'video_assembly', episode_id: ep, title: ep, params: { render_target: 'local' } })
    }
    await waitFor(() => b.active === 1)
    await settle()
    assert.equal(b.peak, 1, 'the control Mac owns only one explicit local final render')
    b.releases.shift()!()
    await waitFor(() => b.done === 1 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 2)
    assert.equal(b.peak, 1)
  })
})
