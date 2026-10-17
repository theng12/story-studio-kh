/**
 * The LLM lineup is retired (owner, 2026-10-03): each writing step uses ONE
 * writing model, and falling back across several models is a Gateway pool.
 * Pools are listed first in every writing-model picker, and the Pipeline page
 * says once what was kept for a project that had a lineup.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { computed, ref } from 'vue'
import { isGatewayPoolId, poolsFirst, POOL_GROUP_LABEL, POOL_HINT } from '../utils/gateway-pool.js'
import { groupMenuOptions } from '../utils/genstudio-relaxed-queue.js'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const pipeline = read('../pages/projects/[slug]/pipeline.vue')
const selector = read('../components/ModelSelector.vue')

test('writing-model pickers list pools first, each keeping the catalogue order', () => {
  const rows = [{ id: 'gemini-a' }, { id: 'pool::gemini-free-all' }, { id: 'qwen' }, { id: 'pool::local' }]
  assert.deepEqual(poolsFirst(rows).map(row => row.id), ['pool::gemini-free-all', 'pool::local', 'gemini-a', 'qwen'])
  assert.equal(isGatewayPoolId('pool::x'), true)
  assert.equal(isGatewayPoolId('gemini-pool'), false)

  // The picker's own sectioning keeps that order and carries the short hint.
  const sections = groupMenuOptions(poolsFirst(rows).map(row => ({
    id: row.id,
    label: row.id,
    group: isGatewayPoolId(row.id) ? POOL_GROUP_LABEL : 'Language models',
    groupNote: isGatewayPoolId(row.id) ? POOL_HINT : '',
  })))
  assert.deepEqual(sections.map(section => section.label), [POOL_GROUP_LABEL, 'Language models'])
  assert.equal(sections[0]!.note, 'Pool — tries several models')
})

test('ModelSelector builds its rows pools-first and labels the pool section with the hint', () => {
  assert.match(selector, /const rows = poolsFirst\(eligibleModels\)\.map/)
  assert.match(selector, /group: pool \? POOL_GROUP_LABEL : queueClassGroupLabel\(model, 'Language models'\)/)
  assert.match(selector, /groupNote: pool \? POOL_HINT :/)
})

test('an empty writing page gets the model kept from the retired lineup, and only then', () => {
  const fill = selector.slice(selector.indexOf('async function fillRetiredLineupChoice'), selector.indexOf('async function identifyEmptyCatalog'))
  assert.match(fill, /if \(!props\.writingStep \|\| props\.modelValue\.trim\(\)\) return/)
  assert.match(fill, /llm_lineup_migration\?\.model/)
  assert.match(fill, /applyModel\(kept\)/, 'the kept model still has to be usable in the live catalogue')
  assert.match(selector, /function applyModel\(value: string, userSelected = false\): void \{\s*const model = allModels\.value\.find/)
  assert.match(selector, /if \(!model \|\| isDisabled\(model\)\) return/)
  for (const page of ['ideas', 'research', 'scripts', 'metadata', 'image-prompts', 'scene-plan', 'contextual-cues']) {
    const source = read(`../pages/projects/[slug]/${page}.vue`)
    assert.doesNotMatch(source, /InheritedLlmLineupNotice|llm_lineup\b|lineup-model-readonly/, `${page} has no lineup left`)
    assert.match(source, /<ModelSelector[^>]*\bwriting-step\b/, `${page}'s writing picker takes the kept model when empty`)
  }
})

function loadNotice(record: Record<string, unknown> | undefined) {
  const start = pipeline.indexOf("// The retired LLM lineup's one-time notice")
  const end = pipeline.indexOf('// Tri-state (E-03)', start)
  assert.ok(start >= 0 && end > start, 'the lineup notice must remain a self-contained block')
  const posted: string[] = []
  const js = ts.transpileModule(`${pipeline.slice(start, end)}\nreturn { lineupNotice, dismissLineupNotice }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  const page = new Function('ref', 'computed', 'watch', 'config', 'slug', 'post', 'useGenStudioModelDisplay', 'useGenStudioChatModels', js)(
    ref, computed, () => undefined, ref({ llm_lineup_migration: record }), ref('kh-boundless'),
    async (url: string) => { posted.push(url) },
    () => ({ hydrate() {}, knownName: () => '' }),
    () => ({ refresh: async () => undefined, find: (id: string) => (id === 'pool::gemini-free-all' ? { display_name: 'Gemini free (all)' } : undefined) }),
  ) as { lineupNotice: { value: { model: string; steps: string[] } | null }; dismissLineupNotice: () => Promise<void> }
  return { page, posted }
}

test('the Pipeline notice says what was kept, once, until it is closed', async () => {
  const { page, posted } = loadNotice({ model: 'pool::gemini-free-all', pool: true, steps: ['Research', 'Scene Plan'] })
  assert.deepEqual(page.lineupNotice.value, { model: 'Gemini free (all)', steps: ['Research', 'Scene Plan'] })
  assert.match(pipeline, /title="The LLM lineup is gone"/)
  assert.match(pipeline, /Each step now uses one writing model\. We kept “\{\{ lineupNotice\.model \}\}”/)
  assert.match(pipeline, /make a pool in GatewayKH → Providers → Pools and pick it here\./)

  await page.dismissLineupNotice()
  assert.equal(page.lineupNotice.value, null)
  assert.deepEqual(posted, ['/projects/kh-boundless/settings/llm-lineup-notice/dismiss'])

  assert.equal(loadNotice({ model: 'gemini-a', steps: [], notice_dismissed_at: '2026-10-03T00:00:00Z' }).page.lineupNotice.value, null)
  assert.equal(loadNotice(undefined).page.lineupNotice.value, null, 'no lineup, no notice')
  assert.deepEqual(loadNotice({ model: 'gemini-a', steps: [] }).page.lineupNotice.value, { model: 'gemini-a', steps: [] })
})

test('no lineup editor, preset group or queue wording is left anywhere in the app', () => {
  assert.doesNotMatch(pipeline, /LlmLineupEditor/)
  assert.doesNotMatch(read('../pages/projects/[slug]/presets.vue'), /llm_lineup|LLM Lineup/)
  assert.doesNotMatch(read('../composables/usePresets.ts'), /llm-lineup/)
  assert.doesNotMatch(read('../pages/projects/[slug]/jobs.vue'), /llm_lineup/)
})
