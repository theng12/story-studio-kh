<template>
  <!-- v1.4.249 — the channel's ONE upload schedule. Once a YouTube channel is
       assigned this IS its active upload plan, shown by name; the Upload
       Center edits the very same plan. Owner: "it saves here but doesn't show
       me the plan's name so I have to do the same save again inside the
       Upload Center." -->
  <section class="card settings-panel schedule-card" aria-labelledby="schedule-card-title">
    <header class="schedule-head">
      <div>
        <h3 id="schedule-card-title">Upload schedule</h3>
        <p v-if="state?.channel">
          This is the upload plan for <strong>{{ state.channel.title }}</strong> — the same one the Upload Center shows.
          A change here changes it there.
        </p>
        <p v-else-if="state">
          No YouTube channel is chosen for this project yet. Set the rhythm now; it becomes the channel’s upload plan
          the moment you choose one below.
        </p>
      </div>
      <NuxtLink v-if="state?.channel" :to="`/projects/${slug}/upload/plans`" class="btn btn-ghost btn-sm">Open in Upload Center</NuxtLink>
    </header>

    <p v-if="loading" class="schedule-muted">Loading the schedule…</p>
    <p v-else-if="loadError" class="schedule-error" role="alert">
      {{ loadError }} <button type="button" class="btn btn-ghost btn-sm" @click="load">Try Again</button>
    </p>

    <template v-else-if="state">
      <div v-if="!editing" class="schedule-summary">
        <div class="schedule-plan">
          <span class="schedule-plan-name">{{ shownName }}</span>
          <span v-if="state.plan" class="schedule-chip">Active plan</span>
          <span v-else-if="state.channel" class="schedule-chip warn">No plan yet</span>
          <span v-else-if="isDefault" class="schedule-chip">Starting schedule</span>
        </div>
        <p class="schedule-when">{{ summary }}</p>
        <p v-if="isDefault" class="schedule-muted">
          Nothing saved yet — this is what every channel starts with. Save to choose your own days and times.
        </p>
        <p v-if="perMonth" class="schedule-muted">About {{ perMonth }} {{ perMonth === 1 ? 'episode' : 'episodes' }} a month.</p>
        <p v-if="otherPlans" class="schedule-muted">
          {{ otherPlans }} other saved {{ otherPlans === 1 ? 'plan' : 'plans' }} for this channel —
          switch in the <NuxtLink :to="`/projects/${slug}/upload/plans`">Upload Center</NuxtLink>.
        </p>
        <div class="schedule-actions">
          <button type="button" class="btn btn-primary btn-sm" @click="startEdit">{{ isDefault || !hasSchedule ? 'Set Schedule' : 'Edit Plan' }}</button>
        </div>
      </div>

      <form v-else class="schedule-form" @submit.prevent="save">
        <UploadScheduleEditor v-model="draft" :disabled="saving" :show-name="!!state.channel" :show-dates="!!state.channel" />
        <p v-if="formError" class="schedule-error" role="alert">{{ formError }}</p>
        <div class="schedule-actions">
          <button type="submit" class="btn btn-primary btn-sm" :disabled="saving">{{ saving ? 'Saving…' : 'Save Plan' }}</button>
          <button type="button" class="btn btn-ghost btn-sm" :disabled="saving" @click="cancelEdit">Cancel</button>
        </div>
      </form>

      <label class="schedule-auto">
        <input type="checkbox" :checked="state.auto_schedule_on_render" :disabled="saving || (!hasSchedule && !editing)" @change="toggleAuto($event.target as HTMLInputElement)" />
        <span>
          Give each episode a publish time as soon as it finishes rendering
          <small>On unless you turn it off. Nothing is sent to YouTube — the episode only gets its slot, and you still press upload. An episode that is already live, or already has a time, is left alone.</small>
        </span>
      </label>
      <label class="schedule-auto">
        <input type="checkbox" :checked="state.auto_schedule_require_final_check !== false" :disabled="saving" @change="toggleCheck($event.target as HTMLInputElement)" />
        <span>Require a passed final check before automatic scheduling
          <small>On by default. Run Final Check in Publish to release a held episode.</small>
        </span>
      </label>
      <p v-if="notice" class="schedule-ok" role="status">{{ notice }}</p>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { draftFromSchedule, emptyDraft, episodesPerMonth, scheduleFromDraft, scheduleSummary, type ScheduleDraft, type UploadScheduleShape } from '~/utils/uploadPlanDraft'

interface PlanLite { id: string; name: string; schedule: UploadScheduleShape }
interface ChannelSchedule {
  channel: { channel_id: string; title: string } | null
  plan: PlanLite | null
  plans: PlanLite[]
  cadence: { schedule: UploadScheduleShape } | null
  /** What this channel publishes on until it saves its own (2026-10-31). */
  default_schedule?: UploadScheduleShape | null
  auto_schedule_on_render: boolean
  auto_schedule_require_final_check?: boolean
}

const props = defineProps<{ slug: string }>()
const { get, put } = useApi()

const state = ref<ChannelSchedule | null>(null)
const loading = ref(true)
const loadError = ref('')
const editing = ref(false)
const saving = ref(false)
const formError = ref('')
const notice = ref('')
const draft = ref<ScheduleDraft>(emptyDraft())

const shownSchedule = computed(() => state.value?.plan?.schedule || state.value?.cadence?.schedule || state.value?.default_schedule || null)
const hasSchedule = computed(() => !!shownSchedule.value)
/** Nothing saved yet: the card shows the default every channel starts on. */
const isDefault = computed(() => !state.value?.plan && !state.value?.cadence?.schedule && !!state.value?.default_schedule)
const shownName = computed(() => state.value?.plan?.name
  || (isDefault.value ? 'Starting schedule' : (state.value?.channel ? `${state.value.channel.title} schedule` : 'Channel schedule')))
const summary = computed(() => hasSchedule.value ? scheduleSummary(shownSchedule.value) : 'No days chosen yet.')
const perMonth = computed(() => episodesPerMonth(shownSchedule.value))
const otherPlans = computed(() => Math.max(0, (state.value?.plans?.length || 0) - (state.value?.plan ? 1 : 0)))

async function load(): Promise<void> {
  const target = props.slug
  loading.value = true
  loadError.value = ''
  try {
    const next = await get<ChannelSchedule>(`/projects/${target}/publishing-schedule`)
    if (target !== props.slug) return
    state.value = next
  } catch (e: any) {
    loadError.value = e?.data?.detail || e?.message || 'Could not read the upload schedule.'
  } finally {
    if (target === props.slug) loading.value = false
  }
}

function startEdit(): void {
  draft.value = draftFromSchedule(shownSchedule.value, state.value?.channel ? shownName.value : '')
  formError.value = ''
  notice.value = ''
  editing.value = true
}
function cancelEdit(): void { editing.value = false; formError.value = '' }

async function send(body: Record<string, unknown>, message: string): Promise<boolean> {
  saving.value = true
  formError.value = ''
  notice.value = ''
  try {
    state.value = await put<ChannelSchedule>(`/projects/${props.slug}/publishing-schedule`, body)
    notice.value = message
    return true
  } catch (e: any) {
    formError.value = e?.data?.detail || e?.message || 'Could not save the schedule.'
    return false
  } finally {
    saving.value = false
  }
}

async function save(): Promise<void> {
  const result = scheduleFromDraft(draft.value, { requireName: !!state.value?.channel })
  if ('error' in result) { formError.value = result.error; return }
  const ok = await send(
    { schedule: result.schedule, ...(state.value?.channel ? { name: draft.value.name.trim() } : {}) },
    state.value?.channel
      ? `Saved “${draft.value.name.trim()}”. The Upload Center shows the same plan — no need to save it there.`
      : 'Saved. This becomes the channel’s upload plan when you choose its YouTube channel.',
  )
  if (ok) editing.value = false
}

async function toggleCheck(box: HTMLInputElement): Promise<void> {
  const ok = await send({ auto_schedule_require_final_check: box.checked },
    box.checked ? 'Automatic scheduling now requires a passed final check.' : 'Automatic scheduling no longer waits for the final check.')
  if (!ok) box.checked = !box.checked
}

async function toggleAuto(box: HTMLInputElement): Promise<void> {
  const parsed = editing.value ? scheduleFromDraft(draft.value) : null
  const schedule = parsed ? (parsed.ok ? parsed.schedule : null) : shownSchedule.value
  if (!schedule) { box.checked = !box.checked; formError.value = 'Set the schedule first.'; return }
  // The starting schedule is not saved on disk, so flipping the switch must
  // not write it there — only the switch itself.
  const body: Record<string, unknown> = { auto_schedule_on_render: box.checked }
  if (editing.value || !isDefault.value) body.schedule = schedule
  const ok = await send(body,
    box.checked ? 'Finished episodes now get the next free slot.' : 'Finished episodes no longer get a slot by themselves.')
  if (!ok) box.checked = !box.checked
}

watch(() => props.slug, () => { editing.value = false; void load() }, { immediate: true })
</script>

<style scoped>
.schedule-card { display: grid; gap: 12px; }
.schedule-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.schedule-head h3 { margin: 0 0 4px; font-size: 16px; }
.schedule-head p { margin: 0; max-width: 720px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.schedule-summary { display: grid; gap: 6px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); }
.schedule-plan { display: flex; align-items: center; gap: 8px; }
.schedule-plan-name { color: var(--text-primary); font-size: 14px; font-weight: 600; }
.schedule-chip { padding: 1px 8px; border-radius: 999px; background: color-mix(in srgb, var(--success) 18%, transparent); color: var(--success); font-size: var(--font-xs); font-weight: 600; }
.schedule-chip.warn { background: color-mix(in srgb, var(--warning, #d97706) 18%, transparent); color: var(--warning, #d97706); }
.schedule-when { margin: 0; color: var(--text-primary); font-size: 13px; }
.schedule-muted { margin: 0; color: var(--text-muted); font-size: 12px; }
.schedule-actions { display: flex; gap: 8px; margin-top: 4px; }
.schedule-form { display: grid; gap: 10px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-primary); }
.schedule-auto { display: flex; gap: 8px; align-items: flex-start; cursor: pointer; }
.schedule-auto input { margin-top: 3px; }
.schedule-auto span { display: grid; gap: 2px; color: var(--text-primary); font-size: 13px; }
.schedule-auto small { color: var(--text-muted); font-size: 12px; }
.schedule-error { margin: 0; color: var(--error); font-size: 12px; }
.schedule-ok { margin: 0; color: var(--success); font-size: 12px; }
</style>
