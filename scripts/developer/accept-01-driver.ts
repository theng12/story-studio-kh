/**
 * ACCEPT-01 — cross-workflow acceptance driver.
 *
 * Hosts the in-process mock GenStudio as a real HTTP gateway, points a running
 * Story Studio dev app at it, then drives the app's own routes (never the
 * database or the filesystem directly) so every artifact is produced by the
 * real pipeline. Zero network, zero spend.
 *
 * Prerequisites (see docs/handoffs/deepseek-reports/ACCEPT-01.md):
 *   1. the dev app running on a disposable Library, backend on ACCEPT_APP_URL
 *   2. the project seeded with two episodes (ACCEPT-01.md → seeding)
 *
 * Usage: npx tsx scripts/developer/accept-01-driver.ts [--leg script]
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { MockGenStudioService } from '../../electron/server/__tests__/fixtures/mock-genstudio-service.js'

const APP = process.env.ACCEPT_APP_URL || 'http://127.0.0.1:8791/api'
const LIBRARY = process.env.ACCEPT_LIBRARY || '/tmp/ssk-accept-data'
const SLUG = process.env.ACCEPT_SLUG || 'accept-01-walkthrough-2026-09-22'
const MOCK_PORT = Number(process.env.ACCEPT_MOCK_PORT || 8801)
const EPISODES = (process.env.ACCEPT_EPISODES || 'EP0001,EP0002').split(',')
const MODEL = process.env.ACCEPT_CHAT_MODEL || 'mock-chat-v1'
const TTS_MODEL = process.env.ACCEPT_TTS_MODEL || 'mock-tts-v1'
// Scene Plan's timeline needs one transcript per audio section, so the walkthrough
// takes the Subtitles page's own per-chapter option.
const PER_CHAPTER = process.env.ACCEPT_PER_CHAPTER !== 'false'
const IMAGE_MODEL = process.env.ACCEPT_IMAGE_MODEL || 'mock-image-v1'
const THUMBNAILS = Number(process.env.ACCEPT_THUMBNAILS || 3)
const CHAPTERS = Number(process.env.ACCEPT_CHAPTERS || 3)

const args = process.argv.slice(2)
const legFlag = args.indexOf('--leg')
const LEG = legFlag === -1 ? 'script' : args[legFlag + 1]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function call(method: string, route: string, body?: unknown) {
  const res = await fetch(`${APP}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: any = null
  try { parsed = JSON.parse(text) } catch {}
  return { status: res.status, body: parsed, text }
}

const projectDir = path.join(LIBRARY, 'projects', SLUG)

/** Every file under a directory, with byte sizes — the "usable bytes" check. */
function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

/**
 * Thumbnail-prompt state the app itself published: how many slots it requires and
 * which are already on disk. A retry then answers exactly the missing slots, the
 * way the generator's own message says it will ask.
 */
function readThumbnailPromptState(code: string): { expected: number; present: number[] } {
  const dir = episodeDir(code)
  if (!dir) return { expected: 0, present: [] }
  const files = walk(dir)
  const completion = files.find(f => f.endsWith('_Thumbnail_Prompts.completion.json'))
  const markdown = files.find(f => f.endsWith('_Thumbnail_Prompts.md'))
  let expected = 0
  if (completion) {
    try { expected = Number(JSON.parse(fs.readFileSync(completion, 'utf8'))?.expected) || 0 } catch { expected = 0 }
  }
  const present: number[] = []
  if (markdown) {
    const text = fs.readFileSync(markdown, 'utf8')
    for (const match of text.matchAll(/^## Thumbnail (\d+):/gm)) present.push(Number(match[1]))
  }
  return { expected, present: [...new Set(present)].sort((a, b) => a - b) }
}

/** Scene ids from the plan the app wrote — the visual contract is per-scene. */
function readSceneIds(code: string): string[] {
  const dir = episodeDir(code)
  if (!dir) return []
  const candidates = walk(dir).filter(f => path.basename(f) === 'scene_plan.json')
  if (!candidates.length) return []
  try {
    const plan = JSON.parse(fs.readFileSync(candidates[0]!, 'utf8'))
    return (Array.isArray(plan?.scenes) ? plan.scenes : [])
      .map((scene: any) => String(scene?.id || '')).filter(Boolean)
  } catch { return [] }
}

const episodeDir = (code: string) => {
  const season = path.join(projectDir, 'episodes')
  if (!fs.existsSync(season)) return null
  for (const seasonName of fs.readdirSync(season)) {
    const dir = path.join(season, seasonName)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(code)) return path.join(dir, entry)
    }
  }
  return null
}

async function waitForJob(jobId: string, timeoutMs = 180_000) {
  const terminal = new Set(['done', 'error', 'cancelled'])
  const started = Date.now()
  let job: any = null
  while (Date.now() - started < timeoutMs) {
    await sleep(1500)
    const res = await call('GET', `/projects/${SLUG}/jobs`)
    const rows: any[] = res.body?.jobs || res.body || []
    job = rows.find(r => r.job_id === jobId) || job
    if (job && terminal.has(job.status)) return job
  }
  return job
}

/**
 * The provider is either attached (a long-lived `serve-mock-genstudio.ts`, so
 * provider job ids recorded in project manifests still resolve after an app
 * restart — the property ACCEPT-01's restart/resume leg exists to observe) or
 * started in-process for a self-contained run.
 */
type Provider = {
  url: string
  queue(operation: string, scenario: unknown): Promise<void>
  clear(operation: string): Promise<void>
  state(): Promise<any>
  close(): Promise<void>
}

const control = async (base: string, route: string, body?: unknown) => {
  const res = await fetch(`${base}/__control/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    // A silently failed queue leaves the provider answering with the fixture's
    // default text, which looks like an app defect. Fail loudly instead.
    throw new Error(`provider control ${route} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  }
  return res.json().catch(() => null)
}

let provider: Provider
if (process.env.ACCEPT_MOCK_URL) {
  const base = process.env.ACCEPT_MOCK_URL.replace(/\/$/, '')
  provider = {
    url: base,
    queue: async (operation, scenario) => { await control(base, 'scenario', { operation, scenario }) },
    clear: async operation => { await control(base, 'clear', { operation }) },
    state: async () => await control(base, 'state'),
    close: async () => {},
  }
} else {
  const mock = new MockGenStudioService()
  mock.server.listen(MOCK_PORT, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    mock.server.once('listening', resolve)
    mock.server.once('error', reject)
  })
  mock.baseUrl = `http://127.0.0.1:${MOCK_PORT}`
  provider = {
    url: mock.baseUrl,
    queue: async (operation, scenario) => { mock.queueScenario(operation as any, scenario as any) },
    clear: async operation => { mock.clearQueuedScenarios(operation as any) },
    state: async () => {
      const live = mock.submissions.filter(s => !s.replay)
      const byOp = (op: string) => live.filter(s => s.operation === op).length
      return {
        submissions: live.length,
        by_operation: { chat: byOp('chat'), tts: byOp('tts'), transcription: byOp('transcription'), image: byOp('image'), video: byOp('video'), music: byOp('music') },
        credits_charged: mock.totalCreditsCharged,
        requests: mock.requests.map(r => `${r.method} ${r.path}`),
      }
    },
    close: async () => { await mock.close() },
  }
}

const outlineFor = (n: number) => JSON.stringify({
  chapters: Array.from({ length: n }, (_, i) => ({
    n: i + 1,
    title: `Chapter ${i + 1}: what the ledger kept`,
    synopsis: `Chapter ${i + 1} follows one entry in the ledger and the person who wrote it.`,
    key_beats: ['the entry is written', 'the town disagrees', 'the loss arrives'],
  })),
})

const expansionFor = (n: number) => Array.from({ length: n }, (_, i) =>
  `## Chapter ${String(i + 1).padStart(2, '0')}: what the ledger kept\n\n` +
  `The ledger was open on the counter and the ink was dry where nobody had written yet. ` +
  `This is chapter ${i + 1} of an acceptance walkthrough: it exists to move real bytes through ` +
  `the pipeline, not to be published.\n`).join('\n')

// The expansion is chunked into as many provider batches as the model's output
// budget needs, and the app does not say how many in advance, so queue a
// generous batch for the step and clear whatever is left over afterwards — the
// next step must never consume a previous step's scripted answer.
const EXPANSION_SCENARIOS = CHAPTERS + 2

console.log(`== ACCEPT-01 driver — leg "${LEG}"`)
console.log(`[mock] gateway ${provider.url}${process.env.ACCEPT_MOCK_URL ? ' (attached, long-lived)' : ' (in-process)'}`)
console.log('[app] genstudio url', JSON.stringify((await call('PUT', '/app-settings/genstudio', { url: provider.url })).body))
console.log('[app] key', JSON.stringify((await call('PUT', '/app-settings/api-keys/genstudio', { apiKey: 'gsk_mock_story_full_scope' })).body))
const overview = await call('GET', '/app-settings/genstudio/overview')
console.log('[app] live gateway identity:', JSON.stringify(overview.body?.overview?.subscription_plan_name), 'credits', overview.body?.overview?.credit_balance)

const episodes = await call('GET', `/projects/${SLUG}/episodes`)
const titles: Record<string, string> = {}
for (const ep of (episodes.body || [])) titles[ep.episode_code] = ep.title
console.log('[app] episodes:', Object.entries(titles).map(([c, t]) => `${c}=${t}`).join(' | '))

if (LEG === 'script' || LEG === 'all') {
  for (const code of EPISODES) {
    const title = titles[code] || code
    console.log(`\n-- ${code}: outline-only`)
    await provider.queue('chat', { states: ['succeeded'], outputText: outlineFor(CHAPTERS) })
    const outline = await call('POST', `/projects/${SLUG}/generate/outline-only`, {
      episode_id: code, title, model: MODEL, length: 8, chapters: CHAPTERS, style: 'auto',
    })
    console.log('   enqueue', outline.status, JSON.stringify(outline.body).slice(0, 160))
    if (outline.status !== 201) continue
    const outlineJob = await waitForJob(outline.body.job_id)
    console.log(`   job ${outlineJob?.status}`, (outlineJob?.output_lines || []).slice(-2).join(' | '))

    const read = await call('GET', `/projects/${SLUG}/episodes/${code}/outline?title=${encodeURIComponent(title)}`)
    const entries = read.body?.outline
    const slots = Array.isArray(entries) ? entries.length : 0
    console.log(`   outline read ${read.status}, slots ${slots}`)
    const approve = await call(
      'PUT',
      `/projects/${SLUG}/episodes/${code}/outline?title=${encodeURIComponent(title)}`,
      { outline: entries, approved: true },
    )
    console.log(`   approve ${approve.status}`, approve.status === 200 ? 'approved' : approve.text.slice(0, 160))

    console.log(`-- ${code}: expand-chapters`)
    for (let i = 0; i < EXPANSION_SCENARIOS; i++) {
      await provider.queue('chat', { states: ['succeeded'], outputText: expansionFor(CHAPTERS) })
    }
    const expand = await call('POST', `/projects/${SLUG}/generate/expand-chapters`, { episode_id: code, title })
    console.log('   enqueue', expand.status, JSON.stringify(expand.body).slice(0, 160))
    if (expand.status !== 201) continue
    const expandJob = await waitForJob(expand.body.job_id)
    console.log(`   job ${expandJob?.status}`, (expandJob?.output_lines || []).slice(-3).join(' | '))
    await provider.clear('chat')
  }
}

if (LEG === 'audio' || LEG === 'all') {
  const ttsModels = await call('GET', '/app-settings/genstudio/tts-models')
  const rows = ttsModels.body?.models || []
  console.log('\n[app] TTS catalogue:', rows.map((m: any) => `${m.id}(${m.display_name})`).join(', '))
  const voices = await call('GET', `/app-settings/genstudio/voices?model_id=${TTS_MODEL}`)
  const voiceRows = voices.body?.voices || []
  console.log(`[app] voices for ${TTS_MODEL}:`, voiceRows.map((v: any) => `${v.id}(${v.display_name})`).join(', '))
  const voice = voiceRows[0]?.id
  if (!voice) { console.log('!! no voice published for the TTS model — stopping this leg'); }

  for (const code of (voice ? EPISODES : [])) {
    const title = titles[code] || code
    console.log(`\n-- ${code}: generate audio (model ${TTS_MODEL}, voice ${voice})`)
    const gen = await call('POST', `/projects/${SLUG}/generate/audio`, {
      episode_id: code, title, model: TTS_MODEL, voice, speed: 1,
    })
    console.log('   enqueue', gen.status, JSON.stringify(gen.body).slice(0, 200))
    if (gen.status !== 201) continue
    const genJob = await waitForJob(gen.body.job_id, 300_000)
    console.log(`   job ${genJob?.status}`, (genJob?.output_lines || []).slice(-3).join(' | '))
    if (genJob?.error) console.log('   error:', String(genJob.error).slice(0, 200))

    console.log(`-- ${code}: audio-merge`)
    // The mock gateway's audio is silence, and this format's merge defaults turn
    // on two-pass loudnorm, which cannot measure a silent stream (FFmpeg exits
    // 222 with `measured_I = -inf`). Turning normalization off is a first-class
    // choice the UI offers, so the walkthrough takes it and records why.
    const merge = await call('POST', `/projects/${SLUG}/generate/audio-merge`, {
      episode_id: code, normalize_volume: false,
    })
    console.log('   enqueue', merge.status, JSON.stringify(merge.body).slice(0, 200))
    if (merge.status !== 201) continue
    const mergeJob = await waitForJob(merge.body.job_id, 300_000)
    console.log(`   job ${mergeJob?.status}`, (mergeJob?.output_lines || []).slice(-3).join(' | '))
    if (mergeJob?.error) console.log('   error:', String(mergeJob.error).slice(0, 200))
  }
}

if (LEG === 'subtitles' || LEG === 'all') {
  const models = await call('GET', '/app-settings/genstudio/transcription-models')
  const rows = models.body?.models || models.body?.transcription_models || models.body || []
  console.log('\n[app] transcription catalogue:', JSON.stringify(rows).slice(0, 300))
  const model = Array.isArray(rows) ? rows[0]?.id : undefined
  if (!model) { console.log('!! no transcription model published — stopping this leg') }
  for (const code of (model ? EPISODES : [])) {
    console.log(`\n-- ${code}: transcribe (model ${model})`)
    const res = await call('POST', `/projects/${SLUG}/video-editor/subtitles/transcribe/${code}`, {
      model, language: 'en', per_chapter: PER_CHAPTER,
    })
    console.log('   enqueue', res.status, JSON.stringify(res.body).slice(0, 200))
    if (res.status !== 201) continue
    const job = await waitForJob(res.body.job_id, 300_000)
    console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-3).join(' | '))
    if (job?.error) console.log('   error:', String(job.error).slice(0, 200))
  }
}

if (LEG === 'scene-plan' || LEG === 'all') {
  for (const code of EPISODES) {
    const title = titles[code] || code
    console.log(`\n-- ${code}: scene plan timeline`)
    const stitch = await call('POST', `/projects/${SLUG}/scene-plan/${code}/stitch-subtitles`, {})
    console.log('   stitch', stitch.status, JSON.stringify(stitch.body).slice(0, 160))
    const timeline = await call('POST', `/projects/${SLUG}/scene-plan/${code}/run`, { stage: 'timeline' })
    console.log('   timeline enqueue', timeline.status, JSON.stringify(timeline.body).slice(0, 120))
    if (timeline.status === 201) {
      const job = await waitForJob(timeline.body.job_id, 300_000)
      console.log(`   timeline job ${job?.status}`, (job?.output_lines || []).slice(-2).join(' | '))
    }

    // The provider answer is built from the plan the app just wrote, exactly as a
    // fake provider must: the visual contract requires one row per requested
    // scene id, no more and no fewer.
    const sceneIds = readSceneIds(code)
    console.log(`   scenes in plan: ${sceneIds.length} — ${sceneIds.join(', ')}`)
    if (!sceneIds.length) continue
    for (let i = 0; i < 4; i++) {
      await provider.queue('chat', {
        states: ['succeeded'],
        outputText: JSON.stringify({
          results: sceneIds.map((id, index) => ({
            scene_id: id,
            visual_prompt: `Editorial still ${index + 1}: a ledger open on a harbour counter, cold morning light, ink still wet, muted coastal palette, no legible text.`,
          })),
        }),
      })
    }

    console.log(`-- ${code}: scene plan visual`)
    const visual = await call('POST', `/projects/${SLUG}/scene-plan/${code}/run`, {
      stage: 'visual', model: MODEL, use_research: false, detail_level: 4,
    })
    console.log('   enqueue', visual.status, JSON.stringify(visual.body).slice(0, 120))
    if (visual.status !== 201) continue
    const visualJob = await waitForJob(visual.body.job_id, 300_000)
    console.log(`   job ${visualJob?.status}`, (visualJob?.output_lines || []).slice(-3).join(' | '))
    if (visualJob?.error) console.log('   error:', String(visualJob.error).slice(0, 200))
    await provider.clear('chat')
  }
}

if (LEG === 'images' || LEG === 'all') {
  for (const code of EPISODES) {
    const title = titles[code] || code
    console.log(`\n-- ${code}: thumbnail prompts`)
    const before = readThumbnailPromptState(code)
    const wanted = before.expected || THUMBNAILS
    const missing = Array.from({ length: wanted }, (_, i) => i + 1).filter(n => !before.present.includes(n))
    console.log(`   app wants ${wanted} prompt(s); on disk ${before.present.join(',') || 'none'}; asking for ${missing.join(',') || 'nothing'}`)
    if (missing.length) {
      await provider.queue('chat', {
        states: ['succeeded'],
        outputText: JSON.stringify({
          thumbnails: missing.map(n => ({
            number: n,
            title: `Variation ${n}: the ledger and the harbour`,
            prompt: `Editorial thumbnail ${n}: a hand-written ledger on a wet harbour counter, cold blue hour light, one small boat out of focus behind, high contrast, wide empty space on the right for a title, no legible lettering.`,
          })),
        }),
      })
    }
    // `fill_gaps` is what the Image Prompts page itself sends for a non-forced
    // generate and what the job Retry sets: ask the provider for the slots still
    // absent from disk rather than re-asking for all of them.
    const prompts = await call('POST', `/projects/${SLUG}/generate/image-prompts`, {
      episode_id: code, title, model: MODEL, mode: 'thumbnails', fill_gaps: true,
    })
    console.log('   enqueue', prompts.status, JSON.stringify(prompts.body).slice(0, 140))
    if (prompts.status === 201) {
      const job = await waitForJob(prompts.body.job_id, 300_000)
      console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-2).join(' | '))
      if (job?.error) console.log('   error:', String(job.error).slice(0, 200))
    }
    await provider.clear('chat')

    console.log(`-- ${code}: thumbnail images`)
    const thumbs = await call('POST', `/projects/${SLUG}/generate/images`, {
      episode_id: code, model: IMAGE_MODEL, mode: 'thumbs', aspect_ratio: '16:9',
    })
    console.log('   enqueue', thumbs.status, JSON.stringify(thumbs.body).slice(0, 140))
    if (thumbs.status === 201) {
      const job = await waitForJob(thumbs.body.job_id, 600_000)
      console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-3).join(' | '))
      if (job?.error) console.log('   error:', String(job.error).slice(0, 200))
    }

    console.log(`-- ${code}: planned scene images`)
    const scenes = await call('POST', `/projects/${SLUG}/scene-review/${code}/generate-missing`, {
      model: IMAGE_MODEL,
    })
    console.log('   enqueue', scenes.status, JSON.stringify(scenes.body).slice(0, 180))
    const sceneJobId = scenes.body?.job_id
    if (sceneJobId) {
      const job = await waitForJob(sceneJobId, 600_000)
      console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-3).join(' | '))
      if (job?.error) console.log('   error:', String(job.error).slice(0, 200))
    }
  }
}

if (LEG === 'assemble' || LEG === 'all') {
  for (const code of EPISODES) {
    console.log(`\n-- ${code}: approve scene review`)
    const approve = await call('PUT', `/projects/${SLUG}/scene-review/${code}/approve`, { all: true })
    console.log('   approve', approve.status, JSON.stringify(approve.body).slice(0, 160))

    console.log(`-- ${code}: video assembly (local FFmpeg)`)
    const assembly = await call('POST', `/projects/${SLUG}/generate/video-assembly`, { episode_id: code })
    console.log('   enqueue', assembly.status, JSON.stringify(assembly.body).slice(0, 200))
    if (assembly.status !== 201) continue
    const job = await waitForJob(assembly.body.job_id, 900_000)
    console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-4).join(' | '))
    if (job?.error) console.log('   error:', String(job.error).slice(0, 300))
  }
}

if (LEG === 'metadata' || LEG === 'all') {
  for (const code of EPISODES) {
    const title = titles[code] || code
    console.log(`\n-- ${code}: metadata (YouTube Finalizer)`)
    // This project's finalizer makes two language calls: a description and then
    // fifteen tags (the title comes from the idea). A re-run over an existing
    // package may make only the tags call, so the same tag list is queued twice —
    // it satisfies either ordering and the description is fixture text either way.
    const before = await call('GET', `/projects/${SLUG}/episodes/${code}/youtube-finalization-status`)
    console.log('   preflight', before.status, JSON.stringify(before.body).slice(0, 220))
    const tagList = Array.from({ length: 15 }, (_, i) => `walkthrough-tag-${String(i + 1).padStart(2, '0')}`).join('\n')
    for (let i = 0; i < 2; i++) {
      await provider.queue('chat', { states: ['succeeded'], outputText: tagList })
    }
    const meta = await call('POST', `/projects/${SLUG}/generate/metadata`, {
      episode_id: code, title, model: MODEL,
      // The Finalizer page always stamps a fresh action id (freshMetadataAction);
      // without one, an identical request is replayed by the provider.
      ...(process.env.ACCEPT_FRESH_ACTION === '1' ? { operation_id: crypto.randomUUID() } : {}),
    })
    console.log('   enqueue', meta.status, JSON.stringify(meta.body).slice(0, 160))
    if (meta.status === 201) {
      const job = await waitForJob(meta.body.job_id, 300_000)
      console.log(`   job ${job?.status}`, (job?.output_lines || []).slice(-4).join(' | '))
      if (job?.error) console.log('   error:', String(job.error).slice(0, 260))
    }
    const after = await call('GET', `/projects/${SLUG}/episodes/${code}/youtube-finalization-status`)
    console.log('   postflight', after.status, JSON.stringify(after.body).slice(0, 260))
    await provider.clear('chat')
  }
}

console.log('\n== artifacts on disk')
for (const code of EPISODES) {
  const d = episodeDir(code)
  if (!d) { console.log(`${code}: no folder`); continue }
  const files = walk(d).map(f => `${path.relative(d, f)} (${fs.statSync(f).size}B)`)
  console.log(`${code} ${path.basename(d)}:`)
  for (const f of files) console.log('   ', f)
}

const state = await provider.state()
console.log(`\n== provider accounting: submissions=${state?.submissions} ${JSON.stringify(state?.by_operation)} creditsCharged=${state?.credits_charged}`)
console.log('== provider requests:', (state?.requests || []).slice(-25).join(' ; '))
await provider.close()
