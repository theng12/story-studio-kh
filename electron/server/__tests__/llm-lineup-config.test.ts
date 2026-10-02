import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeLlmLineup } from '../contracts/llm-lineup.js'
import { UpdateConfigSchema } from '../contracts/index.js'
import * as llmLineup from '../services/llm-lineup.js'
import { applyLlmLineupSnapshot } from '../services/llm-lineup.js'
import { useTempDataDir } from './_helpers.js'

const lineup = { enabled: true, models: ['free-choice', 'paid-choice'], prefer_savings: true }

test('lineup validates choices and stores no live catalogue values', () => {
  assert.deepEqual(normalizeLlmLineup(undefined), { enabled: false, models: [], prefer_savings: true })
  assert.deepEqual(normalizeLlmLineup({ ...lineup, models: [' genstudio-chat:free-choice ', 'free-choice', 'paid-choice'] }), lineup)
  for (const value of [{ enabled: true, models: [] }, { ...lineup, models: [''] }, { ...lineup, prefer_savings: 'yes' }]) {
    assert.equal(UpdateConfigSchema.safeParse({ llm_lineup: value }).success, false)
  }
  assert.equal(UpdateConfigSchema.safeParse({ llm_lineup: { ...lineup, minimum_credits: 0 } }).success, false)
})

test('lineup overrides model only and freezes the entire chain without mutating a preset', () => {
  const original = { model: 'old-preset-model', tone: 'calm', max_sources: 3,
    pipeline_chain: [{ type: 'metadata', params: { model: 'metadata-preset', template_id: 'retained' } }],
  }
  const next = applyLlmLineupSnapshot('research_run', 'EP1', original, lineup)
  assert.equal(original.model, 'old-preset-model')
  assert.equal(next.model, 'free-choice')
  assert.equal(next.tone, 'calm')
  assert.equal(next.max_sources, 3)
  assert.equal(next.pipeline_model_policy.research.wait_for_availability, true)
  assert.equal(next.pipeline_chain[0].params.model, 'free-choice')
  assert.equal(next.pipeline_chain[0].params.template_id, 'retained')
  lineup.models.push('later-change')
  assert.deepEqual(next.llm_lineup_snapshot.models, ['free-choice', 'paid-choice'])
  lineup.models.pop()
})

test('disabled lineup and explicit stage policies retain existing model choice', () => {
  const explicit = { mode: 'single', models: ['deliberate'], assigned_model: 'deliberate' }
  const original = { model: 'deliberate', pipeline_model_policy: { metadata: explicit } }
  assert.deepEqual(applyLlmLineupSnapshot('metadata', 'EP1', original, lineup).pipeline_model_policy.metadata, explicit)
  assert.equal(applyLlmLineupSnapshot('metadata', 'EP1', original, { ...lineup, enabled: false }).model, 'deliberate')
  assert.deepEqual(applyLlmLineupSnapshot('audio', 'EP1', { model: 'voice' }, lineup), { model: 'voice' })
})

test('a lineup never follows a published successor on its own (owner decision 2026-10-03)', () => {
  const params = applyLlmLineupSnapshot('metadata', 'EP1', {}, { ...lineup, models: ['old', 'paid-choice'] })
  assert.deepEqual(params.pipeline_model_policy.metadata.models, ['old', 'paid-choice'])
  assert.equal('replaceRetiredLineupModels' in llmLineup, false, 'the successor-following helper is gone')
})

test('nonwriting handoff preserves a writing child’s deliberately disabled lineup snapshot', () => {
  const disabled = { ...lineup, enabled: false }
  const original = applyLlmLineupSnapshot('audio', 'EP1', {
    pipeline_chain: [{ type: 'metadata', params: { model: 'metadata-preset' } }],
  }, disabled)
  const handedOff = applyLlmLineupSnapshot('audio', 'EP1', {
    pipeline_chain: original.pipeline_chain,
  }, lineup)
  const child = handedOff.pipeline_chain[0].params
  assert.equal(child.llm_lineup_snapshot.enabled, false)
  assert.equal(child.model, 'metadata-preset')
  assert.equal(child.pipeline_model_policy, undefined)
})

test('project lineup and named presets round-trip without changing writing presets or another project', async t => {
  const isolated = await useTempDataDir()
  t.after(() => isolated.cleanup())
  const pm = await import('../services/project-manager.js')
  const a = await pm.createProject({ name: 'Lineup round trip', episode_prefix: 'EP', episode_digits: 4 })
  const b = await pm.createProject({ name: 'Other lineup project', episode_prefix: 'EP', episode_digits: 4 })
  const preset = [{ id: 'script', name: 'Writing content', data: { model: 'old', style: 'calm' } }]
  await pm.updateConfig(a.slug, { script_presets: preset } as any)
  await pm.updateConfig(a.slug, { llm_lineup: lineup, llm_lineup_presets: [{ id: 'value', name: 'Savings', data: lineup }] } as any)
  const saved = await pm.getSafeConfig(a.slug)
  assert.deepEqual(saved.llm_lineup, lineup)
  assert.deepEqual(saved.llm_lineup_presets[0].data, lineup)
  assert.deepEqual((await pm.getConfig(a.slug))!.script_presets, preset)
  assert.equal((await pm.getSafeConfig(b.slug)).llm_lineup.enabled, false)
})
