import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transformSync } from 'esbuild'
import ts from 'typescript'

const source = readFileSync(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url), 'utf8')
const script = source.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const ast = ts.createSourceFile('scene-plan.ts', script, ts.ScriptTarget.Latest, true)
const declarations = new Set(['visualTimingMotion', 'visualPresetNotice', 'planPresets', 'continuityLoadSequence'])
const functions = new Set(['snapshotVisualPreset', 'applyPromptPreset', 'applyVisualSettings', 'loadContinuity'])
const selected = ast.statements.filter(node =>
  (ts.isFunctionDeclaration(node) && functions.has(node.name?.text || ''))
  || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => declarations.has(d.name.getText(ast)))),
).map(node => node.getText(ast)).join('\n')
const { code } = transformSync(selected, { loader: 'ts', format: 'cjs' })

function harness() {
  const form = { value: { model: 'before', prompt_pack_size: 50, prompt_max_tokens: 'auto', motion_level: 4, generate_motion_prompts: true } }
  const episodeId = { value: 'EP0001' }
  const episodeVisualSource = { value: 'scene_plan' as string | null }
  const continuityPacing = { value: null as any }
  const episodeMotionScope = { value: { mode: 'off' } }
  const api = { get: async (_path: string): Promise<any> => ({ config: {} }) }
  const dependencies = {
    ref: (value: unknown) => ({ value }), usePresets: (options: unknown) => options,
    continuityPacing, episodeMotionScope, characterSheetStyleBible: { value: '' }, visualSettingsError: { value: '' },
    get: (path: string) => api.get(path),
    slug: { value: 'project-a' }, form, episodeId, episodeVisualSource,
    creativeDirectionPayload: { value: {} }, CREATIVE_PROFILES: [], CREATIVE_STRATEGIES: [],
    setPromptPackSetting: () => {}, setPromptCharCapSetting: () => {},
    clampOutputAllowance: (value: unknown) => value, normalizePromptTokenSetting: (value: unknown) => value,
    publishedMaxOutput: { value: 10000 },
  }
  const result = new Function(...Object.keys(dependencies), `${code}; return { planPresets, visualTimingMotion, visualPresetNotice, applyPromptPreset, applyVisualSettings, loadContinuity }`)(...Object.values(dependencies))
  return { ...result, form, episodeId, episodeVisualSource, api, continuityPacing, episodeMotionScope }
}

test('Scene Plan preset snapshots and explicitly applies the live timing panel, not stale form flags', () => {
  const h = harness()
  const timing = { pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'opening', end_sec: 120 }, motion_level: 3 }
  const applied: unknown[] = []
  h.visualTimingMotion.value = { snapshotPreset: () => structuredClone(timing), applyPreset: (data: unknown) => applied.push(data) }
  const snapshot = h.planPresets.snapshot()
  assert.deepEqual(snapshot.pacing, timing.pacing)
  assert.deepEqual(snapshot.motion_scope, timing.motion_scope)
  assert.equal(snapshot.motion_level, 3)
  assert.equal('generate_motion_prompts' in snapshot, false)
  h.planPresets.apply({ ...snapshot, model: 'chosen-model' })
  assert.equal(applied.length, 1)
  assert.equal(h.form.value.model, 'chosen-model')
  assert.equal(h.form.value.motion_level, 4)
  assert.equal('pacing' in h.form.value, false)
  assert.equal('motion_scope' in h.form.value, false)
  assert.match(source, /ref="visualTimingMotion"[\s\S]*?@saved="applyVisualSettings"/)
})

test('remembered preset restore changes prompt settings only and project switches remount its captured controller', () => {
  const h = harness()
  h.visualTimingMotion.value = { applyPreset: () => assert.fail('mount restore must not apply episode timing') }
  assert.equal(h.planPresets.autoApplyOnLoad, false)
  h.applyPromptPreset({ model: 'remembered', generate_motion_prompts: false, motion_level: 1, pacing: { min_sec: 10, max_sec: 20 }, motion_scope: { mode: 'off' } })
  assert.equal(h.form.value.model, 'remembered')
  assert.equal(h.form.value.generate_motion_prompts, true)
  assert.equal(h.form.value.motion_level, 4)
  assert.match(source, /planPresets\.load\(\)\.then\([\s\S]*?if \(preset\) applyPromptPreset\(preset\.data\)/)
  assert.match(source, /key: route => `scene-plan-\$\{route\.params\.slug\}`/)
})

test('loading and invalid timing reject Apply before changing prompt fields or saving an incomplete preset', () => {
  const h = harness()
  assert.throws(() => h.planPresets.apply({ model: 'new' }), /loading/)
  assert.throws(() => h.planPresets.snapshot(), /loading/)
  assert.equal(h.form.value.model, 'before')
  h.visualTimingMotion.value = { applyPreset: () => { throw new Error('invalid timing') }, snapshotPreset: () => { throw new Error('invalid timing') } }
  assert.throws(() => h.planPresets.apply({ model: 'new' }), /invalid timing/)
  assert.throws(() => h.planPresets.snapshot(), /invalid timing/)
  assert.equal(h.form.value.model, 'before')
})

test('prompt-only use without a Scene Plan episode stays available and explains the timing boundary', () => {
  const h = harness()
  h.episodeId.value = ''
  h.planPresets.apply({ model: 'new', pacing: { min_sec: 4, max_sec: 8 } })
  assert.equal(h.form.value.model, 'new')
  assert.equal('pacing' in h.planPresets.snapshot(), false)
  assert.match(h.visualPresetNotice.value, /Select a Scene Plan episode and click Apply/)
  h.episodeId.value = 'EP0002'
  h.episodeVisualSource.value = 'image_pool'
  h.planPresets.apply({ model: 'pool-prompt' })
  assert.equal('motion_scope' in h.planPresets.snapshot(), false)
})


test('saving timing supersedes an older page continuity read before it can revert the header', async () => {
  const h = harness()
  let finish!: (value: any) => void
  h.api.get = () => new Promise(resolve => { finish = resolve })
  const pending = h.loadContinuity()
  h.applyVisualSettings({ pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'opening', end_sec: 120 }, motion_level: 3 })
  finish({ config: { pacing: { min_sec: 1, max_sec: 3 }, motion_scope: { mode: 'off' }, motion_level: 2 } })
  await pending
  assert.deepEqual(h.continuityPacing.value, { min_sec: 6, max_sec: 12 })
  assert.deepEqual(h.episodeMotionScope.value, { mode: 'opening', end_sec: 120 })
  assert.equal(h.form.value.generate_motion_prompts, true)
  assert.equal(h.form.value.motion_level, 3)
})
