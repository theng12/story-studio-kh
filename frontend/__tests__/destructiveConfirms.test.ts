import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as vue from 'vue'

const src = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
/** Body of `async function <name>` up to the next top-level function. */
const body = (file: string, name: string) => {
  const s = src(file)
  const i = s.indexOf(`function ${name}(`)
  assert.ok(i >= 0, `${name} exists`)
  return s.slice(i, s.indexOf('\nasync function', i + 10) > 0 ? s.indexOf('\nasync function', i + 10) : i + 900)
}
const ASK = /useConfirm\(\)\.ask\(\{[^\n]*danger: true/

test('destructive removals and bulk clears ask first', () => {
  assert.match(body('pages/projects/[slug]/music.vue', 'remove'), ASK)
  assert.match(body('pages/projects/[slug]/jobs.vue', 'clearHistory'), ASK)
  for (const fn of ['removeThumbnail', 'removeMaster', 'removeScene']) {
    assert.match(body('components/Img2ImgReferencesCard.vue', fn), ASK, fn)
  }
  for (const fn of ['removeComposition', 'removeSheet']) {
    assert.match(body('pages/projects/[slug]/character-sheet.vue', fn), ASK, fn)
  }
  assert.doesNotMatch(src('components/Img2ImgReferencesCard.vue'), /[^.]\bconfirm\('/, 'no native confirm()')
})

test('force-regenerate thumbnails is explicit and cannot be skipped', () => {
  const s = src('pages/projects/[slug]/images.vue')
  assert.match(s, /params\.force\s*\? \{ action: 'Re-render ALL thumbnails[^']*', always: true \}/)
})

test('a forced confirmation ignores a saved skip preference, and a second call settles the first', async () => {
  Object.assign(globalThis, {
    reactive: vue.reactive, readonly: vue.readonly,
    useApi: () => ({ put: async () => ({}) }),
    useProject: () => ({ config: { value: { confirmation_preferences: { thumb_images: false } } }, refreshConfig: async () => {} }),
  })
  const { useConfirmation } = await import('../composables/useConfirmation.js')
  const c = useConfirmation()
  assert.equal(await c.confirmGeneration('s', 'thumb_images', {}), true, 'skip preference honoured normally')
  const forced = c.confirmGeneration('s', 'thumb_images', {}, { action: 'x', always: true })
  assert.equal(c.state.visible, true, 'forced action still asks')
  const second = c.confirmGeneration('s', 'thumb_images', {}, { action: 'y', always: true })
  assert.equal(await forced, false, 'the first caller is resolved, not orphaned')
  c.confirm(true)
  assert.equal(await second, true)
})
