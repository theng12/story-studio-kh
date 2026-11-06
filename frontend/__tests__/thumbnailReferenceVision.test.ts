import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { thumbnailVisionModelMenuOption } from '../utils/thumbnail-vision-model-menu.js'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

test('thumbnail reference analysis shows only qualified Gateway vision models', () => {
  const route = source('../../electron/server/routes/vision.ts')
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  const editor = source('../components/ThumbnailTemplateEditor.vue')
  const selector = source('../components/ModelSelector.vue')
  const health = source('../../electron/server/routes/health.ts')
  assert.match(route, /supports_vision/)
  assert.match(route, /max_input_images >= 1/)
  assert.match(route, /supports_structured_output/)
  assert.match(route, /thumbnail-reference\/vision-models/)
  assert.match(page, /thumbnailVisionModels/)
  // The page's Shell flow and the Shell editor both present the same
  // qualified Gateway rows through the shared menu and option builder — queue
  // shelf and retirement facts come from the live rows, not a hand-built list.
  assert.match(page, /\/projects\/\$\{slug\.value\}\/thumbnail-reference\/vision-models/)
  assert.match(page, /<ModelMenu/)
  assert.match(page, /:options="thumbnailVisionModelMenuOptions"/)
  assert.match(page, /:catalogue-error="thumbnailVisionLoadError"/)
  assert.match(page, /Retry Vision Models/)
  assert.match(editor, /\/thumbnail-templates\/vision\/models/)
  assert.match(editor, /thumbnailVisionModelMenuOption/)
  assert.match(editor, /<ModelMenu/)
  assert.match(editor, /:options="visionModelMenuOptions"/)
  assert.match(editor, /:catalogue-error="visionError"/)
  assert.match(editor, /Retry Vision Models/)
  const option = thumbnailVisionModelMenuOption({
    id: 'vision-priced', display_name: 'Vision priced', supported_detail_levels: ['high'],
    max_input_images: 1, accepted_image_mime_types: ['image/png'], max_image_bytes: 1,
    max_image_dimension: 1, input_credits_per_million_tokens: 2,
    output_credits_per_million_tokens: 3, minimum_credits: 1, price_version: 'v1',
  })
  assert.equal(option.group, 'Gateway · Vision only')
  // Owner, 2026-11-06: owner-facing menus carry no price annotation. Both
  // owning SFCs opt in to the shared row's queue shelf and retirement facts
  // only, so a builder price can never reappear in this UI.
  for (const surface of [page, editor]) {
    assert.doesNotMatch(surface, /price/i)
    assert.match(surface, /group: option\.group/)
    assert.match(surface, /groupNote: option\.groupNote/)
    assert.match(surface, /badges: option\.badges/)
  }
  assert.match(page, /Vision model for a new picture/)
  assert.match(page, /Upload your own/)
  assert.match(page, /saves a reusable Shell in your library/)
  // No model published is stated honestly rather than left as an empty menu.
  assert.match(page, /thumbnailVisionLoadError/)
  assert.match(page, /has not published a currently available vision model with image input and structured JSON output/)
  // Reference guidance is capability-gated on the intended image model.
  assert.match(page, /shellReferenceUnsupported/)
  assert.match(page, /intendedImageModel\.value\?\.supports_reference_images !== true/)
  assert.match(selector, /allModels\.value\.filter\(model => isUsableLiveGenStudioModel\(model, true\)\)/)
  assert.match(health, /supports_vision: model\.supports_vision/)
})

test('thumbnail reference keeps a durable Story asset while using a private Gateway upload', () => {
  const route = source('../../electron/server/routes/vision.ts')
  const client = source('../../electron/server/lib/genstudio-client.ts')
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  assert.match(route, /thumbnail-reference-assets/)
  assert.match(route, /uploadImageSourceWithGenStudio/)
  assert.match(route, /reframing_prompt/)
  assert.match(client, /\/v1\/images\/source-images/)
  assert.match(page, /thumb_reference_asset/)
  // 1.4.384: analysing a picture authors a reusable Shell; the durable record
  // is that Shell's saved image and layout note, selected through the
  // project-owned setting.
  assert.match(page, /shell_template_id: created\.template\.id, source_path: r\.path, model_id: thumbnailVisionModel\.value/)
  assert.match(page, /applyThumbnailShell\(data\.template\)/)
  assert.match(page, /thumbnail_template_id: template\.id/)
})
