import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { register } from 'tsx/esm/api'

const ROOT = new URL('../../../', import.meta.url)
const WAVE = new URL('../../../content-packs/free-starters/', import.meta.url)
const unregister = register()
const { BUILT_IN_STYLES } = await import(new URL('../../../frontend/composables/useBuiltInStyles.ts', import.meta.url))
unregister()

const STYLES = [
  'waxy-outline-cartoon', 'prehistoric-stick-cartoon', 'paleo-documentary-tableau',
  'hand-drawn-editorial-diagram', 'minimal-stick-figure-explainer', 'sepia-ink-wash',
  'cinematic-photoreal', 'watercolor-storybook', 'flat-vector-explainer',
]

test('signed Style source documents retain every legacy renderer-safe field', async () => {
  for (const slug of STYLES) {
    const source = JSON.parse(await readFile(new URL(`style/${slug}/content/visual-style.json`, WAVE), 'utf8'))
    const legacy = BUILT_IN_STYLES.find(candidate => candidate.id === `builtin-${slug}`)
    assert.ok(legacy, `missing legacy Style ${slug}`)
    assert.deepEqual({
      name: source.name,
      blurb: source.description,
      category: source.category,
      tags: source.tags,
      data: { style_bible: source.style_bible, negative_prompt: source.negative_prompt },
    }, {
      name: legacy.name,
      blurb: legacy.blurb,
      category: legacy.category,
      tags: legacy.tags,
      data: legacy.data,
    }, `${slug} must retain its legacy renderer contract`)
  }
})
