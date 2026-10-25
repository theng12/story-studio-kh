import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { genStudioModelLockReason, resolveAliasedModelId, selectLiveGenStudioModel } from '../utils/live-genstudio-model-selection.ts'

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

test('a writing-model selector never picks one for the owner (2026-10-03)', () => {
  assert.equal(selectLiveGenStudioModel('', llmModels), null)
  assert.equal(selectLiveGenStudioModel('', models, false, 'llm'), null)
  assert.equal(selectLiveGenStudioModel('promotional-model', llmModels)?.id, 'promotional-model')
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
    assert.doesNotMatch(source, /Locked for this Gateway account/)
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
  assert.doesNotMatch(promptsPage, /claude-sonnet-4-6|gpt-4o-mini|gpt-4-turbo/)
  assert.match(metadataPage, /const model = ref\(''\)/)
  assert.match(motionPage, /selectLiveImageToVideoModel/)
  assert.doesNotMatch(motionPage, /const fallback = exact \|\| mapped \|\|/)
  assert.doesNotMatch(transcription, /\|\| models\.value\[0\]/)
})

test('an empty writing-model picker says the owner has to choose, visibly', () => {
  const source = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  assert.match(source, /v-else-if="!modelValue\.trim\(\) && allModels\.length && !loading"[\s\S]{0,120}Choose a writing model\. Story Studio does not pick one for you\./)
})

test('a writing model the gateway marks chargeable carries a visible Paid badge', () => {
  const source = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  assert.match(source, /model\.chargeable === true\s*\?\s*\[pool\s*\?[\s\S]{0,400}: \{ label: 'Paid', tone: 'warning'/)
})

test('a chargeable pool reads "Free · paid only as last resort", not "Paid"', () => {
  const source = readFileSync(new URL('../components/ModelSelector.vue', import.meta.url), 'utf8')
  assert.match(source, /\? \{ label: POOL_PAID_LAST_RESORT_LABEL, tone: 'info'/)
  const pool = readFileSync(new URL('../utils/gateway-pool.ts', import.meta.url), 'utf8')
  assert.match(pool, /POOL_PAID_LAST_RESORT_LABEL = 'Free · paid only as last resort'/)
})

test('an empty image/voice/music picker defaults only to a free fleet model, never a paid one listed first', () => {
  const imageRows = [
    { id: 'openai-direct::gpt-image', available: true, cost_tier: 'economy' as const, price_source: 'provider_page' },
    { id: 'studio-hub::klein', available: true, cost_tier: 'economy' as const, price_source: 'local' },
  ]
  assert.equal(selectLiveGenStudioModel('', imageRows)?.id, 'studio-hub::klein')
  assert.equal(selectLiveGenStudioModel('', imageRows.slice(0, 1)), null)
  // An explicit paid choice is still the owner's to make.
  assert.equal(selectLiveGenStudioModel('openai-direct::gpt-image', imageRows)?.id, 'openai-direct::gpt-image')
})

/**
 * The Audio page's alias step — added 2026-10-25 after a production report that
 * the VoxCPM2 voice picker stayed blank and a saved audio preset was cleared.
 *
 * TWO DEFECTS, ONE RENAME. The Gateway republished a TTS product under a new id
 * and published the old one as `legacy_ids`. The TTS catalogue parser dropped
 * that field (see `electron/server/__tests__/tts-model-product-aliases.test.ts`),
 * so a saved preset holding the superseded id resolved to no row at all: the
 * page passed `tts-model-id=""` to VoicePicker, which asked for no voice list,
 * showed "Choose a voice model first.", and stranded the saved voice. And the
 * page's own alias step discarded the customer's other choices with
 * `form.voice = null`, so even once the model resolved the preset's voice was
 * destroyed — the preset looked as though only the model had been restored.
 *
 * The tests below pin the rule that fixes the second half: following an alias
 * moves the MODEL id and nothing else. A migrated id is the same product under a
 * newer name, so the saved voice is still the right selection (AGENTS.md §1,
 * §4) — only a genuinely different product would justify dropping it, and that
 * cannot arise here.
 */
test('a superseded model id follows the live row the Gateway republished it as', () => {
  const ttsRows = [
    { id: 'voxcpm2-v1', available: true, legacy_ids: ['voxcpm2'] },
    { id: 'other-model', available: true },
  ]
  assert.equal(resolveAliasedModelId('voxcpm2', ttsRows), 'voxcpm2-v1')
})

test('an id that already names the live row is left exactly as it is', () => {
  const rows = [{ id: 'voxcpm2-v1', available: true, legacy_ids: ['voxcpm2'] }]
  // No change is not a migration: returning the same id would make the page
  // rewrite the form on every catalogue read.
  assert.equal(resolveAliasedModelId('voxcpm2-v1', rows), null)
})

test('an id nothing in the catalogue answers to is never swapped for another product', () => {
  const rows = [{ id: 'voxcpm2-v1', available: true, legacy_ids: ['voxcpm2'] }]
  assert.equal(resolveAliasedModelId('some-other-vendor-model', rows), null)
  assert.equal(resolveAliasedModelId('', rows), null)
  assert.equal(resolveAliasedModelId(null, rows), null)
})

test('a TTS row publishing generation_enabled counts as available', () => {
  // TTS publishes `generation_enabled`; chat/image/video publish `available`.
  // The picker must not treat a live TTS row as unusable just because its
  // availability arrives under the other name.
  assert.equal(
    resolveAliasedModelId('voxcpm2', [{ id: 'voxcpm2-v1', generation_enabled: true, legacy_ids: ['voxcpm2'] }]),
    'voxcpm2-v1',
  )
  assert.equal(
    resolveAliasedModelId('voxcpm2', [{ id: 'voxcpm2-v1', generation_enabled: false, legacy_ids: ['voxcpm2'] }]),
    null,
  )
})

test('following an alias moves the model id and never the saved voice', () => {
  const page = readFileSync(new URL('../pages/projects/[slug]/audio.vue', import.meta.url), 'utf8')
  const watcher = page.match(/watch\(\[ttsModels, \(\) => form\.model\][\s\S]*?\n\}\)/)
  assert.ok(watcher, 'the model-catalogue watcher is present')
  assert.match(watcher[0], /resolveAliasedModelId\(form\.model, ttsModels\.value\)/)
  // The defect: this line cleared the voice on every rename.
  assert.doesNotMatch(watcher[0], /form\.voice\s*=\s*null/)
  assert.doesNotMatch(watcher[0], /selectLiveGenStudioModel/)
})
