/**
 * Settings Baseline Service — snapshot, preview, apply, read back, and restore.
 *
 * Owner (2026-11-07, Item 19): safe settings baseline application across channels.
 *
 * Rules:
 * - AGENTS.md §5: Presets carry reusable settings, nothing else. Never rewrite
 *   stored presets on disk. Scene rhythm is per-episode; default_scene_pacing is
 *   a starting value for new channels/episodes only, never forced on existing
 *   episodes, and save boundaries never claim pacing without explicit authority.
 * - AGENTS.md §6: A zero that means two things is a defect. Readback returns honest
 *   typed measurements (verified | mismatch | unverified | failed).
 * - AGENTS.md §8: Verified completion contract. Honest readback verification
 *   confirms the actual disk config matches the baseline before reporting success.
 * - User explicit operation: applying a baseline is never automatic or global.
 * - Restorable: pre-apply snapshots allow full rollback of any applied changes.
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ChannelApplyResult,
  type FieldDiffStatus,
  filterSafeBaselinePayload,
  isProtectedExcludedKey,
  isSafeBaselineKey,
  PROTECTED_EXCLUDED_KEYS,
  type ReadbackStatus,
  SAFE_BASELINE_KEYS,
  type SafeBaselineKey,
  type SettingsBaseline,
  type SettingsBaselineApplyOptions,
  type SettingsBaselineApplyResult,
  SETTINGS_BASELINE_FORMAT,
  type SettingsBaselinePreview,
  SETTINGS_BASELINE_SCHEMA_VERSION,
  type SettingsBaselineStoreFile,
  type SettingsFieldDiff,
  type SettingsReadbackMismatch,
  type SettingsReadbackVerification,
  type SettingsRestoreOptions,
  type SettingsRestoreResult,
  type SettingsSnapshot,
} from '../contracts/settings-baseline.js'
export {
  filterSafeBaselinePayload,
  isSafeBaselineKey,
  isProtectedExcludedKey,
} from '../contracts/settings-baseline.js'
import { readJsonOr, withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { assertWriteIsolatedInTests } from '../lib/test-isolation.js'
import { getProjectDir, projectsRoot } from './project-manager.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..', '..', '..')

function resolveSettingsBaselineStorePath(): string {
  if (process.env.STORY_STUDIO_DATA_DIR) {
    return path.join(process.env.STORY_STUDIO_DATA_DIR, 'settings-baselines.json')
  }
  const isPackaged = __dirname.includes('.asar') ||
    (!!process.resourcesPath && !process.env.ELECTRON_RUN_AS_NODE)
  if (isPackaged) {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    const productName = 'Story Studio KH'
    let userData: string
    if (process.platform === 'darwin') {
      userData = path.join(home, 'Library', 'Application Support', productName)
    } else if (process.platform === 'win32') {
      userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), productName)
    } else {
      userData = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), productName)
    }
    return path.join(userData, 'settings-baselines.json')
  }
  return path.join(ROOT, 'settings-baselines.json')
}

export function settingsBaselineStorePath(): string {
  return resolveSettingsBaselineStorePath()
}

function defaultStoreFile(): SettingsBaselineStoreFile {
  return {
    format: SETTINGS_BASELINE_FORMAT,
    schema_version: SETTINGS_BASELINE_SCHEMA_VERSION,
    updated_at: new Date().toISOString(),
    baselines: {},
    snapshots: {},
  }
}

function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(canonicalize)
  const sortedKeys = Object.keys(val as Record<string, unknown>).sort()
  const out: Record<string, unknown> = {}
  for (const k of sortedKeys) {
    out[k] = canonicalize((val as Record<string, unknown>)[k])
  }
  return out
}

export function computePayloadSha256(data: unknown): string {
  const json = JSON.stringify(canonicalize(data))
  return createHash('sha256').update(json).digest('hex')
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false
    if (!deepEqual(aObj[k], bObj[k])) return false
  }
  return true
}

async function readStore(): Promise<SettingsBaselineStoreFile> {
  const target = settingsBaselineStorePath()
  const store = await readJsonOr<SettingsBaselineStoreFile>(target, defaultStoreFile())
  if (!store || typeof store !== 'object' || store.format !== SETTINGS_BASELINE_FORMAT) {
    return defaultStoreFile()
  }
  store.baselines ??= {}
  store.snapshots ??= {}
  return store
}

async function writeStore(store: SettingsBaselineStoreFile): Promise<void> {
  const target = settingsBaselineStorePath()
  assertWriteIsolatedInTests(target, 'settings-baseline')
  store.updated_at = new Date().toISOString()
  await writeJsonAtomic(target, store)
}

function resolveChannelConfigPath(slug: string): string | null {
  const dir = getProjectDir(slug) || (projectsRoot() ? path.join(projectsRoot(), slug) : null)
  if (!dir) return null
  return path.join(dir, 'config.json')
}

// ── Baseline CRUD ─────────────────────────────────────────────────────────────

export async function listBaselines(): Promise<SettingsBaseline[]> {
  const store = await readStore()
  return Object.values(store.baselines).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
}

export async function getBaseline(id: string): Promise<SettingsBaseline | null> {
  const store = await readStore()
  return store.baselines[id] ?? null
}

export async function createBaseline(
  name: string,
  payload: Record<string, unknown>,
  options: { description?: string; source_channel?: string; tags?: string[] } = {},
): Promise<SettingsBaseline> {
  const trimmedName = name.trim()
  if (!trimmedName) throw new Error('Baseline name is required.')

  const safePayload = filterSafeBaselinePayload(payload)
  if (Object.keys(safePayload).length === 0) {
    throw new Error('Baseline payload contains no safe baseline keys.')
  }

  const id = `base_${Date.now()}_${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const baseline: SettingsBaseline = {
    id,
    name: trimmedName,
    description: options.description?.trim() || undefined,
    created_at: now,
    updated_at: now,
    version: 1,
    source_channel: options.source_channel || undefined,
    payload: safePayload,
    payload_sha256: computePayloadSha256(safePayload),
    tags: options.tags || [],
  }

  const target = settingsBaselineStorePath()
  await withLock(target, async () => {
    const store = await readStore()
    store.baselines[id] = baseline
    await writeStore(store)
  })

  return baseline
}

export async function deleteBaseline(id: string): Promise<boolean> {
  const target = settingsBaselineStorePath()
  return withLock(target, async () => {
    const store = await readStore()
    if (!store.baselines[id]) return false
    delete store.baselines[id]
    await writeStore(store)
    return true
  })
}

// ── Channel Snapshot / Baseline from Channel ──────────────────────────────────

export async function snapshotChannelAsBaseline(
  slug: string,
  name: string,
  description?: string,
): Promise<SettingsBaseline> {
  const configPath = resolveChannelConfigPath(slug)
  if (!configPath || !existsSync(configPath)) {
    throw new Error(`Channel configuration not found for slug "${slug}".`)
  }
  const config = await readJsonOr<Record<string, unknown>>(configPath, {})
  const safePayload = filterSafeBaselinePayload(config)
  if (Object.keys(safePayload).length === 0) {
    throw new Error(`Channel "${slug}" has no safe baseline configuration to snapshot.`)
  }
  return createBaseline(name, safePayload, {
    description: description || `Snapshotted from channel ${slug}`,
    source_channel: slug,
  })
}

export async function createChannelSnapshot(
  slug: string,
  reason: 'pre_apply' | 'manual_snapshot' | 'restore_point',
  baselineId?: string,
): Promise<SettingsSnapshot> {
  const configPath = resolveChannelConfigPath(slug)
  if (!configPath || !existsSync(configPath)) {
    throw new Error(`Channel configuration not found for slug "${slug}".`)
  }

  const config = await readJsonOr<Record<string, unknown>>(configPath, {})
  const id = `snp_${Date.now()}_${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const snapshot: SettingsSnapshot = {
    id,
    channel_slug: slug,
    created_at: now,
    reason,
    baseline_id: baselineId,
    config_snapshot: structuredClone(config),
    config_sha256: computePayloadSha256(config),
  }

  const target = settingsBaselineStorePath()
  await withLock(target, async () => {
    const store = await readStore()
    store.snapshots[id] = snapshot
    await writeStore(store)
  })

  return snapshot
}

export async function listRestorePoints(channelSlug?: string): Promise<SettingsSnapshot[]> {
  const store = await readStore()
  const all = Object.values(store.snapshots)
  const filtered = channelSlug ? all.filter(s => s.channel_slug === channelSlug) : all
  return filtered.sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export async function getRestorePoint(id: string): Promise<SettingsSnapshot | null> {
  const store = await readStore()
  return store.snapshots[id] ?? null
}

// ── Preview (Dry Run Diff) ────────────────────────────────────────────────────

export async function previewBaselineApplication(
  baselineId: string,
  channelSlugs: string[],
): Promise<SettingsBaselinePreview[]> {
  const baseline = await getBaseline(baselineId)
  if (!baseline) throw new Error(`Baseline not found: ${baselineId}`)

  const safePayload = filterSafeBaselinePayload(baseline.payload)
  const previews: SettingsBaselinePreview[] = []

  for (const slug of channelSlugs) {
    const configPath = resolveChannelConfigPath(slug)
    const currentConfig = (configPath && existsSync(configPath))
      ? await readJsonOr<Record<string, unknown>>(configPath, {})
      : {}

    const diffs: SettingsFieldDiff[] = []
    let hasChanges = false
    const protectedKeysPreserved: string[] = []
    const warnings: string[] = []

    for (const [key, proposedVal] of Object.entries(safePayload)) {
      if (isProtectedExcludedKey(key)) {
        protectedKeysPreserved.push(key)
        diffs.push({
          key,
          current_value: currentConfig[key],
          proposed_value: proposedVal,
          status: 'protected_or_excluded',
        })
        continue
      }

      const currentVal = currentConfig[key]
      if (currentVal === undefined) {
        hasChanges = true
        diffs.push({ key, current_value: undefined, proposed_value: proposedVal, status: 'added' })
      } else if (!deepEqual(currentVal, proposedVal)) {
        hasChanges = true
        diffs.push({ key, current_value: currentVal, proposed_value: proposedVal, status: 'modified' })
      } else {
        diffs.push({ key, current_value: currentVal, proposed_value: proposedVal, status: 'unchanged' })
      }
    }

    if (safePayload.default_scene_pacing) {
      warnings.push(
        'Scene rhythm stays per-episode (AGENTS.md §5). default_scene_pacing applies only as a starting value for newly created episodes; existing episode rhythms are preserved.',
      )
    }

    // Record protected existing keys present in current channel config
    for (const protKey of PROTECTED_EXCLUDED_KEYS) {
      if (currentConfig[protKey] !== undefined && !protectedKeysPreserved.includes(protKey)) {
        protectedKeysPreserved.push(protKey)
      }
    }

    previews.push({
      channel_slug: slug,
      channel_name: typeof currentConfig.name === 'string' ? currentConfig.name : slug,
      baseline_id: baselineId,
      diffs,
      has_changes: hasChanges,
      protected_keys_preserved: protectedKeysPreserved,
      warnings: warnings.length > 0 ? warnings : undefined,
    })
  }

  return previews
}

// ── Read Back Verification ────────────────────────────────────────────────────

/**
 * Honest readback verification from disk (AGENTS.md §6 & §8).
 * Never reports verified unless every checked key is verified identical on disk.
 */
export async function verifyChannelReadback(
  slug: string,
  expectedPayload: Record<string, unknown>,
): Promise<SettingsReadbackVerification> {
  const configPath = resolveChannelConfigPath(slug)
  const now = new Date().toISOString()
  if (!configPath || !existsSync(configPath)) {
    return {
      status: 'failed',
      channel_slug: slug,
      verified_at: now,
      checked_keys: [],
      matched_keys: [],
      mismatches: [],
      config_sha256: '',
      reason: `Channel configuration file does not exist for slug "${slug}".`,
    }
  }

  let diskConfig: Record<string, unknown>
  try {
    const raw = await fs.readFile(configPath, 'utf-8')
    diskConfig = JSON.parse(raw) as Record<string, unknown>
  } catch (err: any) {
    return {
      status: 'failed',
      channel_slug: slug,
      verified_at: now,
      checked_keys: [],
      matched_keys: [],
      mismatches: [],
      config_sha256: '',
      reason: `Failed to read or parse config.json: ${err?.message || String(err)}`,
    }
  }

  const configSha256 = computePayloadSha256(diskConfig)
  const checkedKeys = Object.keys(expectedPayload)
  const matchedKeys: string[] = []
  const mismatches: SettingsReadbackMismatch[] = []

  for (const key of checkedKeys) {
    const expected = expectedPayload[key]
    const actual = diskConfig[key]
    if (deepEqual(expected, actual)) {
      matchedKeys.push(key)
    } else {
      mismatches.push({ key, expected, actual })
    }
  }

  const status: ReadbackStatus = mismatches.length === 0 ? 'verified' : 'mismatch'
  return {
    status,
    channel_slug: slug,
    verified_at: now,
    checked_keys: checkedKeys,
    matched_keys: matchedKeys,
    mismatches,
    config_sha256: configSha256,
    reason: mismatches.length > 0 ? `${mismatches.length} key(s) differed from expected values.` : undefined,
  }
}

// ── Apply Baseline ────────────────────────────────────────────────────────────

export async function applyBaseline(
  options: SettingsBaselineApplyOptions,
): Promise<SettingsBaselineApplyResult> {
  if (!options.explicit_confirm && !options.dry_run) {
    throw new Error(
      'Explicit user confirmation is required to apply a settings baseline (User explicit operation, AGENTS.md §5).',
    )
  }

  const baseline = await getBaseline(options.baseline_id)
  if (!baseline) throw new Error(`Baseline not found: ${options.baseline_id}`)

  // Verify baseline payload integrity
  const expectedHash = computePayloadSha256(baseline.payload)
  if (baseline.payload_sha256 && baseline.payload_sha256 !== expectedHash) {
    throw new Error('Baseline payload integrity failure: SHA-256 digest does not match stored payload.')
  }

  const safePayload = filterSafeBaselinePayload(baseline.payload)
  const channelResults: Record<string, ChannelApplyResult> = {}
  let successCount = 0
  let failureCount = 0

  if (options.dry_run) {
    for (const slug of options.channel_slugs) {
      channelResults[slug] = {
        channel_slug: slug,
        status: 'dry_run',
        changed_keys: Object.keys(safePayload),
      }
      successCount++
    }
    return {
      baseline_id: options.baseline_id,
      applied_at: new Date().toISOString(),
      dry_run: true,
      total_channels: options.channel_slugs.length,
      success_count: successCount,
      failure_count: failureCount,
      channels: channelResults,
    }
  }

  // Live application
  for (const slug of options.channel_slugs) {
    const configPath = resolveChannelConfigPath(slug)
    if (!configPath || !existsSync(configPath)) {
      channelResults[slug] = {
        channel_slug: slug,
        status: 'failed',
        changed_keys: [],
        error: `Channel directory or config.json not found for "${slug}".`,
      }
      failureCount++
      continue
    }

    try {
      let restorePointId: string | undefined
      let changedKeys: string[] = []
      let readback: SettingsReadbackVerification | undefined

      await withLock(configPath, async () => {
        const currentConfig = await readJsonOr<Record<string, unknown>>(configPath, {})

        // 1. Create restorable pre-apply snapshot before write
        if (options.create_restore_point !== false) {
          const snapshot = await createChannelSnapshot(slug, 'pre_apply', baseline.id)
          restorePointId = snapshot.id
        }

        // 2. Prepare new config, strictly preserving presets, secrets, and episode pacing
        const updatedConfig = structuredClone(currentConfig)
        for (const [key, value] of Object.entries(safePayload)) {
          if (isProtectedExcludedKey(key)) continue
          if (key === 'default_scene_pacing') {
            updatedConfig.default_scene_pacing = value
          } else {
            updatedConfig[key] = value
          }
          changedKeys.push(key)
        }

        // 3. Write atomically to channel config.json
        assertWriteIsolatedInTests(configPath, 'channel-config')
        await writeJsonAtomic(configPath, updatedConfig)
      })

      // 4. Read back immediately and verify
      readback = await verifyChannelReadback(slug, safePayload)

      if (readback.status === 'verified') {
        channelResults[slug] = {
          channel_slug: slug,
          status: 'applied',
          restore_point_id: restorePointId,
          changed_keys: changedKeys,
          readback,
        }
        successCount++
      } else {
        channelResults[slug] = {
          channel_slug: slug,
          status: 'failed',
          restore_point_id: restorePointId,
          changed_keys: changedKeys,
          readback,
          error: `Readback mismatch on ${readback.mismatches.length} key(s).`,
        }
        failureCount++
      }
    } catch (err: any) {
      channelResults[slug] = {
        channel_slug: slug,
        status: 'failed',
        changed_keys: [],
        error: err?.message || String(err),
      }
      failureCount++
    }
  }

  return {
    baseline_id: options.baseline_id,
    applied_at: new Date().toISOString(),
    dry_run: false,
    total_channels: options.channel_slugs.length,
    success_count: successCount,
    failure_count: failureCount,
    channels: channelResults,
  }
}

// ── Restore Channel Snapshot ──────────────────────────────────────────────────

export async function restoreChannelSnapshot(
  options: SettingsRestoreOptions,
): Promise<SettingsRestoreResult> {
  if (!options.explicit_confirm) {
    throw new Error('Explicit user confirmation is required to restore a settings snapshot.')
  }

  const snapshot = await getRestorePoint(options.restore_point_id)
  if (!snapshot) {
    throw new Error(`Restore point not found: ${options.restore_point_id}`)
  }

  if (snapshot.channel_slug !== options.channel_slug) {
    throw new Error(
      `Restore point channel mismatch: snapshot belongs to "${snapshot.channel_slug}", not "${options.channel_slug}".`,
    )
  }

  // Integrity check of snapshot before restore
  const expectedHash = computePayloadSha256(snapshot.config_snapshot)
  if (snapshot.config_sha256 && snapshot.config_sha256 !== expectedHash) {
    throw new Error('Snapshot integrity failure: stored configuration does not match checksum.')
  }

  const configPath = resolveChannelConfigPath(options.channel_slug)
  if (!configPath || !existsSync(configPath)) {
    throw new Error(`Channel configuration not found for "${options.channel_slug}".`)
  }

  await withLock(configPath, async () => {
    assertWriteIsolatedInTests(configPath, 'channel-config')
    await writeJsonAtomic(configPath, snapshot.config_snapshot)
  })

  // Read back and verify restored configuration
  const readback = await verifyChannelReadback(options.channel_slug, snapshot.config_snapshot)

  const now = new Date().toISOString()
  if (readback.status === 'verified') {
    const target = settingsBaselineStorePath()
    await withLock(target, async () => {
      const store = await readStore()
      if (store.snapshots[options.restore_point_id]) {
        store.snapshots[options.restore_point_id].restored_at = now
        await writeStore(store)
      }
    })
  }

  return {
    restore_point_id: options.restore_point_id,
    channel_slug: options.channel_slug,
    restored_at: now,
    success: readback.status === 'verified',
    restored_keys: Object.keys(snapshot.config_snapshot),
    readback,
    error: readback.status !== 'verified' ? 'Restored configuration readback did not match snapshot.' : undefined,
  }
}
