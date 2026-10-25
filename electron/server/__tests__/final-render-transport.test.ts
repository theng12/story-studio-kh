import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import ts from 'typescript'

import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import type { Job } from '../models/types.js'
import { setGenStudioUrl, setPrivateFinalRenderSetting } from '../services/app-settings.js'
import { appSecretsPath } from '../services/app-secrets-store.js'
import {
  preparePrivateFinalRenderDescriptor,
} from '../services/final-render-transport.js'
import { getOrCreatePrivateRenderIdentity, pinGatewayBinding } from '../services/private-render-identity.js'
import { installTestSafeStorage, setTestSafeStorageAvailable } from './safe-storage-test-double.js'
import '../../../scripts/testing/loopback-supertest.mjs'

installTestSafeStorage()

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VIDEO_SOURCE = path.resolve(HERE, '../generators/video.ts')
const ORIGIN = 'https://gateway.private.example'
const OWNER_SCOPE = '11111111-1111-4111-8111-111111111111'
const GATEWAY_ID = '22222222-2222-4222-8222-222222222222'
const BEARER = 'ab'.repeat(32)
const BASE_BYTES = Buffer.from('fresh private final video input\n')
const AUDIO_BYTES = Buffer.from('fresh private final audio input\n')
const originalFetch = globalThis.fetch
const previousEnvironment = new Map(
  ['STORY_STUDIO_DATA_DIR', 'TMPDIR', 'TMP', 'TEMP'].map(key => [key, process.env[key]]),
)

let retainedRoot = ''
let storyInstanceId = ''
let queue: typeof import('../services/job-queue.js')
let fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
const trackedJobIds = new Set<string>()

function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(Object.keys(entry as Record<string, unknown>)
        .sort()
        .map(key => [key, sort((entry as Record<string, unknown>)[key])]))
    }
    return entry
  }
  return JSON.stringify(sort(value))
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

const TOOLS_UTF8 = canonicalJson({
  format: 'studio.render.tools.v1', platform: 'macos-arm64',
  ffmpeg_sha256: '1'.repeat(64), ffmpeg_size_bytes: 132_141_880,
  ffprobe_sha256: '2'.repeat(64), ffprobe_size_bytes: 131_770_248,
  architecture_evidence_sha256: '3'.repeat(64),
  minimum_os_evidence_sha256: '4'.repeat(64),
  linked_libraries_evidence_sha256: '5'.repeat(64),
  build_configuration_evidence_sha256: '6'.repeat(64),
  capability_inventory_evidence_sha256: '7'.repeat(64),
})
const COMPILER_UTF8 = canonicalJson({
  format: 'studio.render.compiler.v1', implementation: 'hub-final-render-v1',
  python_runtime_sha256: '8'.repeat(64), render_hash_sha256: '9'.repeat(64),
  render_contract_sha256: 'b'.repeat(64), final_render_compiler_sha256: 'c'.repeat(64),
})
const TOOLS_DIGEST = sha256(TOOLS_UTF8)
const COMPILER_DIGEST = sha256(COMPILER_UTF8)
const PROFILE_UTF8 = canonicalJson({
  format: 'studio.render.profile.v1', implementation: 'story-classic-no-font-v1',
  recipe_namespace: 'studio.render.final.v1', compiler_artifact_sha256: COMPILER_DIGEST,
  tools_artifact_sha256: TOOLS_DIGEST,
  combination_set: 'retained-classic-no-font-candidate-v1',
  tier_policy: 'story-final-chain-v1', output_policy: 'story-final-output-v1',
  execution_bounds: {
    canvas_pairs: [{ width: 128, height: 96 }], working_fps: [5],
    max_duration_sec: 60, max_operations: 32, max_assets: 32,
    max_asset_bytes: 1024 * 1024, max_total_input_bytes: 2 * 1024 * 1024,
    max_pixel_frames: 128 * 96 * 5 * 60, scratch_reserve_bytes: 1,
    output_limit_bytes: 1024 * 1024, process_tree_rss_limit_bytes: 1024 * 1024,
    cumulative_wall_seconds: 60,
  },
  hardware_qualification_record_sha256: null, fidelity_record_sha256: null,
  production_eligible: false,
})
const PROFILE_DIGEST = sha256(PROFILE_UTF8)
const DESCRIPTOR_PROVENANCE = {
  format: 'studio.render.story-build-provenance.v1', mode: 'descriptor-only',
  descriptors: { profile_digest: PROFILE_DIGEST, tools_digest: TOOLS_DIGEST, compiler_digest: COMPILER_DIGEST },
  qualification: null,
}
const require = createRequire(import.meta.url)
let restoreElectron: (() => void) | undefined

async function installPackagedDescriptorFixture(): Promise<void> {
  const resourcesPath = path.join(retainedRoot, 'packaged-resources')
  const appPath = path.join(resourcesPath, 'app.asar')
  await fs.mkdir(appPath, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify({
    name: 'story-studio-kh', main: 'electron/dist/main.js', type: 'module', storyRenderProvenance: DESCRIPTOR_PROVENANCE,
  }), { mode: 0o600 })
  const electronPath = require.resolve('electron')
  const cache = require.cache as Record<string, any>
  const previous = cache[electronPath]
  const previousResources = process.resourcesPath
  cache[electronPath] = { exports: { ...previous?.exports, app: { isPackaged: true, getAppPath: () => appPath } } }
  ;(process as { resourcesPath?: string }).resourcesPath = resourcesPath
  restoreElectron = () => {
    if (previous === undefined) delete cache[electronPath]
    else cache[electronPath] = previous
    ;(process as { resourcesPath?: string }).resourcesPath = previousResources
  }
}

function capabilities(): FinalRenderCapabilities {
  return {
    format: 'studio.render.gateway-capabilities.v1', private: true, chargeable: false,
    owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID,
    story_instance_id: storyInstanceId, eligible: 0, idle: 0,
    server_time: Math.floor(Date.now() / 1000),
    profile_descriptor_utf8: PROFILE_UTF8, profile_digest: PROFILE_DIGEST,
    tools: { descriptor_utf8: TOOLS_UTF8, digest: TOOLS_DIGEST },
    compiler: { descriptor_utf8: COMPILER_UTF8, digest: COMPILER_DIGEST },
  }
}

async function settle(): Promise<void> {
  if (!queue) return
  for (let turn = 0; turn < 2_000; turn++) {
    if ([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id))) break
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  assert.ok([...trackedJobIds].every(id => !queue._isJobWorkerActiveForTesting(id)), 'all physical workers settle')
  await queue._waitForJobPersistenceForTesting()
}

before(async () => {
  const harnessRoot = process.env.STORY_STUDIO_TEST_HARNESS_ROOT
  assert.ok(harnessRoot, 'run through scripts/testing/run-backend-tests.mjs so the retained root is isolated')
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) {
    assert.equal(path.resolve(process.env[key] || ''), path.resolve(harnessRoot), `${key} remains bound to the retained harness root`)
  }
  retainedRoot = await fs.mkdtemp(path.join(harnessRoot, 'final-render-transport-retained-'))
  await fs.chmod(retainedRoot, 0o700)
  process.env.STORY_STUDIO_DATA_DIR = retainedRoot
  await installPackagedDescriptorFixture()
  setTestSafeStorageAvailable(true)
  queue = await import('../services/job-queue.js')

  await setGenStudioUrl(ORIGIN)
  const identity = await getOrCreatePrivateRenderIdentity()
  storyInstanceId = identity.story_instance_id
  await (await import('../services/app-secrets-store.js')).setApiKey('genstudio', BEARER)
  await pinGatewayBinding({ origin: ORIGIN, owner_scope: OWNER_SCOPE, gateway_instance_id: GATEWAY_ID })
  await setPrivateFinalRenderSetting({ enabled: false })
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), method: init.method ?? 'GET', body: init.body }
    fetchCalls.push(call)
    assert.equal(call.url, `${ORIGIN}/v1/final-renders/capabilities`)
    assert.equal(call.method, 'GET')
    assert.equal(call.body, undefined)
    assert.equal(new Headers(init.headers).get('Authorization'), `Bearer ${BEARER}`)
    return Response.json(capabilities())
  }
})

after(async () => {
  try {
    await settle()
  } finally {
    globalThis.fetch = originalFetch
    restoreElectron?.()
    setTestSafeStorageAvailable(true)
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

function makeJob(slug: string, id: string, marker?: unknown): Job {
  const value: Job = {
    job_id: id, project_slug: slug, type: 'video_assembly', episode_id: 'EP1',
    title: 'Private final render', status: 'running',
    created_at: '2026-10-15T00:00:00.000Z', started_at: '2026-10-15T00:00:00.000Z',
    finished_at: null, error: null, output_lines: [], params: { retained: true },
  }
  if (arguments.length >= 3) value.final_render_remote_wait = marker as any
  trackedJobIds.add(id)
  return value
}

async function writeJob(value: Job): Promise<void> {
  const projectDir = path.join(retainedRoot, 'projects', value.project_slug)
  await fs.mkdir(projectDir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(projectDir, 'jobs.json'), JSON.stringify({ jobs: [value] }), { mode: 0o600 })
  queue._forgetProjectPersistenceForTesting(value.project_slug)
}

type PreparedCase = {
  job: Job
  composition: CompositionOpts & { code: string; titleHint: string; videoDir: string }
  sourceDir: string
  videoDir: string
}

async function prepareCase(label: string, marker?: unknown): Promise<PreparedCase> {
  const slug = `transport-${label}-${process.pid}`
  const sourceDir = path.join(retainedRoot, 'work', slug, 'sources')
  const videoDir = path.join(retainedRoot, 'work', slug, 'project-video')
  await fs.mkdir(sourceDir, { recursive: true, mode: 0o700 })
  await fs.mkdir(videoDir, { recursive: true, mode: 0o700 })
  const base = path.join(sourceDir, 'base.mp4')
  const audio = path.join(sourceDir, 'audio.wav')
  await fs.writeFile(base, BASE_BYTES, { mode: 0o600 })
  await fs.writeFile(audio, AUDIO_BYTES, { mode: 0o600 })
  const id = `55555555-5555-4555-8555-${trackedJobIds.size.toString().padStart(12, '0')}`
  const job = arguments.length >= 2 ? makeJob(slug, id, marker) : makeJob(slug, id)
  await writeJob(job)
  const composition = {
    videoInputPath: base,
    premixedAudioPath: audio,
    targetDuration: 2,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: path.join(sourceDir, 'must-never-be-locally-rendered.mp4'),
    encodingEffort: 'ultrafast',
    codec: 'h264',
    code: 'EP1',
    titleHint: `Title ${label}`,
    videoDir,
    job,
    resolvedLoudness: { lufs: -14, true_peak_db: -1, tolerance_pct: 5, check: 'warn' },
  } satisfies CompositionOpts & { code: string; titleHint: string; videoDir: string }
  return {
    job,
    composition,
    sourceDir,
    videoDir,
  }
}

async function prepare(value: PreparedCase) {
  return preparePrivateFinalRenderDescriptor(value.composition)
}

test('default-off and unsupported compositions stay local before any durable intent', async () => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: false })
  const disabled = await prepareCase('disabled')
  assert.equal(await prepare(disabled), null)
  assert.deepEqual(fetchCalls, [], 'default-off does not discover private capabilities')
  assert.equal(disabled.job.final_render_remote_wait, undefined)
  // A local render says why it is local, the switch being off included (AGENTS §7).
  assert.match(disabled.composition.job.output_lines.join('\n'), /^Private final render: off .*stays on this Mac/m)

  await setPrivateFinalRenderSetting({ enabled: true })
  const unsupported = await prepareCase('unsupported')
  unsupported.composition.subtitles = { enabled: true } as any
  assert.equal(await prepare(unsupported), null)
  assert.equal(fetchCalls.length, 1, 'unsupported composition may read the paired capability but creates no intent')
  assert.equal(unsupported.job.final_render_remote_wait, undefined)
  await assert.rejects(fs.stat(path.join(retainedRoot, 'private-render', 'intents')), /ENOENT/)
})

test('zero-capacity paired capability GET stages immutable copies and exact canonical V2 readback', async () => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('prepare')
  assert.deepEqual(await prepare(value), { kind: 'video-assembly-remote-wait' })
  assert.equal(fetchCalls.length, 1)

  const canonical = await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id)
  const receipt = canonical?.final_render_remote_wait as any
  assert.deepEqual(receipt && { version: receipt.version, phase: receipt.phase, revision: receipt.revision, job_id: receipt.job_id }, {
    version: 2, phase: 'intent_staged', revision: 1, job_id: value.job.job_id,
  })
  const manifestPath = path.join(retainedRoot, 'private-render', 'intents', receipt.intent_id, 'manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.deepEqual(manifest.scope, {
    origin: ORIGIN, owner_scope: OWNER_SCOPE,
    gateway_instance_id: GATEWAY_ID, story_instance_id: storyInstanceId,
  })
  assert.deepEqual(manifest.destination.route, {
    code: 'EP1', title: 'Title prepare', format: 'mp4', external: false,
  })
  assert.equal(manifest.destination.pathname, path.join(await fs.realpath(value.videoDir), 'EP1_final_video.mp4'))
  assert.deepEqual(manifest.descriptors, {
    profile: { utf8: PROFILE_UTF8, sha256: PROFILE_DIGEST },
    tools: { utf8: TOOLS_UTF8, sha256: TOOLS_DIGEST },
    compiler: { utf8: COMPILER_UTF8, sha256: COMPILER_DIGEST },
  })
  assert.deepEqual(await fs.readFile(path.join(path.dirname(manifestPath), 'base.mp4')), BASE_BYTES)
  assert.deepEqual(await fs.readFile(path.join(path.dirname(manifestPath), 'audio.wav')), AUDIO_BYTES)
  await fs.writeFile(value.composition.videoInputPath, 'later live source mutation\n')
  assert.deepEqual(await fs.readFile(path.join(path.dirname(manifestPath), 'base.mp4')), BASE_BYTES,
    'the staged copy is immutable with respect to later live-source changes')
})

test('shared final composition holds before local encoding and both real callers pass authoritative destination facts', async () => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('shared')
  const { _runFinalCompositionForTesting } = await import('../generators/video.js')
  const result = await _runFinalCompositionForTesting(value.composition)
  assert.deepEqual(result, { kind: 'video-assembly-remote-wait' })
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/,
    'the shared seam returns before any local final composition output exists')
  assert.equal(fetchCalls.length, 1)

  const text = await fs.readFile(VIDEO_SOURCE, 'utf8')
  const source = ts.createSourceFile(VIDEO_SOURCE, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const calls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runFinalComposition') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.equal(calls.length, 2, 'the compilation and ordinary callers remain the only shared callers')
  for (const call of calls) {
    const argument = call.arguments[0]
    assert.ok(argument && ts.isObjectLiteralExpression(argument))
    const fields = new Set(argument.properties.flatMap(property => {
      if (ts.isShorthandPropertyAssignment(property)) return [property.name.text]
      if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) return [property.name.text]
      return []
    }))
    assert.equal(fields.has('code'), true)
    assert.equal(fields.has('titleHint'), true)
    assert.equal(fields.has('videoDir'), true)
  }
})

test('a pending canonical commit is retried on its one retained lineage and never falls back locally', async t => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('pending')
  const intentRoot = path.join(retainedRoot, 'private-render', 'intents')
  const before = new Set(await fs.readdir(intentRoot))
  let refuse = true
  const restore = queue._setJobFileLockProbeForTesting(operation => {
    if (operation === 'persist' && refuse) {
      refuse = false
      throw new Error('controlled canonical commit refusal')
    }
  })
  t.after(restore)
  const { _runFinalCompositionForTesting } = await import('../generators/video.js')
  const input = value.composition
  await assert.rejects(_runFinalCompositionForTesting(input), /safety|commit|render/i)
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
  const retained = (await fs.readdir(intentRoot)).filter(entry => !before.has(entry))
  assert.equal(retained.length, 1)
  restore()

  assert.deepEqual(await _runFinalCompositionForTesting(input), { kind: 'video-assembly-remote-wait' })
  assert.deepEqual((await fs.readdir(intentRoot)).filter(entry => !before.has(entry)), retained,
    'retry recommits the same retained private intent')
  const canonical = await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id)
  assert.equal((canonical?.final_render_remote_wait as any)?.intent_id, retained[0])
})

test('disabled preparation blocks a real pending canonical write without losing or claiming its lineage', async t => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('disabled-pending')
  let refuse = true
  const restore = queue._setJobFileLockProbeForTesting(operation => {
    if (operation === 'persist' && refuse) {
      refuse = false
      throw new Error('controlled disabled-pending canonical refusal')
    }
  })
  t.after(restore)
  await assert.rejects(prepare(value), /safety|commit|render/i)
  restore()
  const pending = await queue.loadKnownFinalRenderIntentStagedReceipt(value.job.project_slug, value.job.job_id)
  assert.ok(pending, 'the exact pending transition remains queue-owned')

  await setPrivateFinalRenderSetting({ enabled: false })
  fetchCalls = []
  await assert.rejects(prepare(value), /recovery|blocked|local/i)
  assert.deepEqual(await queue.loadKnownFinalRenderIntentStagedReceipt(value.job.project_slug, value.job.job_id), pending)
  assert.deepEqual(fetchCalls, [], 'disabled pending recovery performs no capability call')
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
})

test('disabled preparation blocks a committed receipt whose private manifest was retained away', async () => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('disabled-missing-manifest')
  assert.deepEqual(await prepare(value), { kind: 'video-assembly-remote-wait' })
  const canonical = await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id)
  const receipt = canonical?.final_render_remote_wait as any
  assert.ok(receipt?.intent_id)
  const intentDir = path.join(retainedRoot, 'private-render', 'intents', receipt.intent_id)
  const manifest = path.join(intentDir, 'manifest.json')
  const retainedManifest = path.join(intentDir, 'manifest.retained-missing')
  const manifestBytes = await fs.readFile(manifest)
  await fs.writeFile(retainedManifest, manifestBytes, { flag: 'wx', mode: 0o600 })
  assert.deepEqual(await fs.readFile(retainedManifest), manifestBytes,
    'retained manifest copy must be byte-identical before removing the canonical name')
  await fs.unlink(manifest)

  await setPrivateFinalRenderSetting({ enabled: false })
  fetchCalls = []
  await assert.rejects(
    preparePrivateFinalRenderDescriptor({ ...value.composition, job: canonical! }),
    /recovery|blocked|local/i,
  )
  assert.deepEqual((await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id))?.final_render_remote_wait, receipt)
  assert.deepEqual(await fs.readFile(retainedManifest), manifestBytes, 'retained manifest evidence remains byte-identical')
  await assert.rejects(fs.stat(manifest), /ENOENT/)
  assert.deepEqual(fetchCalls, [], 'disabled missing-snapshot recovery performs no capability call')
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
})

test('existing and malformed intent evidence blocks disabled or revoked preparation without local fallback', async () => {
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const existing = await prepareCase('existing')
  assert.deepEqual(await prepare(existing), { kind: 'video-assembly-remote-wait' })
  const canonical = await queue.loadAuthoritativeJob(existing.job.project_slug, existing.job.job_id)
  assert.ok(canonical?.final_render_remote_wait)
  const marker = structuredClone(canonical.final_render_remote_wait)

  await setPrivateFinalRenderSetting({ enabled: false })
  const secrets = appSecretsPath()
  const retainedSecrets = `${secrets}.retained-revoked`
  await fs.rename(secrets, retainedSecrets)
  try {
    fetchCalls = []
    await assert.rejects(
      preparePrivateFinalRenderDescriptor({ ...existing.composition, job: canonical! }),
      /recovery|blocked|local/i,
    )
    assert.deepEqual(
      (await queue.loadAuthoritativeJob(existing.job.project_slug, existing.job.job_id))?.final_render_remote_wait,
      marker,
    )
    assert.deepEqual(fetchCalls, [], 'known durable lineage is held before setting or access discovery')
    await assert.rejects(fs.stat(existing.composition.outputFile), /ENOENT/)
  } finally {
    await fs.rename(retainedSecrets, secrets)
  }

  const malformed = await prepareCase('malformed', { version: 2, phase: 'intent_staged', corrupt: true })
  fetchCalls = []
  await assert.rejects(prepare(malformed), /recovery|lineage|intent|render/i)
  assert.deepEqual(fetchCalls, [], 'malformed marker presence fails closed before capability discovery')
  await assert.rejects(fs.stat(malformed.composition.outputFile), /ENOENT/)
})

/** A real fresh process gives each installed-reader singleton exactly one bundle. */
async function isolatedBuildPrepare(value: PreparedCase, mode: string, qualification?: unknown): Promise<any> {
  const fixture = path.join(retainedRoot, 'build-cases', `${mode}-${trackedJobIds.size}-${Date.now()}`)
  await fs.mkdir(fixture, { recursive: true, mode: 0o700 })
  const provenance = mode === 'legacy' ? undefined : mode === 'tool-only' ? {
    ...DESCRIPTOR_PROVENANCE, mode, descriptors: null,
  } : mode === 'sealed-candidate' ? {
    ...DESCRIPTOR_PROVENANCE, mode, qualification,
  } : mode === 'invalid' ? { ...DESCRIPTOR_PROVENANCE, extra: true }
    : mode.startsWith('mismatch-') ? { ...DESCRIPTOR_PROVENANCE, descriptors: {
      ...DESCRIPTOR_PROVENANCE.descriptors, [mode.slice('mismatch-'.length)]: '0'.repeat(64),
    } } : DESCRIPTOR_PROVENANCE
  const source = `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const input = JSON.parse(process.argv[1]);
    const url = name => pathToFileURL(path.join(input.server, name)).href;
    await import(url('__tests__/safe-storage-test-double.ts')).then(m => m.installTestSafeStorage());
    const require = createRequire(pathToFileURL(path.join(input.server, '__tests__/final-render-transport.test.ts')));
    const ep = require.resolve('electron');
    const resourcesPath = path.join(input.fixture, 'resources');
    const appPath = path.join(resourcesPath, 'app.asar');
    await fs.mkdir(appPath, {recursive:true, mode:0o700});
    await fs.writeFile(path.join(appPath, 'package.json'), JSON.stringify({
      name:'story-studio-kh', main:'electron/dist/main.js', type:'module',
      ...(input.provenance === undefined ? {} : {storyRenderProvenance:input.provenance})
    }));
    process.resourcesPath = resourcesPath;
    require.cache[ep].exports = {...require.cache[ep].exports,
      app:{isPackaged:input.mode !== 'development',getAppPath:()=>appPath}};
    const calls=[];
    globalThis.fetch=async (url,init={})=>{
      calls.push({url:String(url),method:init.method ?? 'GET',body:init.body ?? null});
      if(String(url)!==input.origin+'/v1/final-renders/capabilities' || (init.method ?? 'GET')!=='GET' || init.body!==undefined)
        throw new Error('unexpected remote mutation');
      return Response.json(input.capabilities);
    };
    const {preparePrivateFinalRenderDescriptor}=await import(url('services/final-render-transport.ts'));
    let disposition,error;
    try {disposition=await preparePrivateFinalRenderDescriptor(input.composition)} catch(e){error={name:e.name,message:e.message}}
    const queue=await import(url('services/job-queue.ts'));
    await queue._waitForJobPersistenceForTesting();
    const jobFile=path.join(process.env.STORY_STUDIO_DATA_DIR,'projects',input.composition.job.project_slug,'jobs.json');
    const saved=JSON.parse(await fs.readFile(jobFile,'utf8'));
    const job=saved.jobs.find(job=>job.job_id===input.composition.job.job_id);
    const intents=await fs.readdir(path.join(process.env.STORY_STUDIO_DATA_DIR,'private-render','intents')).catch(e=>{if(e.code==='ENOENT')return [];throw e});
    console.log('BUILD_RESULT '+JSON.stringify({disposition,error,calls,receipt:job?.final_render_remote_wait,intents,output_lines:input.composition.job.output_lines}));
  `
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const payload = { fixture, mode, provenance, capabilities: capabilities(), origin: ORIGIN,
    server: path.resolve(HERE, '..'), composition: value.composition }
  const child = spawn(process.execPath, ['--import', require.resolve('tsx'), '--input-type=module', '-e', source, JSON.stringify(payload)], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  /**
   * Watchdog for the isolated-build child. This test owns the child's
   * lifecycle: one SIGTERM when the child overruns its budget, then a bounded
   * settlement in which the real 'close' event must arrive. A child that does
   * not settle is reported as a failure with its pid and its retained
   * evidence. There is no escalation of any kind: the child is terminated
   * politely, and if it refuses, the run fails loudly instead.
   */
  const BUILD_BUDGET_MS = 30_000
  const BUILD_SETTLEMENT_MS = 5_000
  let settlementTimer: NodeJS.Timeout | undefined
  let rejectSettlement: (error: Error) => void = () => {}
  const closed = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve, reject) => {
    rejectSettlement = reject
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (settlementTimer) clearTimeout(settlementTimer)
      resolve({ code, signal })
    })
  })
  const watchdog = setTimeout(() => { child.kill('SIGTERM') }, BUILD_BUDGET_MS)
  settlementTimer = setTimeout(() => rejectSettlement(new Error(
    `the isolated build child pid ${child.pid} did not settle within ${BUILD_SETTLEMENT_MS}ms of its SIGTERM; evidence: ${fixture}`,
  )), BUILD_BUDGET_MS + BUILD_SETTLEMENT_MS)
  let exit: number | null = null
  let settlementError: Error | null = null
  try {
    const result = await closed
    exit = result.code
  } catch (error: any) {
    settlementError = error instanceof Error ? error : new Error(String(error))
  } finally {
    clearTimeout(watchdog)
    if (settlementTimer) clearTimeout(settlementTimer)
  }
  await fs.writeFile(path.join(fixture, 'raw.log'), output, { mode: 0o600 })
  if (settlementError) {
    // The child ignored its SIGTERM. It is never escalated; the parent's hold
    // on its pipes is released so the failure is reported instead of hanging
    // the run, and the pid stays named for the owner.
    child.stdout?.destroy()
    child.stderr?.destroy()
    child.unref()
    throw settlementError
  }
  assert.equal(exit, 0, output)
  const line = output.split('\n').find(row => row.startsWith('BUILD_RESULT '))
  assert.ok(line, output)
  return JSON.parse(line.slice('BUILD_RESULT '.length))
}

const QUALIFICATION = { vector_id: 'candidate-vector', qualification_digest: '1'.repeat(64),
  packet_digest: '2'.repeat(64), recipe_digest: '3'.repeat(64), manifest_digest: '4'.repeat(64) }

test('ordinary unavailable builds never discover or stage', async () => {
  await setPrivateFinalRenderSetting({ enabled: true })
  for (const mode of ['development', 'legacy', 'tool-only']) {
    const value = await prepareCase(`unavailable-${mode}`)
    const result = await isolatedBuildPrepare(value, mode)
    assert.equal(result.disposition, null)
    assert.equal(result.error, undefined)
    assert.deepEqual(result.calls, [])
    assert.equal(result.receipt, undefined)
    await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
  }
})

test('build gating resolves held lineage before local fallback', async () => {
  await setPrivateFinalRenderSetting({ enabled: true })
  const held = await prepareCase('build-held')
  await prepare(held)
  const canonical = await queue.loadAuthoritativeJob(held.job.project_slug, held.job.job_id)
  const before = canonical!.final_render_remote_wait
  for (const mode of ['development', 'legacy', 'tool-only']) {
    const result = await isolatedBuildPrepare(held, mode)
    assert.match(result.error?.message ?? '', /recovery|local/i)
    assert.deepEqual(result.receipt, before)
    assert.deepEqual(result.calls, [])
  }
  const malformed = await prepareCase('build-malformed', { version: 2, phase: 'intent_staged', corrupt: true })
  const result = await isolatedBuildPrepare(malformed, 'tool-only')
  assert.match(result.error?.message ?? '', /recovery|lineage|intent|render/i)
  assert.deepEqual(result.calls, [])
})

test('selected invalid provenance stops, and mismatched selected pins fall back to local', async () => {
  await setPrivateFinalRenderSetting({ enabled: true })

  // A package whose provenance cannot be read is not a build this app can trust: it stops before any
  // capability read, so no durable intent and no remote work can come of it.
  const invalid = await prepareCase('invalid')
  const invalidIntents = await fs.readdir(path.join(retainedRoot, 'private-render', 'intents'))
  const invalidResult = await isolatedBuildPrepare(invalid, 'invalid')
  assert.equal(invalidResult.error?.name, 'RenderProvenanceError')
  assert.equal(invalidResult.disposition, undefined)
  assert.deepEqual(invalidResult.calls, [])
  assert.deepEqual(invalidResult.output_lines, [], 'the stop is not a fallback and has nothing to announce')
  assert.deepEqual(invalidResult.intents, invalidIntents)
  assert.equal(invalidResult.receipt, undefined)
  await assert.rejects(fs.stat(invalid.composition.outputFile), /ENOENT/)

  // Installed pins that do not match the paired Gateway are a compatibility answer, not corruption:
  // a selected remote render fails closed to this Mac and says why. It still performs the capability
  // GET (the comparison needs the paired digests), posts nothing, and leaves no durable receipt, so
  // the next render re-decides from the installed build.
  for (const mode of ['mismatch-profile_digest', 'mismatch-tools_digest', 'mismatch-compiler_digest']) {
    const value = await prepareCase(mode)
    const before = await fs.readdir(path.join(retainedRoot, 'private-render', 'intents'))
    const result = await isolatedBuildPrepare(value, mode)
    assert.equal(result.error, undefined, 'a pin mismatch without live lineage is a local fallback')
    assert.equal(result.disposition, null)
    assert.equal(result.calls.length, 1, 'capability discovery only; no submit, upload or seal')
    assert.deepEqual(result.calls.map((call: { method: string }) => call.method), ['GET'])
    assert.match(result.output_lines.join('\n'), /descriptor pins do not match the paired Gateway/)
    assert.deepEqual(result.intents, before)
    assert.equal(result.receipt, undefined, 'no durable private-render receipt is written')
    await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
  }
})

test('sealed builds never prepare or replace a snapshot', async () => {
  await setPrivateFinalRenderSetting({ enabled: true })
  const held = await prepareCase('sealed-held')
  await prepare(held)
  const canonical = await queue.loadAuthoritativeJob(held.job.project_slug, held.job.job_id)
  for (const value of [await prepareCase('sealed-fresh'), held]) {
    const before = await fs.readdir(path.join(retainedRoot, 'private-render', 'intents'))
    const result = await isolatedBuildPrepare(value, 'sealed-candidate', QUALIFICATION)
    assert.equal(result.error?.name, 'RenderProvenanceError')
    assert.match(result.error.message, /sealed|prepare|snapshot/i)
    assert.deepEqual(result.calls, [])
    assert.deepEqual(result.intents, before)
    assert.deepEqual(result.receipt, value === held ? canonical!.final_render_remote_wait : undefined)
  }
})

test('descriptor preparation performs capability GET only', async () => {
  await setPrivateFinalRenderSetting({ enabled: true })
  const value = await prepareCase('descriptor-get-only')
  const result = await isolatedBuildPrepare(value, 'descriptor-only')
  assert.deepEqual(result.disposition, { kind: 'video-assembly-remote-wait' })
  assert.equal(result.error, undefined)
  assert.deepEqual(result.calls, [{ url: `${ORIGIN}/v1/final-renders/capabilities`, method: 'GET', body: null }])
  assert.equal(result.receipt.phase, 'intent_staged')
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
})

test('explicit H.265 composition stays local before capability discovery or staging', async () => {
  const intents = async (): Promise<string[]> => {
    try {
      return await fs.readdir(path.join(retainedRoot, 'private-render', 'intents'))
    } catch {
      return []
    }
  }
  fetchCalls = []
  await setPrivateFinalRenderSetting({ enabled: true })
  const before = await intents()
  const value = await prepareCase('h265-local')
  value.composition.codec = 'h265'
  assert.equal(await prepare(value), null)
  assert.deepEqual(fetchCalls, [], 'H.265 is refused before the paired capability is read')
  assert.equal(value.job.final_render_remote_wait, undefined)
  assert.match(value.job.output_lines.join('\n'), /H\.265 output is not supported remotely/)
  assert.match(value.job.output_lines.join('\n'), /stays on this Mac/)
  assert.deepEqual(await intents(), before, 'no private intent is staged')
  await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)

  const held = await prepareCase('h265-held')
  assert.deepEqual(await prepare(held), { kind: 'video-assembly-remote-wait' })
  const canonical = await queue.loadAuthoritativeJob(held.job.project_slug, held.job.job_id)
  fetchCalls = []
  await assert.rejects(
    preparePrivateFinalRenderDescriptor({ ...held.composition, codec: 'h265', job: canonical! }),
    /recovery|lineage/i,
  )
  assert.deepEqual(fetchCalls, [], 'held lineage fails closed before capability discovery')
  assert.equal(canonical?.final_render_remote_wait?.phase, 'intent_staged')
  await assert.rejects(fs.stat(held.composition.outputFile), /ENOENT/)
})

test('an encode the paired machine cannot execute stays local before staging', async () => {
  const intents = async (): Promise<string[]> => {
    try {
      return await fs.readdir(path.join(retainedRoot, 'private-render', 'intents'))
    } catch {
      return []
    }
  }
  const withEncode = async (entries: unknown[] | null) => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = async (input, init = {}) => {
      calls.push(String(input))
      assert.equal(init.method ?? 'GET', 'GET')
      return Response.json({
        ...capabilities(),
        encode: entries === null
          ? null
          : { format: 'studio.render.encode-authority.v1', entries },
      })
    }
    return { calls, restore: () => { globalThis.fetch = original } }
  }
  const matching = {
    container: 'mp4', requested_codec: 'h264', requested_effort: 'ultrafast',
    crf: 23, quality_cpu_preset: 'ultrafast', bitrate_kbps: null,
  }

  await setPrivateFinalRenderSetting({ enabled: true })
  const before = await intents()
  const mismatched = await withEncode([{ ...matching, requested_effort: 'medium', quality_cpu_preset: 'medium' }])
  try {
    const value = await prepareCase('encode-local')
    assert.equal(await prepare(value), null)
    assert.equal(mismatched.calls.length, 1, 'one capability GET, no upload or submit')
    assert.match(value.job.output_lines.join('\n'), /exact encode is not qualified for remote rendering/)
    assert.match(value.job.output_lines.join('\n'), /stays on this Mac/)
    assert.equal(value.job.final_render_remote_wait, undefined)
    assert.deepEqual(await intents(), before, 'no private intent is staged')
    await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
  } finally {
    mismatched.restore()
  }

  const unassured = await withEncode(null)
  try {
    const value = await prepareCase('encode-unassured')
    assert.equal(await prepare(value), null)
    assert.equal(unassured.calls.length, 1)
    assert.match(value.job.output_lines.join('\n'), /exact encode is not qualified for remote rendering/)
    assert.equal(value.job.final_render_remote_wait, undefined)
    assert.deepEqual(await intents(), before, 'a null encode authority stages nothing')
    await assert.rejects(fs.stat(value.composition.outputFile), /ENOENT/)
  } finally {
    unassured.restore()
  }

  const supported = await withEncode([matching])
  try {
    const value = await prepareCase('encode-supported')
    assert.deepEqual(await prepare(value), { kind: 'video-assembly-remote-wait' })
    const canonical = await queue.loadAuthoritativeJob(value.job.project_slug, value.job.job_id)
    assert.equal(canonical?.final_render_remote_wait?.phase, 'intent_staged')
  } finally {
    supported.restore()
  }
})
