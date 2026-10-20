import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { ref, createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parse } from '@vue/compiler-sfc'

const source = readFileSync(new URL('../pages/projects/[slug]/pipeline.vue', import.meta.url), 'utf8')
const script = parse(source).descriptor.scriptSetup!.content
const ast = ts.createSourceFile('pipeline.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const names = new Set(['leftOutSteps', 'blockedEpisodes', 'hasGlobalPreflightIssue', 'closeConfirm', 'openConfirm'])
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name!.text)).map(s => s.getText(ast)).join('\n')

async function preflight(result: any) {
  const context = {
    ref, response: result,
    selectedEpisodes: new Set(['TN0001']),
    slug: ref('terranash-sleep-stories'),
    submitting: ref(false), preflighting: ref(false), repairMode: ref(false), forceRerun: ref(false),
    showConfirm: ref(false), repairActionId: ref(''), runActionId: ref(''),
    preflightSummary: ref(''), preflightBlocked: ref<any[]>([]), preflightLeftOut: ref<any[]>([]), preflightWarnings: ref<string[]>([]),
    preflightVideoEffects: ref<any>(null), preflightEligibleCount: ref(0), preflightEligibleEpisodeIds: ref<any>(null),
    batchBlocked: ref<any[]>([]), batchHasJobs: ref(false),
    checkedStepsOrdered: ref([{ id: 'script-only' }, { id: 'audio' }]),
    stepsMeta: [{ id: 'script-only', label: 'Script (chapters)' }, { id: 'audio', label: 'Audio (TTS)' }],
    presetIdsForRun: () => ({}),
  }
  const js = ts.transpileModule(`${functions}\nreturn { openConfirm }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const api = new Function('ctx', `
    const { ${Object.keys(context).join(', ')} } = ctx;
    const canRun = { value: true };
    const chatCatalog = { refresh: async () => {} }, imageCatalog = chatCatalog, mediaCatalog = chatCatalog;
    const secureOperationId = () => 'op-1';
    const showError = (m) => { throw new Error(m) }, showInfo = showError;
    const formatFileSize = () => '';
    const post = async () => response;
    let preflightRequestId = 0, submitRequestId = 0;
    ${js}
  `)(context)
  await api.openConfirm()
  return context
}

async function renderNotices(page: Awaited<ReturnType<typeof preflight>>) {
  const start = source.indexOf('<WorkspaceNotice\n        v-if="preflightLeftOut')
  const template = `<div>${source.slice(start, source.indexOf('<div class="chain-preview">', start))}</div>`
  return renderToString(createSSRApp({
    template,
    setup: () => ({ preflightLeftOut: page.preflightLeftOut, preflightWarnings: page.preflightWarnings, preflighting: page.preflighting }),
    components: { WorkspaceNotice: { props: ['title'], template: '<aside><h4>{{ title }}</h4><slot /></aside>' } },
  }))
}

test('a left-out step is shown with its reason and the ready count excludes it', async () => {
  const page = await preflight({
    steps: 2, episodes: 1, eligible_episode_ids: ['TN0001'],
    steps_left_out: [{ step: 'audio', reason: 'No voice is saved for this channel.' }],
    warnings: ['Free disk space could not be measured on this storage volume.'],
  })
  assert.match(page.preflightSummary.value, /1 episode\(s\) and 1 step\(s\) are ready\. 1 step\(s\) left out\./)
  assert.deepEqual(page.preflightLeftOut.value, [{ label: 'Audio (TTS)', reason: 'No voice is saved for this channel.' }])
  const html = await renderNotices(page)
  assert.match(html, /Left out of this run/)
  assert.match(html, /<strong>Audio \(TTS\)<\/strong> — No voice is saved for this channel\./)
  assert.match(html, /Preflight warnings/)
  assert.match(html, /Free disk space could not be measured/)
})

test('nothing left out and no warnings: the notices stay hidden and all requested steps count', async () => {
  const page = await preflight({ steps: 2, episodes: 1, eligible_episode_ids: ['TN0001'], steps_left_out: [], warnings: [] })
  assert.match(page.preflightSummary.value, /1 episode\(s\) and 2 step\(s\) are ready\.$/)
  const html = await renderNotices(page)
  assert.equal(html.includes('Left out'), false)
  assert.equal(html.includes('Preflight warnings'), false)
})
