/**
 * Episode Visual Setup Phase 2 — per-scene story entity links + state, and
 * adaptive reference selection into the scene-image renderer.
 *
 * What this pins:
 *   - a scene's OWN selection (including an explicit empty one) always wins;
 *   - a non-character scene gets no character guide, whatever the links say;
 *   - linked cast entities become character references only through the
 *     existing character pipeline, and linked important non-cast entities
 *     contribute their own canonical file;
 *   - the live published slot count decides what fits — never a hardcoded cap;
 *   - a foreign entity, or a listed-but-missing file, is refused in preflight;
 *   - links persist by stable scene id, survive an unrelated save, clear on an
 *     explicit empty entry, and never leak from another episode.
 *
 * ZERO paid calls.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import {
  describeStoryState,
  normalizeSceneStoryEntry,
  normalizeStoryState,
  parseSceneStoryContext,
} from '../contracts/scene-story-context.js'
import {
  readSceneStoryContext,
  resolveSceneReferences,
  sceneAdaptiveCharacterIds,
  sceneStoryReferenceEntityIds,
  sceneStoryStateSuffix,
  writeSceneStoryContext,
} from '../services/scene-reference-characters.js'

let cleanup: () => Promise<void>
let app: express.Express

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const { router } = await import('../routes/scene-review.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})
after(async () => { await cleanup() })

// ── pure contract ──────────────────────────────────────────────────────

test('state accepts exactly the five story fields and drops blanks', () => {
  assert.deepEqual(
    normalizeStoryState({ outfit: '  red coat ', age: '', weather: 'rain' }, 'Mara'),
    { outfit: 'red coat', weather: 'rain' },
  )
  assert.equal(normalizeStoryState({}, 'Mara'), undefined)
  assert.throws(() => normalizeStoryState({ mood: 'angry' }, 'Mara'), /state 'mood' is not one of/)
  assert.throws(() => normalizeStoryState({ age: 40 }, 'Mara'), /state 'age' must be text/)
})

test('a scene entry refuses duplicate links and non-canonical ids', () => {
  assert.deepEqual(
    normalizeSceneStoryEntry({ scene_id: 'scene-001', entities: [{ entity_id: 'cast-mara' }] }, 0),
    { scene_id: 'scene-001', entities: [{ entity_id: 'cast-mara' }] },
  )
  assert.throws(
    () => normalizeSceneStoryEntry({ scene_id: 'scene-001', entities: [{ entity_id: 'a' }, { entity_id: 'a' }] }, 0),
    /duplicate entity link 'a'/,
  )
  assert.throws(
    () => normalizeSceneStoryEntry({ scene_id: 'scene-001', entities: [{ entity_id: 'Not Canonical' }] }, 0),
    /not canonical/,
  )
})

test('a malformed sidecar is refused, never read as "no links"', () => {
  assert.throws(() => parseSceneStoryContext('{nope'), /scene-story-context\.json is not valid JSON/)
  assert.throws(() => parseSceneStoryContext(JSON.stringify({ schema_version: 2, scenes: [] })), /schema_version 1/)
})

test('state text keeps a fixed field order', () => {
  assert.equal(
    describeStoryState({ damage: 'torn sleeve', outfit: 'red coat', time: 'night' }),
    'outfit: red coat; time: night; damage: torn sleeve',
  )
  assert.equal(describeStoryState(undefined), '')
})

// ── adaptive selection ─────────────────────────────────────────────────

const ENTITIES: any[] = [
  { id: 'cast-mara', kind: 'cast', name: 'Mara', review: 'keep', important: true, character_id: 'mara', reference_images: [] },
  { id: 'location-inn', kind: 'location', name: 'The Inn', review: 'keep', important: true, reference_images: ['refs/inn.png'] },
  { id: 'object-key', kind: 'object', name: 'Brass key', review: 'drop', important: true, reference_images: ['refs/key.png'] },
  { id: 'object-cup', kind: 'object', name: 'Chipped cup', review: 'keep', important: false, reference_images: ['refs/cup.png'] },
]
const STORY = {
  doc: {
    schema_version: 1 as const,
    updated_at: '',
    scenes: [{
      scene_id: 'scene-001',
      entities: [
        { entity_id: 'cast-mara', state: { outfit: 'red coat' } },
        { entity_id: 'location-inn', state: { weather: 'rain' } },
        { entity_id: 'object-key', state: { damage: 'bent' } },
      ],
    }],
  },
  entities: ENTITIES,
}

test('the scene\'s own selection wins, including a deliberate empty one', () => {
  assert.deepEqual(
    sceneAdaptiveCharacterIds({
      scene: { id: 'scene-001', scene_type: 'character', reference_character_ids: ['other'] },
      story: STORY,
    }),
    ['other'],
  )
  assert.deepEqual(
    sceneAdaptiveCharacterIds({
      scene: { id: 'scene-001', scene_type: 'character', reference_character_ids: [] },
      story: STORY,
      fallback: ['fallback'],
    }),
    [],
  )
})

test('a scene that names none follows its linked cast, then the request default', () => {
  assert.deepEqual(
    sceneAdaptiveCharacterIds({ scene: { id: 'scene-001', scene_type: 'character' }, story: STORY }),
    ['mara'],
  )
  assert.deepEqual(
    sceneAdaptiveCharacterIds({
      scene: { id: 'scene-002', scene_type: 'character' },
      story: STORY,
      fallback: ['fallback'],
    }),
    ['fallback'],
  )
})

test('no character guide on a non-character scene, and none for text2img', () => {
  assert.deepEqual(
    sceneAdaptiveCharacterIds({ scene: { id: 'scene-001', scene_type: 'environment' }, story: STORY }),
    [],
  )
  assert.deepEqual(
    sceneAdaptiveCharacterIds({
      scene: { id: 'scene-001', scene_type: 'character' },
      story: STORY,
      imageMode: 'text2img',
    }),
    [],
  )
})

test('only kept, important, non-character-linked entities contribute a reference', () => {
  assert.deepEqual(sceneStoryReferenceEntityIds('scene-001', STORY), ['location-inn'])
})

test('story state text names only the linked, kept entities that changed', () => {
  const { suffix, applied } = sceneStoryStateSuffix('scene-001', STORY)
  assert.match(suffix, /Mara — outfit: red coat/)
  assert.match(suffix, /The Inn — weather: rain/)
  assert.doesNotMatch(suffix, /Brass key/, 'a dropped entity contributes nothing')
  assert.deepEqual(applied, ['Mara', 'The Inn'])
  assert.equal(sceneStoryStateSuffix('scene-002', STORY).suffix, '')
})

// ── persistence ────────────────────────────────────────────────────────

async function seed(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const cm = await import('../services/character-manager.js')
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const { writeStoryEntities } = await import('../services/story-entities.js')

  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Story links', logline: 'A deterministic episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  await fs.mkdir(path.join(paths.episode_dir, 'refs'), { recursive: true })

  const planPath = await resolveScenePlanPath(project.slug, episodeId, paths.episode_dir)
  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({
    schema_version: 1, generated_at: '', planner_model: '', total_duration_sec: 20,
    scenes: [
      { id: 'scene-001', scene_index: 1, start_sec: 0, end_sec: 10, transcript_segment: '', visual_prompt: 'A lighthouse.' },
      { id: 'scene-002', scene_index: 2, start_sec: 10, end_sec: 20, transcript_segment: '', visual_prompt: 'A harbour.' },
    ],
  }), 'utf-8')

  await cm.createCharacter(project.slug, {
    id: 'mara', name: 'Mara', description: 'Keeper.', scope: 'episode', episode_codes: [episodeId],
  })
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 80, g: 110, b: 150 } } })
    .png().toBuffer()
  await fs.writeFile(path.join(paths.episode_dir, 'refs', 'inn.png'), png)
  await fs.writeFile(path.join(paths.episode_dir, 'refs', 'cup.png'), png)
  const charactersDir = path.join(pm.getProjectDir(project.slug) || '', 'characters', 'mara')
  await fs.mkdir(charactersDir, { recursive: true })
  await fs.writeFile(path.join(charactersDir, 'portrait.png'), png)
  await cm.updateCharacter(project.slug, 'mara', { references: { images: ['portrait.png'] } })

  await writeStoryEntities(project.slug, episodeId, {
    entities: [
      { id: 'cast-mara', kind: 'cast', name: 'Mara', important: true, character_id: 'mara', review: 'keep' },
      { id: 'location-inn', kind: 'location', name: 'The Inn', important: true, review: 'keep', reference_images: ['refs/inn.png'] },
      { id: 'object-cup', kind: 'object', name: 'Chipped cup', important: false, review: 'keep', reference_images: ['refs/cup.png'] },
      { id: 'object-bent', kind: 'object', name: 'Bent key', important: true, review: 'drop', reference_images: [] },
    ],
  })
  return { project, episodeId, paths, planPath }
}

test('links persist by scene id, merge across saves, and clear on an explicit empty entry', async () => {
  const { project, episodeId } = await seed('Story link persistence')
  await writeSceneStoryContext(project.slug, episodeId, {
    scenes: [{ scene_id: 'scene-001', entities: [{ entity_id: 'cast-mara', state: { outfit: 'red coat' } }] }],
  })
  await writeSceneStoryContext(project.slug, episodeId, {
    scenes: [{ scene_id: 'scene-002', entities: [{ entity_id: 'location-inn' }] }],
  })
  let read = await readSceneStoryContext(project.slug, episodeId)
  assert.equal(read.exists, true)
  assert.deepEqual(read.doc.scenes.map(entry => entry.scene_id), ['scene-001', 'scene-002'])
  assert.deepEqual(read.doc.scenes[0]!.entities, [{ entity_id: 'cast-mara', state: { outfit: 'red coat' } }])

  await writeSceneStoryContext(project.slug, episodeId, {
    scenes: [{ scene_id: 'scene-001', entities: [] }],
  })
  read = await readSceneStoryContext(project.slug, episodeId)
  assert.deepEqual(read.doc.scenes[0]!.entities, [], 'an explicit empty entry clears that scene')
  assert.equal(read.doc.scenes[1]!.entities[0]!.entity_id, 'location-inn', 'an unmentioned scene is kept')
})

test('a stale scene id or an entity outside the kept inventory is refused', async () => {
  const { project, episodeId } = await seed('Story link refusals')
  await assert.rejects(
    writeSceneStoryContext(project.slug, episodeId, {
      scenes: [{ scene_id: 'scene-999', entities: [{ entity_id: 'cast-mara' }] }],
    }),
    /Scene 'scene-999' is not in the saved Scene Plan/,
  )
  await assert.rejects(
    writeSceneStoryContext(project.slug, episodeId, {
      scenes: [{ scene_id: 'scene-001', entities: [{ entity_id: 'object-bent' }] }],
    }),
    /not in this episode's kept story context/,
    'a dropped entity stays in the sidecar but cannot be linked to a scene',
  )
})

test('a malformed sidecar fails loudly and another episode has no links', async () => {
  const { project, episodeId, paths } = await seed('Story link isolation')
  const file = path.join(paths.episode_dir, 'scene-story-context.json')
  await fs.writeFile(file, '{broken', 'utf-8')
  await assert.rejects(readSceneStoryContext(project.slug, episodeId), /is not valid JSON/)
  await fs.rm(file)

  const ideas = await import('../services/idea-manager.js')
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Second episode', logline: 'Another.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  const other = await ideas.acceptIdea(project.slug, idea!.id, false)
  const read = await readSceneStoryContext(project.slug, other.episode_code)
  assert.equal(read.exists, false)
  assert.deepEqual(read.doc.scenes, [], 'links never carry across an episode change')
})

// ── references into the resolver ───────────────────────────────────────

test('linked story references fill the slots the live model leaves free', async () => {
  const { project, episodeId, paths } = await seed('Story reference slots')
  const resolved = await resolveSceneReferences({
    slug: project.slug,
    episodeCode: episodeId,
    characterIds: ['mara'],
    storyEntityIds: ['location-inn', 'object-cup'],
    modelName: 'Reference model',
    supportsReferences: true,
    maxReferences: 2,
    episodeDir: paths.episode_dir,
  })
  assert.deepEqual(resolved.names, ['Mara', 'The Inn'], 'the non-important entity contributes no file')
  assert.deepEqual(resolved.omitted, [])

  const tight = await resolveSceneReferences({
    slug: project.slug,
    episodeCode: episodeId,
    characterIds: ['mara'],
    storyEntityIds: ['location-inn'],
    modelName: 'Reference model',
    supportsReferences: true,
    maxReferences: 1,
    episodeDir: paths.episode_dir,
  })
  assert.deepEqual(tight.names, ['Mara'])
  assert.deepEqual(tight.omitted, ['The Inn'], 'a published limit of 1 leaves the story reference out, reported')

  const entityOnly = await resolveSceneReferences({
    slug: project.slug,
    episodeCode: episodeId,
    characterIds: [],
    storyEntityIds: ['location-inn'],
    modelName: 'Reference model',
    supportsReferences: true,
    maxReferences: 2,
    episodeDir: paths.episode_dir,
  })
  assert.deepEqual(entityOnly.names, ['The Inn'], 'a non-character scene may still carry its location reference')
})

test('a foreign entity or a listed-but-missing file is refused before any request', async () => {
  const { project, episodeId, paths } = await seed('Story reference refusals')
  await assert.rejects(
    resolveSceneReferences({
      slug: project.slug, episodeCode: episodeId, characterIds: [], storyEntityIds: ['location-elsewhere'],
      modelName: 'Reference model', supportsReferences: true, maxReferences: 2, episodeDir: paths.episode_dir,
    }),
    /is not part of EP\d+'s story context/,
  )
  await fs.rm(path.join(paths.episode_dir, 'refs', 'inn.png'))
  await assert.rejects(
    resolveSceneReferences({
      slug: project.slug, episodeCode: episodeId, characterIds: [], storyEntityIds: ['location-inn'],
      modelName: 'Reference model', supportsReferences: true, maxReferences: 2, episodeDir: paths.episode_dir,
    }),
    /is missing from this episode's folder/,
  )
})

// ── route shape ────────────────────────────────────────────────────────

test('Scene Review publishes the inventory, per-scene links and subject_kind, and accepts a save', async () => {
  const { project, episodeId } = await seed('Story route')
  const base = `/api/projects/${project.slug}/scene-review/${episodeId}`
  const read = await request(app).get(base).expect(200)
  assert.ok(Array.isArray(read.body.story_entities))
  assert.ok(read.body.story_entities.some((entity: any) => entity.id === 'cast-mara'))
  assert.equal(read.body.story_context_exists, false)
  assert.equal(read.body.scenes[0].subject_kind, null, 'an unclassified scene publishes null, not an absent key')
  assert.deepEqual(read.body.scenes[0].story_context, [])

  const saved = await request(app).put(`${base}/story-context`).send({
    scenes: [{ scene_id: 'scene-001', entities: [{ entity_id: 'cast-mara', state: { outfit: 'red coat' } }] }],
  }).expect(200)
  assert.equal(saved.body.ok, true)

  const again = await request(app).get(base).expect(200)
  assert.equal(again.body.story_context_exists, true)
  assert.deepEqual(again.body.scenes[0].story_context, [{ entity_id: 'cast-mara', state: { outfit: 'red coat' } }])

  await request(app).put(`${base}/story-context`).send({
    scenes: [{ scene_id: 'scene-999', entities: [] }],
  }).expect(400)
})
