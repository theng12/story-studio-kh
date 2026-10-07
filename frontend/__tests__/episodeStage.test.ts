import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { episodeStage, requiredStatusFields, type VisualSource } from '../composables/useProjectFlow.js'

/**
 * R7 (2026-10-07) — one derived state per episode, from fields the episode
 * list already returns, shown on the Production Board and the Overview.
 */
const vs: VisualSource = 'continuity-chain'
const allBut = (except: string[] = []) => Object.fromEntries(
  requiredStatusFields(vs).map(field => [field, !except.includes(field)]),
)

describe('derived episode state', () => {
  test('published wins over everything', () => {
    assert.equal(episodeStage({ status: {}, youtube_upload: { state: 'uploaded' } }, vs, true), 'published')
  })

  test('every required step done is ready to publish, even with a job running', () => {
    assert.equal(episodeStage({ status: allBut() }, vs, true), 'ready_to_publish')
    assert.equal(episodeStage({ status: allBut(), youtube_upload: { state: 'pending' } }, vs, false), 'ready_to_publish')
  })

  test('a queued or running job means producing', () => {
    assert.equal(episodeStage({ status: allBut(['script']) }, vs, true), 'producing')
  })

  test('everything but Video Assembly done is ready to assemble — unless switched-on cues are unfinished', () => {
    assert.equal(episodeStage({ status: allBut(['video_assembly']) }, vs, false), 'ready_to_assemble')
    assert.equal(episodeStage({ status: { ...allBut(['video_assembly']), contextual_cues: false } }, vs, false), 'waiting_for_you')
  })

  test('nothing running and work left is waiting for you', () => {
    assert.equal(episodeStage({ status: allBut(['script', 'video_assembly']) }, vs, false), 'waiting_for_you')
    assert.equal(episodeStage({ status: null }, vs, false), 'waiting_for_you')
  })

  test('the Board and the Overview both show it', () => {
    const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
    assert.match(read('../pages/projects/[slug]/board.vue'), /episodeStageLabel\(stageOf\(ep\)\)/)
    assert.match(read('../pages/projects/[slug]/index.vue'), /v-for="stage in stageCounts"/)
  })
})
