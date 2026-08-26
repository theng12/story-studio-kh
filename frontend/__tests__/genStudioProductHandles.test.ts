/**
 * The picker side of the GenStudio product rename.
 *
 * GenStudio is republishing image and video products under their customer
 * handle (`genstudio-image-studio-v1` → `gpt-image-2`). Story Studio remembers
 * the owner's choice per project in localStorage, so the value in a saved
 * preset is whatever the catalogue was publishing on the day he chose it.
 *
 * A picker that resolves a saved value by `id` alone shows nothing selected,
 * and — worse — the guards that read capabilities off the selected row go
 * unarmed. These tests hold the rule that a saved identifier still finds its
 * product, and that a label follows the product rather than the string.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  describeGenStudioSelectionGap,
  selectLiveGenStudioModel,
} from '../utils/live-genstudio-model-selection.js'
import { buildGenStudioModelLabelEntries } from '../utils/genstudio-model-display.js'

const FRONTEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RAW_IMAGE_ID = 'genstudio-image-studio-v1'
const IMAGE_HANDLE = 'gpt-image-2'

/**
 * One published row after the rename.
 *
 * The back-reference is carried by `public_model_id`, NOT `legacy_ids`.
 * That is deliberate: `legacy_ids` matching already existed on this side, so a
 * fixture using it would pass with or without this change and prove nothing.
 * `public_model_id`/`customer_handle` are the identifier fields GenStudio's
 * product records actually carry, and the ones this change teaches Story
 * Studio to read.
 */
const RENAMED = {
  id: IMAGE_HANDLE,
  customer_handle: IMAGE_HANDLE,
  public_model_id: RAW_IMAGE_ID,
  display_name: 'GPT Image 2',
  available: true,
}

const OTHER = { id: 'flux-2-klein', display_name: 'FLUX 2 Klein', available: true }

test('a saved raw id still selects its product after the rename', () => {
  const selected = selectLiveGenStudioModel(RAW_IMAGE_ID, [OTHER, RENAMED])
  assert.ok(selected, 'the saved raw id must resolve to a live product')
  // The same row the handle resolves to — not a different product that merely
  // happened to be usable, which would silently change price and quality.
  assert.strictEqual(selected, RENAMED)
  assert.strictEqual(selectLiveGenStudioModel(IMAGE_HANDLE, [OTHER, RENAMED]), RENAMED)
})

test('following a published rename is reported as a migration, not a loss', () => {
  const gap = describeGenStudioSelectionGap(RAW_IMAGE_ID, [OTHER, RENAMED])
  assert.equal(gap.kind, 'migrated')
  assert.equal((gap as any).from, RAW_IMAGE_ID)
  assert.equal((gap as any).to, IMAGE_HANDLE)
})

test('a product that genuinely vanished is still reported as vanished', () => {
  // The healing path must not paper over a real retirement.
  const gap = describeGenStudioSelectionGap('genstudio-image-retired-v9', [OTHER, RENAMED])
  assert.equal(gap.kind, 'vanished')
  assert.equal(selectLiveGenStudioModel('genstudio-image-retired-v9', [OTHER, RENAMED]), null)
})

test('a label follows the product, so a saved raw id still reads as its real name', () => {
  const labels = Object.fromEntries(buildGenStudioModelLabelEntries({ image: [RENAMED] }))
  assert.equal(labels[IMAGE_HANDLE], 'GPT Image 2')
  // A job row saved under the old id must not render as a raw identifier.
  assert.equal(labels[RAW_IMAGE_ID], 'GPT Image 2')
})

test('Scene Review resolves its remembered model by identity, not by id equality', () => {
  // Scene Review is where the remembered image-model preset is actually read.
  const page = readFileSync(path.join(FRONTEND_ROOT, 'pages/projects/[slug]/scene-review.vue'), 'utf8')
  assert.match(page, /findGenStudioProduct\(genStudioImageModels\.value, form\.value\.model\)/)
  assert.doesNotMatch(
    page,
    /genStudioImageModels\.value\.find\(model => model\.id === form\.value\.model\)/,
    'the id-equality comparison is what the rename breaks',
  )
})
