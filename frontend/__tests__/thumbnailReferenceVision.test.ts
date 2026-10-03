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
  const selector = source('../components/ModelSelector.vue')
  const health = source('../../electron/server/routes/health.ts')
  assert.match(route, /supports_vision/)
  assert.match(route, /max_input_images >= 1/)
  assert.match(route, /supports_structured_output/)
  assert.match(route, /thumbnail-reference\/vision-models/)
  assert.match(page, /thumbnailVisionModels/)
  assert.match(page, /:options="thumbnailVisionModelMenuOptions"/)
  const option = thumbnailVisionModelMenuOption({
    id: 'vision-priced', display_name: 'Vision priced', supported_detail_levels: ['high'],
    max_input_images: 1, accepted_image_mime_types: ['image/png'], max_image_bytes: 1,
    max_image_dimension: 1, input_credits_per_million_tokens: 2,
    output_credits_per_million_tokens: 3, minimum_credits: 1, price_version: 'v1',
  })
  assert.equal(option.group, 'Gateway · Vision only')
  assert.equal(option.price, '2 credits / 1M input tokens · 3 credits / 1M output tokens')
  assert.match(option.priceTitle, /minimum of 1 credit applies/i)
  assert.match(page, /Reference-guided thumbnail/)
  assert.match(page, /Import & analyse reference/)
  assert.match(page, /Retry vision models/)
  assert.match(page, /:require-vision="Boolean\(form\.thumbnail\.thumb_reference_asset\)"/)
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
  assert.match(page, /thumb_reference_style = data\.reference\.reframing_prompt/)
})
