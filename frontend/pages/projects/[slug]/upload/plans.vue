<template>
  <div class="uc-plans">
    <p v-if="loading" class="hint">Loading upload plans…</p>
    <section v-else-if="loadError" class="panel" role="status">
      <p class="result err">{{ loadError }}</p>
      <button class="btn btn-sm" type="button" @click="load">Retry</button>
    </section>

    <template v-else-if="!channel">
      <section class="panel" role="status">
        <h2>Choose this project’s YouTube channel first</h2>
        <p>An upload plan belongs to one connected channel. Choose a channel in Settings → Publishing; the schedule you set there becomes this channel’s plan.</p>
        <NuxtLink :to="`/projects/${slug}/settings#publishing`" class="btn btn-sm btn-primary">Open Settings → Publishing</NuxtLink>
      </section>
    </template>

    <template v-else>
      <section class="panel heading">
        <div>
          <h2>Upload plans for {{ channel.title }}</h2>
          <p>The active plan is this channel’s upload schedule — the same one Settings → Publishing shows. Existing planned dates and YouTube are unchanged.</p>
        </div>
        <div class="heading-actions">
          <NuxtLink :to="`/projects/${slug}/upload/publish`" class="btn btn-sm">Return to Publish</NuxtLink>
          <button class="btn btn-sm" type="button" :disabled="saving !== ''" @click="requestNewDraft">New Plan</button>
        </div>
      </section>

      <section v-if="plans.length" class="panel plan-list" aria-label="Saved upload plans">
        <div v-for="plan in plans" :key="plan.id" class="plan-row" :class="{ selected: plan.id === draft.id }">
          <div>
            <strong>{{ plan.name }}</strong>
            <p>{{ scheduleSummary(plan.schedule) }}</p>
            <span v-if="plan.id === activePlanId" class="active">Active for this channel</span>
          </div>
          <div class="plan-actions">
            <button class="btn btn-sm" type="button" :disabled="saving !== ''" @click="requestEdit(plan)">Edit</button>
            <button
              v-if="plan.id !== activePlanId"
              class="btn btn-sm btn-primary"
              type="button"
              :disabled="saving !== ''"
              @click="requestActivate(plan)"
            >{{ saving === `activate:${plan.id}` ? 'Activating…' : 'Make Active' }}</button>
          </div>
        </div>
      </section>
      <section v-else class="panel empty">
        <h2>No upload plans yet</h2>
        <p>Create a schedule for this channel. You can save it before choosing to make it active.</p>
      </section>

      <form class="panel editor" @submit.prevent="save">
        <div>
          <h2>{{ draft.id ? draft.name || 'Untitled plan' : 'Plan details' }}</h2>
          <p v-if="draft.id && draft.id === activePlanId">This is the schedule Settings → Publishing shows. Saving here updates it there too. Existing dates and YouTube are unchanged.</p>
          <p v-else-if="draft.id">Changing this plan affects future slot choices only. Existing dates and YouTube are unchanged.</p>
        </div>
        <UploadScheduleEditor v-model="draft" :disabled="saving !== ''" />
        <p v-if="formError" class="result err" role="status">{{ formError }}</p>
        <p v-if="notice" class="result ok" role="status">{{ notice }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving !== ''">{{ saving === 'save' ? 'Saving…' : 'Save Plan' }}</button>
          <button
            v-if="draft.id && draft.id !== activePlanId"
            class="btn"
            type="button"
            :disabled="saving !== '' || dirty"
            @click="selected && requestActivate(selected)"
          >Make This Plan Active</button>
          <span v-else-if="draft.id && draft.id === activePlanId" class="active">This plan is active for {{ channel.title }}.</span>
          <span v-if="draft.id && dirty" class="hint">Save Changes before making this plan active.</span>
        </div>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
import { draftFromSchedule, draftKey, emptyDraft as emptySchedule, scheduleFromDraft, scheduleSummary, type ScheduleDraft } from '~/utils/uploadPlanDraft'
interface Channel { channel_id: string; title: string }
interface Overview { assigned_channel: Channel | null }
interface UploadSchedule {
  weekdays: number[]
  time_local: string
  timezone: string
  interval_weeks?: number
  monthly_day?: number
  start_date?: string
  end_date?: string
  phases?: Array<{ start_date: string; end_date?: string; weekdays: number[]; time_local: string }>
  [key: string]: unknown
}
interface UploadPlan {
  id: string
  name: string
  platform: string
  account_id: string
  schedule: UploadSchedule
  defaults: Record<string, unknown>
  [key: string]: unknown
}
interface Draft extends ScheduleDraft { id: string }

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { ask } = useConfirm()
const loading = ref(true)
const loadError = ref('')
const saving = ref('')
const formError = ref('')
const notice = ref('')
const channel = ref<Channel | null>(null)
const plans = ref<UploadPlan[]>([])
const active = ref<Record<string, string>>({})
const cadence = ref<any>(null)
const selected = ref<UploadPlan | null>(null)
const cleanDraft = ref('')
let revision = 0

const emptyDraft = (): Draft => ({ id: '', ...emptySchedule() })
const draft = ref<Draft>(emptyDraft())
const accountId = computed(() => channel.value ? `registry:${channel.value.channel_id}` : '')
const activePlanId = computed(() => active.value[`youtube:${accountId.value}`] || '')
const draftState = (value: Draft): string => `${value.id}|${draftKey(value)}`
const dirty = computed(() => draftState(draft.value) !== cleanDraft.value)

function isCurrent(action: number, actionSlug: string): boolean { return action === revision && actionSlug === slug.value }
function errorMessage(error: any, fallback: string): string { return error?.data?.detail || error?.message || fallback }
function copyPlan(plan: UploadPlan): Draft {
  return { id: plan.id, ...draftFromSchedule(plan.schedule, plan.name) }
}
function seedDraft(): Draft {
  return { id: '', ...draftFromSchedule(cadence.value?.schedule || null, '') }
}
function newDraft(): void {
  selected.value = null
  draft.value = seedDraft()
  cleanDraft.value = draftState(draft.value)
  formError.value = ''
  notice.value = ''
}
function edit(plan: UploadPlan): void {
  selected.value = plan
  draft.value = copyPlan(plan)
  cleanDraft.value = draftState(draft.value)
  formError.value = ''
  notice.value = ''
}
async function discardDraft(message: string, action = revision, actionSlug = slug.value): Promise<boolean> {
  if (!dirty.value) return true
  const confirmed = await ask({ title: 'Discard unsaved plan changes?', message, confirmLabel: 'Discard Changes' })
  return !!confirmed && isCurrent(action, actionSlug)
}
async function requestNewDraft(): Promise<void> {
  const action = revision
  const actionSlug = slug.value
  if (!await discardDraft('Your current plan edits have not been saved.', action, actionSlug)) return
  newDraft()
}
async function requestEdit(plan: UploadPlan): Promise<void> {
  const action = revision
  const actionSlug = slug.value
  if (!await discardDraft(`Your current plan edits have not been saved. Open ${plan.name} instead?`, action, actionSlug)) return
  edit(plan)
}
function validatedSchedule(): UploadSchedule | null {
  const result = scheduleFromDraft(draft.value, { requireName: true })
  if ('error' in result) { formError.value = result.error; return null }
  // Keep any fields this editor does not show, but let cleared ones clear.
  const kept = { ...(selected.value?.schedule || {}) } as UploadSchedule
  for (const key of ['interval_weeks', 'monthly_day', 'start_date', 'end_date', 'phases']) delete kept[key]
  return { ...kept, ...result.schedule } as UploadSchedule
}
async function save(): Promise<void> {
  if (!channel.value || saving.value) return
  formError.value = ''
  notice.value = ''
  const schedule = validatedSchedule()
  if (!schedule) return
  const action = ++revision
  const actionSlug = slug.value
  saving.value = 'save'
  try {
    const saved = await post<{ plan: UploadPlan }>(`/projects/${actionSlug}/upload/plans`, {
      ...(selected.value || {}), id: draft.value.id || undefined, name: draft.value.name.trim(), platform: 'youtube', account_id: accountId.value,
      schedule, defaults: selected.value?.defaults || cadence.value?.defaults || { privacy_status: 'private', made_for_kids: false },
    })
    if (!isCurrent(action, actionSlug)) return
    const plan = saved.plan
    const index = plans.value.findIndex(item => item.id === plan.id)
    if (index >= 0) plans.value.splice(index, 1, plan); else plans.value.push(plan)
    selected.value = plan
    draft.value = copyPlan(plan)
    cleanDraft.value = draftState(draft.value)
    notice.value = plan.id === activePlanId.value
      ? 'Plan saved — Settings → Publishing shows the same schedule. No dates were applied and YouTube is unchanged.'
      : 'Plan saved. No dates were applied and YouTube is unchanged.'
  } catch (error: any) {
    if (isCurrent(action, actionSlug)) formError.value = errorMessage(error, 'Could not save this plan.')
  } finally {
    if (isCurrent(action, actionSlug)) saving.value = ''
  }
}
async function activate(plan: UploadPlan): Promise<void> {
  if (!plan?.id || saving.value || plan.id === activePlanId.value) return
  const action = ++revision
  const actionSlug = slug.value
  formError.value = ''
  notice.value = ''
  saving.value = `activate:${plan.id}`
  try {
    await put(`/projects/${actionSlug}/upload/plans/${encodeURIComponent(plan.id)}/active`, {})
    if (!isCurrent(action, actionSlug)) return
    active.value = { ...active.value, [`youtube:${accountId.value}`]: plan.id }
    notice.value = `${plan.name} is now the upload schedule for ${channel.value?.title}, here and in Settings → Publishing.`
  } catch (error: any) {
    if (isCurrent(action, actionSlug)) formError.value = errorMessage(error, 'Could not make this plan active.')
  } finally {
    if (isCurrent(action, actionSlug)) saving.value = ''
  }
}
async function requestActivate(plan: UploadPlan): Promise<void> {
  if (!plan?.id || saving.value || plan.id === activePlanId.value) return
  const action = revision
  const actionSlug = slug.value
  if (dirty.value) {
    const confirmed = await ask({
      title: 'Make the saved plan active?',
      message: 'Your editor changes are not saved. This activates the saved version and leaves your draft unchanged.',
      confirmLabel: 'Make Saved Plan Active',
    })
    if (!confirmed || !isCurrent(action, actionSlug)) return
  }
  await activate(plan)
}
async function load(): Promise<void> {
  const action = ++revision
  const actionSlug = slug.value
  loading.value = true
  saving.value = ''
  loadError.value = ''
  formError.value = ''
  notice.value = ''
  try {
    const [overview, listed, config] = await Promise.all([
      get<Overview>(`/projects/${actionSlug}/youtube/overview`),
      get<{ plans: UploadPlan[]; active: Record<string, string> }>(`/projects/${actionSlug}/upload/plans`),
      get<any>(`/projects/${actionSlug}/settings/config`).catch(() => null),
    ])
    if (!isCurrent(action, actionSlug)) return
    channel.value = overview.assigned_channel
    const key = overview.assigned_channel ? `registry:${overview.assigned_channel.channel_id}` : ''
    plans.value = (listed.plans || []).filter(plan => plan.platform === 'youtube' && plan.account_id === key)
    active.value = listed.active || {}
    cadence.value = config?.publish_cadence || config?.config?.publish_cadence || null
    const initial = plans.value.find(plan => plan.id === activePlanId.value) || plans.value[0]
    if (initial) edit(initial); else newDraft()
  } catch (error: any) {
    if (isCurrent(action, actionSlug)) loadError.value = errorMessage(error, 'Could not load upload plans.')
  } finally {
    if (isCurrent(action, actionSlug)) loading.value = false
  }
}

watch(slug, () => { void load() }, { immediate: true })
onBeforeRouteLeave(() => discardDraft('Your current plan edits have not been saved. Leave this page?'))
onBeforeRouteUpdate(() => discardDraft('Your current plan edits have not been saved. Switch projects anyway?'))
</script>

<style scoped>
.uc-plans { container-type: inline-size; container-name: uc-plans; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h2 { margin: 0; font-size: 18px; }
.panel p { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.5; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.result { margin: 0; font-size: var(--font-xs); }
.result.err { color: var(--danger); }
.result.ok, .active { color: var(--success); }
.heading { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.plan-list { padding: 0; overflow: hidden; }
.plan-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.plan-row:last-child { border-bottom: 0; }
.plan-row.selected { background: var(--bg-tertiary); }
.plan-row strong, .active { display: block; font-size: var(--font-xs); }
.heading-actions, .plan-actions, .form-actions, .mode-row, .weekday-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.editor > label, .fields label, fieldset > label { display: grid; gap: 5px; color: var(--text-secondary); font-size: var(--font-xs); }
input { min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-primary); color: var(--text-primary); font: inherit; }
fieldset { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
legend { padding: 0 4px; color: var(--text-secondary); font-size: var(--font-xs); }
.mode-row label, .weekday-row label { color: var(--text-secondary); font-size: var(--font-xs); }
.mode-row input, .weekday-row input { min-width: auto; padding: 0; }
fieldset > label input { width: 86px; margin: 0 4px; }
fieldset > .interval-field { display: flex; align-items: center; flex-wrap: wrap; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
@container uc-plans (max-width: 620px) {
  .heading, .plan-row { grid-template-columns: 1fr; }
  .fields { grid-template-columns: 1fr; }
  .plan-actions { justify-content: start; }
}
</style>
