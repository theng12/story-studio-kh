import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  flowForEpisodeVisualSource,
  isEpisodeDone,
  isFlowStepApplicable,
  unionFlowForEpisodeSources,
} from '../composables/useProjectFlow.js'

const board = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/board.vue', import.meta.url)),
  'utf8',
)
const dashboard = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/index.vue', import.meta.url)),
  'utf8',
)

describe('mixed Scene Plan and Image Pool completion', () => {
  test('each episode branch has only its applicable visual steps', () => {
    const scene = flowForEpisodeVisualSource('continuity-chain', 'scene_plan').map(step => step.key)
    const pool = flowForEpisodeVisualSource('continuity-chain', 'image_pool').map(step => step.key)

    assert.ok(scene.includes('scene-plan'))
    assert.ok(scene.includes('scene-review'))
    assert.ok(!scene.includes('image-pool'))
    assert.ok(pool.includes('image-pool'))
    assert.ok(!pool.includes('character-sheet'))
    assert.ok(!pool.includes('scene-plan'))
    assert.ok(!pool.includes('scene-review'))
    assert.ok(!pool.includes('motion-review'))
  })

  test('the mixed board uses a stable union and can identify inapplicable cells', () => {
    const union = unionFlowForEpisodeSources('continuity-chain', ['scene_plan', 'image_pool'])
    const keys = union.map(step => step.key)
    assert.ok(keys.includes('scene-plan'))
    assert.ok(keys.includes('image-pool'))
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(isFlowStepApplicable(union.find(step => step.key === 'scene-plan')!, 'image_pool'), false)
    assert.equal(isFlowStepApplicable(union.find(step => step.key === 'image-pool')!, 'scene_plan'), false)
  })

  test('completion requires the selected branch and ignores the other branch', () => {
    const common = {
      script: true, thumb_prompts: true, thumbnails: true, audio: true,
      merged_audio: true, subtitles: true, metadata: true, video_assembly: true,
    }
    assert.equal(isEpisodeDone({
      ...common, visual_source: 'image_pool', broll_picked: true,
      scene_plan: false, scene_review: false, character_sheet: false,
    }, 'continuity-chain'), true)
    assert.equal(isEpisodeDone({
      ...common, visual_source: 'image_pool', broll_picked: false,
      scene_plan: true, scene_review: true, character_sheet: true,
    }, 'continuity-chain'), false)
  })

  test('the Board labels row sources, shows Not used, and counts eligible rows only', () => {
    assert.match(board, /episodeVisualSource\(ep\)/)
    assert.match(board, />Not used</)
    assert.match(board, /eligibleCount\(col\)/)
    assert.match(board, /isColumnApplicable\(ep, col\)/)
  })

  test('the Dashboard uses the same union and eligible denominators', () => {
    assert.match(dashboard, /unionFlowForEpisodeSources/)
    assert.match(dashboard, /isFlowStepApplicable/)
    assert.match(dashboard, /eligible\.length/)
    assert.match(dashboard, /requiredStatusFields\(visualSource\.value, episodeVisualSource\(ep\)\)/)
  })
})
