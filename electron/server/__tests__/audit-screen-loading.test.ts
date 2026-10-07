import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { test } from 'node:test'
import ts from 'typescript'
import { mapWithConcurrency } from '../lib/map-with-concurrency.js'

// Exact production functions, with filesystem/network/process boundaries replaced only.
function source(file: string) {
  let text = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
  if (file.endsWith('.vue')) text = text.split(/<script setup[^>]*>/)[1]!.split('</script>')[0]!
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
}
function fn(file: string, name: string) {
  const text = source(file)
  const node = text.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name)!
  assert.ok(node, name)
  return node.getText(text).replace(/^export\s+/, '')
}
function runtime(code: string, context: Record<string, any>) {
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText, context)
  return context
}
const flush = () => new Promise<void>(r => setImmediate(r))
const assembly = 'frontend/pages/projects/[slug]/video-assembly.vue'
function pathsRuntime(post: any, portable = false) {
  const value = portable ? '${CHANNEL}/assets/a.mp4' : '/old/a.mp4'
  const context = runtime(`let videoEpisodeSequence = 1; let pathNormalizationSequence = 0;
    ${fn(assembly, 'collapseToPortablePath')}
    ${fn(assembly, 'normalizeVideoAssemblyPathsInState')}`, {
    post, mapWithConcurrency, slug: { value: 'p' }, episodeId: { value: 'A' }, episodesRoot: { value: '/episodes' },
    intro: { video_path: value }, outro: { video_path: value }, titleImage: { image_path: value }, logo: { image_path: value },
    chromaKey: { source_path: value }, frame: { background_path: value }, titleCard: { background_media_path: value },
    outroCard: { background_media_path: value }, compilationLayout: { backgroundPlate: { source_path: value } },
    timelineClips: { value: [{ video_path: value, image_path: value }] },
  })
  return context
}
test('portable normalization makes zero requests; adoption still validates through the backend', async () => {
  let calls = 0
  const c = pathsRuntime(async () => { calls++; return { output: '${CHANNEL}/adopted' } }, true)
  await c.normalizeVideoAssemblyPathsInState()
  assert.equal(calls, 0)
  for (const token of ['CHANNEL', 'PROJECT', 'ASSET']) assert.equal(await c.collapseToPortablePath('${' + token + '}/a'), '${' + token + '}/a')
  await c.collapseToPortablePath('${CHANNEL}/a', true)
  assert.equal(calls, 1)
})
test('independent path normalizations overlap within a bound and reject episode/edit/older-run results', async () => {
  const pending: Array<(value: any) => void> = []
  let active = 0, peak = 0
  const c = pathsRuntime(() => { active++; peak = Math.max(peak, active); return new Promise(r => pending.push(v => { active--; r(v) })) })
  const run = c.normalizeVideoAssemblyPathsInState()
  await flush()
  const started = pending.length
  c.intro.video_path = '/new/edited.mp4'
  while (pending.length) { pending.splice(0).forEach(r => r({ output: '${CHANNEL}/resolved' })); await flush() }
  await run
  assert.ok(started > 1, 'independent requests must overlap')
  assert.ok(peak <= 4, 'at most four path requests')
  assert.equal(c.intro.video_path, '/new/edited.mp4', 'user edit wins')
  const old = c.normalizeVideoAssemblyPathsInState()
  await flush()
  c.episodeId.value = 'B'
  c.intro.video_path = '/B/file.mp4'
  while (pending.length) { pending.splice(0).forEach(r => r({ output: 'old' })); await flush() }
  await old
  assert.equal(c.intro.video_path, '/B/file.mp4')
  const older = c.normalizeVideoAssemblyPathsInState(); await flush()
  const newer = c.normalizeVideoAssemblyPathsInState(); await flush()
  const complete = pending.splice(0)
  complete[1]!({ output: '${CHANNEL}/latest' }); await newer
  complete[0]!({ output: 'old' }); await older
  assert.equal(c.intro.video_path, '${CHANNEL}/latest', 'newer normalization revision wins')
})
test('cold same-file probes coalesce, changed identity probes separately and failures retry', async () => {
  let size = 1, calls = 0
  const pending: Array<(n: number | undefined) => void> = []
  const c = runtime(`const DURATION_CACHE = new Map(); const DURATION_INFLIGHT = new Map(); const DURATION_CACHE_MAX = 5000;
    ${fn('electron/server/lib/ffmpeg-utils.ts', 'getAudioDuration')}`, {
    fsStat: async () => ({ isFile: () => true, size, mtimeMs: size }),
    probeAudioDuration: () => { calls++; return new Promise(r => pending.push(r)) },
  })
  const a = c.getAudioDuration('/a'), b = c.getAudioDuration('/a')
  await flush(); const firstCalls = calls
  size++
  const changed = c.getAudioDuration('/a'); await flush()
  pending.splice(0).forEach(r => r(42)); await Promise.all([a, b, changed])
  assert.equal(firstCalls, 1)
  assert.equal(calls, 2)
  await c.getAudioDuration('/a'); assert.equal(calls, 2)
  size++
  const failed = c.getAudioDuration('/a'); await flush(); pending.shift()!(undefined); await failed
  const retry = c.getAudioDuration('/a'); await flush(); pending.shift()!(21)
  assert.equal(await retry, 21); assert.equal(calls, 4)
})
test('cold chapter metadata probes overlap within a bound while preserving section results', async () => {
  const s = source('electron/server/generators/video.ts')
  let branch: ts.IfStatement | undefined
  const visit = (n: ts.Node) => { if (ts.isIfStatement(n) && n.expression.getText(s) === 'audioDir' && n.getText(s).includes('fullNarrationPath')) branch = n; ts.forEachChild(n, visit) }
  visit(s); assert.ok(branch)
  let active = 0, peak = 0
  const pending: Array<() => void> = []
  const c = runtime(`async function scan() { ${branch!.getText(s)} }`, {
    audioDir: '/audio', path, mapWithConcurrency, isMergedFilename: () => false,
    safeReaddir: async () => Array.from({ length: 7 }, (_, i) => `EP_Chapter_${i}.mp3`),
    result: { merged_audio: [], audio_sections: [] },
    getAudioDuration: () => { active++; peak = Math.max(peak, active); return new Promise(r => pending.push(() => { active--; r(12) })) },
  })
  const run = c.scan(); await flush(); const started = active
  while (pending.length) { pending.splice(0).forEach(r => r()); await flush() }
  await run
  assert.ok(started > 1); assert.ok(peak <= 4)
  assert.equal(c.result.audio_sections.length, 7)
  assert.equal(c.result.audio_sections[6].filename, 'EP_Chapter_6.mp3')
})
test('boot health fetch has a remaining-budget signal and releases the shared gate after a stall', async () => {
  let now = 0, requestSignal: AbortSignal | undefined, healthCalls = 0
  const timers: Array<() => void> = []
  const c = runtime(`let _bootReadyPromise = null; const BOOT_READY_TIMEOUT_MS = 15000; const BOOT_READY_POLL_MS = 250;
    ${fn('frontend/composables/useApi.ts', 'waitForBootReady')}`, {
    Date: { now: () => now }, AbortController, console: { warn: () => {} },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length }, clearTimeout: () => {},
    $fetch: (_: string, options: any = {}) => { healthCalls++; requestSignal = options.signal; return new Promise(() => {}) },
  })
  const a = c.waitForBootReady(); assert.equal(a, c.waitForBootReady()); await flush()
  now = 15000; timers.splice(0).forEach(r => r()); await flush()
  assert.ok(requestSignal?.aborted, 'stalled request must abort at the boot ceiling')
  await a; assert.equal(healthCalls, 1)
})
