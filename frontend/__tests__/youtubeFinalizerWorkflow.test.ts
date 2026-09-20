import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fullRunSteps, STEP_LABELS } from '../composables/useRemoteChain.js'
import type { VisualSource } from '../composables/useProjectFlow.js'

const finalizerPage = readFileSync(
  new URL('../pages/projects/[slug]/metadata.vue', import.meta.url),
  'utf8',
)
const pipelinePage = readFileSync(
  new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url),
  'utf8',
)

test('YouTube Finalizer exposes one primary generation action after measured audio timing', () => {
  assert.match(finalizerPage, /title="YouTube Finalizer"/)
  assert.match(finalizerPage, /generate-label="Finalize YouTube Package"/)
  assert.match(finalizerPage, /!finalizationStatus\?\.audio_assembly_ready/)
  assert.match(finalizerPage, /Run Audio Assembly first/)
  assert.match(finalizerPage, /You can still finalize/)
  assert.match(finalizerPage, /existing_package:/)
  assert.doesNotMatch(finalizerPage, /Generate (?:Titles|Description|Tags) Only/)
  assert.doesNotMatch(finalizerPage, /async function generate(?:Titles|Description|Tags)/)
  assert.doesNotMatch(finalizerPage, /insertChapterTimestamps/)
})

test('desktop and remote batch chains finalize once after subtitles', () => {
  assert.match(pipelinePage, /'audio', 'audio_merge', 'subtitles',\s*'metadata'/)
  assert.match(pipelinePage, /label: 'YouTube Finalizer'/)

  const sources: VisualSource[] = ['timestamp-driven', 'continuity-chain', 'narrated-scenes']
  for (const visualSource of sources) {
    const steps = fullRunSteps(visualSource)
    assert.equal(STEP_LABELS.metadata, 'YouTube Finalizer')
    assert.equal(steps.filter(step => step === 'metadata').length, 1)
    assert.ok(steps.indexOf('metadata') > steps.indexOf('subtitles'))
    assert.ok(steps.indexOf('metadata') > steps.indexOf('audio_merge'))
  }
})

/**
 * v1.4.194 — the finalizer's readiness belongs to one episode.
 *
 * `finalizerGateReason` answers from `finalizationStatus`, which `loadFinalizationStatus`
 * replaced only on a SUCCESSFUL load. Between an episode change and the new
 * status arriving, the gate therefore reported the previous episode's readiness,
 * and after a failed load it reported it indefinitely. AGENTS.md §4.
 */
test("an episode change blanks the previous episode's finalization status", () => {
  const watcher = finalizerPage.match(/watch\(\[slug, episodeId\][\s\S]*?\n\}\)/)
  assert.ok(watcher, 'expected the [slug, episodeId] watcher on the finalizer page')
  const body = watcher[0]

  assert.match(
    body,
    /finalizationStatus\.value = null/,
    'the gate reads finalizationStatus, so an episode change must blank it',
  )
  assert.match(
    body,
    /finalizationLoadSequence\+\+/,
    'a status already in flight for the episode that is no longer open must be discarded',
  )
})
