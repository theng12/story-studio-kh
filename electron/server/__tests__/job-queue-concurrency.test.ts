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
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import type { Job } from '../models/types.js'

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
  jq.setLlmConcurrency(50)
  jq.setSubtitleTranscribeConcurrency(50)
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
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'outline_only', episode_id: ep, title: ep, params: {} })
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
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'metadata', episode_id: ep, title: ep, params: {} })
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
      jq.enqueuePreparedForTest({
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
      jq.enqueuePreparedForTest({
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
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'metadata', episode_id, title: episode_id, params: { model } })
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
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'outline_only', episode_id: 'EP001', title: 'o1', params: {} })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'metadata', episode_id: 'EP001', title: 'm1', params: {} })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'outline_only', episode_id: 'EP002', title: 'o2', params: {} })
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
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'video', episode_id: ep, title: ep, params: {} })
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
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'subtitles_transcribe', episode_id: ep, title: ep, params: {} })
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

  test('final renders stay serial', async () => {
    const proj = await pm.createProject({ name: 'JQCC7' })
    const b = makeBlocker()
    jq.registerExecutor('video_assembly', b.executor)
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'video_assembly', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 1)
    await settle()
    assert.equal(b.peak, 1, 'this Mac owns only one final render')
    b.releases.shift()!()
    await waitFor(() => b.done === 1 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 2)
    assert.equal(b.peak, 1)
  })

  /**
   * Research was left out of the shared writing-jobs budget when that budget
   * was introduced (v1.0.335) — an omission, not a decision: the release note
   * lists the five text types it did include and the four lanes it deliberately
   * kept serial, and research appears in neither list. Falling through
   * `groupOf` to its own name gave it `groupLimit() === 1`, so fifty-one queued
   * research jobs ran strictly one at a time no matter what the owner set.
   *
   * Research is an ordinary GenStudio-bound text call that writes only inside
   * its own episode folder, so it belongs in the SAME budget as the rest —
   * not a lane of its own. A second lane would mean the effective number of
   * concurrent writing jobs is one nobody set.
   */
  test('research runs N-at-a-time on the writing budget; the N+1th waits', async () => {
    const proj = await pm.createProject({ name: 'JQCC-RESEARCH' })
    const b = makeBlocker()
    jq.registerExecutor('research_run', b.executor)
    jq.setLlmConcurrency(3)
    for (const ep of ['EP001', 'EP002', 'EP003', 'EP004']) {
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'research_run', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => b.active === 3)
    await settle()
    assert.equal(b.active, 3, 'three research jobs run at once when the budget is 3')
    b.releases.splice(0, 3).forEach(release => release())
    await waitFor(() => b.done === 3 && b.active === 1)   // freed budget pulls the 4th
    b.releases.shift()!()
    await waitFor(() => b.done === 4)
    await settle()
    assert.equal(b.peak, 3, 'never exceeded the budget the owner set')
  })

  test('research draws on the SAME budget as outlines, not a second lane', async () => {
    const proj = await pm.createProject({ name: 'JQCC-RESEARCH-SHARED' })
    const b = makeBlocker()              // one closure-state both types share
    jq.registerExecutor('research_run', b.executor)
    jq.registerExecutor('outline_only', b.executor)
    jq.setLlmConcurrency(2)
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'research_run', episode_id: 'EP001', title: 'r1', params: {} })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'outline_only', episode_id: 'EP001', title: 'o1', params: {} })
    jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'research_run', episode_id: 'EP002', title: 'r2', params: {} })
    await waitFor(() => b.active === 2)
    await settle()
    assert.equal(b.active, 2, 'research + outline together obey ONE shared budget')
    b.releases.splice(0, 2).forEach(release => release())
    await waitFor(() => b.done === 2 && b.active === 1)
    b.releases.shift()!()
    await waitFor(() => b.done === 3)
    await settle()
    assert.equal(b.peak, 2, 'two concurrent, never four')
  })

  /**
   * The reason sharing is SAFE, exercised rather than asserted: two research
   * jobs on different episodes are held open at the same instant, both having
   * already written their `research.json`, and each then writes its
   * `research.md` while the other is still live. Both sidecars must survive
   * with their own episode's payload — the real `resolveResearchPaths` is used,
   * so this is the actual write surface the generator uses, not a stand-in.
   */
  test('two concurrent research jobs write only inside their own episode folder', async () => {
    const proj = await pm.createProject({ name: 'JQCC-RESEARCH-PATHS' })
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const { resolveResearchPaths, RESEARCH_JSON_FILENAME, RESEARCH_MD_FILENAME }
      = await import('../lib/research-paths.js')
    const fsp = (await import('fs/promises')).default

    let active = 0
    let peak = 0
    let done = 0
    const releases: Array<() => void> = []
    const written: Record<string, { dir: string; jsonPath: string; mdPath: string }> = {}

    jq.registerExecutor('research_run', async (job: Job) => {
      active++
      peak = Math.max(peak, active)
      const code = job.episode_id
      const paths = await resolveEpisodePathsByCode(job.project_slug, code)
      const rp = await resolveResearchPaths(paths.episode_dir, code)
      await fsp.mkdir(rp.dir, { recursive: true })
      await fsp.writeFile(rp.jsonPath, JSON.stringify({ episode: code }), 'utf-8')
      // Hold here so BOTH jobs are mid-write at the same moment.
      await new Promise<void>(res => releases.push(res))
      await fsp.writeFile(rp.mdPath, `# research for ${code}`, 'utf-8')
      written[code] = rp
      active--
      done++
    })

    jq.setLlmConcurrency(2)
    for (const ep of ['EP001', 'EP002']) {
      jq.enqueuePreparedForTest({ project_slug: proj.slug, type: 'research_run', episode_id: ep, title: ep, params: {} })
    }
    await waitFor(() => releases.length === 2)
    assert.equal(peak, 2, 'both research jobs were genuinely in flight together')

    releases.splice(0, 2).forEach(release => release())
    await waitFor(() => done === 2)
    await settle()

    assert.notEqual(written.EP001!.dir, written.EP002!.dir, 'each episode owns a distinct research folder')
    for (const code of ['EP001', 'EP002']) {
      const rp = written[code]!
      assert.equal(path.basename(rp.jsonPath), RESEARCH_JSON_FILENAME)
      assert.equal(path.basename(rp.mdPath), RESEARCH_MD_FILENAME)
      assert.deepEqual(
        JSON.parse(await fsp.readFile(rp.jsonPath, 'utf-8')),
        { episode: code },
        `${code} kept its own research.json`,
      )
      assert.equal(
        await fsp.readFile(rp.mdPath, 'utf-8'),
        `# research for ${code}`,
        `${code} kept its own research.md`,
      )
    }
  })
})
