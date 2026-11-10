import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

const frontend = fileURLToPath(new URL('../', import.meta.url))
const page = readFileSync(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url), 'utf8')
const script = page.split('<script setup lang="ts">')[1]!.split('</script>')[0]!
const ast = ts.createSourceFile('scene-plan.ts', script, ts.ScriptTarget.Latest, true)
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'updateSceneFillMode')!
assert.ok(declaration, 'exercise the real page handler')
const handler = ts.transpileModule(declaration.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText

function fillHarness(post: (...args: any[]) => Promise<unknown>) {
  const episodeId = { value: 'EP0001' }
  const errors: string[] = []
  const update = new Function('episodeId', 'slug', 'post', 'showError', `${handler}; return updateSceneFillMode`)(
    episodeId, { value: 'demo' }, post, (message: string) => errors.push(message),
  )
  return { update, errors, episodeId }
}

test('video capability alias resolves semantically from both actual frontend consumers', () => {
  const config = ts.readConfigFile(path.join(frontend, 'tsconfig.json'), ts.sys.readFile)
  assert.equal(config.error, undefined)
  // Check the project's declared aliases without requiring generated Nuxt build output.
  const { extends: generatedNuxtConfig, ...declaredConfig } = config.config
  const parsed = ts.parseJsonConfigFileContent({ ...declaredConfig, files: [], include: [] }, ts.sys, frontend)
  const options: ts.CompilerOptions = {
    ...parsed.options, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022, strict: true, noEmit: true, skipLibCheck: true, types: [],
  }
  const target = path.resolve(frontend, '../electron/server/contracts/video-capabilities.ts')
  for (const consumer of ['pages/projects/[slug]/motion-review.vue', 'composables/useGenStudioMediaModels.ts']) {
    const resolved = ts.resolveModuleName('@shared/video-capabilities', path.join(frontend, consumer), options, ts.sys)
    assert.equal(resolved.resolvedModule?.resolvedFileName, target)
  }
  const probe = path.join(frontend, '__video_capability_semantic_probe__.ts')
  const probeSource = `import { videoCapabilityRefusal, type PublishedVideoCapabilities } from '@shared/video-capabilities';
    const row: PublishedVideoCapabilities = { duration_seconds: { min: 4, max: 4, step: 1 }, output_counts: [1] };
    const reason: string = videoCapabilityRefusal(row);`
  const host = ts.createCompilerHost(options)
  const read = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => file === probe
    ? ts.createSourceFile(probe, probeSource, languageVersion, true)
    : read(file, languageVersion, onError, shouldCreateNewSourceFile)
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([probe], options, host))
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [])
})

test('Scene Plan disables chaining and refuses a forced chain choice without local changes or requests', async () => {
  assert.match(page, /<option value="chain" disabled>Chain clips — unavailable<\/option>/)
  const h = fillHarness(async () => assert.fail('unavailable chaining must not submit'))
  const scene = { id: 'scene-1', fill_mode: 'hold' }
  const select = { value: 'chain' }
  await h.update(scene, select)
  assert.equal(scene.fill_mode, 'hold')
  assert.equal(select.value, 'hold')
  assert.match(h.errors[0]!, /chaining is unavailable/)
})

test('Scene Plan preserves historical fill mode while saving and after refusal; only accepted hold changes it', async () => {
  let reject!: (error: Error) => void
  const h = fillHarness(() => new Promise((_resolve, fail) => { reject = fail }))
  const scene = { id: 'scene-1', fill_mode: 'chain' }
  const select = { value: 'hold' }
  const pending = h.update(scene, select)
  assert.equal(scene.fill_mode, 'chain', 'no optimistic rewrite of an existing plan')
  assert.equal(select.value, 'chain', 'the select continues to show saved state')
  reject(new Error('Saved plan is busy'))
  await pending
  assert.equal(scene.fill_mode, 'chain')
  assert.equal(select.value, 'chain')
  assert.deepEqual(h.errors, ['Saved plan is busy'])
  const accepted: any[] = []
  const ready = fillHarness(async (...args) => { accepted.push(args) })
  select.value = 'hold'
  await ready.update(scene, select)
  assert.equal(scene.fill_mode, 'hold')
  assert.equal(select.value, 'hold')
  assert.deepEqual(accepted[0], ['/projects/demo/scene-plan/EP0001/set-fill-mode', { scene_id: 'scene-1', fill_mode: 'hold' }])

  let complete!: () => void
  const switched = fillHarness(() => new Promise<void>(resolve => { complete = resolve }))
  const previousScene = { id: 'scene-1', fill_mode: 'chain' }
  select.value = 'hold'
  const oldRequest = switched.update(previousScene, select)
  switched.episodeId.value = 'EP0002'
  select.value = 'new episode state'
  complete()
  await oldRequest
  assert.equal(previousScene.fill_mode, 'chain')
  assert.equal(select.value, 'new episode state', 'an old save does not write into the new episode’s control')
})
