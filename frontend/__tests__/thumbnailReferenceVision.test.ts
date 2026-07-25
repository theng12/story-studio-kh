import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

test('thumbnail reference analysis shows only qualified GenStudio vision models', () => {
  const route = source('../../electron/server/routes/vision.ts')
  const page = source('../pages/projects/[slug]/image-prompts.vue')
  const selector = source('../components/ModelSelector.vue')
  const health = source('../../electron/server/routes/health.ts')
  assert.match(route, /supports_vision/)
  assert.match(route, /max_input_images >= 1/)
  assert.match(route, /supports_structured_output/)
  assert.match(route, /thumbnail-reference\/vision-models/)
  assert.match(page, /thumbnailVisionModels/)
  assert.match(page, /GenStudio KH · Vision only/)
  assert.match(page, /Reference-guided thumbnail/)
  assert.match(page, /Import & analyse reference/)
  assert.match(page, /Retry vision models/)
  assert.match(page, /:require-vision="Boolean\(form\.thumbnail\.thumb_reference_asset\)"/)
  assert.match(selector, /allModels\.value\.filter\(model => isUsableLiveGenStudioModel\(model, true\)\)/)
  assert.match(health, /supports_vision: model\.supports_vision/)
})

test('thumbnail reference keeps a durable Story asset while using a private GenStudio upload', () => {
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
