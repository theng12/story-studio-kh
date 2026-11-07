<template>
  <section class="panel settings-baseline-panel" data-setting="settings-baseline" aria-labelledby="settings-baseline-title">
    <header class="sb-header">
      <div class="copy">
        <span class="eyebrow">Production Standards</span>
        <h4 id="settings-baseline-title">Settings Baseline &amp; Safe Application</h4>
        <p>
          Snapshot, preview, apply, and restore configuration baselines across channels.
          Every application creates a pre-apply restore point, strictly preserves episode pacing and disk presets,
          and performs honest readback verification against disk before reporting success.
        </p>
      </div>
      <div class="sb-mode-badge" role="note">
        <span class="sb-badge-dot"></span>
        <span>Explicit User Operation</span>
      </div>
    </header>

    <!-- Pacing and preset safety notice -->
    <div class="sb-notice" role="note">
      <strong>Safety rules (AGENTS.md &sect;5 &amp; &sect;6):</strong>
      Baselines never rewrite stored disk presets or secret credentials.
      Scene rhythm stays per-episode; channel default pacing acts only as a starting template for new episodes,
      and existing episode pacing is never modified.
    </div>

    <div v-if="error" class="sb-alert error" role="alert">
      {{ error }}
    </div>
    <div v-if="successMessage" class="sb-alert success" role="status">
      {{ successMessage }}
    </div>

    <!-- Section 1: Choose or Create Baseline -->
    <div class="sb-section">
      <div class="sb-section-head">
        <h5>1. Configuration Baseline</h5>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="!!busy"
          @click="showCreateModal = !showCreateModal"
        >
          {{ showCreateModal ? 'Cancel Snapshot' : 'Snapshot Channel as Baseline' }}
        </button>
      </div>

      <!-- Snapshot Channel Form -->
      <div v-if="showCreateModal" class="sb-card sb-create-card">
        <h6>Snapshot Baseline from Channel</h6>
        <div class="sb-form-grid">
          <label class="sb-field">
            <span>Source Channel</span>
            <select v-model="snapshotSourceSlug" class="input" :disabled="!!busy">
              <option value="" disabled>Select a channel…</option>
              <option v-for="proj in projects" :key="proj.slug" :value="proj.slug">
                {{ proj.name }} ({{ proj.slug }})
              </option>
            </select>
          </label>
          <label class="sb-field">
            <span>Baseline Name</span>
            <input
              v-model="snapshotName"
              type="text"
              class="input"
              placeholder="e.g. Owner Standard 2026 Production Baseline"
              :disabled="!!busy"
            />
          </label>
          <label class="sb-field full-width">
            <span>Description (Optional)</span>
            <input
              v-model="snapshotDescription"
              type="text"
              class="input"
              placeholder="e.g. Standard tiers, audio review enabled, 6% music bed"
              :disabled="!!busy"
            />
          </label>
        </div>
        <div class="sb-actions">
          <button
            type="button"
            class="btn btn-primary"
            :disabled="!!busy || !snapshotSourceSlug || !snapshotName.trim()"
            @click="createSnapshotBaseline"
          >
            Create Baseline Snapshot
          </button>
        </div>
      </div>

      <!-- Baseline Selector & Details -->
      <div v-if="baselines.length > 0" class="sb-card">
        <label class="sb-field">
          <span>Active Baseline</span>
          <select v-model="selectedBaselineId" class="input" :disabled="!!busy" @change="onBaselineChange">
            <option v-for="b in baselines" :key="b.id" :value="b.id">
              {{ b.name }} &middot; v{{ b.version }} ({{ formatDateTime(b.updated_at) }})
            </option>
          </select>
        </label>

        <div v-if="selectedBaseline" class="sb-baseline-details">
          <div class="sb-meta-row">
            <span v-if="selectedBaseline.source_channel" class="sb-chip">
              Source: <strong>{{ selectedBaseline.source_channel }}</strong>
            </span>
            <span class="sb-chip">
              Fingerprint: <code>{{ selectedBaseline.payload_sha256.slice(0, 12) }}&hellip;</code>
            </span>
            <span class="sb-chip">
              Safe Keys: <strong>{{ Object.keys(selectedBaseline.payload).length }}</strong>
            </span>
          </div>
          <p v-if="selectedBaseline.description" class="sb-desc">
            {{ selectedBaseline.description }}
          </p>

          <div class="sb-payload-preview">
            <h6>Included Baseline Keys:</h6>
            <div class="sb-tags">
              <span v-for="k in Object.keys(selectedBaseline.payload)" :key="k" class="sb-tag">
                {{ k }}
              </span>
            </div>
          </div>
        </div>
      </div>
      <p v-else-if="!loading" class="sb-empty-state">
        No baselines created yet. Snapshot a channel above to establish a standardized baseline.
      </p>
    </div>

    <!-- Section 2: Target Channels & Dry Run Preview -->
    <div v-if="selectedBaseline" class="sb-section">
      <div class="sb-section-head">
        <h5>2. Target Channels &amp; Dry Run Preview</h5>
        <div class="sb-button-group">
          <button
            type="button"
            class="btn btn-text btn-sm"
            :disabled="!!busy"
            @click="selectAllChannels"
          >
            Select All
          </button>
          <button
            type="button"
            class="btn btn-text btn-sm"
            :disabled="!!busy"
            @click="clearAllChannels"
          >
            Clear All
          </button>
        </div>
      </div>

      <div class="sb-channels-selector">
        <label v-for="proj in projects" :key="proj.slug" class="sb-channel-checkbox">
          <input
            v-model="selectedChannelSlugs"
            type="checkbox"
            :value="proj.slug"
            :disabled="!!busy"
          />
          <span class="sb-channel-label">
            <strong>{{ proj.name }}</strong>
            <small>{{ proj.slug }}</small>
          </span>
        </label>
      </div>

      <div class="sb-actions">
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="!!busy || selectedChannelSlugs.length === 0"
          @click="runPreview"
        >
          {{ busy === 'preview' ? 'Comparing…' : `Preview Diff (${selectedChannelSlugs.length} Channels)` }}
        </button>
      </div>

      <!-- Preview Diff Table -->
      <div v-if="previews.length > 0" class="sb-preview-results">
        <h6>Dry Run Diff Results</h6>
        <div v-for="prev in previews" :key="prev.channel_slug" class="sb-channel-preview-card">
          <header class="sb-card-head">
            <strong>{{ prev.channel_name }}</strong>
            <span :class="['sb-status-pill', prev.has_changes ? 'pill-modified' : 'pill-unchanged']">
              {{ prev.has_changes ? 'Changes Detected' : 'Already Identical' }}
            </span>
          </header>

          <p v-if="prev.warnings?.length" class="sb-warning-note">
            {{ prev.warnings[0] }}
          </p>

          <table class="sb-diff-table">
            <thead>
              <tr>
                <th scope="col">Setting Key</th>
                <th scope="col">Current Disk Value</th>
                <th scope="col">Proposed Baseline</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="diff in prev.diffs" :key="diff.key" :class="diff.status">
                <td><code>{{ diff.key }}</code></td>
                <td><pre>{{ formatValue(diff.current_value) }}</pre></td>
                <td><pre>{{ formatValue(diff.proposed_value) }}</pre></td>
                <td>
                  <span :class="['sb-diff-badge', diff.status]">
                    {{ diff.status }}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="prev.protected_keys_preserved.length > 0" class="sb-protected-footer">
            <small>Preserved protected keys: {{ prev.protected_keys_preserved.join(', ') }}</small>
          </div>
        </div>
      </div>
    </div>

    <!-- Section 3: Safe Apply with Explicit Confirmation -->
    <div v-if="selectedBaseline && selectedChannelSlugs.length > 0" class="sb-section sb-apply-section">
      <h5>3. Apply Baseline</h5>
      <p class="fine">
        A restorable snapshot of each channel’s current configuration will be saved before any modifications.
        Disk presets and episode pacing are never rewritten.
      </p>

      <label class="sb-confirm-checkbox">
        <input
          v-model="explicitConfirm"
          type="checkbox"
          :disabled="!!busy"
        />
        <span>I explicitly confirm applying baseline &ldquo;{{ selectedBaseline.name }}&rdquo; to {{ selectedChannelSlugs.length }} channel(s).</span>
      </label>

      <div class="sb-actions">
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!!busy || !explicitConfirm"
          @click="applyBaselineToChannels"
        >
          {{ busy === 'apply' ? 'Applying & Verifying…' : `Apply Baseline to ${selectedChannelSlugs.length} Channel(s)` }}
        </button>
      </div>

      <!-- Live Readback Results -->
      <div v-if="applyResults" class="sb-apply-results" role="status" aria-live="polite">
        <h6>Apply &amp; Readback Verification Results</h6>
        <div class="sb-result-summary">
          <span class="sb-summary-stat">
            Total: <strong>{{ applyResults.total_channels }}</strong>
          </span>
          <span class="sb-summary-stat success">
            Verified: <strong>{{ applyResults.success_count }}</strong>
          </span>
          <span v-if="applyResults.failure_count > 0" class="sb-summary-stat error">
            Mismatches/Failures: <strong>{{ applyResults.failure_count }}</strong>
          </span>
        </div>

        <div v-for="(res, slug) in applyResults.channels" :key="slug" class="sb-channel-result-card">
          <div class="sb-card-head">
            <strong>{{ slug }}</strong>
            <span :class="['sb-status-pill', `pill-${res.status}`]">
              {{ res.status }}
            </span>
          </div>

          <div v-if="res.restore_point_id" class="sb-restore-ref">
            <small>Pre-apply snapshot: <code>{{ res.restore_point_id }}</code></small>
          </div>

          <div v-if="res.readback" class="sb-readback-details">
            <p class="fine">
              Disk Verification:
              <strong :class="res.readback.status === 'verified' ? 'text-success' : 'text-error'">
                {{ res.readback.status === 'verified' ? 'Verified on Disk' : 'Mismatch Detected' }}
              </strong>
              &middot; {{ res.readback.matched_keys.length }} / {{ res.readback.checked_keys.length }} keys matched
            </p>

            <ul v-if="res.readback.mismatches.length > 0" class="sb-mismatch-list">
              <li v-for="m in res.readback.mismatches" :key="m.key">
                <strong>{{ m.key }}:</strong> Expected <pre>{{ formatValue(m.expected) }}</pre> but found <pre>{{ formatValue(m.actual) }}</pre>
              </li>
            </ul>
          </div>

          <p v-if="res.error" class="sb-error-text">{{ res.error }}</p>
        </div>
      </div>
    </div>

    <!-- Section 4: Restorable Snapshots & Rollback -->
    <div class="sb-section sb-restore-section">
      <div class="sb-section-head">
        <h5>4. Restorable Snapshots (Rollback)</h5>
        <button
          type="button"
          class="btn btn-secondary btn-sm"
          :disabled="!!busy"
          @click="loadRestorePoints"
        >
          Refresh Snapshots
        </button>
      </div>
      <p class="fine">
        Snapshots created before applying baselines or manually saved.
        Restoring completely resets the channel's configuration to its exact pre-apply state and verifies the restored disk state.
      </p>

      <div v-if="restorePoints.length > 0" class="sb-snapshots-list">
        <div v-for="snp in restorePoints" :key="snp.id" class="sb-snapshot-item">
          <div class="sb-snapshot-info">
            <span class="sb-snapshot-slug"><strong>{{ snp.channel_slug }}</strong></span>
            <span class="sb-snapshot-time">{{ formatDateTime(snp.created_at) }}</span>
            <small class="sb-snapshot-reason">{{ snp.reason }} &middot; <code>{{ snp.id }}</code></small>
            <span v-if="snp.restored_at" class="sb-chip restored">
              Restored {{ formatDateTime(snp.restored_at) }}
            </span>
          </div>

          <div class="sb-snapshot-actions">
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="!!busy"
              @click="restoreSnapshot(snp)"
            >
              {{ busy === `restore-${snp.id}` ? 'Restoring…' : 'Restore Config' }}
            </button>
          </div>
        </div>
      </div>
      <p v-else class="sb-empty-state">
        No restore snapshots available yet.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
/**
 * `ref`, `computed`, `onMounted` and `useApi` are Nuxt auto-imports here,
 * matching ChannelProfilePanel / CostSettings / DuplicateScreeningSettings.
 */

/**
 * Local mirrors of the server contracts (`@shared/settings-baseline`).
 * Type-only, so the renderer bundle carries no runtime dependency. The wire
 * shapes are validated by the service; these exist so the panel compiles
 * without a shared tsconfig path entry (that mapping is the lead's wiring).
 */
interface SettingsBaseline {
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

interface SettingsFieldDiff {
  key: string
  current_value: unknown
  proposed_value: unknown
  status: 'unchanged' | 'modified' | 'added' | 'protected_or_excluded'
}

interface SettingsBaselinePreview {
  channel_slug: string
  channel_name: string
  baseline_id: string
  diffs: SettingsFieldDiff[]
  has_changes: boolean
  protected_keys_preserved: string[]
  warnings?: string[]
}

interface SettingsReadbackVerification {
  status: 'verified' | 'mismatch' | 'unverified' | 'failed'
  channel_slug: string
  verified_at: string
  checked_keys: string[]
  matched_keys: string[]
  mismatches: Array<{ key: string; expected: unknown; actual: unknown }>
  config_sha256: string
  reason?: string
}

interface ChannelApplyResult {
  channel_slug: string
  status: 'applied' | 'dry_run' | 'skipped' | 'failed'
  restore_point_id?: string
  changed_keys: string[]
  readback?: SettingsReadbackVerification
  error?: string
}

interface SettingsBaselineApplyResult {
  baseline_id: string
  applied_at: string
  dry_run: boolean
  total_channels: number
  success_count: number
  failure_count: number
  channels: Record<string, ChannelApplyResult>
}

interface SettingsSnapshot {
  id: string
  channel_slug: string
  created_at: string
  reason: 'pre_apply' | 'manual_snapshot' | 'restore_point'
  baseline_id?: string
  restored_at?: string
}

interface ProjectItem {
  slug: string
  name: string
}

const { get, post } = useApi()

const projects = ref<ProjectItem[]>([])
const baselines = ref<SettingsBaseline[]>([])
const selectedBaselineId = ref<string>('')
const selectedChannelSlugs = ref<string[]>([])
const previews = ref<SettingsBaselinePreview[]>([])
const applyResults = ref<SettingsBaselineApplyResult | null>(null)
const restorePoints = ref<SettingsSnapshot[]>([])

const showCreateModal = ref(false)
const snapshotSourceSlug = ref('')
const snapshotName = ref('')
const snapshotDescription = ref('')

const explicitConfirm = ref(false)
const busy = ref<string>('')
const loading = ref(true)
const error = ref('')
const successMessage = ref('')

const selectedBaseline = computed(() => {
  return baselines.value.find(b => b.id === selectedBaselineId.value) || null
})

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}

function formatValue(val: unknown): string {
  if (val === undefined) return '<undefined>'
  if (typeof val === 'string') return val
  return JSON.stringify(val, null, 2)
}

function selectAllChannels(): void {
  selectedChannelSlugs.value = projects.value.map(p => p.slug)
}

function clearAllChannels(): void {
  selectedChannelSlugs.value = []
}

function onBaselineChange(): void {
  previews.value = []
  applyResults.value = null
  explicitConfirm.value = false
}

async function loadData(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const [projList, baseList] = await Promise.all([
      get<ProjectItem[]>('/projects'),
      get<SettingsBaseline[]>('/settings-baselines'),
    ])
    projects.value = Array.isArray(projList) ? projList : []
    baselines.value = Array.isArray(baseList) ? baseList : []
    if (baselines.value.length > 0 && !selectedBaselineId.value) {
      selectedBaselineId.value = baselines.value[0].id
    }
  } catch (err: any) {
    error.value = err?.message || 'Could not load settings baselines or projects.'
  } finally {
    loading.value = false
  }
}

async function loadRestorePoints(): Promise<void> {
  try {
    const list = await get<SettingsSnapshot[]>('/settings-baselines/snapshots')
    restorePoints.value = Array.isArray(list) ? list : []
  } catch (err: any) {
    error.value = err?.message || 'Could not load restore points.'
  }
}

async function createSnapshotBaseline(): Promise<void> {
  if (!snapshotSourceSlug.value || !snapshotName.value.trim()) return
  busy.value = 'create'
  error.value = ''
  successMessage.value = ''
  try {
    const created = await post<SettingsBaseline>('/settings-baselines/snapshot-channel', {
      slug: snapshotSourceSlug.value,
      name: snapshotName.value.trim(),
      description: snapshotDescription.value.trim(),
    })
    baselines.value.unshift(created)
    selectedBaselineId.value = created.id
    showCreateModal.value = false
    snapshotSourceSlug.value = ''
    snapshotName.value = ''
    snapshotDescription.value = ''
    successMessage.value = `Baseline "${created.name}" snapshotted successfully.`
  } catch (err: any) {
    error.value = err?.data?.detail || err?.message || 'Failed to create baseline snapshot.'
  } finally {
    busy.value = ''
  }
}

async function runPreview(): Promise<void> {
  if (!selectedBaselineId.value || selectedChannelSlugs.value.length === 0) return
  busy.value = 'preview'
  error.value = ''
  try {
    const res = await post<SettingsBaselinePreview[]>('/settings-baselines/preview', {
      baseline_id: selectedBaselineId.value,
      channel_slugs: selectedChannelSlugs.value,
    })
    previews.value = Array.isArray(res) ? res : []
  } catch (err: any) {
    error.value = err?.data?.detail || err?.message || 'Preview generation failed.'
  } finally {
    busy.value = ''
  }
}

async function applyBaselineToChannels(): Promise<void> {
  if (!selectedBaselineId.value || selectedChannelSlugs.value.length === 0 || !explicitConfirm.value) return
  busy.value = 'apply'
  error.value = ''
  successMessage.value = ''
  applyResults.value = null
  try {
    const result = await post<SettingsBaselineApplyResult>('/settings-baselines/apply', {
      baseline_id: selectedBaselineId.value,
      channel_slugs: selectedChannelSlugs.value,
      explicit_confirm: true,
      create_restore_point: true,
    })
    applyResults.value = result
    if (result.failure_count === 0) {
      successMessage.value = `Successfully applied and verified baseline across ${result.success_count} channel(s).`
    } else {
      error.value = `Completed with ${result.failure_count} mismatch(es) or failure(s). Check readback details below.`
    }
    await loadRestorePoints()
  } catch (err: any) {
    error.value = err?.data?.detail || err?.message || 'Baseline application failed.'
  } finally {
    busy.value = ''
  }
}

async function restoreSnapshot(snapshot: SettingsSnapshot): Promise<void> {
  const confirmed = window.confirm(
    `Are you sure you want to restore "${snapshot.channel_slug}" to snapshot ${snapshot.id}? This will overwrite the channel's current configuration with the snapshotted state.`,
  )
  if (!confirmed) return

  busy.value = `restore-${snapshot.id}`
  error.value = ''
  successMessage.value = ''
  try {
    const res = await post<{ success: boolean; readback: { status: string } }>('/settings-baselines/restore', {
      restore_point_id: snapshot.id,
      channel_slug: snapshot.channel_slug,
      explicit_confirm: true,
    })
    if (res.success && res.readback.status === 'verified') {
      successMessage.value = `Channel "${snapshot.channel_slug}" successfully restored to snapshot and verified on disk.`
    } else {
      error.value = `Channel restored, but disk readback status is: ${res.readback?.status || 'unknown'}`
    }
    await loadRestorePoints()
  } catch (err: any) {
    error.value = err?.data?.detail || err?.message || 'Failed to restore snapshot.'
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  loadData()
  loadRestorePoints()
})
</script>

<style scoped>
.settings-baseline-panel {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.sb-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.copy h4 {
  margin: 4px 0 6px;
  font-size: 1.15rem;
  font-weight: 600;
}

.copy p {
  margin: 0;
  line-height: 1.5;
  color: var(--text-muted, #71717a);
  max-width: 65ch;
}

.eyebrow {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--primary, #3b82f6);
}

.sb-mode-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 9999px;
  background: var(--bg-surface-secondary, rgba(59, 130, 246, 0.08));
  border: 1px solid var(--border-color, rgba(59, 130, 246, 0.2));
  font-size: 12px;
  font-weight: 500;
}

.sb-badge-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--primary, #3b82f6);
}

.sb-notice {
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--bg-surface-secondary, rgba(234, 179, 8, 0.08));
  border-left: 3px solid var(--warning, #eab308);
  font-size: 13px;
  line-height: 1.45;
}

.sb-alert {
  padding: 10px 14px;
  border-radius: 6px;
  font-size: 13px;
}

.sb-alert.error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
}

.sb-alert.success {
  background: rgba(34, 197, 94, 0.1);
  border: 1px solid rgba(34, 197, 94, 0.3);
  color: #22c55e;
}

.sb-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  border-top: 1px solid var(--border, rgba(128, 128, 128, 0.15));
  padding-top: 16px;
}

.sb-section-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.sb-section-head h5 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.sb-card {
  padding: 14px;
  border-radius: 8px;
  background: var(--bg-surface, rgba(128, 128, 128, 0.04));
  border: 1px solid var(--border, rgba(128, 128, 128, 0.15));
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.sb-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}

.sb-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
}

.sb-field.full-width {
  grid-column: 1 / -1;
}

.sb-meta-row {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.sb-chip {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-surface-secondary, rgba(128, 128, 128, 0.1));
}

.sb-chip.restored {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.sb-desc {
  margin: 0;
  font-size: 13px;
  color: var(--text-muted, #71717a);
}

.sb-payload-preview h6 {
  margin: 0 0 6px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  opacity: 0.8;
}

.sb-tags {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.sb-tag {
  font-size: 11px;
  font-family: monospace;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--bg-surface-secondary, rgba(128, 128, 128, 0.1));
}

.sb-channels-selector {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  max-height: 200px;
  overflow-y: auto;
  padding: 8px;
  border-radius: 6px;
  background: var(--bg-surface, rgba(128, 128, 128, 0.03));
  border: 1px solid var(--border, rgba(128, 128, 128, 0.15));
}

.sb-channel-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.sb-channel-label {
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

.sb-channel-label small {
  color: var(--text-muted, #71717a);
  font-size: 11px;
}

.sb-confirm-checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  margin: 6px 0;
}

.sb-status-pill {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 9999px;
  text-transform: uppercase;
}

.pill-applied, .pill-verified {
  background: rgba(34, 197, 94, 0.15);
  color: #22c55e;
}

.pill-modified {
  background: rgba(234, 179, 8, 0.15);
  color: #eab308;
}

.pill-unchanged {
  background: rgba(128, 128, 128, 0.15);
  color: var(--text-muted, #71717a);
}

.pill-failed, .pill-mismatch {
  background: rgba(239, 68, 68, 0.15);
  color: #ef4444;
}

.pill-dry_run {
  background: rgba(59, 130, 246, 0.15);
  color: #3b82f6;
}

.sb-diff-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin-top: 8px;
}

.sb-diff-table th, .sb-diff-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.1));
}

.sb-diff-table pre {
  margin: 0;
  max-height: 60px;
  overflow: auto;
  font-size: 11px;
}

.sb-diff-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
}

.sb-diff-badge.modified {
  background: rgba(234, 179, 8, 0.2);
  color: #eab308;
}

.sb-diff-badge.added {
  background: rgba(59, 130, 246, 0.2);
  color: #3b82f6;
}

.sb-diff-badge.unchanged {
  background: rgba(128, 128, 128, 0.1);
  color: var(--text-muted, #71717a);
}

.sb-diff-badge.protected_or_excluded {
  background: rgba(168, 85, 247, 0.2);
  color: #a855f7;
}

.sb-snapshot-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 14px;
  border-radius: 6px;
  background: var(--bg-surface, rgba(128, 128, 128, 0.04));
  border: 1px solid var(--border, rgba(128, 128, 128, 0.15));
  margin-bottom: 6px;
}

.sb-snapshot-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sb-snapshot-slug {
  font-size: 13px;
}

.sb-snapshot-time {
  font-size: 12px;
  color: var(--text-muted, #71717a);
}

.sb-snapshot-reason {
  font-size: 11px;
  color: var(--text-muted, #71717a);
}

.sb-actions {
  display: flex;
  gap: 10px;
}

.fine {
  font-size: 12px;
  color: var(--text-muted, #71717a);
  margin: 0;
}

.sb-empty-state {
  font-size: 13px;
  color: var(--text-muted, #71717a);
  margin: 4px 0;
  font-style: italic;
}
</style>
