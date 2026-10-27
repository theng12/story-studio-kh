import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

/**
 * The opt-in stronger scene-image check's surface (owner 2026-10-27).
 *
 * It is a SECOND switch beside the free one, OFF by default, with a model
 * chosen from the live Gateway catalogue and one auto-remake switch per axis.
 * These assertions are about wiring that no backend test can see.
 */
test('the stronger check is a separate opt-in switch with per-axis auto-remake', () => {
  const page = source('../pages/projects/[slug]/scene-review.vue')
  assert.ok(page.includes('<strong>Stronger vision image check</strong>'), 'its own switch, named plainly')
  assert.ok(!page.includes('Stronger vision image check (paid)'),
    'the label never claims a price: which row is chosen decides that')
  assert.ok(page.includes("visionSelectedModel.chargeable ? 'chargeable per image' : 'free'"),
    'the switch says whether the chosen row costs anything')
  assert.ok(page.includes('@change="toggleVisionCheckEnabled"'), 'the switch saves through its own handler')
  // OFF by default: only an explicit true turns it on.
  assert.ok(page.includes('enabled: raw.enabled === true'), 'nothing defaults the check on')
  assert.ok(page.includes('scene-image-check/vision-models'), 'the model list comes from the live catalogue')
  for (const axis of ['anatomy', 'face', 'text']) {
    assert.ok(page.includes(`${axis}: '`), `one auto-remake switch per axis (${axis})`)
  }
  assert.ok(page.includes('v-for="axis in SCENE_VISION_AXES"'), 'the switches are generated from the shared axis list')
  assert.ok(page.includes(':disabled="visionCheckSaving || !visionCheckSwitchUnlocked"'),
    'auto-remake stays locked until the shadow window ends')
  assert.ok(page.includes('visionSelectedModel.provider_name'), 'the provided-by label is shown where published')
  // Recorded beside, never instead of, the free check.
  assert.ok(page.includes('scene.vision_check'))
})

test('the vision-model route publishes only image-capable rows, provider as display only', () => {
  const route = source('../../electron/server/routes/vision.ts')
  assert.ok(route.includes('chatImageEligibility'), 'eligibility is the client\'s published-facts rule')
  assert.ok(route.includes('supports_vision'))
  assert.ok(route.includes('provider_id_published'), 'the unknown-provider limitation is reported')
  assert.ok(route.includes('provider_name: row.provider_name'), 'the provider travels for display')
})

test('the check never sends an invented image-asset field', () => {
  const client = source('../../electron/server/lib/genstudio-client.ts')
  assert.ok(client.includes('type: \'image_url\''), 'the picture rides as an OpenAI-style content part')
  assert.ok(!client.includes('inputImage?: { assetId'), 'the chat image-asset field the Gateway never had is gone')
  assert.ok(!client.includes('asset_id: request.inputImage'), 'no asset id is ever put on the chat wire')
  assert.ok(client.includes('input_image_sha256'), 'the idempotency key hashes the digest, never the base64')
})
