/**
 * The Pipeline handoff child id is an idempotency key AND a name every job row,
 * lock key and generated file has to carry.
 *
 * Production evidence (EP0017, 2026-10-28): one segment was appended per
 * successful step — research_run `1813dc57` handed off to
 * `pipeline-handoff-1813dc57`, which handed off to
 * `pipeline-handoff-pipeline-handoff-1813dc57`. The chain shrinks by exactly
 * one link per handoff (9 → 8 → 7 → 6), so this is the Pipeline's own step
 * count, not a loop or a Retry. What is a defect is that each segment is 17
 * characters and `generators/scene-clip.ts` embeds the child id in a filename
 * that must stay under the filesystem's 255-byte component limit.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let jq: typeof import('../services/job-queue.js')

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  jq = await import('../services/job-queue.js')
})

after(async () => { await cleanup() })

const PREFIX = 'pipeline-handoff-'
const DIGEST_ID = /^pipeline-handoff-[0-9a-f]{24}$/

test('a first-level child keeps the readable pipeline-handoff-<parent> id', () => {
  assert.equal(
    jq._pipelineHandoffChildIdForTesting({ job_id: '1813dc57', type: 'research_run' }, { type: 'outline_only' }),
    `${PREFIX}1813dc57`,
  )
})

test('a parent that is itself a handoff gets a bounded, deterministic digest id', () => {
  const parent = { job_id: `${PREFIX}1813dc57`, type: 'outline_only' as const }
  const first = jq._pipelineHandoffChildIdForTesting(parent, { type: 'expand_chapters' })
  const again = jq._pipelineHandoffChildIdForTesting(parent, { type: 'expand_chapters' })
  assert.match(first, DIGEST_ID)
  assert.equal(first, again, 'the same parent and step must be the same id: it is the idempotency key')
  assert.equal(first.length, 41)
  assert.notEqual(
    jq._pipelineHandoffChildIdForTesting(parent, { type: 'audio' }),
    first,
    'a different next step is different work and must not collide',
  )
  assert.notEqual(
    jq._pipelineHandoffChildIdForTesting({ job_id: `${PREFIX}deadbeef`, type: 'outline_only' }, { type: 'expand_chapters' }),
    first,
    'a different parent must not collide',
  )
})

test('a chain of any length stays inside the same short id, and every step stays distinct', () => {
  let parent = { job_id: '1813dc57', type: 'research_run' as string }
  const seen = new Set<string>()
  let firstLevel = ''
  for (const type of ['outline_only', 'expand_chapters', 'audio', 'audio_merge', 'subtitles', 'scene_plan',
    'contextual_cues', 'scene_review', 'motion_review', 'video_assembly', 'thumb_images', 'metadata']) {
    const child = jq._pipelineHandoffChildIdForTesting(parent, { type })
    assert.ok(child.length <= 41, `${type} id is ${child.length} characters: ${child}`)
    if (!firstLevel) firstLevel = child
    else assert.match(child, DIGEST_ID, `${type} is not first-level and must be digested`)
    assert.ok(!seen.has(child), `${type} reused an earlier id`)
    seen.add(child)
    parent = { job_id: child, type }
  }
  assert.equal(firstLevel, `${PREFIX}1813dc57`)
  // The filename `scene-clip.ts` builds is `.${scene_id}.${job_id}.candidate.mp4`.
  // At the maximum chain length the digest keeps the whole component near 40
  // bytes instead of the ~280 a repeated prefix reached.
  const longest = Math.max(...[...seen].map(id => id.length))
  assert.ok(longest + '.SC001.'.length + '.candidate.mp4'.length <= 255,
    'the scene-clip candidate filename must stay inside the 255-byte component limit')
})

test('the subtitle → Finalizer handoff keeps its own identity, whatever the subtitle id looks like', () => {
  assert.equal(
    jq._pipelineHandoffChildIdForTesting({ job_id: 'sub-1', type: 'subtitles_transcribe' }, { type: 'metadata' }),
    jq.subtitleFinalizerJobId('sub-1'),
  )
})
