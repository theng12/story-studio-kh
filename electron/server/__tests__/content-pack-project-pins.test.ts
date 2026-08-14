import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import express from 'express'
import JSZip from 'jszip'
import request from 'supertest'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import {
  pruneUnpinnedContentPackVersions,
  setContentPackDiscoveryDisabled,
  uninstallContentPackVersion,
} from '../content-packs/lifecycle.js'
import {
  applyProjectContentUpgrade,
  ContentPackMissingError,
  isProjectContentPackVersionPinnedLocked,
  listProjectSlugsPinningContentPackVersionLocked,
  planProjectContentUpgrade,
  resolveProjectContentPins,
  setProjectContentPin,
  snapshotProjectContentPackProvenance,
  updateProjectContentSelections,
  createProjectWithContentSelections,
} from '../content-packs/project-pins.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { readContentPackState } from '../content-packs/state.js'
import type { ContentPackDocument } from '../content-packs/types.js'
import * as jobQueue from '../services/job-queue.js'
import * as nicheLoader from '../services/niche-loader.js'
import * as projectManager from '../services/project-manager.js'
import * as formatLoader from '../services/format-loader.js'
import { resolveProjectArtStyle } from '../services/art-style-resolver.js'
import { errorBoundary } from '../lib/error-boundary.js'
import { router as settingsRouter } from '../routes/settings.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-project-pins'
const PACK_ID = 'com.storystudio.project-pin-test'
const FORMULA_ID = `${PACK_ID}.formula`
const TOPIC_ID = `${PACK_ID}.topic`
const STYLE_ID = `${PACK_ID}.style`
const RECIPE_ID = `${PACK_ID}.recipe`
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function documents(label: string, includeCreativeSelections = false): ContentPackDocument[] {
  const base: ContentPackDocument[] = [{
    kind: 'series-formula', schema_version: 1, id: FORMULA_ID, name: `Formula ${label}`,
    description: 'A pinned Formula.', channel_promise: 'Explain one bounded system.', audience: 'Curious adults.',
    narrative_rules: [`Narrative ${label}`], title_rules: ['Name the mechanism.'],
    script_structure: {
      default_chapter_count: 3, chapter_count_range: [2, 4], default_length_minutes: 10,
      length_minutes_range: [5, 15], duration_presets: [5, 10, 15], default_words_per_minute: 120,
      chapters_independent: true, pacing_arc: ['Opening'], additional_rules: ['Stay precise.'],
    },
    compatible_topic_pack_ids: [TOPIC_ID], default_topic_pack_ids: [TOPIC_ID],
    recommended_visual_style_ids: [], recommended_thumbnail_recipe_ids: [],
    script_context: `Script context ${label}`,
  }, {
    kind: 'topic-pack', schema_version: 1, id: TOPIC_ID, name: `Topic ${label}`,
    description: 'A pinned Topic Pack.', compatible_formula_ids: [FORMULA_ID], subjects: [`Ledger ${label}`],
    episode_objects: ['Tax office'], time_place_scopes: ['1800s'], mechanisms: ['Extraction'],
    evidence_lenses: ['Accounts'], exclusions: [], max_siblings_per_subject: 4, prompt_context: `Topic context ${label}`,
  }]
  if (includeCreativeSelections) base.push({
    kind: 'visual-style', schema_version: 1, id: STYLE_ID, name: `Style ${label}`,
    description: 'A signed visual style.', category: 'Realistic', tags: ['archive'],
    style_bible: `Style bible ${label}`, negative_prompt: 'No text.',
    preview_assets: ['assets/style.png'], compatible_formula_ids: [FORMULA_ID],
  }, {
    kind: 'thumbnail-recipe', schema_version: 1, id: RECIPE_ID, name: `Recipe ${label}`,
    description: 'A signed recipe.', layout: 'hero', category: 'Documentary', tags: ['evidence'],
    aspect_ratio: '16:9', title_mode: 'ai', composition_guidance: 'One document.',
    required_elements: ['Document'], avoid_elements: ['Clutter'], headline_mode: 'episode-title',
    headline_guidance: 'Use the title.', default_text_style: 'Ivory', default_font_style: 'Serif',
    default_text_position: 'top', headline_formats: ['THE RECORD'], visual_style_guidance: 'Archival.',
    preview_assets: ['assets/recipe.png'], compatible_formula_ids: [FORMULA_ID],
  })
  return base
}

async function buildArchive(version: string, label: string, includeCreativeSelections = false): Promise<Uint8Array> {
  const docs = documents(label, includeCreativeSelections)
  const content = docs.map((document, index) => ({
    path: `content/item-${index}.json`,
    document,
    bytes: Buffer.from(JSON.stringify(document)),
  }))
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version,
    min_app_version: '1.0.0',
    lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: content.map(item => ({ id: item.document.id, kind: item.document.kind, schema_version: 1, path: item.path })),
    files: [...content.map(item => ({
      path: item.path,
      sha256: sha256(item.bytes),
      bytes: item.bytes.byteLength,
      mime: 'application/json',
    })), ...(includeCreativeSelections ? [
      { path: 'assets/style.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
      { path: 'assets/recipe.png', sha256: sha256(PNG_1PX), bytes: PNG_1PX.byteLength, mime: 'image/png' },
    ] : [])],
  }))
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  for (const item of content) zip.file(item.path, item.bytes, { createFolders: false })
  if (includeCreativeSelections) {
    zip.file('assets/style.png', PNG_1PX, { createFolders: false })
    zip.file('assets/recipe.png', PNG_1PX, { createFolders: false })
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function isolated() {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const recoveryRoot = path.join(temp.dir, 'recovery')
  await fs.mkdir(recoveryRoot, { recursive: true })
  return {
    temp,
    paths,
    options: { paths, policy, recoveryRoot, appVersion: '1.0.0' },
  }
}

async function install(version: string, label: string, options: Awaited<ReturnType<typeof isolated>>['options']) {
  const archiveBytes = await buildArchive(version, label)
  return installContentPack({
    archiveBytes,
    source: 'local-import',
    expectedArchiveSha256: sha256(archiveBytes),
  }, options)
}

async function installCreative(version: string, label: string, options: Awaited<ReturnType<typeof isolated>>['options']) {
  const archiveBytes = await buildArchive(version, label, true)
  return installContentPack({
    archiveBytes,
    source: 'local-import',
    expectedArchiveSha256: sha256(archiveBytes),
  }, options)
}

async function waitForTerminalJob(jobId: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline && !['done', 'error', 'cancelled'].includes(jobQueue.getJob(jobId)?.status || '')) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(
    ['done', 'error', 'cancelled'].includes(jobQueue.getJob(jobId)?.status || ''),
    `job ${jobId} did not reach a terminal state before test cleanup`,
  )
  // Queue persistence follows the terminal in-memory update asynchronously.
  await new Promise(resolve => setTimeout(resolve, 80))
}

describe('exact project Content Pack pins', () => {
  test('pins a signed Formula selected explicitly during project creation', async () => {
    const { options } = await isolated()
    const active = await install('1.0.0', 'v1', options)

    const project = await createProjectWithContentSelections({
      name: 'Created With Signed Formula',
      niche_id: FORMULA_ID,
      topic_pack_ids: [TOPIC_ID],
    }, options)

    assert.deepEqual(project.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.equal((await resolveProjectContentPins(project, options))[0]?.archive_sha256, active.archive_sha256)
  })

  test('pins the active exact versions only when a user explicitly changes selected content', async () => {
    const { options } = await isolated()
    await install('1.0.0', 'v1', options)
    const active = await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Explicit Selection' })

    const updated = await updateProjectContentSelections(project.slug, {
      replace_kinds: ['series-formula', 'topic-pack'],
      selections: [
        { id: FORMULA_ID, kind: 'series-formula' },
        { id: TOPIC_ID, kind: 'topic-pack' },
      ],
      update(projectMeta) {
        projectMeta.niche_id = FORMULA_ID
        projectMeta.topic_pack_ids = [TOPIC_ID]
      },
    }, options)

    assert.equal(updated.content_pack_versions?.[PACK_ID], '1.1.0')
    assert.equal((await resolveProjectContentPins(updated, options))[0]?.archive_sha256, active.archive_sha256)
  })

  test('pins the selected archive until an explicit reviewed upgrade or rollback changes it', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({
      name: 'Pinned Formula',
      niche_id: FORMULA_ID,
      topic_pack_ids: [TOPIC_ID],
    })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    await install('1.1.0', 'v1.1', options)
    const pinned = await projectManager.getProject(project.slug)
    assert.deepEqual(pinned?.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.deepEqual(pinned?.content_pack_items, {
      [FORMULA_ID]: { pack_id: PACK_ID, kind: 'series-formula' },
      [TOPIC_ID]: { pack_id: PACK_ID, kind: 'topic-pack' },
    })
    const effective = await nicheLoader.getEffectiveNicheFor(pinned!, undefined, options)
    assert.equal(effective?.name, 'Formula v1')
    assert.match(effective?.scriptContext || '', /Script context v1/)
    assert.doesNotMatch(effective?.scriptContext || '', /v1\.1/)

    await assert.rejects(updateProjectContentSelections(project.slug, {
      replace_kinds: ['series-formula', 'topic-pack'],
      selections: [
        { id: FORMULA_ID, kind: 'series-formula' },
        { id: TOPIC_ID, kind: 'topic-pack' },
      ],
      update(projectMeta) {
        projectMeta.niche_id = FORMULA_ID
        projectMeta.topic_pack_ids = [TOPIC_ID]
      },
    }, options), /review and apply an explicit upgrade/i)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.0.0')

    const plan = await planProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    assert.equal(plan.from.version, '1.0.0')
    assert.equal(plan.to.version, '1.1.0')
    assert.deepEqual(plan.changed_item_ids, [FORMULA_ID, TOPIC_ID])
    assert.ok(plan.affected_generation_types.includes('idea_campaign'))
    assert.ok(plan.affected_generation_types.includes('script-only'))

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], '1.1.0')
    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.0.0', options)
    const rolledBack = await projectManager.getProject(project.slug)
    assert.equal(rolledBack?.content_pack_versions?.[PACK_ID], '1.0.0')
    assert.ok(rolledBack)
    assert.equal((await resolveProjectContentPins(rolledBack, options))[0]?.archive_sha256,
      v1.archive_sha256,
      'an explicit rollback must restore the retained exact bytes, not rediscover a current release',
    )
  })

  test('reports exact missing requirements and blocks only job types that consume them', async () => {
    const { temp, options } = await isolated()
    const project = await projectManager.createProject({ name: 'Imported Missing Pack', niche_id: FORMULA_ID })
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '9.9.9' }
    imported.content_pack_items = { [FORMULA_ID]: { pack_id: PACK_ID, kind: 'series-formula' } }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    await assert.rejects(resolveProjectContentPins(imported, options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.equal(error.code, 'content-pack-missing')
      assert.deepEqual(error.requirements, [{
        pack_id: PACK_ID,
        version: '9.9.9',
        item_ids: [FORMULA_ID],
        item_kinds: ['series-formula'],
      }])
      return true
    })

    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'audio', options), [])
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'research_run', options), [])
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'contextual_cues', options), [])
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'prompt_director', options), [])
    await assert.rejects(snapshotProjectContentPackProvenance(project.slug, 'script-only', options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.equal(error.requirements[0]?.version, '9.9.9')
      return true
    })
  })

  test('missing style and recipe bytes do not block downstream render jobs that consume saved prompts', async () => {
    const { temp, options } = await isolated()
    const project = await projectManager.createProject({ name: 'Imported Missing Creative Pack' })
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '9.9.9' }
    imported.content_pack_items = {
      [STYLE_ID]: { pack_id: PACK_ID, kind: 'visual-style' },
      [RECIPE_ID]: { pack_id: PACK_ID, kind: 'thumbnail-recipe' },
    }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    for (const jobType of ['images', 'thumb_images', 'continuity_render', 'prompt_director', 'composition_generate'] as const) {
      assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, jobType, options), [])
    }
    await assert.rejects(
      snapshotProjectContentPackProvenance(project.slug, 'image_prompts', options),
      (error: unknown) => error instanceof ContentPackMissingError
        && error.requirements[0]?.item_kinds.join(',') === 'thumbnail-recipe,visual-style',
    )
  })

  test('settings selections pin signed visual styles and thumbnail recipes in the same transaction', async () => {
    const { options } = await isolated()
    const active = await installCreative('1.0.0', 'creative', options)
    const project = await projectManager.createProject({ name: 'Signed Creative Selections' })
    const app = express()
    app.locals.contentPackOptions = options
    app.use(express.json())
    app.use('/api', settingsRouter)
    app.use(errorBoundary)

    await request(app)
      .put(`/api/projects/${project.slug}/settings/config`)
      .send({ active_style_preset_id: STYLE_ID, thumbnail_template_id: RECIPE_ID })
      .expect(200)

    const saved = await projectManager.getProject(project.slug)
    assert.deepEqual(saved?.content_pack_versions, { [PACK_ID]: '1.0.0' })
    assert.deepEqual(saved?.content_pack_items, {
      [RECIPE_ID]: { pack_id: PACK_ID, kind: 'thumbnail-recipe' },
      [STYLE_ID]: { pack_id: PACK_ID, kind: 'visual-style' },
    })
    assert.equal((saved as any)?.active_style_preset_id, STYLE_ID)
    assert.equal((saved as any)?.thumbnail_template_id, RECIPE_ID)
    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'image_prompts', options), [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: active.archive_sha256,
      item_ids: [RECIPE_ID, STYLE_ID],
    }])

    await installCreative('1.1.0', 'new active', options)
    const pinnedStyle = await resolveProjectArtStyle(project.slug, options)
    assert.equal(pinnedStyle?.description, 'Style bible creative')
  })

  test('reports a selected item missing from an available exact archive only to its consumers', async () => {
    const { temp, options } = await isolated()
    const installed = await install('1.0.0', 'v1', options)
    const project = await projectManager.createProject({ name: 'Imported Missing Item' })
    const missingFormulaId = `${PACK_ID}.removed-formula`
    const projectPath = path.join(temp.dir, 'projects', project.slug, 'project.json')
    const imported = JSON.parse(await fs.readFile(projectPath, 'utf8'))
    imported.content_pack_versions = { [PACK_ID]: '1.0.0' }
    imported.content_pack_items = { [missingFormulaId]: { pack_id: PACK_ID, kind: 'series-formula' } }
    await fs.writeFile(projectPath, `${JSON.stringify(imported, null, 2)}\n`)

    assert.deepEqual(await snapshotProjectContentPackProvenance(project.slug, 'audio', options), [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: installed.archive_sha256,
      item_ids: [missingFormulaId],
    }])
    await assert.rejects(snapshotProjectContentPackProvenance(project.slug, 'script-only', options), (error: unknown) => {
      assert.ok(error instanceof ContentPackMissingError)
      assert.deepEqual(error.requirements[0]?.item_ids, [missingFormulaId])
      assert.deepEqual(error.requirements[0]?.item_kinds, ['series-formula'])
      return true
    })
  })

  test('freezes provenance at enqueue even after project upgrade, disable, and uninstall', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Queued Provenance', niche_id: FORMULA_ID })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    jobQueue.registerExecutor('script-only', async () => {
      await blocked
      await formatLoader.getEffectiveFormat(project.slug)
    })
    const queued = await jobQueue.enqueue({
      project_slug: project.slug,
      type: 'script-only',
      episode_id: 'EP001',
      title: 'Pinned job',
      params: {},
    }, options)
    assert.deepEqual(queued.content_pack_provenance, [{
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
      item_ids: [FORMULA_ID, TOPIC_ID],
    }])

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    await setContentPackDiscoveryDisabled(PACK_ID, true, options)
    await uninstallContentPackVersion(
      PACK_ID,
      '1.0.0',
      listProjectSlugsPinningContentPackVersionLocked,
      options,
    )
    assert.deepEqual(jobQueue.getJob(queued.job_id)?.content_pack_provenance, queued.content_pack_provenance)
    release()
    await waitForTerminalJob(queued.job_id)
    assert.equal(jobQueue.getJob(queued.job_id)?.status, 'error')
    assert.match(jobQueue.getJob(queued.job_id)?.error || '', /required Content Pack version is unavailable/i)
  })

  test('executes against the enqueued exact Formula instead of resolving the upgraded project live', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Frozen Formula Execution', niche_id: FORMULA_ID })
    await setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options)

    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    let observedFormula = ''
    jobQueue.registerExecutor('script-only', async () => {
      await blocked
      observedFormula = (await nicheLoader.loadNiche(FORMULA_ID, options))?.name || ''
    })
    const queued = await jobQueue.enqueue({
      project_slug: project.slug,
      type: 'script-only',
      episode_id: 'EP002',
      title: 'Frozen Formula',
      params: {},
    }, options)

    await applyProjectContentUpgrade(project.slug, PACK_ID, '1.1.0', options)
    release()
    await waitForTerminalJob(queued.job_id)
    assert.equal(observedFormula, 'Formula v1')
  })

  test('serializes a real pin mutation behind uninstall and refuses a pin to deleted bytes', async () => {
    const { options } = await isolated()
    const v1 = await install('1.0.0', 'v1', options)
    await install('1.1.0', 'v1.1', options)
    const project = await projectManager.createProject({ name: 'Uninstall Barrier' })
    let releaseRemoval!: () => void
    const removalBlocked = new Promise<void>(resolve => { releaseRemoval = resolve })
    let removalEntered!: () => void
    const removalStarted = new Promise<void>(resolve => { removalEntered = resolve })
    const removing = uninstallContentPackVersion(PACK_ID, '1.0.0', listProjectSlugsPinningContentPackVersionLocked, {
      ...options,
      hooks: { beforeRemovalDelete: async () => { removalEntered(); await removalBlocked } },
    })
    await removalStarted

    let pinFinished = false
    const pinning = setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: v1.archive_sha256,
    }, options).finally(() => { pinFinished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(pinFinished, false)
    releaseRemoval()
    await removing
    await assert.rejects(pinning, /required Content Pack version is unavailable/i)
    assert.equal((await projectManager.getProject(project.slug))?.content_pack_versions?.[PACK_ID], undefined)
  })

  test('holds the coordination barrier through the project write so uninstall and prune observe the new pin', async () => {
    const { options } = await isolated()
    const refs = new Map<string, Awaited<ReturnType<typeof install>>>()
    for (const version of ['1.0.0', '1.0.1', '1.0.2', '1.0.3']) {
      refs.set(version, await install(version, version, options))
    }
    const project = await projectManager.createProject({ name: 'Pin Write Barrier' })
    let releasePin!: () => void
    const pinBlocked = new Promise<void>(resolve => { releasePin = resolve })
    let pinEntered!: () => void
    const pinStarted = new Promise<void>(resolve => { pinEntered = resolve })
    const pinning = setProjectContentPin(project.slug, {
      pack_id: PACK_ID,
      version: '1.0.0',
      archive_sha256: refs.get('1.0.0')!.archive_sha256,
    }, {
      ...options,
      hooks: { beforeProjectWrite: async () => { pinEntered(); await pinBlocked } },
    })
    await pinStarted

    let uninstallFinished = false
    const uninstall = uninstallContentPackVersion(
      PACK_ID,
      '1.0.0',
      listProjectSlugsPinningContentPackVersionLocked,
      options,
    ).finally(() => { uninstallFinished = true })
    let pruneFinished = false
    const prune = pruneUnpinnedContentPackVersions(
      PACK_ID,
      isProjectContentPackVersionPinnedLocked,
      options,
    ).finally(() => { pruneFinished = true })
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(uninstallFinished, false)
    assert.equal(pruneFinished, false)

    releasePin()
    await pinning
    await assert.rejects(uninstall, /pinned by projects: pin-write-barrier/i)
    assert.deepEqual(await prune, [])
    assert.ok((await readContentPackState(options.paths)).packs[PACK_ID].versions['1.0.0'])
  })
})
