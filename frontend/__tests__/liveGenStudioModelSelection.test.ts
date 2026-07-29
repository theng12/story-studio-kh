import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.ts'

const models = [
  { id: 'writer-fast', available: true },
  { id: 'writer-quality', available: true, legacy_ids: ['old-quality'] },
  { id: 'writer-retired', available: false },
]

test('a named saved product is never silently replaced', () => {
  assert.equal(selectLiveGenStudioModel('gpt-4o', models), null)
  assert.equal(selectLiveGenStudioModel('writer-retired', models), null)
  assert.equal(selectLiveGenStudioModel('', models)?.id, 'writer-fast')
})

test('a valid explicit selection wins and a published legacy alias migrates', () => {
  assert.equal(selectLiveGenStudioModel('writer-quality', models)?.id, 'writer-quality')
  assert.equal(selectLiveGenStudioModel('old-quality', models)?.id, 'writer-quality')
})

test('no catalog model means no selection rather than reviving a retired id', () => {
  assert.equal(selectLiveGenStudioModel('gpt-4o', [{ id: 'paused', available: false }]), null)
})

test('Script Generator has no hardcoded GPT-4o default and waits for a live model', () => {
  const scriptPage = readFileSync(new URL('../pages/projects/[slug]/scripts.vue', import.meta.url), 'utf8')
  assert.match(scriptPage, /model: '',/)
  assert.match(scriptPage, /@model-meta="onScriptModelMeta"/)
  assert.match(scriptPage, /!scriptModelReady/)
})

test('generator pickers keep stale selections visible until the user replaces them', () => {
  const imagePicker = readFileSync(new URL('../components/ImageModelPicker.vue', import.meta.url), 'utf8')
  const modelPicker = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  const imagesPage = readFileSync(new URL('../pages/projects/[slug]/images.vue', import.meta.url), 'utf8')
  const promptsPage = readFileSync(new URL('../pages/projects/[slug]/image-prompts.vue', import.meta.url), 'utf8')
  const metadataPage = readFileSync(new URL('../pages/projects/[slug]/metadata.vue', import.meta.url), 'utf8')
  const motionPage = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')
  const transcription = readFileSync(new URL('../composables/useGenStudioTranscription.ts', import.meta.url), 'utf8')

  for (const source of [imagePicker, motionPage]) {
    assert.doesNotMatch(source, /Unavailable saved selection|migration required|Historical/)
  }
  assert.match(modelPicker, /will not switch products automatically/)
  assert.match(imagePicker, /selectLiveGenStudioModel/)
  assert.match(imagesPage, /model: '',/)
  assert.match(promptsPage, /thumbnail:\s*\{\s*model: '',/)
  assert.match(promptsPage, /scene:\s*\{\s*model: '',/)
  assert.match(promptsPage, /group: 'GenStudio KH'/)
  assert.doesNotMatch(promptsPage, /claude-sonnet-4-6|gpt-4o-mini|gpt-4-turbo/)
  assert.match(metadataPage, /const model = ref\(''\)/)
  assert.match(motionPage, /const fallback = exact \|\| mapped \|\|/)
  assert.doesNotMatch(transcription, /\|\| models\.value\[0\]/)
})
