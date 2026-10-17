/**
 * Who may move an episode's scene rhythm — enforced at the SAVE BOUNDARY.
 *
 * Scene rhythm belongs to the episode, and one surface owns it: Scene Plan's
 * "Visual timing & motion" panel (`VisualTimingMotion.vue`), which is the only
 * writer that claims authority over `pacing` (owner decision, 2026-10-17).
 *
 * The defect this file pins: the Character Sheet's *Save visual setup* sends
 * the whole continuity config it loaded. If Scene Plan changes the rhythm in
 * between, that stale save wrote its older band back — the page owned a write
 * of a field it must not own. It cannot be fixed in the preset payload alone,
 * because the payload is not where the field is decided; it has to be fixed
 * where the file is written.
 *
 * The contract, at the boundary:
 *   - a whole-config save WITHOUT the claim (`claim_pacing: true`) keeps the
 *     `pacing` already on disk and applies everything else it sent;
 *   - the timing editor's save WITH the claim is authoritative;
 *   - the read that supplies the preserved value happens inside the sidecar
 *     lock, so a timing save landing while a visual save is in flight is not
 *     undone by a value read before it.
 *
 * Deliberately NOT covered, and not claimed anywhere: the other whole-config
 * fields (anchors, style bible, denoise, references) still revert on a stale
 * save. That is the broader pre-existing shape and the pacing contract does
 * not fix it.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const EP_A = 'EP001'
const EP_B = 'EP002'

/** The rhythm the episode is on before a stale save tries to replace it. */
const SCENE_PLAN_RHYTHM = { min_sec: 12, max_sec: 20 }
/** The rhythm a stale whole-config save is still carrying. */
const STALE_RHYTHM = { min_sec: 4, max_sec: 8 }

let cleanup: () => Promise<void>
let app: any
let slug: string
let dirA: string
let dirB: string
let sidecarA: string
let sidecarB: string

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The whole continuity config the Character Sheet page would send. */
function pagePayload(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    anchor_character_ids: [],
    use_episode_sheet: false,
    pacing: { ...STALE_RHYTHM },
    motion_scope: { mode: 'off' },
    motion_level: 2,
    references: { prev_render: false, sheet: false, characters: false, style: false, composition: false },
    denoise_strength: 0.5,
    style_bible: '',
    negative_prompt: '',
    ...overrides,
  }
}

async function readSidecar(file: string): Promise<any> {
  return JSON.parse(await fs.readFile(file, 'utf-8'))
}

/** Write a sidecar directly, as the episode would already have it on disk. */
async function seedSidecar(file: string, config: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(config, null, 2), 'utf-8')
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  const project = await request(app).post('/api/projects').send({
    name: 'Continuity Pacing Ownership',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201, JSON.stringify(project.body))
  slug = project.body.slug

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  dirA = (await resolveEpisodePathsByCode(slug, EP_A)).episode_dir
  dirB = (await resolveEpisodePathsByCode(slug, EP_B)).episode_dir
  sidecarA = path.join(dirA, 'continuity.json')
  sidecarB = path.join(dirB, 'continuity.json')
  await fs.mkdir(dirA, { recursive: true })
  await fs.mkdir(dirB, { recursive: true })
})

after(async () => { await cleanup() })

describe('a whole-config save does not own the episode rhythm', () => {
  test('a stale visual save keeps the newer Scene Plan rhythm and still applies its look', async () => {
    // The episode is on the rhythm Scene Plan chose…
    await seedSidecar(sidecarA, {
      ...pagePayload(),
      pacing: { ...SCENE_PLAN_RHYTHM },
      style_bible: 'the look before the save',
    })

    // …and the Character Sheet saves the config it loaded earlier, which still
    // carries the old band plus the look the customer just picked.
    const res = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_A}`)
      .send(pagePayload({ style_bible: 'watercolour dusk', denoise_strength: 0.35 }))

    assert.equal(res.status, 200, JSON.stringify(res.body))

    const onDisk = await readSidecar(sidecarA)
    assert.deepEqual(
      onDisk.pacing,
      SCENE_PLAN_RHYTHM,
      'the stale band must not replace the rhythm Scene Plan set',
    )
    // …and the save was NOT refused: everything the page does own landed.
    assert.equal(onDisk.style_bible, 'watercolour dusk', 'the look fields must still apply')
    assert.equal(onDisk.denoise_strength, 0.35)
    // The response is what the page stores, so it must not hand the stale band
    // back to the page either — otherwise the page shows a rhythm the episode
    // is not on until the next load.
    assert.deepEqual(res.body.config.pacing, SCENE_PLAN_RHYTHM)
  })

  test('the timing editor\'s save IS authoritative — it claims the rhythm', async () => {
    await seedSidecar(sidecarA, { ...pagePayload(), pacing: { ...SCENE_PLAN_RHYTHM } })

    const res = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_A}`)
      .send(pagePayload({ pacing: { min_sec: 2, max_sec: 5 }, claim_pacing: true }))

    assert.equal(res.status, 200, JSON.stringify(res.body))
    const onDisk = await readSidecar(sidecarA)
    assert.deepEqual(onDisk.pacing, { min_sec: 2, max_sec: 5 }, 'the claimed rhythm is what the episode gets')
  })

  test('only an explicit true claims — a wrong value preserves', async () => {
    await seedSidecar(sidecarA, { ...pagePayload(), pacing: { ...SCENE_PLAN_RHYTHM } })

    for (const claim of ['yes', 1, false, null]) {
      const res = await request(app)
        .put(`/api/projects/${slug}/continuity/${EP_A}`)
        .send(pagePayload({ pacing: { min_sec: 6, max_sec: 9 }, claim_pacing: claim }))
      assert.equal(res.status, 200, JSON.stringify(res.body))
      const onDisk = await readSidecar(sidecarA)
      assert.deepEqual(
        onDisk.pacing,
        SCENE_PLAN_RHYTHM,
        `claim_pacing: ${JSON.stringify(claim)} must not be read as a claim`,
      )
    }
  })

  test('the claim itself is never written into the sidecar', async () => {
    await seedSidecar(sidecarA, { ...pagePayload(), pacing: { ...SCENE_PLAN_RHYTHM } })

    await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_A}`)
      .send(pagePayload({ claim_pacing: true }))
      .expect(200)

    const onDisk = await readSidecar(sidecarA)
    assert.equal('claim_pacing' in onDisk, false, 'a request directive must not become stored data')
  })
})

describe('the fresh-episode and isolation cases', () => {
  test('a first save on an episode with no continuity.json still writes its rhythm', async () => {
    // Nothing on disk to preserve. `undefined` here must mean "there is
    // nothing to keep", NOT "substitute the 1–3s default" — that substitution
    // is the 2026-08-03 incident with the sign flipped.
    await fs.rm(sidecarB, { force: true })

    const res = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_B}`)
      .send(pagePayload({ pacing: { min_sec: 7, max_sec: 11 } }))

    assert.equal(res.status, 200, JSON.stringify(res.body))
    const onDisk = await readSidecar(sidecarB)
    assert.deepEqual(onDisk.pacing, { min_sec: 7, max_sec: 11 }, 'a first save has nothing to preserve')
    // …and the rest of the write is a normal first save.
    assert.equal(onDisk.schema_version, 1)
    assert.deepEqual(onDisk.anchor_character_ids, [])
  })

  test('a save on one episode never touches another episode\'s rhythm', async () => {
    await seedSidecar(sidecarA, { ...pagePayload(), pacing: { min_sec: 2, max_sec: 4 } })
    await seedSidecar(sidecarB, { ...pagePayload(), pacing: { ...SCENE_PLAN_RHYTHM } })
    const bBefore = await fs.readFile(sidecarB, 'utf-8')

    await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_A}`)
      .send(pagePayload({ pacing: { min_sec: 9, max_sec: 14 }, style_bible: 'A only' }))
      .expect(200)

    assert.deepEqual(
      (await readSidecar(sidecarA)).pacing,
      { min_sec: 2, max_sec: 4 },
      'episode A keeps its own rhythm',
    )
    assert.equal(
      await fs.readFile(sidecarB, 'utf-8'),
      bBefore,
      'episode B\'s sidecar is untouched, byte for byte',
    )
  })

  test('a malformed sidecar is refused rather than overwritten', async () => {
    // The page only enables Save because its own GET of this file succeeded, so
    // a file that no longer parses is a real error. Writing the client's older
    // rhythm over it would be the defect, silently.
    await fs.writeFile(sidecarA, '{ this is not json', 'utf-8')
    const before = await fs.readFile(sidecarA, 'utf-8')

    const res = await request(app)
      .put(`/api/projects/${slug}/continuity/${EP_A}`)
      .send(pagePayload())

    assert.equal(res.status, 500, `a broken sidecar is a server-side problem, got ${res.status}`)
    assert.equal(await fs.readFile(sidecarA, 'utf-8'), before, 'the broken file is left exactly as it was')
  })
})

describe('the preserve read happens inside the sidecar lock', () => {
  test('a save queues behind the sidecar key and reads AFTER it, not before', async () => {
    // Two properties, and both need proving — a single final-state assertion
    // cannot carry them on its own, because a writer that landed later would
    // mask a missing lock.
    //
    //  (a) the save takes the sidecar key at all (a save that never locks
    //      finishes while the key is held);
    //  (b) the read happens INSIDE that lock. The writer below lands a NEW
    //      rhythm from inside the held lock, AFTER the delay — so a save that
    //      read before taking the lock would have read the old band and would
    //      write it back. That is the assertion that carries T1.
    const { withLock } = await import('../lib/atomic-store.js')
    await seedSidecar(sidecarA, { ...pagePayload(), pacing: { ...SCENE_PLAN_RHYTHM } })

    const LANDED_WHILE_WAITING = { min_sec: 21, max_sec: 30 }
    const gate = withLock(sidecarA, async () => {
      await sleep(80)
      // The timing editor's write, landing while the visual save is in flight.
      await fs.writeFile(
        sidecarA,
        JSON.stringify({ ...pagePayload(), pacing: { ...LANDED_WHILE_WAITING } }, null, 2),
        'utf-8',
      )
      await sleep(80)
    })

    const inFlight = Promise.resolve(
      request(app).put(`/api/projects/${slug}/continuity/${EP_A}`).send(pagePayload()),
    )

    // (a) Advisory and timing-based: a save that does not take the key at all
    // completes in a few ms, long before this probe. The assertion below is
    // what carries the value.
    const raced = await Promise.race([
      inFlight.then(() => 'completed'),
      sleep(60).then(() => 'waited'),
    ])
    assert.equal(raced, 'waited', 'the save must queue behind the sidecar key, not run through it')

    await gate
    const res = await inFlight
    assert.equal(res.status, 200, JSON.stringify(res.body))

    // (b) The load-bearing assertion. A read taken before `withLock` would have
    // carried SCENE_PLAN_RHYTHM back out; a read taken inside it preserves what
    // landed while the save waited.
    assert.deepEqual(
      (await readSidecar(sidecarA)).pacing,
      LANDED_WHILE_WAITING,
      'the preserve read must happen inside the lock, after the writer it waited for',
    )
    assert.deepEqual(res.body.config.pacing, LANDED_WHILE_WAITING, 'and the page is handed that same rhythm')
  })
})

describe('the preserve is scoped to the write boundary', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../routes/continuity.ts', import.meta.url)),
    'utf8',
  )

  test('buildContinuityConfig stays a pure normaliser', () => {
    // Its other callers — `readPipelineContinuityConfig` (routes/pipeline.ts)
    // and the continuity-config tests — rely on it substituting the defaults
    // for an episode with no file. An unconditional "absent means keep" inside
    // the builder would break that seeding path, so the preserve lives on the
    // write boundary instead and this pins it there.
    const builder = source.slice(
      source.indexOf('export function buildContinuityConfig'),
      source.indexOf('export class ContinuityConfigValidationError'),
    )
    assert.ok(builder.length > 0, 'expected to find buildContinuityConfig in the route source')
    assert.doesNotMatch(builder, /claim_pacing|claimPacingAuthority|readStoredPacing|withLock/, 'no I/O or claim in the builder')
    assert.match(builder, /b\.pacing === undefined \? \{ \.\.\.defaults\.pacing \} : parseScenePacing\(b\.pacing\)/,
      'the builder still substitutes the default for an absent pacing — the fresh-episode path depends on it')
  })

  test('the claim is defined once and only an explicit true is read as one', () => {
    assert.equal(
      (source.match(/export const PACING_AUTHORITY_CLAIM = 'claim_pacing'/g) || []).length,
      1,
      'the claim name has one definition',
    )
    assert.match(source, /claimPacingAuthority: body\[PACING_AUTHORITY_CLAIM\] === true/,
      'an absent, false or typo\'d claim must preserve rather than claim')
  })
})
