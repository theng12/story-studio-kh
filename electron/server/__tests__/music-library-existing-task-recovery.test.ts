/**
 * 2026-10-16 — recover an existing accepted music result (Dreamlands 571ec142, "Night-Woven Wool").
 *
 * The Gateway accepted the item, held it as an unknown outcome after a Hub artifact 503, then
 * finished it. Story could only offer Retry, which is the generation path. The recovery route reads
 * the exact saved task with GETs (status + outputs), imports every take into the same library, and
 * keeps a receipt. These tests record every outbound request: a POST, a new key or a new model would
 * show up here.
 */
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { buildGenStudioMusicIdempotencyKey } from '../lib/genstudio-client.js'
import type { Job } from '../models/types.js'

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let app: any
let pm: typeof import('../services/project-manager.js')
let lib: typeof import('../services/music-library.js')
let sp: typeof import('../services/song-pool.js')

const MODEL = 'studio-hub::stabilityai/stable-audio-3-optimized'
const BRIEF = '3aac12e8-cb51-4620-8b1a-7f970628ea83'

before(async () => {
  isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
  lib = await import('../services/music-library.js')
  sp = await import('../services/song-pool.js')
  const { setGenStudioUrl } = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  await setGenStudioUrl('https://recover.test')
  await setApiKey('genstudio', 'recover-test-key')
})

after(async () => {
  const jq = await import('../services/job-queue.js')
  await jq._waitForJobPersistenceForTesting()
  await isolated?.cleanup()
})

const m4a = (fill: number) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(4096, fill)])
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

interface Source {
  slug: string
  jobId: string
  taskId: string
  key: string
  dir: string
  filename: (take: number) => string
  receiptFile: string
}

/** A stopped Music Library job saved exactly as Story 1.4.305 left job 571ec142. */
async function stoppedSource(name: string, options: {
  evidence?: Record<string, unknown>
  extraEvidence?: boolean
  item?: (item: any) => void
  params?: Record<string, unknown>
  result?: Record<string, unknown>
} = {}): Promise<Source> {
  const project = await pm.createProject({ name })
  const slug = project.slug
  const jobId = `src${createHash('sha1').update(name).digest('hex').slice(0, 8)}`
  const taskId = `9c963cdc-2fec-4c36-b689-${createHash('sha1').update(name).digest('hex').slice(0, 12)}`
  const requestIdentity = `${slug}:music:${BRIEF}:0`
  const req = {
    title: 'Night-Woven Wool', prompt: '62 BPM, A minor. Muted solo cello.', instrumental: true,
    duration_seconds: 240, model_id: MODEL, output_format: 'm4a' as const,
  }
  const key = buildGenStudioMusicIdempotencyKey({
    title: req.title, prompt: req.prompt, instrumental: req.instrumental, durationSeconds: req.duration_seconds,
    modelId: req.model_id, requestIdentity, outputFormat: req.output_format,
  })
  const item: any = {
    item_key: 'track-0', index: 0,
    plan: { title: req.title, prompt: req.prompt, tags: ['cello', 'sleep'] },
    request: req, request_identity: requestIdentity, idempotency_key: key, accepted_task_id: taskId, state: 'failed',
  }
  options.item?.(item)
  const evidence = {
    id: taskId, operation: 'music.generation', state: 'succeeded', queue_state: 'succeeded', model_id: MODEL,
    request_key: key, dispatch_state: 'dispatched', recovery_required: false, recovery_state: null,
    updated_at: '2026-10-15T15:17:14.110Z', ...options.evidence,
  }
  const job: Job = {
    job_id: jobId, project_slug: slug, type: 'music_generate', episode_id: '', title: 'Music library top-up (20 tracks)',
    status: 'error', created_at: '2026-10-15T14:55:39.944Z', started_at: '2026-10-15T15:08:49.840Z',
    finished_at: '2026-10-15T15:17:14.050Z', error: 'Music library top-up incomplete: 19/20', output_lines: [],
    params: { brief: 'dreamy', count: 20, model: MODEL, instrumental: true, brief_id: BRIEF,
      music_library_items: { version: 1, items: [item] }, ...options.params },
    local_execution_complete: true, remote_cancellations: {}, ...(options.result ? { result: options.result } : {}),
    genstudio_jobs: [evidence as any, ...(options.extraEvidence ? [{ ...evidence, id: `${taskId}-other` } as any] : [])],
  }
  await fs.writeFile(path.join(isolated.dir, 'projects', slug, 'jobs.json'), JSON.stringify({ jobs: [job] }))
  const dir = (await lib.getLibraryDir(slug))!
  return {
    slug, jobId, taskId, key, dir,
    filename: take => `night-woven-wool-${taskId.slice(-8)}-take${take}.m4a`,
    receiptFile: path.join(dir, '.existing-task-recovery', jobId, 'track-0.json'),
  }
}

type Answer = (pathname: string) => Response | Promise<Response>

/** The Gateway: a status answer for the exact task, output bytes by index; every request is recorded. */
function gateway(source: Source, status: Record<string, unknown> | (() => Response), outputs: Buffer[] = [m4a(1)], onOutput?: Answer) {
  const original = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase()
    const url = new URL(String(input))
    requests.push(`${method} ${url.pathname}`)
    if (method !== 'GET') return Response.json({ detail: 'no POST may be sent while recovering' }, { status: 500 })
    if (url.pathname === `/v1/music/jobs/${source.taskId}`) {
      return typeof status === 'function' ? status() : Response.json(status)
    }
    const output = url.pathname.match(new RegExp(`^/v1/music/jobs/${source.taskId}/outputs/(\\d+)$`))
    if (output) {
      const custom = await onOutput?.(url.pathname)
      return custom || new Response(new Uint8Array(outputs[Number(output[1])]!), { headers: { 'content-type': 'audio/mp4' } })
    }
    return Response.json({ detail: 'unexpected request' }, { status: 500 })
  }
  return { requests, restore: () => { globalThis.fetch = original } }
}

function succeeded(source: Source, count = 1, fields: Record<string, unknown> = {}) {
  return {
    id: source.taskId, state: 'succeeded', model_id: MODEL, cancelled: false, dispatch_state: 'dispatched',
    recovery_required: false, recovery_state: null, late_result_state: 'succeeded',
    outputs: Array.from({ length: count }, (_, i) => ({ asset_id: String(i), url: `/v1/music/jobs/${source.taskId}/outputs/${i}` })),
    credit_cost: 0, remaining_credits: 0, price_version: 'local', ...fields,
  }
}

const recover = (source: Source, body: unknown = { source_job_id: source.jobId, source_item_key: 'track-0' }) =>
  request(app).post(`/api/projects/${source.slug}/music-library/recover-existing-task`).send(body as object)

async function audioFiles(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter(name => sp.AUDIO_EXT.test(name) && !name.startsWith('.'))
}

const exists = (file: string) => fs.access(file).then(() => true, () => false)

test('strict body/project/job/checkpoint/item/task/key/model/brief refusals perform zero network and zero writes', async () => {
  const good = await stoppedSource('Refusals good')
  const net = gateway(good, succeeded(good))
  try {
    for (const body of [{}, { source_job_id: good.jobId }, { source_job_id: good.jobId, source_item_key: 'track-0', task_id: 'x' },
      { source_job_id: 7, source_item_key: 'track-0' }, { source_job_id: good.jobId, source_item_key: '' }]) {
      assert.equal((await recover(good, body)).status, 400, JSON.stringify(body))
    }
    assert.equal((await request(app).post('/api/projects/no-such-project/music-library/recover-existing-task')
      .send({ source_job_id: good.jobId, source_item_key: 'track-0' })).status, 404)
    assert.equal((await recover(good, { source_job_id: 'missing', source_item_key: 'track-0' })).status, 404)
    assert.equal((await recover(good, { source_job_id: good.jobId, source_item_key: 'track-9' })).status, 409)

    const refusals = [
      await stoppedSource('Refusal song pool', { params: { song_pool: true } }),
      await stoppedSource('Refusal no task', { item: item => { delete item.accepted_task_id } }),
      await stoppedSource('Refusal legacy wav', { item: item => {
        delete item.request.output_format
        item.idempotency_key = buildGenStudioMusicIdempotencyKey({
          title: item.request.title, prompt: item.request.prompt, instrumental: true, durationSeconds: 240,
          modelId: MODEL, requestIdentity: item.request_identity,
        })
      } }),
      await stoppedSource('Refusal wrong key', { evidence: { request_key: 'story-music-someone-else' } }),
      await stoppedSource('Refusal cross model', { evidence: { model_id: 'studio-hub::other-model' } }),
      await stoppedSource('Refusal ambiguous', { extraEvidence: true }),
      await stoppedSource('Refusal no brief', { params: { brief_id: '' } }),
    ]
    for (const source of refusals) {
      const response = await recover(source)
      assert.equal(response.status, 409, `${source.slug}: ${response.body.detail}`)
      assert.match(response.body.detail, /Nothing was read or imported/)
      assert.deepEqual(await audioFiles(source.dir), [])
      assert.equal(await exists(path.join(source.dir, '.existing-task-recovery')), false)
    }
    assert.deepEqual(net.requests, [], 'a refusal reads nothing')
  } finally {
    net.restore()
  }
})

test('succeeded exact status plus output GET saves every returned M4A take through the normal writer/metadata path, with no generation POST', async () => {
  const source = await stoppedSource('Two takes')
  const takes = [m4a(11), m4a(12)]
  const net = gateway(source, succeeded(source, 2), takes)
  try {
    const first = await recover(source)
    assert.equal(first.status, 201, first.body.detail)
    assert.equal(first.body.reused, false)
    assert.equal(first.body.gateway_job_id, source.taskId)
    assert.deepEqual(first.body.filenames, [source.filename(1), source.filename(2)])
    assert.deepEqual(Object.keys(first.body).sort(), ['filenames', 'gateway_job_id', 'library', 'reused', 'source_item_key', 'source_job_id'])
    assert.deepEqual(net.requests, [
      `GET /v1/music/jobs/${source.taskId}`,
      `GET /v1/music/jobs/${source.taskId}/outputs/0`,
      `GET /v1/music/jobs/${source.taskId}/outputs/1`,
    ])
    for (const [i, bytes] of takes.entries()) {
      assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(i + 1))), bytes)
    }
    const tracks = (await lib.listLibrary(source.slug)).tracks
    for (const take of [1, 2]) {
      const track = tracks.find(t => t.filename === source.filename(take))!
      assert.equal(track.title, `Night-Woven Wool — take ${take}`)
      assert.equal(track.genstudio_job_id, source.taskId)
      assert.equal(track.brief_id, BRIEF)
      assert.equal(track.sibling_index, take)
      assert.equal(track.sibling_group, lib.siblingGroupForJob(source.taskId))
      assert.deepEqual(track.tags, ['cello', 'sleep'])
      assert.equal(track.enabled, true)
    }
    const receipt = JSON.parse(await fs.readFile(source.receiptFile, 'utf8'))
    assert.equal(receipt.state, 'complete')
    assert.equal(receipt.task_id, source.taskId)
    assert.equal(receipt.idempotency_key, source.key)
    assert.equal(receipt.model_id, MODEL)
    assert.deepEqual(receipt.outputs.map((o: any) => [o.take, o.sha256, o.state]), takes.map((b, i) => [i + 1, sha(b), 'complete']))

    net.requests.length = 0
    const again = await recover(source)
    assert.equal(again.status, 200)
    assert.equal(again.body.reused, true)
    assert.deepEqual(net.requests, [], 'a complete receipt replays from disk with zero network')

    const sources = await request(app).get(`/api/projects/${source.slug}/music-library/manual-redo-sources`)
    assert.equal(sources.body.sources[0].recovery, 'recovered')
    assert.deepEqual(net.requests, [], 'listing never calls the Gateway')
  } finally {
    net.restore()
  }
})

test('held failure, active state, cancelled/failed state, task/model mismatch, empty outputs, accepted-ID 404, and unavailable GET write nothing and never create a fresh identity', async () => {
  const cases: Array<[string, (s: Source) => Record<string, unknown> | (() => Response), number]> = [
    ['held', s => succeeded(s, 1, { state: 'failed', recovery_required: true, recovery_state: 'unknown_outcome', outputs: [] }), 409],
    ['active', s => succeeded(s, 1, { state: 'running', outputs: [] }), 409],
    ['cancelled', s => succeeded(s, 1, { cancelled: true }), 409],
    ['failed', s => succeeded(s, 1, { state: 'failed', outputs: [] }), 409],
    ['task mismatch', s => succeeded(s, 1, { id: 'another-task' }), 409],
    ['model mismatch', s => succeeded(s, 1, { model_id: 'studio-hub::other-model' }), 409],
    ['empty outputs', s => succeeded(s, 0), 409],
    ['duplicate outputs', s => succeeded(s, 1, { outputs: [{ asset_id: '0' }, { asset_id: '0' }] }), 409],
    ['accepted-ID 404', () => () => Response.json({ detail: 'music job not found' }, { status: 404 }), 409],
    ['unavailable', () => () => Response.json({ detail: 'down' }, { status: 503 }), 503],
  ]
  for (const [label, answer, status] of cases) {
    const source = await stoppedSource(`Closed ${label}`)
    const net = gateway(source, answer(source))
    try {
      const response = await recover(source)
      assert.equal(response.status, status, `${label}: ${response.body.detail}`)
      assert.deepEqual(net.requests, [`GET /v1/music/jobs/${source.taskId}`], `${label}: one status GET, nothing else`)
      assert.deepEqual(await audioFiles(source.dir), [], label)
      assert.equal(await exists(source.receiptFile), false, label)
    } finally {
      net.restore()
    }
  }
})

test('crash-bound prepared/file-present receipt completes by exact hash without overwriting', async () => {
  const source = await stoppedSource('Prepared receipt')
  const body = m4a(21)
  // A crash after publication, before metadata: the complete file and a prepared receipt exist.
  await fs.writeFile(path.join(source.dir, source.filename(1)), body)
  const before = await fs.stat(path.join(source.dir, source.filename(1)))
  await fs.mkdir(path.dirname(source.receiptFile), { recursive: true })
  await fs.writeFile(source.receiptFile, JSON.stringify({
    version: 1, project_slug: source.slug, source_job_id: source.jobId, source_item_key: 'track-0', brief_id: BRIEF,
    request_identity: `${source.slug}:music:${BRIEF}:0`, idempotency_key: source.key, task_id: source.taskId, model_id: MODEL,
    state: 'prepared', completed_at: null,
    outputs: [{ asset_id: '0', take: 1, filename: source.filename(1), sha256: sha(body), size: body.length, state: 'prepared' }],
  }))
  const net = gateway(source, succeeded(source), [body])
  try {
    const response = await recover(source)
    assert.equal(response.status, 201, response.body.detail)
    const after = await fs.stat(path.join(source.dir, source.filename(1)))
    assert.equal(after.ino, before.ino, 'the existing file is not replaced')
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(1))), body)
    const track = (await lib.listLibrary(source.slug)).tracks.find(t => t.filename === source.filename(1))!
    assert.equal(track.genstudio_job_id, source.taskId)
    assert.equal(track.title, 'Night-Woven Wool', 'an unedited disk-discovered row gets the planned title')
    assert.equal(JSON.parse(await fs.readFile(source.receiptFile, 'utf8')).state, 'complete')
  } finally {
    net.restore()
  }
})

test('preexisting different bytes or metadata cause 409 and remain byte-identical; same bytes without a receipt fail closed', async () => {
  for (const [label, existing, prepare] of [
    ['different bytes', m4a(31), async () => {}],
    ['same bytes without receipt', m4a(1), async () => {}],
    ['foreign metadata', m4a(1), async (s: Source) => {
      await lib.upsertTrackMeta(s.slug, s.filename(1), { genstudio_job_id: 'someone-else', brief_id: 'other-brief', sibling_index: 1 })
    }],
  ] as const) {
    const source = await stoppedSource(`Collision ${label}`)
    const file = path.join(source.dir, source.filename(1))
    await fs.writeFile(file, existing)
    await prepare(source)
    const net = gateway(source, succeeded(source), [m4a(1)])
    try {
      const before = (await sp.readPool(source.slug)).songs.find(s => s.file === source.filename(1))!
      // Review 2026-10-16 #6: a second click must not find a receipt this flow never earned and
      // claim the file (overwriting its unedited title and tags).
      for (const attempt of [1, 2]) {
        const response = await recover(source)
        assert.equal(response.status, 409, `${label} #${attempt}: ${response.body.detail}`)
        assert.deepEqual(await fs.readFile(file), existing, `${label} #${attempt}: the original bytes are untouched`)
        assert.equal(await exists(source.receiptFile), false, `${label} #${attempt}: no receipt is written for a file this flow did not write`)
      }
      const after = (await sp.readPool(source.slug)).songs.find(s => s.file === source.filename(1))!
      assert.equal(after.title, before.title, label)
      assert.deepEqual(after.tags, before.tags, label)
      assert.equal(after.gateway_job_id, before.gateway_job_id, label)
      assert.ok(net.requests.every(r => r.startsWith('GET ')), label)
    } finally {
      net.restore()
    }
  }
})

test('output failure after an earlier take preserves the receipted take and resumes only the missing output', async () => {
  const source = await stoppedSource('Resume missing take')
  const takes = [m4a(41), m4a(42)]
  let failSecond = true
  const net = gateway(source, succeeded(source, 2), takes, pathname =>
    pathname.endsWith('/outputs/1') && failSecond ? Response.json({ detail: 'busy' }, { status: 404 }) : undefined as any)
  try {
    const first = await recover(source)
    assert.ok([409, 503].includes(first.status), first.body.detail)
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(1))), takes[0])
    assert.equal(await exists(path.join(source.dir, source.filename(2))), false)
    const partial = JSON.parse(await fs.readFile(source.receiptFile, 'utf8'))
    assert.equal(partial.state, 'prepared')
    assert.deepEqual(partial.outputs.map((o: any) => o.state), ['complete'])

    failSecond = false
    net.requests.length = 0
    const second = await recover(source)
    assert.equal(second.status, 201, second.body.detail)
    assert.deepEqual(net.requests, [
      `GET /v1/music/jobs/${source.taskId}`,
      `GET /v1/music/jobs/${source.taskId}/outputs/1`,
    ], 'the good take is never downloaded or rewritten again')
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(2))), takes[1])
  } finally {
    net.restore()
  }
})

test('owner disable/title/tag edits committed while status/download awaits survive recovery publication', async () => {
  const source = await stoppedSource('Owner edits during download')
  const body = m4a(51)
  // Crash-bound state so a row exists before the awaited download.
  await fs.writeFile(path.join(source.dir, source.filename(1)), body)
  await fs.mkdir(path.dirname(source.receiptFile), { recursive: true })
  await fs.writeFile(source.receiptFile, JSON.stringify({
    version: 1, project_slug: source.slug, source_job_id: source.jobId, source_item_key: 'track-0', brief_id: BRIEF,
    request_identity: `${source.slug}:music:${BRIEF}:0`, idempotency_key: source.key, task_id: source.taskId, model_id: MODEL,
    state: 'prepared', completed_at: null,
    outputs: [{ asset_id: '0', take: 1, filename: source.filename(1), sha256: sha(body), size: body.length, state: 'prepared' }],
  }))
  const net = gateway(source, succeeded(source), [body], async () => {
    await lib.upsertTrackMeta(source.slug, source.filename(1), { title: 'Owner title', enabled: false, tags: ['mine'] })
    return undefined as any
  })
  try {
    const response = await recover(source)
    assert.equal(response.status, 201, response.body.detail)
    const track = (await lib.listLibrary(source.slug)).tracks.find(t => t.filename === source.filename(1))!
    assert.equal(track.title, 'Owner title')
    assert.equal(track.enabled, false)
    assert.deepEqual(track.tags, ['mine'])
    assert.equal(track.genstudio_job_id, source.taskId, 'only missing immutable provenance is added')
  } finally {
    net.restore()
  }
})

test('an owner removal during the output GET is never undone', async () => {
  const source = await stoppedSource('Owner removes during download')
  const body = m4a(61)
  await fs.writeFile(path.join(source.dir, source.filename(1)), body)
  await fs.mkdir(path.dirname(source.receiptFile), { recursive: true })
  await fs.writeFile(source.receiptFile, JSON.stringify({
    version: 1, project_slug: source.slug, source_job_id: source.jobId, source_item_key: 'track-0', brief_id: BRIEF,
    request_identity: `${source.slug}:music:${BRIEF}:0`, idempotency_key: source.key, task_id: source.taskId, model_id: MODEL,
    state: 'prepared', completed_at: null,
    outputs: [{ asset_id: '0', take: 1, filename: source.filename(1), sha256: sha(body), size: body.length, state: 'prepared' }],
  }))
  const net = gateway(source, succeeded(source), [body], async () => {
    await lib.removeTrack(source.slug, source.filename(1))
    return undefined as any
  })
  try {
    const response = await recover(source)
    assert.equal(response.status, 409, response.body.detail)
    assert.match(response.body.detail, /removed from the library/)
    assert.equal(await exists(path.join(source.dir, source.filename(1))), false, 'the removed file does not reappear')
    assert.equal((await lib.listLibrary(source.slug)).tracks.length, 0)
    assert.ok(net.requests.every(r => r.startsWith('GET ')))
    assert.equal(JSON.parse(await fs.readFile(source.receiptFile, 'utf8')).state, 'prepared')
  } finally {
    net.restore()
  }
})

test('a completed receipt replays after owner edits, disable and archive by validating immutable origin and bytes only', async () => {
  const source = await stoppedSource('Replay after edits')
  const net = gateway(source, succeeded(source), [m4a(71)])
  try {
    assert.equal((await recover(source)).status, 201)
    await lib.upsertTrackMeta(source.slug, source.filename(1), { title: 'Renamed', enabled: false, tags: ['owner'] })
    const id = (await sp.readPool(source.slug)).songs.find(s => s.file === source.filename(1))!.id
    await sp.recordEpisodeUse(source.slug, [id], { code: 'EP0001', project_slug: source.slug, used_at: new Date().toISOString() })
    await sp.rejectSongs(source.slug, [id])
    assert.equal((await sp.readPool(source.slug)).songs.find(s => s.id === id)!.status, 'archived')
    net.requests.length = 0
    const replay = await recover(source)
    assert.equal(replay.status, 200, replay.body.detail)
    assert.deepEqual(net.requests, [])
    const song = (await sp.readPool(source.slug)).songs.find(s => s.id === id)!
    assert.equal(song.title, 'Renamed')
    assert.equal(song.enabled, false)
    assert.equal(song.status, 'archived')
  } finally {
    net.restore()
  }
})

test('the sources listing classifies a held item as check-existing and a succeeded one as ready, with no Gateway call', async () => {
  const held = await stoppedSource('Classify held', {
    evidence: { state: 'failed', queue_state: 'failed', recovery_required: true, recovery_state: 'unknown_outcome' },
  })
  const net = gateway(held, () => Response.json({ detail: 'down' }, { status: 503 }))
  try {
    const listed = (await request(app).get(`/api/projects/${held.slug}/music-library/manual-redo-sources`)).body.sources[0]
    assert.equal(listed.recovery, 'check-existing')
    assert.match(listed.recovery_reason, /never starts a new one/)
    assert.equal(listed.eligible, true, 'the paid separate-attempt flow is unchanged')
    assert.ok(net.requests.every(r => r === `GET /v1/music/jobs/${held.taskId}`), 'only the existing history evidence refresh may read status')
  } finally {
    net.restore()
  }
  const ready = await stoppedSource('Classify ready')
  const quiet = gateway(ready, succeeded(ready))
  try {
    const listed = (await request(app).get(`/api/projects/${ready.slug}/music-library/manual-redo-sources`)).body.sources[0]
    assert.equal(listed.recovery, 'ready')
    assert.match(listed.recovery_reason, /delivery failed/)
    assert.deepEqual(quiet.requests, [])
  } finally {
    quiet.restore()
  }
})

// ── Review 2026-10-16 #3: a hold that resolves to succeeded must not orphan the paid result ──

const heldEvidence = { state: 'failed', queue_state: 'failed', recovery_required: true, recovery_state: 'unknown_outcome' }

test('a held song that later succeeds cannot be removed from history until its result is imported', async () => {
  const jq = await import('../services/job-queue.js')
  const source = await stoppedSource('Hold resolves before import', { evidence: heldEvidence })
  const net = gateway(source, succeeded(source), [m4a(81)])
  try {
    await jq.getJobs(source.slug)
    await jq.recheckJobProviderStatus(source.slug, source.jobId)
    const job = jq.getJob(source.jobId)!
    assert.equal(job.genstudio_jobs![0]!.state, 'succeeded')
    assert.notEqual(jq.getPublicJob(source.jobId)!.control?.action, 'clear-history')
    assert.ok(!job.output_lines.some(line => /This history can now be removed/.test(line)), job.output_lines.join('\n'))
    assert.ok(job.output_lines.some(line => /Recover existing result/.test(line)))
    assert.equal(jq.removeTerminalJob(source.slug, source.jobId), false, 'single removal is refused')
    assert.equal(await jq.clearFinished(source.slug), 0, 'bulk clear skips it')
    assert.ok(jq.getJob(source.jobId), 'the job and its recovery source survive')
    const listed = (await request(app).get(`/api/projects/${source.slug}/music-library/manual-redo-sources`)).body.sources[0]
    assert.equal(listed.recovery, 'ready')

    const response = await recover(source)
    assert.equal(response.status, 201, response.body.detail)
    assert.equal(jq.getPublicJob(source.jobId)!.control?.action, 'clear-history', 'imported: the history is free to go')
    assert.equal(jq.removeTerminalJob(source.slug, source.jobId), true)
  } finally {
    net.restore()
  }
})

test('a hold that resolves after the song is already in the library frees the history and says nothing about importing', async () => {
  const jq = await import('../services/job-queue.js')
  const source = await stoppedSource('Hold resolves already imported', { evidence: heldEvidence })
  await fs.writeFile(path.join(source.dir, source.filename(1)), m4a(82))
  await lib.upsertTrackMeta(source.slug, source.filename(1), { genstudio_job_id: source.taskId, brief_id: BRIEF, sibling_index: 1 })
  const net = gateway(source, succeeded(source), [m4a(82)])
  try {
    await jq.getJobs(source.slug)
    await jq.recheckJobProviderStatus(source.slug, source.jobId)
    const job = jq.getJob(source.jobId)!
    assert.equal(job.genstudio_jobs![0]!.state, 'succeeded')
    assert.ok(!job.output_lines.some(line => /not in the library yet|Recover existing result/.test(line)), job.output_lines.join('\n'))
    assert.equal(jq.getPublicJob(source.jobId)!.control?.action, 'clear-history')
  } finally {
    net.restore()
  }
})

// ── Review 2026-10-16 #4: classification reads every pool row and does not hide partial items ──

test('a partly delivered multi-take item stays recoverable and imports only the missing take', async () => {
  const source = await stoppedSource('Partly delivered', {
    result: { completion: { missing: ['Night-Woven Wool: Could not download track 2: HTTP 503'] } },
  })
  const takes = [m4a(91), m4a(92)]
  await fs.writeFile(path.join(source.dir, source.filename(1)), takes[0]!)
  await lib.upsertTrackMeta(source.slug, source.filename(1), {
    title: 'Night-Woven Wool — take 1', genstudio_job_id: source.taskId, brief_id: BRIEF,
    sibling_group: lib.siblingGroupForJob(source.taskId), sibling_index: 1,
  })
  const net = gateway(source, succeeded(source, 2), takes)
  try {
    const listed = (await request(app).get(`/api/projects/${source.slug}/music-library/manual-redo-sources`)).body.sources[0]
    assert.equal(listed.recovery, 'ready', listed.recovery_reason)
    const response = await recover(source)
    assert.equal(response.status, 201, response.body.detail)
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(1))), takes[0], 'the delivered take is untouched')
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(2))), takes[1])
  } finally {
    net.restore()
  }
})

test('a result the owner removed from the library is not offered for recovery', async () => {
  const source = await stoppedSource('Owner removed result')
  await fs.writeFile(path.join(source.dir, source.filename(1)), m4a(93))
  await lib.upsertTrackMeta(source.slug, source.filename(1), { genstudio_job_id: source.taskId, brief_id: BRIEF, sibling_index: 1 })
  await lib.removeTrack(source.slug, source.filename(1))
  const net = gateway(source, succeeded(source))
  try {
    const listed = (await request(app).get(`/api/projects/${source.slug}/music-library/manual-redo-sources`)).body.sources[0]
    assert.equal(listed.recovery, 'none')
    assert.match(listed.recovery_reason, /removed/)
    assert.deepEqual(net.requests, [])
  } finally {
    net.restore()
  }
})

// ── Review 2026-10-16 #5: an owner-removed receipted take never blocks the takes after it ──

test('a receipted take the owner removed is skipped and later takes are still recovered', async () => {
  const source = await stoppedSource('Removed receipted take')
  const takes = [m4a(95), m4a(96)]
  let failSecond = true
  const net = gateway(source, succeeded(source, 2), takes, pathname =>
    pathname.endsWith('/outputs/1') && failSecond ? Response.json({ detail: 'gone for now' }, { status: 404 }) : undefined as any)
  try {
    assert.notEqual((await recover(source)).status, 201)
    await lib.removeTrack(source.slug, source.filename(1))
    failSecond = false
    net.requests.length = 0
    const second = await recover(source)
    assert.equal(second.status, 201, second.body.detail)
    assert.ok(!net.requests.includes(`GET /v1/music/jobs/${source.taskId}/outputs/0`), 'the removed take is not fetched again')
    assert.equal(await exists(path.join(source.dir, source.filename(1))), false, 'the removed take does not reappear')
    assert.deepEqual(await fs.readFile(path.join(source.dir, source.filename(2))), takes[1])
    net.requests.length = 0
    const replay = await recover(source)
    assert.equal(replay.status, 200, replay.body.detail)
    assert.deepEqual(net.requests, [])
  } finally {
    net.restore()
  }
})
