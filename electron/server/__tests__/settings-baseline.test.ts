/**
 * Settings Baseline Service — snapshot, preview, apply, read back, and restore.
 *
 * Owner (2026-11-07, Item 19): safe settings baseline application across channels.
 *
 * Rules covered:
 * - AGENTS.md §5: Presets carry reusable settings, nothing else. Never rewrite
 *   stored presets on disk. default_scene_pacing acts as a starting template
 *   for new episodes only; existing episode pacing is never claimed or modified.
 * - AGENTS.md §6: A zero that means two things is a defect. Readback returns
 *   honest typed measurements (verified | mismatch | unverified | failed).
 * - AGENTS.md §8: Verified completion contract. Honest readback verification
 *   confirms the actual disk config matches the baseline before reporting success.
 * - User explicit operation: applying a baseline requires explicit user confirmation.
 * - Restorable: pre-apply snapshots allow full rollback of applied changes.
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'

import {
  isProtectedExcludedKey,
  isSafeBaselineKey,
} from '../contracts/settings-baseline.js'
import {
  computePayloadSha256,
  deepEqual,
  filterSafeBaselinePayload,
} from '../services/settings-baseline.js'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let settingsBaseline: typeof import('../services/settings-baseline.js')

before(async () => {
  const temp = await useTempDataDir()
  tempDir = temp.dir
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  settingsBaseline = await import('../services/settings-baseline.js')
})

after(async () => {
  process.env.STORY_STUDIO_DATA_DIR = tempDir
  await cleanup()
})

// ── Contract: safe filtering & integrity (§5, §6) ────────────────────────────

test('filterSafeBaselinePayload keeps safe reusable keys and drops secrets, disk presets, episode pacing, and retired fields', () => {
  const input = {
    // Safe reusable standard settings
    audio_quality: { mode: 'flag_issues' },
    default_scene_pacing: { phases: [{ end: 180, min: 5, max: 10 }] },
    pipeline_last_steps: { volume: 0.06, enabled: true },
    default_models: { writing: 'story-llm', image: 'qwen' },
    aspect_ratio: '16:9',
    // Secrets / API keys (§7)
    genstudio_api_key: 'secret-key-value',
    google_api_key: 'google-secret-key',
    // Disk preset dictionaries (§5: never rewrite stored disk presets)
    thumbnail_prompts_presets: [{ name: 'Old Template' }],
    scene_prompts_presets: [{ name: 'Old Template' }],
    thumbnail_generator_presets: [{ name: 'Old Generator' }],
    scene_generator_presets: [{ name: 'Old Generator' }],
    audio_generator_presets: { legacy_audio: { some: 'value' } },
    // Episode-specific state / live episode pacing (§4, §5)
    sheet: { episode_id: 'EP0018' },
    use_episode_sheet: true,
    pacing: { scene_seconds: 8 },
    // Retired fields (§7)
    models: { retired: true },
    audio_concurrency: 10,
  }

  const safe = filterSafeBaselinePayload(input)

  // Safe keys are kept
  assert.deepEqual(safe.audio_quality, { mode: 'flag_issues' })
  assert.deepEqual(safe.default_scene_pacing, { phases: [{ end: 180, min: 5, max: 10 }] })
  assert.deepEqual(safe.pipeline_last_steps, { volume: 0.06, enabled: true })
  assert.deepEqual(safe.default_models, { writing: 'story-llm', image: 'qwen' })
  assert.equal(safe.aspect_ratio, '16:9')

  // Secrets, disk presets, episode pacing, and retired fields are dropped
  assert.equal('genstudio_api_key' in safe, false)
  assert.equal('google_api_key' in safe, false)
  assert.equal('thumbnail_prompts_presets' in safe, false)
  assert.equal('scene_prompts_presets' in safe, false)
  assert.equal('thumbnail_generator_presets' in safe, false)
  assert.equal('scene_generator_presets' in safe, false)
  assert.equal('audio_generator_presets' in safe, false)
  assert.equal('sheet' in safe, false)
  assert.equal('use_episode_sheet' in safe, false)
  assert.equal('pacing' in safe, false)
  assert.equal('models' in safe, false)
  assert.equal('audio_concurrency' in safe, false)
})

test('isSafeBaselineKey and isProtectedExcludedKey match AGENTS.md boundaries', () => {
  assert.equal(isSafeBaselineKey('audio_quality'), true)
  assert.equal(isSafeBaselineKey('default_scene_pacing'), true)
  assert.equal(isSafeBaselineKey('pacing'), false)
  assert.equal(isSafeBaselineKey('thumbnail_prompts_presets'), false)

  assert.equal(isProtectedExcludedKey('thumbnail_prompts_presets'), true)
  assert.equal(isProtectedExcludedKey('scene_generator_presets'), true)
  assert.equal(isProtectedExcludedKey('pacing'), true)
  assert.equal(isProtectedExcludedKey('claim_pacing'), true)
  assert.equal(isProtectedExcludedKey('audio_quality'), false)
  assert.equal(isProtectedExcludedKey('default_scene_pacing'), false)
})

test('computePayloadSha256 is canonical, order-independent, and detects tampering', () => {
  const objA = { b: 2, a: 1, nested: { y: true, x: 100 } }
  const objB = { a: 1, nested: { x: 100, y: true }, b: 2 }

  const shaA = computePayloadSha256(objA)
  const shaB = computePayloadSha256(objB)

  assert.equal(shaA, shaB)
  assert.equal(shaA.length, 64)

  const tampered = { ...objA, a: 999 }
  assert.notEqual(computePayloadSha256(tampered), shaA)
})

test('deepEqual correctly compares structures', () => {
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] }), true)
  assert.equal(deepEqual({ a: 1, b: [1, 2] }, { a: 1, b: [1, 3] }), false)
  assert.equal(deepEqual({ x: 1 }, { x: 1, y: 2 }), false)
})

// ── Service: snapshot, apply, read back, restorable restore ───────────────────

test('createBaseline stores a safe baseline with SHA-256 fingerprint', async () => {
  const baseline = await settingsBaseline.createBaseline('Owner Standard Baseline', {
    audio_quality: { mode: 'flag_issues' },
    default_scene_pacing: { phases: [{ end: 180, min: 5, max: 10 }] },
    pipeline_last_steps: { volume: 0.06 },
    genstudio_api_key: 'should-be-stripped',
  })

  assert.ok(baseline.id)
  assert.equal(baseline.name, 'Owner Standard Baseline')
  assert.ok(baseline.payload_sha256)
  assert.equal('genstudio_api_key' in baseline.payload, false)
  assert.deepEqual(baseline.payload.audio_quality, { mode: 'flag_issues' })

  const fetched = await settingsBaseline.getBaseline(baseline.id)
  assert.ok(fetched)
  assert.deepEqual(fetched.payload, baseline.payload)
  assert.equal(fetched.payload_sha256, computePayloadSha256(fetched.payload))
})

test('previewBaselineApplication computes dry run diff without writing disk', async () => {
  const proj = await pm.createProject({ name: 'Preview Diff Channel' } as any)
  const slug = proj.slug
  const channelDir = path.join(tempDir, 'projects', slug)
  const configPath = path.join(channelDir, 'config.json')

  const baseline = await settingsBaseline.createBaseline('Baseline for Preview', {
    audio_quality: { mode: 'flag_issues' },
    default_scene_pacing: { phases: [{ end: 180, min: 5, max: 10 }] },
    thumbnail_prompts_presets: { should: 'never-apply' },
    pacing: { live: 'must-be-preserved' },
  })

  const previews = await settingsBaseline.previewBaselineApplication(baseline.id, [slug])
  assert.equal(previews.length, 1)

  const prev = previews[0]
  assert.equal(prev.channel_slug, slug)
  assert.equal(prev.baseline_id, baseline.id)
  assert.equal(prev.has_changes, true)

  const diffKeys = prev.diffs.map(d => d.key).sort()
  assert.deepEqual(diffKeys, ['audio_quality', 'default_scene_pacing'])

  const audioDiff = prev.diffs.find(d => d.key === 'audio_quality')
  assert.ok(audioDiff)
  assert.equal(audioDiff.status, 'added')

  assert.ok(prev.protected_keys_preserved.includes('pacing') || prev.protected_keys_preserved.includes('thumbnail_prompts_presets'))

  // Dry run must not modify the actual disk config.json: capture before/after.
  const before = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : null
  await settingsBaseline.previewBaselineApplication(baseline.id, [slug])
  const after = existsSync(configPath) ? await fs.readFile(configPath, 'utf-8') : null
  assert.equal(after, before, 'a dry run must not touch config.json')
})

test('applyBaseline requires explicit user confirmation', async () => {
  const proj = await pm.createProject({ name: 'Confirm Refusal Channel' } as any)
  const slug = proj.slug

  const baseline = await settingsBaseline.createBaseline('Confirm Baseline', {
    audio_quality: { mode: 'flag_issues' },
  })

  await assert.rejects(
    async () => {
      await settingsBaseline.applyBaseline({
        baseline_id: baseline.id,
        channel_slugs: [slug],
        explicit_confirm: false,
        create_restore_point: true,
      })
    },
    /Explicit user confirmation is required/,
    'Applying without explicit confirmation must be refused',
  )
})

test('applyBaseline atomic application, readback verification, and restorable snapshot (§8)', async () => {
  const proj = await pm.createProject({ name: 'Safe Apply Channel' } as any)
  const slug = proj.slug
  const channelDir = path.join(tempDir, 'projects', slug)
  const configPath = path.join(channelDir, 'config.json')

  // Setup existing config with disk presets, secret, live episode pacing, and partial settings
  const originalConfig = {
    name: 'Safe Apply Channel',
    genstudio_api_key: 'existing-secret-key',
    thumbnail_prompts_presets: [{ id: 'existing_template', name: 'Custom Template' }],
    pacing: { scene_seconds: 12 },
    audio_quality: { mode: 'off' },
    pipeline_last_steps: { volume: 0.15 },
  }
  await fs.writeFile(configPath, JSON.stringify(originalConfig, null, 2), 'utf-8')

  const baseline = await settingsBaseline.createBaseline('Safe Apply Baseline', {
    audio_quality: { mode: 'flag_issues' },
    default_scene_pacing: { phases: [{ end: 180, min: 5, max: 10 }] },
    pipeline_last_steps: { volume: 0.06 },
    thumbnail_prompts_presets: { must: 'never-apply' },
    pacing: { must: 'never-claim-or-overwrite' },
    genstudio_api_key: 'must-never-overwrite-secret',
  })

  const result = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: [slug],
    explicit_confirm: true,
    create_restore_point: true,
  })

  assert.equal(result.success_count, 1)
  assert.equal(result.failure_count, 0)

  const channelRes = result.channels[slug]
  assert.ok(channelRes)
  assert.equal(channelRes.status, 'applied')
  assert.ok(channelRes.restore_point_id)

  // Honest readback verification (§8)
  assert.ok(channelRes.readback)
  assert.equal(channelRes.readback.status, 'verified')
  assert.ok(channelRes.readback.matched_keys.includes('audio_quality'))
  assert.ok(channelRes.readback.matched_keys.includes('pipeline_last_steps'))

  // Inspect actual disk state
  const disk = JSON.parse(await fs.readFile(configPath, 'utf-8'))

  // Apply safe standard settings
  assert.deepEqual(disk.audio_quality, { mode: 'flag_issues' })
  assert.deepEqual(disk.pipeline_last_steps, { volume: 0.06 })
  assert.deepEqual(disk.default_scene_pacing, { phases: [{ end: 180, min: 5, max: 10 }] })

  // Strictly preserve disk presets (§5)
  assert.deepEqual(disk.thumbnail_prompts_presets, [{ id: 'existing_template', name: 'Custom Template' }])

  // Strictly preserve live episode pacing (§5)
  assert.deepEqual(disk.pacing, { scene_seconds: 12 })

  // Strictly preserve secrets
  assert.equal(disk.genstudio_api_key, 'existing-secret-key')

  // Verify restore point exists and is restorable
  const snapshots = await settingsBaseline.listRestorePoints(slug)
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0].id, channelRes.restore_point_id)
  assert.equal(snapshots[0].reason, 'pre_apply')

  // Restore back to pre-apply state (rollback)
  const hashAtRestore = settingsBaseline.computePayloadSha256(
    JSON.parse(await fs.readFile(configPath, 'utf-8')),
  )
  const restoreRes = await settingsBaseline.restoreChannelSnapshot({
    restore_point_id: channelRes.restore_point_id!,
    channel_slug: slug,
    explicit_confirm: true,
    expected_current_sha256: hashAtRestore,
  })

  assert.equal(restoreRes.success, true)
  assert.equal(restoreRes.readback.status, 'verified')

  // Verify disk is back to exact pre-apply state
  const restoredDisk = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  assert.deepEqual(restoredDisk.audio_quality, { mode: 'off' })
  assert.deepEqual(restoredDisk.pipeline_last_steps, { volume: 0.15 })
  assert.equal('default_scene_pacing' in restoredDisk, false)
  assert.deepEqual(restoredDisk.thumbnail_prompts_presets, [{ id: 'existing_template', name: 'Custom Template' }])
  assert.deepEqual(restoredDisk.pacing, { scene_seconds: 12 })
})

test('restoreChannelSnapshot requires explicit user confirmation', async () => {
  const proj = await pm.createProject({ name: 'Restore Confirm Channel' } as any)
  const slug = proj.slug

  const baseline = await settingsBaseline.createBaseline('Snapshot for Confirm', {
    audio_quality: { mode: 'flag_issues' },
  })

  const snapshot = await settingsBaseline.createChannelSnapshot(slug, 'manual_snapshot', baseline.id)

  await assert.rejects(
    async () => {
      await settingsBaseline.restoreChannelSnapshot({
        restore_point_id: snapshot.id,
        channel_slug: slug,
        explicit_confirm: false,
        expected_current_sha256: '',
      })
    },
    /Explicit user confirmation is required/,
    'Restore without explicit confirmation must be refused',
  )
})

// ── Integrity regressions (release-386 item 19 repair) ──────────────────────

test('corrupt store bytes are preserved, never silently replaced', async () => {
  const target = settingsBaseline.settingsBaselineStorePath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  const original = await fs.readFile(target, 'utf-8').catch(() => '')
  const garbage = '{"format":"story-studio-settings-baseline","baselines":{CORRUPT'
  await fs.writeFile(target, garbage, 'utf-8')
  try {
    await assert.rejects(async () => { await settingsBaseline.listBaselines() }, /corrupt/)
    assert.equal(await fs.readFile(target, 'utf-8'), garbage, 'corrupt bytes must be preserved')
  } finally {
    await fs.writeFile(target, original, 'utf-8')
  }
})

test('no-op apply leaves config.json mtime untouched and creates no restore point', async () => {
  const proj = await pm.createProject({ name: 'Noop Mtime Channel' } as any)
  const slug = proj.slug
  const configPath = path.join(tempDir, 'projects', slug, 'config.json')
  const current = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  const safeNow: Record<string, unknown> = {}
  for (const k of ['audio_quality', 'default_scene_pacing', 'pipeline_last_steps'] as const) {
    if (current[k] !== undefined) safeNow[k] = current[k]
  }
  const baseline = await settingsBaseline.createBaseline('Identical Baseline', safeNow)
  const before = (await fs.stat(configPath)).mtimeMs
  const res = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: [slug],
    explicit_confirm: true,
    create_restore_point: true,
  })
  const after = (await fs.stat(configPath)).mtimeMs
  assert.equal(res.channels[slug].status, 'skipped')
  assert.equal(res.channels[slug].changed_keys.length, 0)
  assert.equal(res.channels[slug].restore_point_id, undefined)
  assert.equal(after, before, 'no-op apply must not touch config.json')
})

test('foreign slugs, symlinked channels and missing channels fail dry-run too', async () => {
  const baseline = await settingsBaseline.createBaseline('Refusal Baseline', {
    audio_quality: { mode: 'flag_issues' },
  })

  const traversal = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: ['../evil'],
    explicit_confirm: true,
  })
  assert.equal(traversal.channels['../evil'].status, 'failed')

  const dryGhost = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: ['ghost-channel-that-does-not-exist'],
    dry_run: true,
    explicit_confirm: true,
  })
  assert.equal(dryGhost.channels['ghost-channel-that-does-not-exist'].status, 'failed')
  assert.equal(dryGhost.failure_count, 1)

  const outside = path.join(tempDir, 'outside-channel')
  await fs.mkdir(outside, { recursive: true })
  await fs.writeFile(path.join(outside, 'project.json'), '{}', 'utf-8')
  const outsideConfig = { audio_quality: { mode: 'untouched' } }
  await fs.writeFile(path.join(outside, 'config.json'), JSON.stringify(outsideConfig), 'utf-8')
  const linkDir = path.join(tempDir, 'projects', 'evil-link')
  await fs.symlink(outside, linkDir).catch(() => {})
  if (existsSync(linkDir)) {
    const viaLink = await settingsBaseline.applyBaseline({
      baseline_id: baseline.id,
      channel_slugs: ['evil-link'],
      explicit_confirm: true,
    })
    assert.equal(viaLink.channels['evil-link'].status, 'failed')
    const untouched = JSON.parse(await fs.readFile(path.join(outside, 'config.json'), 'utf-8'))
    assert.deepEqual(untouched, outsideConfig, 'a symlinked channel outside the Library is never written')
  }
})

test('stale preview: restore refuses when config changed after preview', async () => {
  const proj = await pm.createProject({ name: 'Stale Preview Channel' } as any)
  const slug = proj.slug
  const configPath = path.join(tempDir, 'projects', slug, 'config.json')
  const baseline = await settingsBaseline.createBaseline('Stale Baseline', {
    audio_quality: { mode: 'flag_issues' },
  })
  const applyRes = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: [slug],
    explicit_confirm: true,
  })
  const rpId = applyRes.channels[slug].restore_point_id!
  const hashAtPreview = settingsBaseline.computePayloadSha256(JSON.parse(await fs.readFile(configPath, 'utf-8')))
  const current = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  current.audio_quality = { mode: 'check_and_repair' }
  await fs.writeFile(configPath, JSON.stringify(current, null, 2), 'utf-8')
  await assert.rejects(
    () => settingsBaseline.restoreChannelSnapshot({
      restore_point_id: rpId,
      channel_slug: slug,
      explicit_confirm: true,
      expected_current_sha256: hashAtPreview,
    }),
    /changed since the restore preview/,
  )
  const after = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  assert.deepEqual(after.audio_quality, { mode: 'check_and_repair' }, 'the later edit must survive')
})

test('restore saves a pre-restore undo snapshot that brings the newer config back', async () => {
  const proj = await pm.createProject({ name: 'Undo Restore Channel' } as any)
  const slug = proj.slug
  const configPath = path.join(tempDir, 'projects', slug, 'config.json')
  const baseline = await settingsBaseline.createBaseline('Undo Baseline', {
    audio_quality: { mode: 'flag_issues' },
  })
  const applyRes = await settingsBaseline.applyBaseline({
    baseline_id: baseline.id,
    channel_slugs: [slug],
    explicit_confirm: true,
  })
  const rpId = applyRes.channels[slug].restore_point_id!
  const edited = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  edited.audio_quality = { mode: 'check_and_repair' }
  await fs.writeFile(configPath, JSON.stringify(edited, null, 2), 'utf-8')

  const hashNow = settingsBaseline.computePayloadSha256(JSON.parse(await fs.readFile(configPath, 'utf-8')))
  const restoreRes = await settingsBaseline.restoreChannelSnapshot({
    restore_point_id: rpId,
    channel_slug: slug,
    explicit_confirm: true,
    expected_current_sha256: hashNow,
  })
  assert.equal(restoreRes.success, true)
  const restored = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  assert.equal('audio_quality' in restored, false)

  const undo = (await settingsBaseline.listRestorePoints(slug)).find(s => s.reason === 'pre_restore')
  assert.ok(undo, 'pre-restore undo snapshot must exist')
  const undoHash = settingsBaseline.computePayloadSha256(JSON.parse(await fs.readFile(configPath, 'utf-8')))
  const undoRes = await settingsBaseline.restoreChannelSnapshot({
    restore_point_id: undo.id,
    channel_slug: slug,
    explicit_confirm: true,
    expected_current_sha256: undoHash,
  })
  assert.equal(undoRes.success, true)
  const backToEdit = JSON.parse(await fs.readFile(configPath, 'utf-8'))
  assert.deepEqual(backToEdit.audio_quality, { mode: 'check_and_repair' })
})
