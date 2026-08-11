import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

test('Motion Review exposes every live variant and queues the exact selected pair', () => {
  assert.match(source, /<select\s+v-model="videoVariantKey"/)
  assert.match(source, /v-for="variant in selectedVideoVariants"/)
  assert.match(source, /variant\.credits_per_video/)
  assert.match(source, /variant\.minimum_credits/)
  assert.match(source, /variant\.price_version/)
  assert.match(source, /duration_seconds:\s*selectedVideoVariant\.value\.duration_seconds/)
  assert.match(source, /resolution:\s*selectedVideoVariant\.value\.resolution/)
})

test('Motion Review uses cheapest only as an initial default and clamps when the selected model changes', () => {
  assert.match(source, /const videoVariantKey = ref\(''\)/)
  assert.match(source, /watch\(selectedVideoVariants, \(variants\) =>/)
  assert.match(source, /variants\.some\(variant => variantKey\(variant\) === videoVariantKey\.value\)/)
  assert.match(source, /videoVariantKey\.value = variantKey\(cheapestVariant\(variants\)!\)/)
})
