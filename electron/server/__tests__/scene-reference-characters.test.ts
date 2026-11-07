/**
 * Scene Review "Reference to Image" — the OWNERSHIP boundary and the wire.
 *
 * AGENTS.md §4: only THIS episode's own characters, decided by membership in
 * the list the picker was built from — never by parsing a path or trusting an
 * id because it looks local. AGENTS.md §8: every failure that could have sent
 * a text-to-image render instead is a blocking refusal that names the
 * character, the episode and the published limit.
 *
 * The service-level cases below call the real resolver against a real
 * temporary project. The two end-to-end cases drive the real per-scene
 * generator against the in-process mock Gateway and read the ACTUAL HTTP
 * traffic (`service.requests`), so "the references reached the request" is
 * proven from what left the machine.
 *
 * ZERO paid calls. Nothing here touches the real Gateway.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import {
  proposeSceneReferenceCharacters,
  referenceContentIdentity,
  resolveSceneReferences,
  sceneReferenceIds,
} from '../services/scene-reference-characters.js'

async function png(dir: string, name: string, width = 800, height = 800): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: { r: 80, g: 110, b: 150 } } })
    .png().toFile(file)
  return file
}

/** A project with one accepted episode and a real episode directory. */
async function createProject(name: string) {
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'Reference ownership', logline: 'A deterministic mock episode.', themes: [],
    suggested_chapters: 1, suggested_length: 'short', mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  return {
    project,
    episodeId: accepted.episode_code,
    paths: await resolveEpisodePathsByCode(project.slug, accepted.episode_code),
  }
}

interface CharacterOptions {
  /** Which episodes own the character. Defaults to the current episode. */
  episodeCodes?: string[]
  /** Create a real portrait on disk. Defaults to true. */
  portrait?: boolean
  /** Portrait pixel size, so the published ceiling can be exercised. */
  width?: number
  height?: number
  /** Write bytes that are not a decodable image. */
  corrupt?: boolean
  /** Delete the portrait after it was registered, as a stale selection does. */
  deleteAfter?: boolean
}

async function addCharacter(
  slug: string,
  name: string,
  id: string,
  opts: CharacterOptions = {},
): Promise<string> {
  const cm = await import('../services/character-manager.js')
  const project = await import('../services/project-manager.js')
  await cm.createCharacter(slug, {
    id, name, description: `${name} — test character.`, scope: 'episode',
    episode_codes: opts.episodeCodes || ['EP-ANY'],
  })
  if (opts.portrait === false) return id
  const charactersDir = path.join(project.getProjectDir(slug) || '', 'characters', id)
  const file = path.join(charactersDir, 'portrait.png')
  if (opts.corrupt) {
    await fs.mkdir(charactersDir, { recursive: true })
    const bytes = await fs.readFile(await png(charactersDir, 'source.png', opts.width, opts.height))
    await fs.writeFile(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
  } else {
    await png(charactersDir, 'portrait.png', opts.width, opts.height)
  }
  await cm.updateCharacter(slug, id, { references: { images: ['portrait.png'] } })
  if (opts.deleteAfter) await fs.rm(file)
  return id
}

const CAPABLE = {
  supportsReferences: true,
  maxReferences: 2,
  maxDimension: 1024,
  modelName: 'Reference model',
}

test('only THIS episode\'s own characters can be referenced, and the refusal names both', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference ownership')
    const other = await addCharacter(project.slug, 'Elsewhere', 'elsewhere', { episodeCodes: ['EP-OTHER'] })
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [other],
        episodeDir: paths.episode_dir, ...CAPABLE,
      }),
      /Character 'elsewhere' is not part of EP\d+/,
      'a character owned by another episode must be refused, naming the character and the episode',
    )
  } finally {
    await temp.cleanup()
  }
})

test('a character with no portrait is refused, never a silent N−1 references', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference partial')
    const withPortrait = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] })
    const without = await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId], portrait: false })
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [withPortrait, without],
        episodeDir: paths.episode_dir, ...CAPABLE,
      }),
      /'Kiri' has no reference image/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('a selection over the published ceiling is refused with the model and the number', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference ceiling')
    const ids = [
      await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] }),
      await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId] }),
      await addCharacter(project.slug, 'Sen', 'sen', { episodeCodes: [episodeId] }),
    ]
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: ids,
        episodeDir: paths.episode_dir, supportsReferences: true, maxReferences: 2, modelName: 'Reference model',
      }),
      /3 character reference\(s\) were selected but Reference model accepts at most 2/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('a model publishing no reference support refuses the selection — never a text-only render', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference unsupported')
    const id = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] })
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [id],
        episodeDir: paths.episode_dir, supportsReferences: false, maxReferences: 0, modelName: 'model-with-zero-references',
      }),
      /model-with-zero-references accepts no reference images/,
    )
    // A reference-capable model that publishes no limit is refused too: the count is
    // never guessed (AGENTS.md §1).
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [id],
        episodeDir: paths.episode_dir, supportsReferences: true, maxReferences: undefined, modelName: 'model-with-unpublished-reference-limit',
      }),
      /model-with-unpublished-reference-limit accepts no reference images/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('a portrait that has gone missing since it was selected is refused naming the character and the path', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference stale')
    const id = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId], deleteAfter: true })
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [id],
        episodeDir: paths.episode_dir, ...CAPABLE,
      }),
      /'Mara's reference image is missing: .*portrait\.png/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('a corrupt portrait is refused with the app\'s decode message before anything is submitted', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference malformed')
    const id = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId], corrupt: true })
    await assert.rejects(
      resolveSceneReferences({
        slug: project.slug, episodeCode: episodeId, characterIds: [id],
        episodeDir: paths.episode_dir, ...CAPABLE,
      }),
      /Reference image is corrupt or incomplete/,
    )
  } finally {
    await temp.cleanup()
  }
})

test('an empty selection is not an error, and the identity stays empty', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference empty')
    const resolved = await resolveSceneReferences({
      slug: project.slug, episodeCode: episodeId, characterIds: [],
      episodeDir: paths.episode_dir, ...CAPABLE,
    })
    assert.deepEqual(resolved, { paths: [], digests: [], names: [], fitted: [], omitted: [] })
    assert.equal(await referenceContentIdentity([]), '')
  } finally {
    await temp.cleanup()
  }
})

test('the selection is submitted in order and fitted to the published ceiling', async () => {
  const temp = await useTempDataDir()
  try {
    const { project, episodeId, paths } = await createProject('Reference complete')
    const mara = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId], width: 1600, height: 1600 })
    const kiri = await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId], width: 800, height: 800 })
    const resolved = await resolveSceneReferences({
      slug: project.slug, episodeCode: episodeId, characterIds: [mara, kiri],
      episodeDir: paths.episode_dir, ...CAPABLE,
    })
    assert.deepEqual(resolved.names, ['Mara', 'Kiri'], 'selection order is preserved')
    assert.equal(resolved.paths.length, 2)
    assert.equal(resolved.paths[0]!.includes(path.join('.render-fit', 'mara')), true,
      'an oversized portrait is fitted into a per-character cache, never beside another character\'s')
    assert.deepEqual(resolved.fitted, [{ name: 'Mara', from: { width: 1600, height: 1600 }, to: { width: 1024, height: 1024 } }])
    assert.equal(resolved.paths[1]!.endsWith('portrait.png'), true, 'a portrait inside the ceiling is submitted untouched')
    const original = await fs.stat(path.join(paths.episode_dir, 'img2img-references', '.render-fit', 'mara', 'portrait.png'))
    assert.ok(original.size > 0)
  } finally {
    await temp.cleanup()
  }
})

test('the idempotency identity follows the reference CONTENT, in order', async () => {
  const temp = await useTempDataDir()
  try {
    const first = await png(path.join(temp.dir, 'refs'), 'a.png')
    const second = await png(path.join(temp.dir, 'refs'), 'b.png', 640, 480)
    const a = await referenceContentIdentity([first])
    const again = await referenceContentIdentity([first])
    const changed = await referenceContentIdentity([second])
    const both = await referenceContentIdentity([first, second])
    const reversed = await referenceContentIdentity([second, first])
    assert.equal(a, again, 'the same files replay the same request instead of paying twice')
    assert.notEqual(a, changed, 'a changed reference is a different request')
    assert.notEqual(both, reversed, 'which character is first is part of the request')
    assert.match(a, /^[0-9a-f]{16}$/)
  } finally {
    await temp.cleanup()
  }
})

// ── Per-scene selection ───────────────────────────────────────────────────

test('a scene\'s own list wins; an empty list stays empty; only a scene that never chose falls back', () => {
  assert.deepEqual(sceneReferenceIds({ reference_character_ids: ['mara'] }, ['kiri']), ['mara'])
  assert.deepEqual(sceneReferenceIds({ reference_character_ids: [] }, ['kiri']), [],
    'a deliberate text-only scene must not inherit the default')
  assert.deepEqual(sceneReferenceIds({}, ['kiri']), ['kiri'])
  assert.deepEqual(sceneReferenceIds({}, []), [])
  assert.deepEqual(sceneReferenceIds({ reference_character_ids: ['mara', 'mara', ' '] }, ['kiri']), ['mara'])
})

test('re-planning one scene keeps the cast the customer chose for it', () => {
  // A re-plan rewrites the scene object. It must not take the per-scene
  // characters with it — that is episode state the customer set (§4/§5).
  const source = readFileSync(new URL('../generators/scene-plan.ts', import.meta.url), 'utf8')
  assert.match(source, /const previousReferences = fresh\.scenes\[freshIdx\]!\.reference_character_ids/)
  assert.match(source, /\.\.\.\(previousReferences \? \{ reference_character_ids: \[\.\.\.previousReferences\] \} : \{\}\)/)
})

test('the planner proposes references only for characters a character scene names', () => {
  const scenes = [
    { id: 'scene-001', scene_index: 1, visual_prompt: 'Mara crosses the night market.', transcript_segment: '', scene_type: 'character' },
    { id: 'scene-002', scene_index: 2, visual_prompt: 'A map of the trade routes.', transcript_segment: '', scene_type: 'map' },
    { id: 'scene-003', scene_index: 3, visual_prompt: 'The crowd parts for the Guide.', transcript_segment: '', scene_type: 'character' },
    { id: 'scene-004', scene_index: 4, visual_prompt: 'Lanterns over the water.', transcript_segment: '', scene_type: 'environment' },
  ] as any[]
  proposeSceneReferenceCharacters(scenes, [
    { id: 'mara', name: 'Mara' },
    { id: 'mascot', name: 'The Guide' },
  ])
  assert.deepEqual(scenes[0].reference_character_ids, ['mara'])
  assert.deepEqual(scenes[1].reference_character_ids, [], 'a cutaway is proposed none')
  assert.deepEqual(scenes[2].reference_character_ids, ['mascot'], 'the mascot is proposed only where it appears')
  assert.deepEqual(scenes[3].reference_character_ids, [])
})

// ── The per-scene generator's wire ───────────────────────────────────────

async function configureMockGateway(baseUrl: string): Promise<void> {
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
}

/** Republish the mock image catalogue with a given reference capability. */
async function withCatalog(baseUrl: string, overrides: Record<string, unknown>): Promise<void> {
  const originalFetch = globalThis.fetch
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init)
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== baseUrl || !['/v1/image/models', '/v1/images/models'].includes(url.pathname)) return response
    const models = await response.json() as Array<Record<string, unknown>>
    return new Response(JSON.stringify(models.map(model => ({ ...model, ...overrides }))), {
      status: response.status, headers: { 'Content-Type': 'application/json' },
    })
  }
  clearGenStudioCatalogCache()
  mockRestore = async () => { globalThis.fetch = originalFetch; clearGenStudioCatalogCache() }
}
let mockRestore: (() => Promise<void>) | null = null

async function writeScenePrerequisites(
  episodeId: string,
  paths: { scene_prompts_dir: string; subtitles_dir: string },
  sceneOverrides: Record<string, unknown> = {},
): Promise<void> {
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({
    scenes: [{
      id: 'scene-001', scene_index: 1, visual_prompt: 'Mara waits in a lantern-lit archive.', ...sceneOverrides,
    }],
  }))
  await fs.mkdir(paths.subtitles_dir, { recursive: true })
  const stitched = path.join(paths.subtitles_dir, `${episodeId}_stitched.srt`)
  await fs.writeFile(stitched, '1\n00:00:00,000 --> 00:00:01,000\nTest\n')
  await fs.writeFile(`${stitched}.json`, JSON.stringify({ complete: true, sections: [] }))
}

function sceneJob(projectSlug: string, episodeId: string, referenceIds: string[]): any {
  return {
    job_id: `scene-reference-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    project_slug: projectSlug,
    type: 'scene_image_generate',
    episode_id: episodeId,
    title: 'Reference wiring',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params: {
      episode_id: episodeId, scene_id: 'scene-001', model: 'mock-image-v1',
      aspect_ratio: '16:9', resolution: '1K',
      auto_approve_generated: false,
      ...(referenceIds.length ? { reference_character_ids: referenceIds } : {}),
    },
  }
}

test('two character portraits reach the generation POST in order, with a reference identity', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGateway(service.baseUrl)
    await import('../providers/image/genstudio.js')
    await withCatalog(service.baseUrl, {
      supports_reference_images: true, supports_image_to_image: true,
      max_reference_images: 2, min_reference_images: 1, reference_image_max_dimension: 1024,
      chargeable: false, operations: ['image.generation', 'image.edit'],
    })
    const { generateSceneImageJob } = await import('../generators/scene-image.js')
    const { project, episodeId, paths } = await createProject('Scene reference wire')
    await writeScenePrerequisites(episodeId, paths)
    const mara = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] })
    const kiri = await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId] })
    const job = sceneJob(project.slug, episodeId, [mara, kiri])
    await generateSceneImageJob(job)

    const uploads = service.requests.filter(request => request.method === 'POST' && request.path === '/v1/images/source-images')
    const bodies = service.requests
      .filter(request => request.method === 'POST' && request.path === '/v1/images/generations')
      .map(request => JSON.parse(request.bodyText))
    assert.equal(uploads.length, 2, 'both portraits are uploaded — one upload per reference')
    assert.equal(bodies.length, 1)
    assert.equal(bodies[0].reference_asset_ids?.length, 2, 'the generation POST carries both references')
    assert.match(job.output_lines.join('\n'), /Character references: Mara, Kiri \(2 of 2 published slot\(s\)\)/)
    const saved = await fs.stat(path.join(job.output_dir, 'scene-001.png'))
    assert.ok(saved.size > 0, 'the verified image is written to this episode\'s scene-image folder')

    // §4.3 — the replay identity covers WHICH references were attached, so a
    // retry with the same characters reconnects and a changed selection does
    // not hand back the previous render.
    const { readManifest } = await import('../services/task-manifest.js')
    const keyOf = async (target: any) => {
      await generateSceneImageJob(target)
      return (await readManifest(target.output_dir)).tasks['scene-001.png']!.idempotency_key!
    }
    const firstKey = (await readManifest(job.output_dir)).tasks['scene-001.png']!.idempotency_key!
    assert.equal(await keyOf(sceneJob(project.slug, episodeId, [mara, kiri])), firstKey,
      'the same references keep the same request identity, so a retry reconnects')
    assert.notEqual(await keyOf(sceneJob(project.slug, episodeId, [kiri])), firstKey,
      'a changed reference set is a new request, never a replay of the old image')
  } finally {
    if (mockRestore) await mockRestore()
    await service.close()
    await temp.cleanup()
  }
})

test('the scene\'s own characters override the request default in the per-scene generator', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGateway(service.baseUrl)
    await import('../providers/image/genstudio.js')
    await withCatalog(service.baseUrl, {
      supports_reference_images: true, supports_image_to_image: true,
      max_reference_images: 2, min_reference_images: 0, reference_image_max_dimension: 1024,
      chargeable: false, operations: ['image.generation', 'image.edit'],
    })
    const { generateSceneImageJob } = await import('../generators/scene-image.js')
    const { project, episodeId, paths } = await createProject('Scene own references')
    const mara = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] })
    const kiri = await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId] })
    await writeScenePrerequisites(episodeId, paths, { reference_character_ids: [kiri] })
    const job = sceneJob(project.slug, episodeId, [mara])
    await generateSceneImageJob(job)

    const uploads = service.requests.filter(request => request.method === 'POST' && request.path === '/v1/images/source-images')
    const bodies = service.requests
      .filter(request => request.method === 'POST' && request.path === '/v1/images/generations')
      .map(request => JSON.parse(request.bodyText))
    assert.equal(uploads.length, 1, 'only the scene\'s own character is uploaded')
    assert.equal(bodies[0].reference_asset_ids?.length, 1)
    const referenceLine = (job.output_lines.join('\n').match(/Character references:.*/) || [''])[0]
    assert.match(referenceLine, /Kiri/)
    assert.doesNotMatch(referenceLine, /Mara/, 'the request default never overrides the scene')
  } finally {
    if (mockRestore) await mockRestore()
    await service.close()
    await temp.cleanup()
  }
})

test('a model switch re-reads the published ceiling instead of trusting the previous one', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  try {
    await configureMockGateway(service.baseUrl)
    await import('../providers/image/genstudio.js')
    const { generateSceneImageJob } = await import('../generators/scene-image.js')
    const { project, episodeId, paths } = await createProject('Scene reference model switch')
    await writeScenePrerequisites(episodeId, paths)
    const mara = await addCharacter(project.slug, 'Mara', 'mara', { episodeCodes: [episodeId] })
    const kiri = await addCharacter(project.slug, 'Kiri', 'kiri', { episodeCodes: [episodeId] })

    await withCatalog(service.baseUrl, {
      supports_reference_images: true, supports_image_to_image: true, max_reference_images: 1,
      min_reference_images: 1, reference_image_max_dimension: 1024, chargeable: false,
      operations: ['image.generation', 'image.edit'],
    })
    await assert.rejects(
      generateSceneImageJob(sceneJob(project.slug, episodeId, [mara, kiri])),
      /2 character reference\(s\) were selected but .* accepts at most 1/,
      'the first model publishes one slot, so two references are refused',
    )
    assert.equal(service.requests.filter(r => r.path === '/v1/images/source-images').length, 0,
      'nothing is uploaded for a selection the model refuses')

    await mockRestore?.()
    await withCatalog(service.baseUrl, {
      supports_reference_images: true, supports_image_to_image: true, max_reference_images: 2,
      min_reference_images: 1, reference_image_max_dimension: 1024, chargeable: false,
      operations: ['image.generation', 'image.edit'],
    })
    const job = sceneJob(project.slug, episodeId, [mara, kiri])
    await generateSceneImageJob(job)
    assert.equal(service.requests.filter(r => r.path === '/v1/images/source-images').length, 2,
      'the SAME selection is accepted once the live catalogue publishes room for it')
  } finally {
    if (mockRestore) await mockRestore()
    await service.close()
    await temp.cleanup()
  }
})
