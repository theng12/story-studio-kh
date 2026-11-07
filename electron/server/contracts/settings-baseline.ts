/**
 * Settings Baseline contracts — snapshot, preview, apply, read back, and restore.
 *
 * Owner (2026-11-07, Item 19): safe settings baseline application across channels.
 *
 * Core rules:
 * - AGENTS.md §5: Presets carry reusable settings, nothing else. Never rewrite
 *   stored presets on disk. Scene rhythm stays per-episode; default_scene_pacing
 *   is a starting value only for new channels/episodes, never forced on existing
 *   episodes, and save boundaries never claim pacing without explicit authority.
 * - AGENTS.md §6: A zero that means two things is a defect. Honest typed measurements
 *   distinguish verified states from mismatches or unmeasured states.
 * - AGENTS.md §8: Verified completion contract. Honest readback verification
 *   confirms the actual disk config matches the baseline before reporting success.
 * - User explicit operation: applying a baseline or restoring is never automatic
 *   or global; it requires explicit user confirmation.
 * - Restorable: pre-apply snapshots allow complete rollback of applied changes.
 */

export const SETTINGS_BASELINE_FORMAT = 'story-studio-settings-baseline'
export const SETTINGS_BASELINE_SCHEMA_VERSION = 1

/** Safe configuration keys permitted in a settings baseline */
export const SAFE_BASELINE_KEYS = [
  'audio_quality',
  'default_scene_pacing',
  'music_bed_defaults',
  'default_models',
  'aspect_ratio',
  'intro_settings',
  'caption_settings',
  'thumbnail_options',
  'pipeline_last_steps',
] as const

export type SafeBaselineKey = (typeof SAFE_BASELINE_KEYS)[number]

/**
 * Keys strictly prohibited from settings baselines.
 * - Secrets and credentials (§7)
 * - Stored disk presets (§5: presets must never be rewritten on disk to compensate)
 * - Live episode pacing (§5: timing panel owns episode rhythm with claim_pacing)
 * - Episode-specific files/anchors (§4)
 * - Retired features (§7)
 */
export const PROTECTED_EXCLUDED_KEYS = [
  // Secrets and credentials
  'genstudio_api_key',
  'google_api_key',
  'api_keys',
  'secrets',
  // Disk preset dictionaries (never bulk-rewrite stored presets)
  'thumbnail_prompts_presets',
  'scene_prompts_presets',
  'thumbnail_generator_presets',
  'scene_generator_presets',
  'voice_presets',
  'audio_generator_presets',
  'style_presets',
  // Live episode pacing
  'pacing',
  'scene_pacing',
  'claim_pacing',
  // Episode-specific state
  'sheet',
  'use_episode_sheet',
  'anchors',
  'episode_prefix',
  // Retired model/generation settings
  'models',
  'audio_concurrency',
  'video_concurrency',
  'image_concurrency',
  'subtitle_concurrency',
  'image_launch_stagger_ms',
  'audio_launch_stagger_ms',
  'video_launch_stagger_ms',
  'generation_timeouts',
] as const

export function isSafeBaselineKey(key: string): boolean {
  return (SAFE_BASELINE_KEYS as readonly string[]).includes(key)
}

export function isProtectedExcludedKey(key: string): boolean {
  if ((PROTECTED_EXCLUDED_KEYS as readonly string[]).includes(key)) return true
  if (key.endsWith('_presets')) return true
  const lower = key.toLowerCase()
  if (lower.includes('key') || lower.includes('secret') || lower.includes('token')) return true
  return false
}

export function filterSafeBaselinePayload(data: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (isSafeBaselineKey(key) && !isProtectedExcludedKey(key)) {
      safe[key] = value
    }
  }
  return safe
}

export interface SettingsBaseline {
  id: string
  name: string
  description?: string
  created_at: string
  updated_at: string
  version: number
  source_channel?: string
  payload: Record<string, unknown>
  payload_sha256: string
  tags?: string[]
}

export interface SettingsSnapshot {
  id: string
  channel_slug: string
  created_at: string
  reason: 'pre_apply' | 'manual_snapshot' | 'restore_point'
  baseline_id?: string
  config_snapshot: Record<string, unknown>
  config_sha256: string
  restored_at?: string
}

export type FieldDiffStatus = 'unchanged' | 'modified' | 'added' | 'protected_or_excluded'

export interface SettingsFieldDiff {
  key: string
  current_value: unknown
  proposed_value: unknown
  status: FieldDiffStatus
}

export interface SettingsBaselinePreview {
  channel_slug: string
  channel_name: string
  baseline_id: string
  diffs: SettingsFieldDiff[]
  has_changes: boolean
  protected_keys_preserved: string[]
  warnings?: string[]
}

export type ReadbackStatus = 'verified' | 'mismatch' | 'unverified' | 'failed'

export interface SettingsReadbackMismatch {
  key: string
  expected: unknown
  actual: unknown
}

export interface SettingsReadbackVerification {
  status: ReadbackStatus
  channel_slug: string
  verified_at: string
  checked_keys: string[]
  matched_keys: string[]
  mismatches: SettingsReadbackMismatch[]
  config_sha256: string
  reason?: string
}

export interface ChannelApplyResult {
  channel_slug: string
  status: 'applied' | 'dry_run' | 'skipped' | 'failed'
  restore_point_id?: string
  changed_keys: string[]
  readback?: SettingsReadbackVerification
  error?: string
}

export interface SettingsBaselineApplyOptions {
  baseline_id: string
  channel_slugs: string[]
  dry_run?: boolean
  create_restore_point?: boolean
  explicit_confirm: boolean
}

export interface SettingsBaselineApplyResult {
  baseline_id: string
  applied_at: string
  dry_run: boolean
  total_channels: number
  success_count: number
  failure_count: number
  channels: Record<string, ChannelApplyResult>
}

export interface SettingsRestoreOptions {
  restore_point_id: string
  channel_slug: string
  explicit_confirm: boolean
}

export interface SettingsRestoreResult {
  restore_point_id: string
  channel_slug: string
  restored_at: string
  success: boolean
  restored_keys: string[]
  readback: SettingsReadbackVerification
  error?: string
}

export interface SettingsBaselineStoreFile {
  format: typeof SETTINGS_BASELINE_FORMAT
  schema_version: typeof SETTINGS_BASELINE_SCHEMA_VERSION
  updated_at: string
  baselines: Record<string, SettingsBaseline>
  snapshots: Record<string, SettingsSnapshot>
}
