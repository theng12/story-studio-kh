<!--
  Channel upload pacing settings (Story 386 Item 1).

  The channel's own operating rules: tier (Gentle / Regular / Bulk / Custom),
  an explicit upload window, allowed days, timezone and spacing. Every count
  comes from the shared contract or the server's tier_defaults — nothing is
  restated here as a literal, and no window or spacing is invented: an
  unconfigured channel says so and stays unconfigured until the owner chooses
  hours.

  These are OUR limits for how this channel works, not YouTube's. No
  auto-promotion, no channel-age guessing, no random anti-detection.
-->
<template>
  <section class="panel upload-pacing-settings" data-setting="upload-pacing" aria-labelledby="upload-pacing-title">
    <header class="pacing-head">
      <div class="copy">
        <span class="eyebrow">Per-channel rules</span>
        <h3 id="upload-pacing-title">Upload pacing</h3>
        <p>
          How many uploads this channel accepts per day and when they may start. These are our
          operating rules, not YouTube limits. New channels start on Gentle; every channel picks
          its tier deliberately, and the counts stay editable.
        </p>
      </div>
      <span v-if="currentLabel" class="tier-badge">{{ currentLabel }}</span>
    </header>

    <p v-if="loading" class="hint" role="status">Loading this channel’s pacing…</p>

    <p v-else-if="loadError" class="result err" role="alert">{{ loadError }}</p>

    <template v-else>
      <div class="tier-row" role="radiogroup" aria-label="Pacing tier">
        <label
          v-for="tier in tiers"
          :key="tier"
          :class="['tier-option', { active: draft.tier === tier }]"
        >
          <input
            v-model="draft.tier" type="radio" name="upload-pacing-tier" :value="tier"
            :aria-label="tierName(tier)"
            @change="applyTierDefaults(tier)"
          />
          <span>
            <strong>{{ tierName(tier) }}</strong>
            <small v-if="tier !== 'custom'">up to {{ tierCount(tier) }}/day</small>
            <small v-else>your own count</small>
          </span>
        </label>
      </div>

      <div class="grid">
        <label class="field">
          <span>Uploads per channel day</span>
          <input
            v-model.number="draft.daily_limit" type="number" min="1" step="1"
            :disabled="saving" aria-label="Uploads per channel day"
          />
          <small class="fine">Editable. This is the count Story Studio enforces and shows everywhere it counts.</small>
        </label>

        <label class="field">
          <span>Timezone for the pacing day</span>
          <select v-model="draft.timezone" :disabled="saving" aria-label="Pacing timezone">
            <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
          </select>
          <small class="fine">The pacing day and the window hours are counted in this zone.</small>
        </label>

        <label class="field">
          <span>Upload window starts</span>
          <input
            v-model="draft.window.start" type="time" :disabled="saving"
            aria-label="Upload window start time"
          />
        </label>

        <label class="field">
          <span>Upload window ends</span>
          <input
            v-model="draft.window.end" type="time" :disabled="saving"
            aria-label="Upload window end time"
          />
          <small class="fine">No default hours: uploads stay unconfigured until you choose both times.</small>
        </label>

        <label class="field">
          <span>Minimum minutes between uploads</span>
          <input
            v-model="draft.min_spacing" type="number" min="0" step="5" placeholder="spread across window"
            :disabled="saving" aria-label="Minimum minutes between uploads"
          />
          <small class="fine">
            Leave empty to spread uploads evenly across your window
            <template v-if="effectiveSpacing !== null">— at least {{ effectiveSpacing }} minutes apart today</template>.
          </small>
        </label>
      </div>

      <fieldset class="days" :disabled="saving">
        <legend>Days uploads may start</legend>
        <label v-for="day in weekdayOptions" :key="day.value" class="day-chip">
          <input type="checkbox" :checked="dayChecked(day.value)" @change="toggleDay(day.value)" />
          <span>{{ day.label }}</span>
        </label>
        <small class="fine">{{ daysNote }}</small>
      </fieldset>

      <p v-if="quotaLine" class="hint quota-line" role="status">{{ quotaLine }}</p>

      <p v-if="saveError" class="result err" role="alert">{{ saveError }}</p>
      <p v-if="saveOk" class="result ok" role="status">{{ saveOk }}</p>

      <div class="actions">
        <button
          class="btn btn-primary" type="button"
          :disabled="saving" @click="save"
        >{{ saving ? 'Saving…' : 'Save Pacing Rules' }}</button>
        <span class="fine">Saved per channel. Nothing here changes YouTube’s own limits or any other channel.</span>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, onMounted } from 'vue'
import { useApi } from '~/composables/useApi'
import {
  UPLOAD_PACING_TIERS,
  UPLOAD_PACING_TIER_DEFAULTS,
  UPLOAD_PACING_TIER_NAMES,
  uploadPacingTierLabel,
  effectiveSpacingMinutes,
  validateUploadPacingPolicy,
  type UploadPacingTier,
  type UploadPacingPolicy,
} from '~/utils/upload-pacing'
import { deviceTimezone, timezoneOptions, WEEKDAYS } from '~/utils/uploadPlanDraft'

const props = defineProps<{ slug: string }>()

const { get, put } = useApi()

const loading = ref(true)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const saveOk = ref('')

const tiers = UPLOAD_PACING_TIERS
const weekdayOptions = WEEKDAYS
const zones = computed(() => timezoneOptions(draft.timezone))

/** The server's tier defaults when it publishes them; else the shared contract. */
const tierDefaults = ref<Record<string, { daily_limit: number }> | null>(null)
const quota = ref<any>(null)

const draft = reactive({
  tier: 'gentle' as UploadPacingTier,
  daily_limit: UPLOAD_PACING_TIER_DEFAULTS.gentle.daily_limit,
  timezone: deviceTimezone(),
  window: { start: '', end: '' },
  min_spacing: '' as string | number,
  weekdays: [] as number[],
})

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

function tierCount(tier: UploadPacingTier): number {
  if (tier === 'custom') return Number(draft.daily_limit) || 0
  return tierDefaults.value?.[tier]?.daily_limit ?? UPLOAD_PACING_TIER_DEFAULTS[tier as 'gentle' | 'regular' | 'bulk'].daily_limit
}

const currentLabel = computed(() => uploadPacingTierLabel(draft.tier, Number(draft.daily_limit) || 0))
const tierName = (tier: UploadPacingTier) => UPLOAD_PACING_TIER_NAMES[tier]

function applyTierDefaults(tier: UploadPacingTier): void {
  if (tier === 'custom') return
  draft.daily_limit = tierCount(tier)
}

const effectiveDays = computed(() => (draft.weekdays.length ? [...draft.weekdays].sort() : ALL_DAYS))
const daysNote = computed(() => (draft.weekdays.length
  ? `${draft.weekdays.length} day${draft.weekdays.length === 1 ? '' : 's'} allowed.`
  : 'All seven days allowed — no days restricted.'))

function dayChecked(day: number): boolean {
  return effectiveDays.value.includes(day)
}

function toggleDay(day: number): void {
  const current = effectiveDays.value
  const next = current.includes(day) ? current.filter(value => value !== day) : [...current, day].sort((a, b) => a - b)
  // All seven chosen is the same as no restriction — store it that way.
  draft.weekdays = next.length === 7 ? [] : next
}

const effectiveSpacing = computed(() => {
  const limit = Number(draft.daily_limit)
  if (!limit || !draft.window.start || !draft.window.end) return null
  const spacing = effectiveSpacingMinutes({
    window: { start: draft.window.start, end: draft.window.end },
    daily_limit: limit,
    ...(Number(draft.min_spacing) > 0 ? { min_spacing_minutes: Number(draft.min_spacing) } : {}),
  })
  return Number.isFinite(spacing) ? spacing : null
})

const quotaLine = computed(() => {
  const snap = quota.value
  if (!snap || typeof snap !== 'object') return ''
  const bucket = snap.buckets?.video_uploads
  const parts: string[] = []
  if (bucket) {
    const used = Number(bucket.used)
    const limit = bucket.limit
    if (Number.isFinite(used) && limit !== null && limit !== undefined) {
      parts.push(`${used} of ${limit} video-upload calls tracked for ${snap.tracking_day || 'today'}`)
    } else if (Number.isFinite(used)) {
      parts.push(`${used} video-upload calls tracked for ${snap.tracking_day || 'today'} (allowance unknown)`)
    }
    if (snap.resets_at) parts.push(`resets ${new Date(snap.resets_at).toLocaleString()}`)
  }
  if (!parts.length) return ''
  const external = snap.external_usage_known === false
    ? ' Only this installation’s calls are counted; other systems sharing the Cloud project are unknown.'
    : ''
  return `Tracked quota: ${parts.join(' · ')}.${external}`
})

function policyFromDraft(): UploadPacingPolicy {
  const spacing = Number(draft.min_spacing)
  return {
    tier: draft.tier,
    daily_limit: Number(draft.daily_limit),
    timezone: draft.timezone,
    window: { start: draft.window.start, end: draft.window.end },
    ...(Number.isFinite(spacing) && spacing > 0 ? { min_spacing_minutes: spacing } : {}),
    ...(draft.weekdays.length ? { weekdays: [...draft.weekdays].sort((a, b) => a - b) } : {}),
  }
}

function applyPolicy(policy: UploadPacingPolicy | null | undefined): void {
  if (!policy) {
    // No saved policy: Gentle is the starting tier; the window stays empty
    // because hours are an explicit choice with no hidden default.
    draft.tier = 'gentle'
    draft.daily_limit = tierCount('gentle')
    draft.timezone = deviceTimezone()
    draft.window = { start: '', end: '' }
    draft.min_spacing = ''
    draft.weekdays = []
    return
  }
  draft.tier = policy.tier
  draft.daily_limit = Number(policy.daily_limit)
  draft.timezone = policy.timezone
  draft.window = { start: policy.window?.start || '', end: policy.window?.end || '' }
  draft.min_spacing = policy.min_spacing_minutes ?? ''
  draft.weekdays = Array.isArray(policy.weekdays) ? [...policy.weekdays] : []
}

async function load(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    const data = await get<any>(`/projects/${encodeURIComponent(props.slug)}/youtube/upload-pacing`)
    tierDefaults.value = data?.tier_defaults ?? null
    quota.value = data?.quota ?? null
    applyPolicy(data?.policy ?? null)
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message
      || 'Pacing settings could not be loaded — the server may be offline or asleep.'
  } finally {
    loading.value = false
  }
}

async function save(): Promise<void> {
  saveError.value = ''
  saveOk.value = ''
  const result = validateUploadPacingPolicy(policyFromDraft())
  if (!result.ok) {
    saveError.value = result.message
    return
  }
  saving.value = true
  try {
    await put(`/projects/${encodeURIComponent(props.slug)}/youtube/upload-pacing`, { policy: result.policy })
    saveOk.value = 'Saved. These rules apply from the next upload this channel queues.'
    applyPolicy(result.policy)
  } catch (error: any) {
    saveError.value = error?.data?.detail || error?.message || 'These pacing rules could not be saved.'
  } finally {
    saving.value = false
  }
}

onMounted(() => { void load() })
</script>

<style scoped>
.upload-pacing-settings {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.25rem;
  border-radius: 8px;
  background: var(--bg-surface, rgba(255, 255, 255, 0.03));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
}

.pacing-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
}

.eyebrow {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted, #888);
}

.pacing-head h3 {
  margin: 0.2rem 0 0.35rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-normal, #f0f0f0);
}

.pacing-head p {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.45;
  color: var(--text-muted, #a0a0a0);
  max-width: 62ch;
}

.tier-badge {
  flex-shrink: 0;
  padding: 0.35rem 0.7rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 600;
  background: var(--bg-chip, rgba(255, 255, 255, 0.06));
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
  color: var(--text-normal, #e8e8e8);
  white-space: nowrap;
}

.tier-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
}

.tier-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.55rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  background: rgba(0, 0, 0, 0.14);
  cursor: pointer;
}

.tier-option.active {
  border-color: var(--primary, #3b82f6);
  background: rgba(59, 130, 246, 0.14);
}

.tier-option strong {
  display: block;
  font-size: 0.9rem;
  color: var(--text-normal, #f0f0f0);
}

.tier-option small {
  display: block;
  font-size: 0.78rem;
  color: var(--text-muted, #a0a0a0);
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 1rem;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.field > span {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted, #a0a0a0);
}

.fine {
  font-size: 0.76rem;
  color: var(--text-muted, #8a8a8a);
  line-height: 1.4;
}

input[type="number"],
input[type="time"],
select {
  padding: 0.45rem 0.65rem;
  font-size: 0.875rem;
  border-radius: 4px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.15));
  background: var(--bg-input, rgba(0, 0, 0, 0.2));
  color: var(--text-normal, #f0f0f0);
}

input:focus, select:focus {
  outline: none;
  border-color: var(--primary, #3b82f6);
}

.days {
  border: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.days legend {
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-muted, #a0a0a0);
  padding: 0;
  margin-bottom: 0.4rem;
  width: 100%;
}

.day-chip {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.3rem 0.6rem;
  border-radius: 4px;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.1));
  background: var(--bg-chip, rgba(255, 255, 255, 0.04));
  font-size: 0.83rem;
  color: var(--text-normal, #ddd);
  cursor: pointer;
}

.quota-line {
  margin: 0;
}

.actions {
  display: flex;
  align-items: center;
  gap: 0.85rem;
  flex-wrap: wrap;
}
</style>
