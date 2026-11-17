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

test('destructive removals ask first, and hiding failed rows confirms what stays', () => {
  assert.match(body('pages/projects/[slug]/music.vue', 'remove'), ASK)
  for (const fn of ['removeComposition', 'removeSheet']) {
    assert.match(body('pages/projects/[slug]/character-sheet.vue', fn), ASK, fn)
  }
  // Bulk hide is restorable, so its confirm is a full block rather than the
  // one-line ASK shape: only the failed rows ask, and the dialog says plainly
  // that nothing is deleted and the Hidden filter restores them.
  const jobs = src('pages/projects/[slug]/jobs.vue')
  const clear = jobs.slice(jobs.indexOf('async function clearHistory('), jobs.indexOf('function clearFinished()'))
  assert.match(clear, /if \(status === 'failed' && !await useConfirm\(\)\.ask\(\{/)
  assert.match(clear, /title: 'Hide failed jobs from the list\?'/)
  assert.match(clear, /Nothing is deleted — their error details, logs and Retry\/Recover stay on the record, and the Hidden filter brings them back\./)
  assert.match(clear, /confirmLabel: 'Hide From List'/)
  assert.match(clear, /danger: true/)
  assert.match(clear, /await post<\{ hidden: number \}>\(`\$\{endpoint\}\/hide\?status=\$\{status\}`\)/)
})

test('force-regenerate thumbnails is explicit and cannot be skipped', () => {
  const s = src('pages/projects/[slug]/images.vue')
  assert.match(s, /params\.force\s*\? \{ action: regenerateAllAction\.value, details, always: true \}/)
  // The wording follows the selected model: credits are only promised when it charges.
  assert.match(s, /activeModelPaid\.value\s*\? 'Re-render ALL thumbnails\? This replaces the existing ones and uses credits again\.'/)
  assert.match(s, /: 'Re-render ALL thumbnails\? This replaces the existing ones\. This model is free/)
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

test('recency deletions in scripts.vue and recency.vue avoid bare confirm() and route through useConfirm', () => {
  const bareNativeDialog = /(^|[^.\w$])(confirm|alert|prompt)\(/m
  const scripts = src('pages/projects/[slug]/scripts.vue')
  const recency = src('pages/projects/[slug]/recency.vue')

  assert.match(scripts, /const \{\s*ask\s*\}\s*=\s*useConfirm\(\)/)
  assert.match(recency, /const \{\s*ask\s*\}\s*=\s*useConfirm\(\)/)

  const clearLog = body('pages/projects/[slug]/scripts.vue', 'clearRecencyLog')
  assert.doesNotMatch(clearLog, bareNativeDialog, 'scripts.vue clearRecencyLog must not call bare confirm/alert/prompt')
  assert.match(clearLog, /await ask\(\{[\s\S]*danger: true/, 'scripts.vue clearRecencyLog routes through useConfirm ask()')

  for (const fn of ['removeEntry', 'clearByKind', 'clearAll']) {
    const fnBody = body('pages/projects/[slug]/recency.vue', fn)
    assert.doesNotMatch(fnBody, bareNativeDialog, `recency.vue ${fn} must not call bare confirm/alert/prompt`)
    assert.match(fnBody, /await ask\(\{[\s\S]*danger: true/, `recency.vue ${fn} routes through useConfirm ask()`)
  }

  // Whole-file guard on both pages (strip comments first so JSDoc mentions do not trip).
  for (const [name, content] of [['scripts.vue', scripts], ['recency.vue', recency]] as const) {
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(stripped, bareNativeDialog, `${name} has no bare native confirm/alert/prompt`)
  }
})

