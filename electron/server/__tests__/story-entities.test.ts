/**
 * Episode-owned story entity inventory — Episode Visual Setup Phase 1
 * (owner-approved 2026-11-05, decisions 54959 → 54963 → 54879).
 *
 * What this pins:
 *   - the sidecar lands in THIS episode's real folder (resolveEpisodePathsByCode)
 *     and never in a sibling episode's (§4 ownership is looked up, not guessed);
 *   - an unknown episode code is refused BEFORE anything is written, so a stale
 *     code cannot create a phantom folder;
 *   - a `character_id` must be in this episode's own character list — a
 *     character owned only by another episode is refused by name;
 *   - a reference file must be a real file inside this episode's folder,
 *     proven by realpath containment (traversal and foreign files refused);
 *   - a malformed entity is a 400 that names the offender, and a refused save
 *     leaves the stored inventory untouched (§8);
 *   - saves are idempotent merges: omitted fields keep their stored values
 *     (an out-of-date save cannot reset a keep/drop review), unmentioned
 *     entities are preserved, and an id-less retry adopts the stored record
 *     instead of duplicating it;
 *   - `chapters` is number | null: a missing script folder measures as null,
 *     never as 0 (§6 — a zero that means two things is a defect).
 *
 * Route registration lives in routes/index.ts, which is the lead's reserved
 * integration lane in release-386; this suite mounts the router on the app
 * directly so the real handlers are exercised against the real app.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: any
let slug: string
let epA: string
let epB: string
let dirA: string
let dirB: string
let fileA: string
let ownedCharacterId: string
let foreignCharacterId: string

function entity(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cast-aria',
    kind: 'cast',
    name: 'Aria',
    description: 'the guide with the silver lamp',
    important: true,
    review: 'keep',
    reference_images: [] as string[],
    ...overrides,
  }
}

async function makeEpisode(title: string): Promise<string> {
  const created = await request(app).post(`/api/projects/${slug}/ideas`).send({ title, suggested_chapters: 4 })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  const accepted = await request(app)
    .post(`/api/projects/${slug}/ideas/${created.body.id}/accept`)
    .send({})
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body))
  assert.ok(accepted.body.episode_code, 'accept must return the episode code')
  return accepted.body.episode_code as string
}

async function getInventory(code: string) {
  const res = await request(app).get(`/api/projects/${slug}/story-entities/${code}`)
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  const { router: storyEntitiesRouter } = await import('../routes/story-entities.js')
  app.use('/api', storyEntitiesRouter)

  const project = await request(app).post('/api/projects').send({
    name: 'Story Entities',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201, JSON.stringify(project.body))
  slug = project.body.slug

  epA = await makeEpisode('Harbor at Dawn')
  epB = await makeEpisode('The Long Road')

  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  dirA = (await resolveEpisodePathsByCode(slug, epA)).episode_dir
  dirB = (await resolveEpisodePathsByCode(slug, epB)).episode_dir
  fileA = path.join(dirA, 'story-entities.json')
  await fs.mkdir(dirA, { recursive: true })
  await fs.mkdir(dirB, { recursive: true })

  // EP001 has one real chapter file — the whole completed script this
  // inventory is reviewed against. EP002 deliberately gets no script folder.
  const scriptDirA = (await resolveEpisodePathsByCode(slug, epA)).script_dir
  await fs.mkdir(scriptDirA, { recursive: true })
  await fs.writeFile(path.join(scriptDirA, `${epA}_Chapter_01.md`), '# chapter one', 'utf-8')

  const cl = await import('../services/character-library.js')
  const cm = await import('../services/character-manager.js')
  const owned = await cl.createChannelCharacter(slug, {
    name: 'Aria',
    description: 'the guide with the silver lamp',
  })
  ownedCharacterId = owned.id
  const foreign = await cm.createCharacter(slug, {
    name: 'Boro',
    description: 'belongs to the other episode only',
    scope: 'episode',
    episode_codes: [epB],
  })
  foreignCharacterId = foreign.id
})

after(async () => {
  await cleanup()
})

describe('story entity inventory', () => {
  test('an episode with no sidecar answers exists:false, and a missing script folder measures as null', async () => {
    const body = await getInventory(epB)
    assert.equal(body.exists, false)
    assert.deepEqual(body.doc.entities, [])
    assert.equal(body.chapters, null, 'no script folder must read as null, never as 0 (§6)')
  })

  test('the completed script on disk is counted for this episode', async () => {
    const body = await getInventory(epA)
    assert.equal(body.exists, false, 'nothing saved yet')
    assert.equal(body.chapters, 1, "this episode's own chapter file is the ground truth")
  })

  test('a save lands in the real episode folder and reads back — and only there', async () => {
    const payload = {
      schema_version: 1,
      entities: [
        entity({ character_id: ownedCharacterId }),
        entity({
          id: 'location-harbor',
          kind: 'location',
          name: 'Harbor',
          description: 'fog at dawn, ropes creaking',
          character_id: undefined,
        }),
      ],
    }
    const put = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send(payload)
    assert.equal(put.status, 200, JSON.stringify(put.body))
    assert.equal(put.body.ok, true)
    assert.deepEqual(put.body.doc.entities.map((e: any) => e.id), ['cast-aria', 'location-harbor'])

    // The sidecar is in THIS episode's real folder — resolved, not guessed.
    const onDisk = JSON.parse(await fs.readFile(fileA, 'utf-8'))
    assert.equal(onDisk.entities.length, 2)
    assert.equal(onDisk.entities[0].character_id, ownedCharacterId)
    assert.equal(onDisk.entities[1].character_id, undefined, 'a non-cast entity carries no character link')

    // …and EP002 has none of EP001's inventory (§4).
    const sibling = await fs.stat(path.join(dirB, 'story-entities.json')).catch(() => null)
    assert.equal(sibling, null, "one episode's inventory must not appear in another's folder")

    const body = await getInventory(epA)
    assert.equal(body.exists, true)
    assert.deepEqual(body.doc.entities.map((e: any) => e.id), ['cast-aria', 'location-harbor'])
    assert.equal(body.doc.entities[0].review, 'keep')
  })

  test('an unknown episode code is refused before anything is written', async () => {
    const res = await request(app)
      .put(`/api/projects/${slug}/story-entities/EP999`)
      .send({ schema_version: 1, entities: [] })
    assert.equal(res.status, 404, JSON.stringify(res.body))
    assert.match(res.body.detail, /Episode not found/)
  })

  test('a cast link must be a character of this episode’s own roster', async () => {
    const before = await getInventory(epA)

    const ghost = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({ schema_version: 1, entities: [entity({ character_id: 'ghost-character' })] })
    assert.equal(ghost.status, 400, JSON.stringify(ghost.body))
    assert.match(ghost.body.detail, /ghost-character/)
    assert.match(ghost.body.detail, /this channel's cast/)

    const foreign = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({ schema_version: 1, entities: [entity({ character_id: foreignCharacterId })] })
    assert.equal(foreign.status, 400, JSON.stringify(foreign.body))
    assert.match(foreign.body.detail, new RegExp(foreignCharacterId))

    const after = await getInventory(epA)
    assert.deepEqual(
      after.doc.entities.map((e: any) => e.id),
      before.doc.entities.map((e: any) => e.id),
      'a refused save must leave the stored inventory untouched',
    )
  })

  test('a malformed entity is a 400 that names it, and the stored inventory survives', async () => {
    const before = await getInventory(epA)
    const cases: Array<{ body: any; expect: RegExp }> = [
      { body: entity({ id: 'cast-aria', kind: 'prop' }), expect: /kind must be/ },
      { body: entity({ id: 'cast-aria', name: '   ' }), expect: /name is required/ },
      { body: entity({ id: 'Cast Aria' }), expect: /not canonical/ },
      { body: entity({ id: 'cast-boro', description: 42 as any }), expect: /description must be text/ },
      { body: entity({ review: 'maybe' as any }), expect: /review must be/ },
    ]
    for (const c of cases) {
      const res = await request(app)
        .put(`/api/projects/${slug}/story-entities/${epA}`)
        .send({ schema_version: 1, entities: [c.body] })
      assert.equal(res.status, 400, `${JSON.stringify(c.body)} → ${JSON.stringify(res.body)}`)
      assert.match(res.body.detail, c.expect)
    }

    const duplicate = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({ schema_version: 1, entities: [entity({ id: 'cast-aria' }), entity({ id: 'cast-aria' })] })
    assert.equal(duplicate.status, 400, JSON.stringify(duplicate.body))
    assert.match(duplicate.body.detail, /duplicate entity id 'cast-aria'/)

    const after = await getInventory(epA)
    assert.deepEqual(
      after.doc.entities.map((e: any) => e.id),
      before.doc.entities.map((e: any) => e.id),
      'no malformed save may reach disk',
    )
  })

  test('reference images must be real files inside this episode', async () => {
    const refDir = path.join(dirA, 'img2img-references')
    await fs.mkdir(refDir, { recursive: true })
    await fs.writeFile(path.join(refDir, 'ref.png'), 'png', 'utf-8')
    const outside = path.join(path.dirname(dirA), 'outside.png')
    await fs.writeFile(outside, 'png', 'utf-8')

    const ok = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [entity({ character_id: ownedCharacterId, reference_images: ['img2img-references/ref.png'] })],
      })
    assert.equal(ok.status, 200, JSON.stringify(ok.body))
    assert.deepEqual(ok.body.doc.entities[0].reference_images, ['img2img-references/ref.png'])

    const escaped = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [entity({ character_id: ownedCharacterId, reference_images: ['../outside.png'] })],
      })
    assert.equal(escaped.status, 400, JSON.stringify(escaped.body))
    assert.match(escaped.body.detail, /outside\.png/)

    const missing = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [entity({ character_id: ownedCharacterId, reference_images: ['no-such-file.png'] })],
      })
    assert.equal(missing.status, 400, JSON.stringify(missing.body))
    assert.match(missing.body.detail, /no-such-file\.png/)

    // The refused saves must not have replaced the good reference either.
    const body = await getInventory(epA)
    assert.deepEqual(body.doc.entities[0].reference_images, ['img2img-references/ref.png'])
  })

  test('re-saves are idempotent, preserve review, and keep unmentioned entities', async () => {
    // The same payload again: same records, no duplicates.
    const again = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [
          entity({ character_id: ownedCharacterId, reference_images: ['img2img-references/ref.png'] }),
          entity({ id: 'location-harbor', kind: 'location', name: 'Harbor', description: 'fog at dawn, ropes creaking' }),
        ],
      })
    assert.equal(again.status, 200, JSON.stringify(again.body))
    assert.deepEqual(again.body.doc.entities.map((e: any) => e.id), ['cast-aria', 'location-harbor'])

    // Drop Aria (the review decision), mentioning only Aria.
    const dropped = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [entity({ character_id: ownedCharacterId, review: 'drop' })],
      })
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body))

    // An out-of-date save that omits `review` entirely must NOT reset it,
    // and must NOT delete the entity it never mentioned.
    const stale = await request(app)
      .put(`/api/projects/${slug}/story-entities/${epA}`)
      .send({
        schema_version: 1,
        entities: [entity({ character_id: ownedCharacterId, review: undefined })],
      })
    assert.equal(stale.status, 200, JSON.stringify(stale.body))
    const byId = new Map<string, any>(
      stale.body.doc.entities.map((e: any): [string, any] => [e.id, e]),
    )
    assert.equal(byId.get('cast-aria')?.review, 'drop', 'an omitted review keeps the stored decision')
    assert.ok(byId.has('location-harbor'), 'an unmentioned entity is preserved, never deleted')

    // An id-less retry adopts the stored record instead of duplicating it.
    const worldPayload = {
      schema_version: 1,
      entities: [{ kind: 'world', name: 'The Long Winter', description: 'the snow that never stops', important: true, review: 'keep' }],
    }
    const first = await request(app).put(`/api/projects/${slug}/story-entities/${epA}`).send(worldPayload)
    assert.equal(first.status, 200, JSON.stringify(first.body))
    const minted = first.body.doc.entities.find((e: any) => e.kind === 'world')
    assert.ok(minted, 'the new entity must be saved')
    assert.match(minted.id, /^world-the-long-winter/, 'the id is canonical, from kind + name')

    const second = await request(app).put(`/api/projects/${slug}/story-entities/${epA}`).send(worldPayload)
    assert.equal(second.status, 200, JSON.stringify(second.body))
    assert.equal(second.body.doc.entities.length, first.body.doc.entities.length, 'the retry must not duplicate')
    assert.equal(
      second.body.doc.entities.filter((e: any) => e.kind === 'world').length,
      1,
      'exactly one world entity after the retry',
    )
  })
})
