import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test, type TestContext } from 'node:test'
import sharp from 'sharp'

import { useTempDataDir } from './_helpers.js'
import {
  F2CaseOwner,
  classifyFontSelectionReport,
  runBoundedChild,
} from './fixtures/final-composition-evidence.js'
import { twoSecondVideoBytes } from './fixtures/tiny-video.js'
import { escapeFilterArgValue } from '../lib/ffmpeg-utils.js'
import { workFolderIdentity } from '../lib/segmented-render.js'
import { bundledFontsFilterOption } from '../lib/subtitle-font-dir.js'
import type { ContextualCue, Job } from '../models/types.js'
import { getAppSetting, setAppSetting } from '../services/app-settings.js'
import { clearFFmpegCache } from '../services/ffmpeg-manager.js'

const BASE = '80e34dfd1e9eea0a4955e1a145316ee29335b823'
const F2_BASE = 'be2e77cea9caea102b9b1fe9304e09e22939405c'
const F4_BASE = '9bed6b3b9dcda4e38e0b3b1572078c96c570ea72'
/** This test file's own repository root: `<repo>/electron/server/__tests__` is three levels below it. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GOLDEN = new URL('./fixtures/final-composition-argv-v1.json', import.meta.url)
const FFMPEG_SHA256 = 'ba3a9d9d20b43492a85649d7e03122144905e3f07b713279fb5a0e659cf73e84'
const FFPROBE_SHA256 = 'f9827709561c11162a9fe93380fe6ecd92648461faf53c5bf5eb3a037442621e'
const CALL_MARKER = '__STORY_F0_CALL__'
const VT_REJECT_MARKER = '__STORY_TEST_REJECT_VIDEOTOOLBOX__'
const F4_CHILD_WATCHDOG_MS = 30_000
const F2_CHILD_WATCHDOG_MS = 60_000
const F4_CASE_TIMEOUT_MS = 150_000
const F2_CASE_TIMEOUT_MS = 180_000

const CASE_IDS = [
  'F0',
  'F1',
  'F2-editorial-1080p30',
  'F4-hardware-q-h265-request',
  'F4-hardware-bitrate',
  'F4-injected-hardware-fallback',
] as const
type CaseId = typeof CASE_IDS[number]

/**
 * F2 (editorial 1080p30, whose captions bind a platform font) is a QUALIFICATION case, not a
 * release-gate case. Its layout is outside the V1 supported envelope on this platform (CoreText
 * reports negative TTC collection indexes and drawtext without a face), and it has no reviewed
 * fidelity golden — `final-composition-argv-v1.json` deliberately carries no `editorial_1080p30`
 * entry. Asserting platform font resolution and an unreviewed golden in an ordinary suite is not a
 * product check, so F2 is gated behind an explicit qualification run:
 *
 *   STORY_STUDIO_F2_QUALIFICATION=1 \
 *   STORY_STUDIO_CHARACTERIZATION_CASES=F2-editorial-1080p30 \
 *     node --import tsx --test electron/server/__tests__/final-composition-characterization.test.ts
 *
 * The pinned tools are read from `STORY_STUDIO_F0_TOOL_DIR` (or `<repo>/bundled/ffmpeg`). F0, F1 and
 * F4 stay in the default run and keep their real checks. Under the qualification flag, unresolved
 * font bindings and the absent golden still fail the run closed, with the retained evidence listed.
 */
const F2_QUALIFICATION = process.env.STORY_STUDIO_F2_QUALIFICATION === '1'
const F2_GATE_REASON = 'F2 editorial-1080p30 is a qualification case: this layout is outside the V1 '
  + 'supported envelope (platform font binding is unresolved) and no reviewed fidelity golden exists. '
  + 'Set STORY_STUDIO_F2_QUALIFICATION=1 to run it; unresolved fonts or a missing golden then fail closed.'

/**
 * The cases a run selects, and whether F2 was gated out. Pure so the release gate pins the contract
 * without generating a video: the default selection must never carry F2, and naming F2 explicitly
 * without the qualification flag is a visible configuration failure, not a silent skip.
 */
export function characterizationCases(raw: string | undefined, qualified: boolean): {
  selected: CaseId[]
  gated: boolean
} {
  const values = raw === undefined ? [...CASE_IDS] : raw.split(',').map(value => value.trim())
  if (raw !== undefined) {
    assert.ok(values.length > 0 && values.every(Boolean), 'characterization case selection must not be empty')
    assert.equal(new Set(values).size, values.length, 'characterization case selection must not contain duplicates')
    const unknown = values.filter(value => !(CASE_IDS as readonly string[]).includes(value))
    assert.deepEqual(unknown, [], `unknown characterization case(s): ${unknown.join(', ')}`)
  }
  const requested = values as CaseId[]
  const namesF2 = requested.includes('F2-editorial-1080p30')
  if (namesF2 && !qualified && raw !== undefined) {
    assert.fail(`${F2_GATE_REASON} This run named F2 explicitly, so it is refused rather than silently skipped.`)
  }
  return {
    selected: qualified ? requested : requested.filter(id => id !== 'F2-editorial-1080p30'),
    gated: namesF2 && !qualified,
  }
}

const SELECTION = characterizationCases(process.env.STORY_STUDIO_CHARACTERIZATION_CASES, F2_QUALIFICATION)
const SELECTED_CASES: ReadonlySet<CaseId> = new Set(SELECTION.selected)
const F2_SELECTED = SELECTED_CASES.has('F2-editorial-1080p30')
const F4_SELECTED = [...SELECTED_CASES].some(id => id.startsWith('F4-'))
if (SELECTION.gated) console.log(`[characterization] ${F2_GATE_REASON}`)

const mutableChildProcess = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
const originalSpawn = mutableChildProcess.spawn
const mutableFsPromises = createRequire(import.meta.url)('node:fs/promises') as typeof import('node:fs/promises')
const originalRm = mutableFsPromises.rm

type OwnedChildBudget = {
  caseId: CaseId
  maxLaunches: number
  launches: number
  refused: number
  aborted: boolean
  live: Set<ChildProcess>
  settlements: Set<Promise<void>>
}

type VideoModule = typeof import('../generators/video.js')

let dataDir = ''
let capturePath = ''
let ffmpegPath = ''
let ffprobePath = ''
let wrapperPath = ''
let video: VideoModule
let previousFfmpegSetting: unknown
let previousFfprobeSetting: unknown
let previousRealFfmpeg: string | undefined
let previousCapturePath: string | undefined
let previousResourcesDir: string | undefined
let previousFailureMode: string | undefined
let previousWatchdogMs: string | undefined
let previousFfmpegReport: string | undefined
let ffmpegSettingCaptured = false
let ffprobeSettingCaptured = false
let settingsMutationBegan = false
let spawnObserverInstalled = false
let subtitleScratchRetainerInstalled = false
let activeOwnedChildBudget: OwnedChildBudget | null = null
let activeOwnedWorkSettlement: Promise<void> | null = null
let activeF2Owner: F2CaseOwner | null = null
let activeF2BodySettlement: Promise<void> | null = null
let activeSubtitleScratchRetention: {
  source: string
  retained: string
  observed: boolean
  error: unknown
} | null = null
const allOwnedChildren = new Set<ChildProcess>()
const allOwnedSettlements = new Set<Promise<void>>()

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function requiredToolPath(name: 'ffmpeg' | 'ffprobe'): string {
  // Anchored to THIS file, never the process cwd: the release harness spawns tests with cwd
  // `<repo>/electron`, where a cwd-relative `bundled/ffmpeg` does not exist. The explicit override
  // stays first so a qualification machine can point at its own pinned pair.
  const toolDir = process.env.STORY_STUDIO_F0_TOOL_DIR || path.join(REPO_ROOT, 'bundled', 'ffmpeg')
  return path.join(toolDir, name)
}

function silentStereoWav(seconds: number): Buffer {
  const sampleRate = 48_000
  const channels = 2
  const bitsPerSample = 16
  const blockAlign = channels * bitsPerSample / 8
  const dataBytes = sampleRate * seconds * blockAlign
  const wav = Buffer.alloc(44 + dataBytes)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataBytes, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(channels, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * blockAlign, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bitsPerSample, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataBytes, 40)
  return wav
}

function parseCapturedCalls(raw: Buffer): string[][] {
  const fields = raw.toString('utf8').split('\0')
  if (fields.at(-1) === '') fields.pop()
  const calls: string[][] = []
  for (let i = 0; i < fields.length;) {
    assert.equal(fields[i++], CALL_MARKER, 'the observer log contains a complete call marker')
    const count = Number(fields[i++])
    assert.ok(Number.isSafeInteger(count) && count >= 0, 'the observer recorded a valid argv count')
    calls.push(fields.slice(i, i + count))
    i += count
  }
  return calls
}

async function capturedCalls(): Promise<string[][]> {
  return parseCapturedCalls(await fs.readFile(capturePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return Buffer.alloc(0)
    throw error
  }))
}

function trackOwnedChild(child: ChildProcess, budget: OwnedChildBudget): void {
  budget.live.add(child)
  allOwnedChildren.add(child)
  let settlement: Promise<void>
  settlement = new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('close', () => resolve())
  })
  budget.settlements.add(settlement)
  allOwnedSettlements.add(settlement)
  void settlement.then(() => {
    budget.live.delete(child)
    budget.settlements.delete(settlement)
    allOwnedChildren.delete(child)
    allOwnedSettlements.delete(settlement)
  })
}

function installSpawnObserver(): void {
  if (spawnObserverInstalled || (!F2_SELECTED && !F4_SELECTED)) return
  const observingSpawn = ((...args: any[]) => {
    const command = args[0]
    const owned = command === wrapperPath || command === ffmpegPath
    const budget = activeOwnedChildBudget
    if (!owned || !budget) return (originalSpawn as any)(...args)
    if (budget.aborted) {
      budget.refused += 1
      throw Object.assign(
        new Error(`[F4 test watchdog] ${budget.caseId} refused an owned child launch after test cancellation`),
        { code: 'STORY_F4_CHILD_ABORTED' },
      )
    }
    if (budget.launches >= budget.maxLaunches) {
      budget.refused += 1
      throw Object.assign(
        new Error(`[F4 test watchdog] ${budget.caseId} refused owned child launch ${budget.launches + 1}; budget=${budget.maxLaunches}`),
        { code: 'STORY_F4_CHILD_BUDGET' },
      )
    }
    budget.launches += 1
    const child = (originalSpawn as any)(...args) as ChildProcess
    trackOwnedChild(child, budget)
    return child
  }) as typeof originalSpawn
  ;(mutableChildProcess as any).spawn = observingSpawn
  spawnObserverInstalled = true
  syncBuiltinESMExports()
}

function installSubtitleScratchRetainer(): void {
  if (subtitleScratchRetainerInstalled || !F2_SELECTED) return
  const retainingRm = (async (file: Parameters<typeof originalRm>[0], options?: Parameters<typeof originalRm>[1]) => {
    const retention = activeSubtitleScratchRetention
    if (!retention || path.resolve(String(file)) !== retention.source) {
      return originalRm(file as any, options as any)
    }
    try {
      await mutableFsPromises.copyFile(retention.source, retention.retained)
      retention.observed = true
    } catch (error) {
      retention.error = error
      throw error
    }
  }) as typeof originalRm
  ;(mutableFsPromises as any).rm = retainingRm
  subtitleScratchRetainerInstalled = true
  syncBuiltinESMExports()
}

function restoreSubtitleScratchRetainer(): void {
  if (!subtitleScratchRetainerInstalled) return
  ;(mutableFsPromises as any).rm = originalRm
  try {
    syncBuiltinESMExports()
  } finally {
    subtitleScratchRetainerInstalled = false
  }
}

function restoreSpawnObserver(): void {
  if (!spawnObserverInstalled) return
  ;(mutableChildProcess as any).spawn = originalSpawn
  try {
    syncBuiltinESMExports()
  } finally {
    spawnObserverInstalled = false
  }
}

function stopOwnedChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const killTimer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 1_000)
  killTimer.unref()
  child.once('close', () => clearTimeout(killTimer))
}

async function settleOwnedChildren(children: Iterable<ChildProcess>, settlements: Iterable<Promise<void>>, stop: boolean): Promise<void> {
  const selectedChildren = [...children]
  const stopErrors: unknown[] = []
  if (stop) {
    for (const child of selectedChildren) {
      try { stopOwnedChild(child) } catch (error) { stopErrors.push(error) }
    }
  }
  await Promise.all([...settlements])
  if (stopErrors.length) throw new AggregateError(stopErrors, 'failed to stop one or more owned F4 children')
}

async function withOwnedChildBudget<T>(
  t: TestContext,
  caseId: CaseId,
  maxLaunches: number,
  work: () => Promise<T>,
): Promise<T> {
  assert.ok(spawnObserverInstalled, 'the F4 owned-child observer must be installed before the video module loads')
  assert.equal(activeOwnedChildBudget, null, 'F4 child budgets must not overlap')
  const budget: OwnedChildBudget = {
    caseId,
    maxLaunches,
    launches: 0,
    refused: 0,
    aborted: false,
    live: new Set(),
    settlements: new Set(),
  }
  activeOwnedChildBudget = budget
  const abort = () => {
    budget.aborted = true
    for (const child of budget.live) {
      try { stopOwnedChild(child) } catch { /* reported by the settlement pass */ }
    }
  }
  t.signal.addEventListener('abort', abort, { once: true })

  let value: T | undefined
  let primaryError: unknown
  const workPromise = work()
  const workSettlement = workPromise.then(() => undefined, () => undefined)
  activeOwnedWorkSettlement = workSettlement
  try {
    value = await workPromise
  } catch (error) {
    primaryError = error
  }

  let settlementError: unknown
  try {
    await settleOwnedChildren(budget.live, budget.settlements, t.signal.aborted || primaryError !== undefined)
  } catch (error) {
    settlementError = error
  } finally {
    t.signal.removeEventListener('abort', abort)
    activeOwnedChildBudget = null
    if (activeOwnedWorkSettlement === workSettlement) activeOwnedWorkSettlement = null
    console.log(`[F4 child budget] case=${caseId} launches=${budget.launches} refused=${budget.refused} max=${maxLaunches}`)
  }

  if (primaryError !== undefined) {
    if (settlementError !== undefined) {
      throw new AggregateError([primaryError, settlementError], `${caseId} failed and owned-child settlement also failed`)
    }
    throw primaryError
  }
  if (settlementError !== undefined) throw settlementError
  return value as T
}

async function withF2CaseOwnership<T>(
  t: TestContext,
  work: (owner: F2CaseOwner) => Promise<T>,
): Promise<T> {
  assert.equal(activeF2Owner, null, 'F2 case ownership must not overlap')
  assert.equal(activeF2BodySettlement, null, 'F2 body settlements must not overlap')
  const owner = new F2CaseOwner(t.signal)
  activeF2Owner = owner
  const ownedWork = owner.track(Promise.resolve().then(() => work(owner)))
  const settlement = ownedWork.then(() => undefined, () => undefined)
  activeF2BodySettlement = settlement
  try {
    return await ownedWork
  } finally {
    owner.stopLaunching()
    await owner.settle()
    console.log(`[F2 phase counts] ${JSON.stringify(owner.counts)}`)
    if (activeF2Owner === owner) activeF2Owner = null
    if (activeF2BodySettlement === settlement) activeF2BodySettlement = null
  }
}

async function runF4Composition(opts: Parameters<VideoModule['_runFinalCompositionForTesting']>[0]): Promise<void> {
  try {
    await video._runFinalCompositionForTesting(opts)
  } catch (error) {
    console.error(`[F4 render failure] case=${opts.job.episode_id} diagnostics=${JSON.stringify(opts.job.output_lines)}`)
    throw error
  }
}

function assertOrdered(haystack: string, needles: string[]): void {
  let offset = -1
  for (const needle of needles) {
    const next = haystack.indexOf(needle, offset + 1)
    assert.ok(next > offset, `expected ${JSON.stringify(needle)} after byte ${offset}`)
    offset = next
  }
}

const ORIGINAL_F0_GOLDEN_KEYS = [
  'version',
  'source_commit',
  'tool_profile',
  'fixture',
  'actual_child_calls',
  'actual_child_argv',
  'referenced_files',
  'media_proof',
  'job_proof',
] as const

const ADDITIVE_GOLDEN_KEYS = [
  'rich_closed_2s',
  'editorial_1080p30',
  'f4_hardware_q_h265_request',
  'f4_hardware_bitrate_2500',
  'f4_injected_hardware_fallback',
] as const

function originalF0Golden(golden: Record<string, any>): Record<string, any> {
  const allowed = new Set<string>([...ORIGINAL_F0_GOLDEN_KEYS, ...ADDITIVE_GOLDEN_KEYS])
  assert.deepEqual(
    Object.keys(golden).filter(key => !allowed.has(key)),
    [],
    'the golden root may only grow through explicitly declared characterization entries',
  )
  return {
    version: golden.version,
    source_commit: golden.source_commit,
    tool_profile: golden.tool_profile,
    fixture: golden.fixture,
    actual_child_calls: golden.actual_child_calls,
    actual_child_argv: golden.actual_child_argv,
    referenced_files: golden.referenced_files,
    media_proof: golden.media_proof,
    job_proof: golden.job_proof,
  }
}

function newJob(id: string, title: string): Job {
  return {
    job_id: `fleet-characterization-${id}`,
    project_slug: 'fleet-characterization',
    episode_id: id,
    type: 'video_assembly',
    status: 'running',
    title,
    created_at: '',
    started_at: '',
    finished_at: null,
    error: null,
    output_lines: [],
    params: {},
  } as unknown as Job
}

async function prepareF4Inputs(id: string): Promise<{
  workDir: string
  inputVideo: string
  inputAudio: string
  output: string
  job: Job
}> {
  const workDir = path.join(dataDir, id)
  await fs.mkdir(workDir, { recursive: true })
  const inputVideo = path.join(workDir, 'intermediate_video.mp4')
  const inputAudio = path.join(workDir, 'premixed_audio.wav')
  const output = path.join(workDir, 'output.mp4')
  await fs.writeFile(inputVideo, twoSecondVideoBytes())
  await fs.writeFile(inputAudio, silentStereoWav(2))
  return { workDir, inputVideo, inputAudio, output, job: newJob(id, id) }
}

async function normalizedCall(argv: string[], workDir: string, output: string): Promise<{
  argv: string[]
  files: Record<string, string>
}> {
  const identity = await workFolderIdentity(argv, workDir, output)
  const normalized = [...identity.argv]
  const threadFlag = normalized.indexOf('-threads')
  if (threadFlag >= 0) {
    assert.equal(normalized[threadFlag - 1], 'libx264')
    assert.equal(normalized[threadFlag + 1], String(Math.max(1, os.availableParallelism() - 2)))
    normalized[threadFlag + 1] = '<x264-threads>'
  }
  assert.ok(normalized.every(arg => !arg.includes(workDir) && !arg.includes(dataDir)),
    'the canonical argv contains no private host path')
  return { argv: normalized, files: identity.files }
}

function outputCodec(argv: readonly string[]): string | undefined {
  const flag = argv.lastIndexOf('-c:v')
  return flag >= 0 ? argv[flag + 1] : undefined
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

async function probeF4Output(output: string): Promise<{
  stable: Record<string, any>
  receipt: Record<string, any>
}> {
  const probe = JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration,size:stream=index,codec_type,codec_name,width,height,avg_frame_rate,time_base,sample_rate,channels',
    '-of', 'json', output,
  ], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }))
  const videoStream = probe.streams.find((stream: any) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.equal(probe.streams.length, 2)
  assert.deepEqual(
    { codec_name: videoStream?.codec_name, width: videoStream?.width, height: videoStream?.height },
    { codec_name: 'h264', width: 128, height: 96 },
  )
  assert.deepEqual(
    { codec_name: audioStream?.codec_name, sample_rate: audioStream?.sample_rate, channels: audioStream?.channels },
    { codec_name: 'aac', sample_rate: '48000', channels: 2 },
  )
  assert.ok(Math.abs(Number(probe.format.duration) - 2) <= 0.05, `output duration ${probe.format.duration}`)
  return {
    stable: {
      format_name: probe.format.format_name,
      video: { codec_name: videoStream.codec_name, width: videoStream.width, height: videoStream.height },
      audio: { codec_name: audioStream.codec_name, sample_rate: audioStream.sample_rate, channels: audioStream.channels },
    },
    receipt: {
      duration: probe.format.duration,
      size: probe.format.size,
      video_avg_frame_rate: videoStream.avg_frame_rate,
      video_time_base: videoStream.time_base,
      audio_time_base: audioStream.time_base,
    },
  }
}

async function logF4Receipt(id: string, output: string, job: Job, probeReceipt: Record<string, any>): Promise<void> {
  const stat = await fs.stat(output)
  assert.ok(stat.size > 0, 'the validated final MP4 is nonempty')
  console.log(`[F4 receipt] case=${id} output=${output}`)
  console.log(`[F4 receipt] case=${id} output_bytes=${stat.size} output_sha256=${await sha256File(output)}`)
  console.log(`[F4 receipt] case=${id} media=${JSON.stringify(probeReceipt)}`)
  console.log(`[F4 receipt] case=${id} job_encoder=${JSON.stringify(job.result?.encoder)} degraded=${JSON.stringify(job.result?.degraded ?? null)}`)
}

async function fontSelectionEvidence(reportPath: string): Promise<{
  provider: string
  complete: boolean
  glyph_warning_present: boolean
  selected: Array<{
    renderer: 'ass' | 'drawtext'
    filter_id: string | null
    raw_line: string
    status: 'resolved' | 'unresolved'
    requested: string | null
    path: string | null
    collection_index: number | null
    face: string | null
    sha256: string | null
  }>
}> {
  const report = await fs.readFile(reportPath, 'utf8')
  const evidence = classifyFontSelectionReport(report)
  assert.ok(evidence.provider, 'the actual FFmpeg report names the libass font provider')
  assert.ok(evidence.events.some(item => item.renderer === 'ass' && item.requested?.startsWith('Helvetica,')),
    'the actual libass trace records a selection event for the requested Helvetica face')
  assert.ok(evidence.events.some(item => item.renderer === 'drawtext'),
    'the actual drawtext trace records its current selection events')
  return {
    provider: evidence.provider,
    complete: evidence.complete,
    glyph_warning_present: evidence.glyph_warning_present,
    selected: await Promise.all(evidence.events.map(async item => {
      if (item.path === null) return { ...item, sha256: null }
      assert.equal(path.isAbsolute(item.path), true, 'selected font evidence uses the actual absolute font path')
      assert.equal((await fs.stat(item.path)).isFile(), true, `selected font exists: ${item.path}`)
      return { ...item, sha256: await sha256File(item.path) }
    })),
  }
}

before(async () => {
  previousRealFfmpeg = process.env.STORY_STUDIO_TEST_REAL_FFMPEG
  previousCapturePath = process.env.STORY_STUDIO_TEST_FFMPEG_ARGV
  previousResourcesDir = process.env.STORY_STUDIO_RESOURCES_DIR
  previousFailureMode = process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE
  previousWatchdogMs = process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS
  previousFfmpegReport = process.env.STORY_STUDIO_TEST_FFMPEG_REPORT
  dataDir = (await useTempDataDir()).dir
  ffmpegPath = requiredToolPath('ffmpeg')
  ffprobePath = requiredToolPath('ffprobe')
  assert.equal(await sha256File(ffmpegPath), FFMPEG_SHA256, 'F0 must use the pinned primary 305 FFmpeg bytes')
  assert.equal(await sha256File(ffprobePath), FFPROBE_SHA256, 'F0 must use the pinned primary 305 FFprobe bytes')

  previousFfmpegSetting = await getAppSetting('ffmpeg_path')
  ffmpegSettingCaptured = true
  previousFfprobeSetting = await getAppSetting('ffprobe_path')
  ffprobeSettingCaptured = true

  wrapperPath = path.join(dataDir, 'observed-ffmpeg')
  capturePath = path.join(dataDir, 'actual-child-argv.bin')
  await fs.writeFile(wrapperPath, `#!/bin/sh
{
  printf '${CALL_MARKER}\\000%s\\000' "$#"
  printf '%s\\000' "$@"
} >> "$STORY_STUDIO_TEST_FFMPEG_ARGV"
if [ -n "$STORY_STUDIO_TEST_FFMPEG_REPORT" ]; then
  export FFREPORT="file=$STORY_STUDIO_TEST_FFMPEG_REPORT:level=48"
fi
case "$STORY_STUDIO_TEST_FFMPEG_FAILURE" in
  "")
    ;;
  reject-videotoolbox)
    output_codec=
    previous=
    for arg in "$@"; do
      if [ "$previous" = "-c:v" ]; then output_codec="$arg"; fi
      previous="$arg"
    done
    if [ "$output_codec" = "h264_videotoolbox" ]; then
      printf '%s\\n' '${VT_REJECT_MARKER}' >&2
      exit 86
    fi
    ;;
  *)
    printf '%s\\n' '__STORY_TEST_UNKNOWN_FFMPEG_FAILURE_MODE__' >&2
    exit 97
    ;;
esac
exec "$STORY_STUDIO_TEST_REAL_FFMPEG" "$@"
`)
  await fs.chmod(wrapperPath, 0o755)
  installSpawnObserver()
  process.env.STORY_STUDIO_TEST_REAL_FFMPEG = ffmpegPath
  process.env.STORY_STUDIO_TEST_FFMPEG_ARGV = capturePath
  delete process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE
  process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS = String(F4_CHILD_WATCHDOG_MS)
  // A release resources directory wins over the saved setting. Clear it so the
  // observer remains the selected binary; the observer itself delegates to the
  // already hash-verified release binary above.
  delete process.env.STORY_STUDIO_RESOURCES_DIR
  settingsMutationBegan = true
  await setAppSetting('ffmpeg_path', wrapperPath)
  await setAppSetting('ffprobe_path', ffprobePath)
  clearFFmpegCache()
  video = await import('../generators/video.js')
})

after(async () => {
  const restorationErrors: unknown[] = []
  const attempt = async (label: string, restore: () => void | Promise<void>): Promise<void> => {
    try {
      await restore()
    } catch (error) {
      restorationErrors.push(Object.assign(new Error(`F4 restoration failed: ${label}`), { cause: error }))
    }
  }
  const restoreEnv = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }

  await attempt('owned render and child settlement', async () => {
    const settlementErrors: unknown[] = []
    try {
      activeF2Owner?.stopLaunching()
      if (activeOwnedChildBudget) activeOwnedChildBudget.aborted = true
      try {
        await settleOwnedChildren(allOwnedChildren, allOwnedSettlements, true)
      } catch (error) {
        settlementErrors.push(error)
      }
      if (activeF2BodySettlement) await activeF2BodySettlement
      if (activeF2Owner) await activeF2Owner.settle()
      if (activeOwnedWorkSettlement) await activeOwnedWorkSettlement
      try {
        await settleOwnedChildren(allOwnedChildren, allOwnedSettlements, true)
      } catch (error) {
        settlementErrors.push(error)
      }
      if (settlementErrors.length) {
        throw new AggregateError(settlementErrors, 'owned F4 render settlement failed')
      }
    } finally {
      activeF2Owner = null
      activeF2BodySettlement = null
      activeOwnedChildBudget = null
      activeOwnedWorkSettlement = null
    }
  })
  if (settingsMutationBegan && ffmpegSettingCaptured) {
    await attempt('ffmpeg_path setting', () => setAppSetting('ffmpeg_path', previousFfmpegSetting))
  }
  if (settingsMutationBegan && ffprobeSettingCaptured) {
    await attempt('ffprobe_path setting', () => setAppSetting('ffprobe_path', previousFfprobeSetting))
  }
  if (settingsMutationBegan) await attempt('FFmpeg cache', () => clearFFmpegCache())
  await attempt('STORY_STUDIO_TEST_REAL_FFMPEG', () => restoreEnv('STORY_STUDIO_TEST_REAL_FFMPEG', previousRealFfmpeg))
  await attempt('STORY_STUDIO_TEST_FFMPEG_ARGV', () => restoreEnv('STORY_STUDIO_TEST_FFMPEG_ARGV', previousCapturePath))
  await attempt('STORY_STUDIO_RESOURCES_DIR', () => restoreEnv('STORY_STUDIO_RESOURCES_DIR', previousResourcesDir))
  await attempt('STORY_STUDIO_TEST_FFMPEG_FAILURE', () => restoreEnv('STORY_STUDIO_TEST_FFMPEG_FAILURE', previousFailureMode))
  await attempt('STORY_STUDIO_FFMPEG_TIMEOUT_MS', () => restoreEnv('STORY_STUDIO_FFMPEG_TIMEOUT_MS', previousWatchdogMs))
  await attempt('STORY_STUDIO_TEST_FFMPEG_REPORT', () => restoreEnv('STORY_STUDIO_TEST_FFMPEG_REPORT', previousFfmpegReport))
  await attempt('child-process spawn observer', () => restoreSpawnObserver())
  await attempt('subtitle scratch retainer', () => restoreSubtitleScratchRetainer())
  // The backend harness owns its disposable sandbox lifecycle. Do not remove
  // evidence paths here; failed runs retain the sandbox for inspection.
  if (restorationErrors.length) {
    throw new AggregateError(restorationErrors, 'one or more F4 test restorations failed')
  }
})

test('F0 freezes the real minimal final-composition child argv and validates its media', {
  skip: !SELECTED_CASES.has('F0'),
}, async () => {
  const workDir = path.join(dataDir, 'f0')
  await fs.mkdir(workDir, { recursive: true })
  const inputVideo = path.join(workDir, 'intermediate_video.mp4')
  const inputAudio = path.join(workDir, 'premixed_audio.wav')
  const output = path.join(workDir, 'output.mp4')
  await fs.writeFile(inputVideo, twoSecondVideoBytes())
  await fs.writeFile(inputAudio, silentStereoWav(2))

  const job = {
    job_id: 'fleet-characterization-f0', project_slug: 'fleet-characterization', episode_id: 'F0',
    type: 'video_assembly', status: 'running', title: 'F0', created_at: '', started_at: '',
    finished_at: null, error: null, output_lines: [], params: {},
  } as unknown as Job

  await video._runFinalCompositionForTesting({
    videoInputPath: inputVideo,
    premixedAudioPath: inputAudio,
    targetDuration: 2,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: output,
    encodingEffort: 'ultrafast',
    codec: 'h264',
    job,
  })

  const calls = await capturedCalls()
  assert.equal(calls.length, 1, 'the successful software F0 uses one final FFmpeg child')
  const actual = calls[0]!
  const identity = await workFolderIdentity(actual, workDir, output)
  const argv = [...identity.argv]
  const threadFlag = argv.indexOf('-threads')
  assert.ok(threadFlag > 0, 'the actual libx264 child receives the runtime thread cap')
  assert.equal(argv[threadFlag - 1], 'libx264')
  assert.equal(argv[threadFlag + 1], String(Math.max(1, os.availableParallelism() - 2)))
  argv[threadFlag + 1] = '<x264-threads>'

  assert.deepEqual(argv.slice(0, 5), ['-y', '-i', '<work>/intermediate_video.mp4', '-i', '<work>/premixed_audio.wav'])
  assert.equal(argv[argv.indexOf('-filter_complex') + 1], '[0:v]setpts=PTS-STARTPTS[v0];\n[v0]null[vout]')
  const mapStart = argv.indexOf('-map')
  const encoderStart = argv.indexOf('-c:v', mapStart)
  assert.deepEqual(argv.slice(mapStart, encoderStart), ['-map', '[vout]', '-map', '1:a'])
  assert.deepEqual(argv.slice(argv.indexOf('-c:v'), -3), [
    '-c:v', 'libx264', '-threads', '<x264-threads>', '-crf', '23', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.deepEqual(argv.slice(-3), ['-t', '2', '<work>/<output>'])
  assert.equal(job.result?.encoder, 'software (libx264)')
  assert.equal(job.result?.degraded, undefined)

  const outputStat = await fs.stat(output)
  assert.ok(outputStat.size > 0, 'the validated final MP4 is nonempty')
  const probe = JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,time_base,sample_rate,channels',
    '-of', 'json', output,
  ], { encoding: 'utf8' }))
  const videoStream = probe.streams.find((stream: any) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.equal(probe.streams.length, 2)
  assert.deepEqual({ codec: videoStream.codec_name, width: videoStream.width, height: videoStream.height },
    { codec: 'h264', width: 128, height: 96 })
  assert.deepEqual({ codec: audioStream.codec_name, sample_rate: audioStream.sample_rate, channels: audioStream.channels },
    { codec: 'aac', sample_rate: '48000', channels: 2 })
  assert.ok(Math.abs(Number(probe.format.duration) - 2) <= 0.05, `output duration ${probe.format.duration}`)

  const observed = {
    version: 1,
    source_commit: BASE,
    tool_profile: { ffmpeg_sha256: FFMPEG_SHA256, ffprobe_sha256: FFPROBE_SHA256 },
    fixture: { duration_sec: 2, width: 128, height: 96, fps: 5, codec: 'h264', effort: 'ultrafast', crf: 23 },
    actual_child_calls: calls.length,
    actual_child_argv: argv,
    referenced_files: identity.files,
    media_proof: {
      format_name: probe.format.format_name,
      duration: probe.format.duration,
      video: {
        codec_name: videoStream.codec_name,
        width: videoStream.width,
        height: videoStream.height,
        avg_frame_rate: videoStream.avg_frame_rate,
        time_base: videoStream.time_base,
      },
      audio: {
        codec_name: audioStream.codec_name,
        sample_rate: audioStream.sample_rate,
        channels: audioStream.channels,
        time_base: audioStream.time_base,
      },
    },
    job_proof: { encoder: job.result?.encoder, degraded: job.result?.degraded ?? null },
  }
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))
  assert.deepEqual(observed, originalF0Golden(golden))

  console.log(`[F0 evidence] output=${output}`)
  console.log(`[F0 evidence] private_capture=${capturePath}`)
  console.log(`[F0 evidence] real_ffmpeg=${ffmpegPath}`)
  console.log(`[F0 evidence] child_calls=${calls.length} output_bytes=${outputStat.size}`)
})

test('F1 freezes the real ordered rich final-composition child argv and validates every requested layer', {
  skip: !SELECTED_CASES.has('F1'),
}, async () => {
  const workDir = path.join(dataDir, 'f1-rich-closed-2s')
  await fs.mkdir(workDir, { recursive: true })
  const inputVideo = path.join(workDir, 'intermediate_video.mp4')
  const inputAudio = path.join(workDir, 'premixed_audio.wav')
  const overlayVideo = path.join(workDir, 'overlay-a.mp4')
  const overlayPng = path.join(workDir, 'overlay-b.png')
  const logoPng = path.join(workDir, 'logo-source.png')
  const shapedLogo = path.join(workDir, 'logo-rounded.png')
  const frameBackground = path.join(workDir, 'frame-background.png')
  const subtitles = path.join(workDir, 'captions.srt')
  const output = path.join(workDir, 'output.mp4')

  await fs.writeFile(inputVideo, twoSecondVideoBytes())
  await fs.writeFile(inputAudio, silentStereoWav(2))
  await fs.writeFile(overlayVideo, twoSecondVideoBytes())
  await sharp({ create: { width: 32, height: 24, channels: 4, background: { r: 20, g: 180, b: 90, alpha: 0.75 } } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(overlayPng)
  await sharp({ create: { width: 40, height: 28, channels: 4, background: { r: 230, g: 190, b: 40, alpha: 1 } } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(logoPng)
  await sharp({ create: { width: 128, height: 96, channels: 4, background: { r: 17, g: 28, b: 52, alpha: 1 } } })
    .png({ compressionLevel: 9, adaptiveFiltering: false }).toFile(frameBackground)
  await fs.writeFile(subtitles, "1\n00:00:00,400 --> 00:00:01,600\nHistory's turn, 40%\nSecond line.\n", 'utf8')

  const job = {
    job_id: 'fleet-characterization-f1', project_slug: 'fleet-characterization', episode_id: 'F1',
    type: 'video_assembly', status: 'running', title: 'F1 rich closed 2s', created_at: '', started_at: '',
    finished_at: null, error: null, output_lines: [], params: {},
  } as unknown as Job
  const callsBefore = (await capturedCalls()).length

  await video._runFinalCompositionForTesting({
    videoInputPath: inputVideo,
    premixedAudioPath: inputAudio,
    logo: {
      enabled: true, image_path: logoPng, position: 'top-left', opacity: 0.8, scale: 0.2,
      margin: 4, hide_during_intro: false, shape: 'rounded', corner_radius_pct: 25,
    },
    targetDuration: 2,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: output,
    colorGrading: {
      enabled: true, preset: 'cinematic', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0,
    },
    vignette: { enabled: true, strength: 0.4 },
    overlays: {
      enabled: true,
      layers: [
        {
          id: 'video-underlay', enabled: true, source_path: overlayVideo, opacity: 0.75, scale: 'contain',
          chroma_key: { color: '#00FF00', similarity: 0.15, blend: 0.1 },
          position_anchor: 'center', time_range: { start_s: 0.1, end_s: 1.7 },
        },
        {
          id: 'rgba-overlay', enabled: true, source_path: overlayPng, opacity: 0.6, scale_pct: 0.25,
          position_anchor: 'lower-right', time_range: { start_s: 0.2, end_s: 1.6 },
        },
      ],
    },
    filmGrain: { enabled: true, strength: 7 },
    agedArchiveFilm: { enabled: true, strength: 20 },
    letterbox: { enabled: true, ratio: '1.85:1', color: 'black', mode: 'fit' },
    frame: {
      enabled: true, inset_pct: 4, border_width: 12, corner_radius: 20,
      border_color: '#F2C14E', background_color: '#111C34', background_path: frameBackground, fit: 'cover',
    },
    subtitles: {
      enabled: true, source: 'upload', srt_path: subtitles,
      style: {
        font_family: 'Helvetica', font_size_px: 28, color_hex: '#FFFFFF',
        outline_color_hex: '#000000', outline_px: 2, background: 'semi',
        position: 'bottom', align: 'center', max_chars_per_line: 20, max_lines: 2, animation: 'fade',
      },
    },
    contextualCues: [{
      id: 'cue-f1', scene_id: 'scene-1', start_sec: 0.2, end_sec: 0.8,
      title: "Archive's turn, 40%", subtitle: 'Line two', kind: 'historical_context',
      placement: 'top-right', template: 'documentary-label', entrance: 'fade', exit: 'dissolve',
      status: 'approved', created_at: '', updated_at: '',
    }],
    excludeIntroFromEffects: true,
    preSceneDuration: 0.25,
    sceneTimelineOffsetSec: 0.35,
    postAudioStart: 1.75,
    encodingEffort: 'ultrafast',
    codec: 'h264',
    job,
  })

  const calls = (await capturedCalls()).slice(callsBefore)
  console.log(`[F1 preparation] private_capture=${capturePath}`)
  console.log(`[F1 preparation] output=${output}`)
  assert.equal(calls.length, 1, 'the first full software tier wins without recovery')
  const actual = calls[0]!
  const inputPaths = actual.filter((_arg, index) => actual[index - 1] === '-i')
  assert.deepEqual(inputPaths, [inputVideo, inputAudio, shapedLogo, overlayVideo, overlayPng, frameBackground])
  assert.ok((await fs.stat(shapedLogo)).size > 0, 'the rounded logo staged in the work folder is the logo input')

  const identity = await workFolderIdentity(actual, workDir, output)
  // The bundled caption faces (1.4.361) are an install path, not part of the composition.
  const fonts = bundledFontsFilterOption()
  const argv = identity.argv.map(arg => fonts ? arg.split(fonts).join(':fontsdir=<bundled-fonts>') : arg)
  const threadFlag = argv.indexOf('-threads')
  assert.ok(threadFlag > 0, 'the actual rich libx264 child receives the runtime thread cap')
  assert.equal(argv[threadFlag - 1], 'libx264')
  assert.equal(argv[threadFlag + 1], String(Math.max(1, os.availableParallelism() - 2)))
  argv[threadFlag + 1] = '<x264-threads>'
  assert.ok(argv.every(arg => !arg.includes(workDir) && !arg.includes(dataDir)), 'the canonical argv contains no private host path')

  const graph = argv[argv.indexOf('-filter_complex') + 1]!
  assertOrdered(graph, [
    '[0:v]setpts=PTS-STARTPTS',
    '[3:v]scale=128:96:force_original_aspect_ratio=decrease',
    'chromakey=color=0x00FF00:similarity=0.15:blend=0.1',
    'colorchannelmixer=aa=0.75',
    "overlay=(W-w)/2:(H-h)/2:enable='between(t,0.25,1.75)*between(t,0.1,1.7)'",
    '[4:v]scale=32:-2,format=rgba,colorchannelmixer=aa=0.6',
    "overlay=W-w-4:H-h-4:enable='between(t,0.25,1.75)*between(t,0.2,1.6)'",
    'eq=brightness=-0.030:contrast=1.200:saturation=0.850',
    'vignette=',
    'noise=alls=7:allf=t+u',
    "eq=brightness='0.010*sin(2*PI*t*8)'",
    'scale=90:68,pad=128:96:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
    'mainframe',
    'ass=filename=<work>/subtitles-burn.ass',
    'drawtext=text=',
    '[logo]overlay=4:4',
    'null[vout]',
  ])
  // The bundled caption faces travel as `fontsdir` (1.4.361, Quote Shorts); still no enable expression.
  assert.match(graph, /ass=filename=<work>\/subtitles-burn\.ass(?::fontsdir=<bundled-fonts>)?\[v\d+\]/, 'libass has no unsupported enable expression')
  assert.ok(graph.includes("enable=between(t\\,0.550\\,1.150)"), 'the contextual cue receives the scene-clock offset')
  assert.ok(graph.includes("Archive\\\\\\'s turn\\, 40%\nLine two"), 'cue punctuation and line break are escaped in the child graph')
  assert.ok((graph.match(/:enable='between\(t,0\.25,1\.75\)'/g) || []).length >= 8, 'dual intro/tail gate reaches supported effects')
  const mapStart = argv.indexOf('-map')
  const encoderStart = argv.indexOf('-c:v', mapStart)
  assert.deepEqual(argv.slice(mapStart, encoderStart), ['-map', '[vout]', '-map', '1:a'])
  assert.deepEqual(argv.slice(-3), ['-t', '2', '<work>/<output>'])

  assert.ok(job.output_lines.some(line => line === 'Effects gated: after 0.3s (intro/title) + before 1.8s (post-audio/outro)'))
  assert.ok(job.output_lines.some(line => line === 'Logo shape: rounded corners (25%)'))
  assert.ok(job.output_lines.some(line => line.startsWith('Frame: 4% inset')))
  assert.ok(job.output_lines.some(line => line.includes('Burning in subtitles: captions.srt')))
  assert.ok(job.output_lines.some(line => line === 'Burning 1 approved contextual cue(s) exactly as reviewed.'))
  assert.ok(job.output_lines.some(line => line === 'Codec: H.264 · preset ultrafast'))
  assert.ok(job.output_lines.some(line => line === 'Encoder: software (libx264)'))
  assert.equal(job.result?.encoder, 'software (libx264)')
  assert.equal(job.result?.degraded, undefined)

  const outputStat = await fs.stat(output)
  assert.ok(outputStat.size > 0, 'the validated rich MP4 is nonempty')
  const probe = JSON.parse(execFileSync(ffprobePath, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,time_base,sample_rate,channels',
    '-of', 'json', output,
  ], { encoding: 'utf8' }))
  const videoStream = probe.streams.find((stream: any) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.equal(probe.streams.length, 2)
  assert.deepEqual({ codec: videoStream.codec_name, width: videoStream.width, height: videoStream.height },
    { codec: 'h264', width: 128, height: 96 })
  assert.deepEqual({ codec: audioStream.codec_name, sample_rate: audioStream.sample_rate, channels: audioStream.channels },
    { codec: 'aac', sample_rate: '48000', channels: 2 })
  assert.ok(Math.abs(Number(probe.format.duration) - 2) <= 0.05, `output duration ${probe.format.duration}`)

  const observed = {
    fixture_id: 'rich_closed_2s',
    source_commit: BASE,
    tool_profile: { ffmpeg_sha256: FFMPEG_SHA256, ffprobe_sha256: FFPROBE_SHA256 },
    fixture: {
      duration_sec: 2, width: 128, height: 96, fps: 5, codec: 'h264', effort: 'ultrafast', crf: 23,
      effects_gate: { start_sec: 0.25, end_sec: 1.75 }, cue_offset_sec: 0.35,
    },
    actual_child_calls: calls.length,
    actual_child_argv: argv,
    referenced_files: identity.files,
    preparation_files: {
      'logo-source.png': await sha256File(logoPng),
      'captions.srt': await sha256File(subtitles),
    },
    media_proof: {
      format_name: probe.format.format_name,
      duration: probe.format.duration,
      video: {
        codec_name: videoStream.codec_name, width: videoStream.width, height: videoStream.height,
        avg_frame_rate: videoStream.avg_frame_rate, time_base: videoStream.time_base,
      },
      audio: {
        codec_name: audioStream.codec_name, sample_rate: audioStream.sample_rate,
        channels: audioStream.channels, time_base: audioStream.time_base,
      },
    },
    job_proof: { encoder: job.result?.encoder, degraded: job.result?.degraded ?? null },
  }
  console.log(`[F1 capture candidate] ${JSON.stringify(observed)}`)
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))
  assert.deepEqual(observed, golden.rich_closed_2s,
    'F1 has no manufactured golden: review the retained actual child capture, then add rich_closed_2s manually')

  console.log(`[F1 evidence] output=${output}`)
  console.log(`[F1 evidence] private_capture=${capturePath}`)
  console.log(`[F1 evidence] child_calls=${calls.length} output_bytes=${outputStat.size}`)
})

test('F2 retains the real 1080p30 editorial ASS and hashes the fonts selected for literal text', {
  skip: F2_SELECTED ? false : F2_GATE_REASON,
  timeout: F2_CASE_TIMEOUT_MS,
}, async t => {
  await withF2CaseOwnership(t, async owner => {
  const id = 'F2-editorial-1080p30'
  const workDir = path.join(dataDir, 'f2-editorial-1080p30')
  await fs.mkdir(workDir, { recursive: true })
  const inputVideo = path.join(workDir, 'intermediate-video-1080p30.mp4')
  const inputAudio = path.join(workDir, 'premixed-audio.wav')
  const subtitles = path.join(workDir, "captions [Story's Cut], 40%.srt")
  const generatedAss = path.join(workDir, 'subtitles-burn.ass')
  const reportPath = path.join(workDir, 'ffmpeg-font-selection.log')
  const output = path.join(workDir, 'output.mp4')
  // Anchored to the repository, not the process cwd (the release harness runs tests from
  // `<repo>/electron`). Qualification-only: an ordinary run never reaches this file's F2 case.
  const retainedRoot = path.join(REPO_ROOT, '_trash', 'f2-editorial-assets')
  await fs.mkdir(retainedRoot, { recursive: true })
  const retainedDir = await fs.mkdtemp(path.join(retainedRoot, 'capture-'))
  const retainedAss = path.join(retainedDir, 'subtitles-burn.ass')
  const retainedFontReport = path.join(retainedDir, 'ffmpeg-font-selection.log')
  const retainedFontEvents = path.join(retainedDir, 'ffmpeg-font-selection-events.json')

  const sourceArgs = [
    '-y', '-f', 'lavfi', '-i', 'color=c=0x17324D:s=1920x1080:r=30:d=2',
    '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', inputVideo,
  ]
  await runBoundedChild(owner, 'source_encode', () => originalSpawn(ffmpegPath, sourceArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  }), { timeoutMs: 60_000, killGraceMs: 1_000 })
  await fs.writeFile(inputAudio, silentStereoWav(2))
  const requestedCaptionLines = ["Archive's [cut], 40%: ../EP02", 'ពន្លឺ Khmer']
  const requestedCaption = requestedCaptionLines.join(' ')
  const subtitleText = `1\n00:00:00,100 --> 00:00:01,900\n${requestedCaptionLines.join('\n')}\n`
  await fs.writeFile(subtitles, subtitleText, 'utf8')

  const sourceProbe = JSON.parse((await runBoundedChild(owner, 'source_probe', () => originalSpawn(ffprobePath, [
    '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate',
    '-of', 'json', inputVideo,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }), { timeoutMs: 30_000, killGraceMs: 1_000 })).stdout)
  assert.deepEqual(sourceProbe.streams, [{
    codec_name: 'h264', codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1',
  }])
  assert.ok(Math.abs(Number(sourceProbe.format.duration) - 2) <= 0.05, `source duration ${sourceProbe.format.duration}`)

  const contextualCues: ContextualCue[] = [
    {
      id: 'cue-documentary', scene_id: 'scene-1', start_sec: 0.05, end_sec: 0.4,
      title: '../Archive/[EP 02]', subtitle: "Story's Cut, 40%", kind: 'historical_context',
      placement: 'top-left', template: 'documentary-label', entrance: 'fade', exit: 'fade',
      status: 'approved', created_at: '', updated_at: '',
    },
    {
      id: 'cue-map', scene_id: 'scene-1', start_sec: 0.45, end_sec: 0.8,
      title: 'C:\\Field Notes\\40%', subtitle: 'Map: Phnom Penh', kind: 'historical_context',
      placement: 'top-right', template: 'map-pin', entrance: 'fade', exit: 'fade',
      status: 'approved', created_at: '', updated_at: '',
    },
    {
      id: 'cue-archive', scene_id: 'scene-1', start_sec: 0.85, end_sec: 1.2,
      title: "/Volumes/Story's Cut, 01", subtitle: 'ពន្លឺ [archive]', kind: 'historical_context',
      placement: 'bottom-left', template: 'archival-caption', entrance: 'fade', exit: 'fade',
      status: 'approved', created_at: '', updated_at: '',
    },
    {
      id: 'cue-chapter', scene_id: 'scene-1', start_sec: 1.25, end_sec: 1.75,
      title: 'Chapter: [04], 100%', subtitle: '../literal/path', kind: 'historical_context',
      placement: 'bottom-right', template: 'chapter-plate', entrance: 'fade', exit: 'fade',
      status: 'approved', created_at: '', updated_at: '',
    },
  ]

  const job = newJob(id, 'F2 editorial 1080p30')
  const callsBefore = (await capturedCalls()).length
  const savedReport = process.env.STORY_STUDIO_TEST_FFMPEG_REPORT
  const savedWatchdog = process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS
  const retention = {
    source: path.resolve(generatedAss), retained: retainedAss, observed: false, error: null as unknown,
  }
  installSubtitleScratchRetainer()
  activeSubtitleScratchRetention = retention
  process.env.STORY_STUDIO_TEST_FFMPEG_REPORT = reportPath
  process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS = String(F2_CHILD_WATCHDOG_MS)
  try {
    owner.begin('final_encode')
    await withOwnedChildBudget(t, id, 1, () => video._runFinalCompositionForTesting({
      videoInputPath: inputVideo,
      premixedAudioPath: inputAudio,
      targetDuration: 2,
      w: 1920,
      h: 1080,
      quality: { crf: 23, preset: 'medium', fps: 30 },
      format: 'mp4',
      outputFile: output,
      subtitles: {
        enabled: true, source: 'upload', srt_path: subtitles,
        style: {
          font_family: 'Helvetica', font_size_px: 28, color_hex: '#FFFFFF',
          outline_color_hex: '#000000', outline_px: 2, background: 'semi',
          position: 'bottom', align: 'center', max_chars_per_line: 36, max_lines: 2, animation: 'fade',
        },
      },
      contextualCues: [...contextualCues],
      encodingEffort: 'medium',
      codec: 'h264',
      job,
    }))
  } finally {
    activeSubtitleScratchRetention = null
    restoreSubtitleScratchRetainer()
    if (savedReport === undefined) delete process.env.STORY_STUDIO_TEST_FFMPEG_REPORT
    else process.env.STORY_STUDIO_TEST_FFMPEG_REPORT = savedReport
    if (savedWatchdog === undefined) delete process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS
    else process.env.STORY_STUDIO_FFMPEG_TIMEOUT_MS = savedWatchdog
  }

  assert.equal(retention.error, null, 'the test-only ASS retention adapter did not lose the generated scratch file')
  assert.equal(retention.observed, true, 'the production cleanup route reached the exact test-only ASS retention adapter')
  assert.equal(await sha256File(generatedAss), await sha256File(retainedAss),
    'the generated ASS remains in the sandbox and has a byte-identical project-trash copy')
  const assText = await fs.readFile(generatedAss, 'utf8')
  assert.match(assText, /^PlayResX: 1920$/m)
  assert.match(assText, /^PlayResY: 1080$/m)
  assert.match(assText, /^Style: Default,Helvetica,/m)
  const dialogueLines = assText.split(/\r?\n/).filter(line => line.startsWith('Dialogue: '))
  assert.equal(dialogueLines.length, 1, 'the generated ASS contains the fixture\'s one dialogue event')
  const dialoguePayload = /^Dialogue: (?:[^,]*,){9}(.*)$/.exec(dialogueLines[0]!)?.[1]
  assert.ok(dialoguePayload, 'the generated ASS exposes its dialogue payload after the nine format fields')
  const generatedFade = '{\\fad(180,180)}'
  assert.equal(dialoguePayload.startsWith(generatedFade), true, 'the dialogue begins with only the requested fade formatting')
  assert.equal(dialoguePayload.slice(generatedFade.length).replaceAll('\\N', ' '), requestedCaption,
    'the generated ASS preserves the complete requested caption in order across layout wrapping')
  assert.ok(dialoguePayload.includes('\\N'), 'the actual ASS retains a compiled caption line break')

  const calls = (await capturedCalls()).slice(callsBefore)
  assert.equal(calls.length, 1, 'the first full medium-CPU tier wins through one real final FFmpeg child')
  const actual = calls[0]!
  const identity = await normalizedCall(actual, workDir, output)
  assert.deepEqual(actual.filter((_arg, index) => actual[index - 1] === '-i'), [inputVideo, inputAudio])
  const graph = flagValue(identity.argv, '-filter_complex')!
  const cueLabels = contextualCues.map(cue => cue.subtitle ? `${cue.title}\n${cue.subtitle}` : cue.title)
  assertOrdered(graph, [
    'ass=filename=<work>/subtitles-burn.ass',
    ...cueLabels.map(label => `drawtext=text=${escapeFilterArgValue(label)}:expansion=none`),
    'null[vout]',
  ])
  assert.equal((graph.match(/expansion=none/g) || []).length, 5,
    'the map pin and all four reviewed cue labels disable text expansion')
  assert.equal(graph.includes('subtitles=filename='), false)
  assert.equal(graph.includes('movie=filename='), false)
  for (const label of cueLabels) {
    const escaped = escapeFilterArgValue(label)
    assert.equal(graph.split(escaped).length - 1, 1, `${JSON.stringify(label)} occurs only as one literal drawtext value`)
    assert.equal(Object.keys(identity.files).some(name => name.includes(label)), false,
      `${JSON.stringify(label)} is not a hashed asset identity`)
  }
  assert.deepEqual(identity.argv.slice(identity.argv.indexOf('-map'), identity.argv.indexOf('-c:v')),
    ['-map', '[vout]', '-map', '1:a'])
  assert.equal(flagValue(identity.argv, '-c:v'), 'libx264')
  assert.equal(flagValue(identity.argv, '-preset'), 'medium')
  assert.equal(flagValue(identity.argv, '-crf'), '23')
  assert.equal(job.result?.encoder, 'software (libx264)')
  assert.equal(job.result?.degraded, undefined)

  owner.assertCanLaunch('font evidence completion')
  await fs.copyFile(reportPath, retainedFontReport)
  const fontEvidence = await fontSelectionEvidence(reportPath)
  await fs.writeFile(retainedFontEvents, `${JSON.stringify(fontEvidence, null, 2)}\n`, 'utf8')
  owner.assertCanLaunch('output_probe')
  console.log(`[F2 font evidence] complete=${fontEvidence.complete} selections=${JSON.stringify(fontEvidence.selected)}`)
  const selectedDrawtextFilterIds = fontEvidence.selected.filter(item => item.renderer === 'drawtext').map(item => item.filter_id)
  assert.ok(selectedDrawtextFilterIds.every(filterId => filterId !== null), 'every drawtext selection event names its filter instance')
  assert.equal(new Set(selectedDrawtextFilterIds).size, (graph.match(/drawtext=/g) || []).length,
    'font-selection evidence covers every emitted drawtext filter instance')
  const probe = JSON.parse((await runBoundedChild(owner, 'output_probe', () => originalSpawn(ffprobePath, [
    '-v', 'error', '-show_entries',
    'format=format_name,duration:stream=index,codec_type,codec_name,width,height,avg_frame_rate,time_base,sample_rate,channels',
    '-of', 'json', output,
  ], { stdio: ['ignore', 'pipe', 'pipe'] }), { timeoutMs: 30_000, killGraceMs: 1_000 })).stdout)
  const videoStream = probe.streams.find((stream: any) => stream.codec_type === 'video')
  const audioStream = probe.streams.find((stream: any) => stream.codec_type === 'audio')
  assert.equal(probe.streams.length, 2)
  assert.deepEqual(
    { codec_name: videoStream?.codec_name, width: videoStream?.width, height: videoStream?.height, avg_frame_rate: videoStream?.avg_frame_rate },
    { codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
  )
  assert.deepEqual(
    { codec_name: audioStream?.codec_name, sample_rate: audioStream?.sample_rate, channels: audioStream?.channels },
    { codec_name: 'aac', sample_rate: '48000', channels: 2 },
  )
  assert.ok(Math.abs(Number(probe.format.duration) - 2) <= 0.05, `output duration ${probe.format.duration}`)
  assert.deepEqual(owner.counts, {
    source_encode: 1, source_probe: 1, final_encode: 1, output_probe: 1,
  }, 'F2 runs exactly one preparation encode, one final encode, and its two declared probes')

  const stableFontSelections = fontEvidence.selected.map(({ raw_line: _rawLine, ...selection }) => selection)

  const observed = {
    fixture_id: 'editorial_1080p30',
    source_commit: F2_BASE,
    tool_profile: { ffmpeg_sha256: FFMPEG_SHA256, ffprobe_sha256: FFPROBE_SHA256 },
    fixture: {
      duration_sec: 2, width: 1920, height: 1080, fps: 30,
      format: 'mp4', codec: 'h264', requested_effort: 'medium', crf: 23,
      subtitle_font_request: 'Helvetica', cue_font_request: null,
      cue_templates: contextualCues.map(cue => cue.template),
      evidence_class: 'real_output',
    },
    source_preparation_argv: sourceArgs.map(arg => arg === inputVideo ? '<work>/intermediate-video-1080p30.mp4' : arg),
    actual_child_calls: calls.length,
    actual_child_argv: identity.argv,
    referenced_files: identity.files,
    retained_editorial_assets: {
      source_srt_sha256: await sha256File(subtitles),
      generated_ass_sha256: await sha256File(generatedAss),
      generated_ass_bytes: (await fs.stat(generatedAss)).size,
      font_provider: fontEvidence.provider,
      font_bindings_qualified: fontEvidence.complete,
      glyph_warning_present: fontEvidence.glyph_warning_present,
      selected_fonts: stableFontSelections,
    },
    media_facts: {
      format_name: probe.format.format_name,
      video: { codec_name: videoStream.codec_name, width: videoStream.width, height: videoStream.height, avg_frame_rate: videoStream.avg_frame_rate },
      audio: { codec_name: audioStream.codec_name, sample_rate: audioStream.sample_rate, channels: audioStream.channels },
    },
    tier_facts: { selected_encoder: 'libx264', encoder_kind: job.result?.encoder, degraded: job.result?.degraded ?? null },
  }
  console.log(`[F2 characterization evidence] ${JSON.stringify(observed)}`)
  console.log(`[F2 evidence] output=${output}`)
  console.log(`[F2 evidence] font_report=${reportPath}`)
  console.log(`[F2 evidence] retained_ass=${retainedAss}`)
  console.log(`[F2 evidence] retained_font_report=${retainedFontReport}`)
  console.log(`[F2 evidence] retained_font_events=${retainedFontEvents}`)
  // Qualification is fail-closed. The observation above is retained either way; what follows says
  // plainly which qualification evidence is missing and refuses to pass without it. Nothing here
  // invents a font binding or a golden.
  assert.equal(fontEvidence.complete, true,
    'F2 qualification is incomplete: the retained font report has unresolved bindings, so this '
    + 'observation cannot be compared with or accepted as a fidelity golden')
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))
  assert.notEqual(golden.editorial_1080p30, undefined,
    'F2 qualification has no reviewed golden for editorial_1080p30: root must review the retained '
    + 'ASS/font/output evidence listed above before adding one. No golden is fabricated here.')
  assert.deepEqual(observed, golden.editorial_1080p30,
    'F2 qualification differs from the reviewed editorial_1080p30 golden')
  })
})

async function runNativeHardwareCase(t: TestContext, opts: {
  id: 'F4-hardware-q-h265-request' | 'F4-hardware-bitrate'
  goldenKey: 'f4_hardware_q_h265_request' | 'f4_hardware_bitrate_2500'
  codec: 'h264' | 'h265'
  videoBitrateKbps?: number
}): Promise<void> {
  await withOwnedChildBudget(t, opts.id, 1, async () => {
  const fixture = await prepareF4Inputs(opts.id)
  const callsBefore = (await capturedCalls()).length
  await runF4Composition({
    videoInputPath: fixture.inputVideo,
    premixedAudioPath: fixture.inputAudio,
    targetDuration: 2,
    w: 128,
    h: 96,
    quality: { crf: 23, preset: 'ultrafast', fps: 5 },
    format: 'mp4',
    outputFile: fixture.output,
    encodingEffort: 'hardware',
    codec: opts.codec,
    videoBitrateKbps: opts.videoBitrateKbps,
    job: fixture.job,
  })

  const calls = (await capturedCalls()).slice(callsBefore)
  const probe = await probeF4Output(fixture.output)
  await logF4Receipt(opts.id, fixture.output, fixture.job, probe.receipt)
  console.log(`[F4 receipt] case=${opts.id} private_capture=${capturePath} child_calls=${calls.length}`)
  assert.equal(calls.length, 1,
    'native hardware qualification requires the first actual child to win; retain a CPU fallback as failure evidence')

  const actual = calls[0]!
  const identity = await normalizedCall(actual, fixture.workDir, fixture.output)
  assert.equal(outputCodec(actual), 'h264_videotoolbox')
  assert.equal(actual.includes('-allow_sw'), false)
  assert.equal(actual.includes('-crf'), false)
  assert.equal(actual.includes('-preset'), false)
  assert.equal(actual.includes('-threads'), false)
  assert.deepEqual(actual.slice(actual.indexOf('-map'), actual.indexOf('-c:v')), ['-map', '[vout]', '-map', '1:a'])
  assert.equal(flagValue(actual, '-filter_complex'), '[0:v]setpts=PTS-STARTPTS[v0];\n[v0]null[vout]')

  if (opts.videoBitrateKbps === undefined) {
    assert.equal(flagValue(actual, '-q:v'), '65')
    assert.equal(actual.includes('-b:v'), false)
    assert.equal(actual.includes('-maxrate'), false)
    assert.equal(actual.includes('-bufsize'), false)
  } else {
    assert.equal(actual.includes('-q:v'), false)
    assert.equal(flagValue(actual, '-b:v'), '2500k')
    assert.equal(flagValue(actual, '-maxrate'), '3750k')
    assert.equal(flagValue(actual, '-bufsize'), '5000k')
  }
  assert.equal(fixture.job.result?.encoder, 'hardware (VideoToolbox h264)')
  assert.equal(fixture.job.result?.degraded, undefined)

  const observed = {
    fixture_id: opts.id,
    source_commit: F4_BASE,
    tool_profile: { ffmpeg_sha256: FFMPEG_SHA256, ffprobe_sha256: FFPROBE_SHA256 },
    fixture: {
      duration_sec: 2,
      width: 128,
      height: 96,
      fps: 5,
      format: 'mp4',
      requested_codec: opts.codec,
      requested_effort: 'hardware',
      crf: 23,
      video_bitrate_kbps: opts.videoBitrateKbps ?? null,
      injection: null,
      evidence_class: 'real_output',
    },
    actual_child_calls: calls.length,
    attempts: [{ classification: 'successful_final_attempt', argv: identity.argv }],
    referenced_files: identity.files,
    media_facts: probe.stable,
    tier_facts: {
      selected_encoder: 'h264_videotoolbox',
      encoder_kind: 'hardware (VideoToolbox h264)',
      degraded: null,
    },
  }
  console.log(`[F4 capture candidate] key=${opts.goldenKey} ${JSON.stringify(observed)}`)
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))
  assert.deepEqual(observed, golden[opts.goldenKey],
    `F4 has no manufactured golden: review the retained actual capture, then add ${opts.goldenKey} manually`)
  })
}

test('F4 actual native hardware maps an H.265 request to quality-based H.264 VideoToolbox', {
  skip: !SELECTED_CASES.has('F4-hardware-q-h265-request'),
  timeout: F4_CASE_TIMEOUT_MS,
}, async t => {
  await runNativeHardwareCase(t, {
    id: 'F4-hardware-q-h265-request',
    goldenKey: 'f4_hardware_q_h265_request',
    codec: 'h265',
  })
})

test('F4 actual native hardware applies the requested H.264 bitrate controls', {
  skip: !SELECTED_CASES.has('F4-hardware-bitrate'),
  timeout: F4_CASE_TIMEOUT_MS,
}, async t => {
  await runNativeHardwareCase(t, {
    id: 'F4-hardware-bitrate',
    goldenKey: 'f4_hardware_bitrate_2500',
    codec: 'h264',
    videoBitrateKbps: 2500,
  })
})

test('F4 injected VideoToolbox rejection keeps the full graph for the real CPU winner', {
  skip: !SELECTED_CASES.has('F4-injected-hardware-fallback'),
  timeout: F4_CASE_TIMEOUT_MS,
}, async t => {
  const id = 'F4-injected-hardware-fallback'
  await withOwnedChildBudget(t, id, 2, async () => {
  const fixture = await prepareF4Inputs(id)
  const callsBefore = (await capturedCalls()).length
  const savedFailureMode = process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE
  process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE = 'reject-videotoolbox'
  try {
    await runF4Composition({
      videoInputPath: fixture.inputVideo,
      premixedAudioPath: fixture.inputAudio,
      targetDuration: 2,
      w: 128,
      h: 96,
      quality: { crf: 23, preset: 'ultrafast', fps: 5 },
      format: 'mp4',
      outputFile: fixture.output,
      vignette: { enabled: true, strength: 0.4 },
      encodingEffort: 'hardware',
      codec: 'h264',
      job: fixture.job,
    })
  } finally {
    if (savedFailureMode === undefined) delete process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE
    else process.env.STORY_STUDIO_TEST_FFMPEG_FAILURE = savedFailureMode
  }

  const calls = (await capturedCalls()).slice(callsBefore)
  const probe = await probeF4Output(fixture.output)
  await logF4Receipt(id, fixture.output, fixture.job, probe.receipt)
  console.log(`[F4 receipt] case=${id} private_capture=${capturePath} child_calls=${calls.length}`)
  console.log(`[F4 receipt] case=${id} injected_marker_seen=${fixture.job.output_lines.some(line => line.includes(VT_REJECT_MARKER))}`)
  assert.equal(calls.length, 2, 'one injected hardware failure must be followed by one real CPU full-graph child')

  const failed = await normalizedCall(calls[0]!, fixture.workDir, fixture.output)
  const winner = await normalizedCall(calls[1]!, fixture.workDir, fixture.output)
  const failedGraph = flagValue(failed.argv, '-filter_complex')
  const winnerGraph = flagValue(winner.argv, '-filter_complex')
  assert.equal(outputCodec(failed.argv), 'h264_videotoolbox')
  assert.equal(outputCodec(winner.argv), 'libx264')
  assert.equal(failedGraph, winnerGraph, 'CPU fallback must preserve the exact full filter graph')
  assert.match(failedGraph || '', /vignette=/)
  assert.deepEqual(
    failed.argv.slice(0, failed.argv.lastIndexOf('-c:v')),
    winner.argv.slice(0, winner.argv.lastIndexOf('-c:v')),
    'CPU fallback must preserve inputs, graph, and maps before the encoder selection',
  )
  assert.equal(flagValue(failed.argv, '-q:v'), '65')
  assert.equal(flagValue(winner.argv, '-crf'), '23')
  assert.equal(flagValue(winner.argv, '-preset'), 'ultrafast')
  assert.ok(fixture.job.output_lines.some(line => line.includes(VT_REJECT_MARKER)),
    'the recovery log must retain the exact injected rejection marker')
  assert.ok(fixture.job.output_lines.some(line => line.includes('hardware fallback, full effects')),
    'the recovery log must identify the winning full-graph CPU tier')
  assert.match(fixture.job.result?.encoder || '', /^software \(libx264\) — hardware unavailable:/)
  assert.match(fixture.job.result?.encoder || '', new RegExp(VT_REJECT_MARKER))
  assert.equal(fixture.job.result?.degraded, undefined,
    'the current bookkeeping does not mark a fallback degraded when it drops no requested burn-in')

  const observed = {
    fixture_id: id,
    source_commit: F4_BASE,
    tool_profile: { ffmpeg_sha256: FFMPEG_SHA256, ffprobe_sha256: FFPROBE_SHA256 },
    fixture: {
      duration_sec: 2,
      width: 128,
      height: 96,
      fps: 5,
      format: 'mp4',
      requested_codec: 'h264',
      requested_effort: 'hardware',
      crf: 23,
      effect: { vignette: { enabled: true, strength: 0.4 } },
      injection: 'reject-videotoolbox',
      evidence_class: 'injected_failure_real_output',
    },
    actual_child_calls: calls.length,
    attempts: [
      { classification: 'injected_failed_final_attempt', argv: failed.argv },
      { classification: 'successful_final_attempt', argv: winner.argv },
    ],
    referenced_files: failed.files,
    media_facts: probe.stable,
    tier_facts: {
      selected_encoder: 'libx264',
      encoder_kind: 'software (libx264)',
      recovery_tier: 'H.264 · libx264 ultrafast (hardware fallback, full effects)',
      requested: ['vignette'],
      survived: ['vignette'],
      dropped: [],
      structured_degradation: null,
    },
  }
  assert.deepEqual(winner.files, failed.files)
  console.log(`[F4 capture candidate] key=f4_injected_hardware_fallback ${JSON.stringify(observed)}`)
  const golden = JSON.parse(await fs.readFile(GOLDEN, 'utf8'))
  assert.deepEqual(observed, golden.f4_injected_hardware_fallback,
    'F4 has no manufactured golden: review the retained actual capture, then add f4_injected_hardware_fallback manually')
  })
})

/**
 * The F2 gate itself. Deterministic, no media, and part of the ordinary suite: it pins that the
 * default selection never carries F2, that F0/F1/F4 selection is untouched, and that naming F2
 * without the qualification flag fails visibly instead of silently skipping.
 */
test('F2 qualification is gated behind its explicit flag and never rides the default selection', () => {
  const all = characterizationCases(undefined, true).selected
  assert.deepEqual(all, [...CASE_IDS])
  assert.deepEqual(characterizationCases(undefined, false).selected,
    all.filter(id => id !== 'F2-editorial-1080p30'))
  assert.equal(characterizationCases(undefined, false).gated, true)
  assert.deepEqual(characterizationCases('F0,F4-hardware-bitrate', false).selected,
    ['F0', 'F4-hardware-bitrate'])
  assert.equal(characterizationCases('F0', false).gated, false)
  assert.throws(() => characterizationCases('F2-editorial-1080p30', false),
    /STORY_STUDIO_F2_QUALIFICATION=1/)
  assert.deepEqual(characterizationCases('F2-editorial-1080p30', true).selected,
    ['F2-editorial-1080p30'])
})
