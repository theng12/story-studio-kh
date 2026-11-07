/**
 * Scene Review — per-scene story links (Episode Visual Setup Phase 2).
 *
 * Static analysis over the page source, the frontend lane's convention. It
 * proves the wiring and the episode-change contract are present; it does NOT
 * prove the DOM renders (AGENTS.md §3).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const page = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url)),
  'utf8',
)

test('links only kept inventory entities through the episode-owned route', () => {
  // One source of truth with the backend for the state fields and labels.
  assert.ok(page.includes("from '../../../../electron/server/contracts/scene-story-context.js'"))
  assert.ok(page.includes("from '../../../../electron/server/contracts/story-entities.js'"))
  assert.ok(page.includes("entity.review === 'keep'"))
  assert.ok(page.includes('/scene-review/${episode}/story-context'))
})

test('an unreadable story context is reported, never shown as no links', () => {
  assert.ok(page.includes("storyContextError.value = r.story_context_error || ''"))
  assert.ok(page.includes('!storyContextError'))
  assert.ok(page.includes('Story context could not be read'))
})

test('episode change clears story state before the reload', () => {
  const watcher = page.match(/watch\(\[slug, episodeId\],[\s\S]*?flush: 'sync' \}\)/)
  assert.ok(watcher, 'the episode-change watcher must exist')
  for (const line of [
    'storyEntities.value = []',
    "storyContextError.value = ''",
    'storyDirtyScenes.value = new Set()',
    'storySavingScene.value = null',
  ]) {
    assert.ok(watcher![0].includes(line), `the watcher must clear ${line}`)
  }
})

test('save waits for a dropped link and reads the scene back from the server answer', () => {
  // The server refuses a save naming a dropped entity, so the button waits.
  assert.ok(page.includes('storySceneHasOrphan(scene)'))
  assert.ok(page.includes('result?.doc?.scenes?.find(entry => entry.scene_id === scene.id)'))
  assert.ok(page.includes('target.story_context = saved.entities.map'))
})

test('a render refresh keeps unsaved drafts on the same episode', () => {
  assert.ok(page.includes('dirtyStoryScenes.has(scene.id) && previousStory.has(scene.id)'))
})
