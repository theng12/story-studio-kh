import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { genStudioModelLockReason, selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.ts'

/** A sentence the gateway can publish when the fleet behind a product is down. */
const FLEET_OUTAGE_REASON = 'every Mac offering this model is offline'

const models = [
  { id: 'writer-fast', available: true },
  { id: 'writer-quality', available: true, legacy_ids: ['old-quality'] },
  { id: 'writer-retired', available: false },
]

const fullyTieredModels = [
  { id: 'balanced-model', available: true, cost_tier: 'balanced' as const },
  { id: 'economy-model', available: true, cost_tier: 'economy' as const },
  { id: 'premium-model', available: true, cost_tier: 'premium' as const },
]

const tieredWithoutEconomy = [
  { id: 'balanced-model', available: true, cost_tier: 'balanced' as const },
  { id: 'premium-model', available: true, cost_tier: 'premium' as const },
]

const lockedModels = [
  { id: 'locked-economy', available: true, cost_tier: 'economy' as const, locked: true, lock_reason: 'requires_paid_account' },
  { id: 'open-economy', available: true, cost_tier: 'economy' as const },
]

const llmModels = [
  { id: 'premium-model', available: true, cost_tier: 'premium' as const },
  { id: 'promotional-model', available: true, cost_tier: 'promotional' as const },
  { id: 'value-model', available: true, cost_tier: 'value' as const },
  { id: 'economy-model', available: true, cost_tier: 'economy' as const },
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

test('a fully tiered empty selector chooses only an available Economy model', () => {
  assert.equal(selectLiveGenStudioModel('', fullyTieredModels)?.id, 'economy-model')
  assert.equal(selectLiveGenStudioModel('', tieredWithoutEconomy), null)
  assert.equal(selectLiveGenStudioModel('premium-model', fullyTieredModels)?.id, 'premium-model')
  assert.equal(selectLiveGenStudioModel('missing-saved-model', fullyTieredModels), null)
})

test('a fully tiered language selector chooses Promotional before other language tiers', () => {
  assert.equal(selectLiveGenStudioModel('', llmModels)?.id, 'promotional-model')
})

test('an untiered legacy catalog keeps its existing first-usable default', () => {
  assert.equal(selectLiveGenStudioModel('', models)?.id, 'writer-fast')
})

test('account-locked teaser models stay visible but are never selectable or chosen by default', () => {
  assert.equal(selectLiveGenStudioModel('locked-economy', lockedModels), null)
  assert.equal(selectLiveGenStudioModel('', lockedModels)?.id, 'open-economy')
})

test('a gateway lock reason is rendered verbatim, never rewritten as an account problem', () => {
  assert.equal(
    genStudioModelLockReason({ locked: true, lock_reason: FLEET_OUTAGE_REASON }),
    FLEET_OUTAGE_REASON,
  )
  const longReason = 'Every Mac offering this model is offline; the product returns by itself once one is back.'
  assert.equal(genStudioModelLockReason({ locked: true, lock_reason: longReason }), longReason)
})

test('the paid-account lock code keeps its own sentence', () => {
  assert.equal(
    genStudioModelLockReason({ locked: true, lock_reason: 'requires_paid_account' }),
    'Requires a paid GenStudio account.',
  )
})

test('a locked row with no usable reason never blames the account or billing', () => {
  for (const lock_reason of [undefined, null, '', '   ']) {
    const sentence = genStudioModelLockReason({ locked: true, lock_reason })
    assert.equal(sentence, 'Temporarily unavailable.')
    assert.doesNotMatch(sentence, /account|billing|paid|subscri/i)
  }
})

test('an unlocked row states no lock reason even when a stale one rides along', () => {
  assert.equal(genStudioModelLockReason({ locked: false, lock_reason: FLEET_OUTAGE_REASON }), '')
  assert.equal(genStudioModelLockReason({ lock_reason: FLEET_OUTAGE_REASON }), '')
})

test('the lock-reason call sites pass the gateway sentence through unchanged', () => {
  for (const path of [
    '../components/ModelSelector.vue',
    '../components/ImageModelPicker.vue',
    '../composables/useGenStudioTranscription.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    assert.match(source, /genStudioModelLockReason\(model\)/)
    assert.doesNotMatch(source, /Locked for this GenStudio account/)
  }
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
  assert.match(motionPage, /selectLiveImageToVideoModel/)
  assert.doesNotMatch(motionPage, /const fallback = exact \|\| mapped \|\|/)
  assert.doesNotMatch(transcription, /\|\| models\.value\[0\]/)
})
