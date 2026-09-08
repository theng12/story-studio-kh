<template>
  <div class="uc-plans">
    <p v-if="loading" class="hint">Loading local upload plans…</p>
    <section v-else-if="loadError" class="panel" role="status">
      <p class="result err">{{ loadError }}</p>
      <button class="btn btn-sm" type="button" @click="load">Retry</button>
    </section>

    <template v-else-if="!channel">
      <section class="panel" role="status">
        <h2>Choose this project’s YouTube channel first</h2>
        <p>An upload plan belongs to one connected channel. Choose a channel in Settings, then return here to create its local plan.</p>
        <NuxtLink :to="`/projects/${slug}/settings#youtube`" class="btn btn-sm btn-primary">Open Settings → YouTube</NuxtLink>
      </section>
    </template>

    <template v-else>
      <section class="panel heading">
        <div>
          <h2>Upload plans for {{ channel.title }}</h2>
          <p>Saving changes this channel’s local future-slot choices. Existing planned dates and YouTube are unchanged.</p>
        </div>
        <div class="heading-actions">
          <NuxtLink :to="`/projects/${slug}/upload/publish`" class="btn btn-sm">Return to Publish</NuxtLink>
          <button class="btn btn-sm" type="button" :disabled="saving !== ''" @click="requestNewDraft">New plan</button>
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
            >{{ saving === `activate:${plan.id}` ? 'Activating…' : 'Make active' }}</button>
          </div>
        </div>
      </section>
      <section v-else class="panel empty">
        <h2>No local upload plans yet</h2>
        <p>Create a schedule for this channel. You can save it before choosing to make it active.</p>
      </section>

      <form class="panel editor" @submit.prevent="save">
        <div>
          <h2>{{ draft.id ? draft.name || 'Untitled plan' : 'Plan details' }}</h2>
          <p v-if="draft.id">Changing this plan affects future local slot choices only. Existing dates and YouTube are unchanged.</p>
        </div>
        <label>
          Plan name
          <input v-model="draft.name" required maxlength="120" autocomplete="off" placeholder="Weekly uploads" :disabled="saving !== ''" />
        </label>

        <fieldset :disabled="saving !== ''">
          <legend>Repeats</legend>
          <div class="mode-row">
            <label><input v-model="draft.mode" type="radio" value="weekly" /> Weekly</label>
            <label><input v-model="draft.mode" type="radio" value="monthly" /> Monthly</label>
          </div>
          <template v-if="draft.mode === 'weekly'">
            <div class="weekday-row" aria-label="Weekly weekdays">
              <label v-for="day in weekdays" :key="day.value">
                <input v-model="draft.weekdays" type="checkbox" :value="day.value" /> {{ day.label }}
              </label>
            </div>
            <label class="interval-field">
              Every <input v-model.number="draft.intervalWeeks" type="number" min="1" /> week<span v-if="draft.intervalWeeks !== 1">s</span>
            </label>
          </template>
          <label v-else>
            Day of month
            <input v-model.number="draft.monthlyDay" type="number" min="1" max="31" />
          </label>
        </fieldset>

        <div class="fields">
          <label>Local time <input v-model="draft.timeLocal" type="time" required :disabled="saving !== ''" /></label>
          <label>Timezone <input v-model="draft.timezone" required placeholder="America/Los_Angeles" :disabled="saving !== ''" /></label>
          <label>Starts on (optional) <input v-model="draft.startDate" type="date" :disabled="saving !== ''" /></label>
          <label>Ends on (optional) <input v-model="draft.endDate" type="date" :disabled="saving !== ''" /></label>
        </div>
        <p v-if="formError" class="result err" role="status">{{ formError }}</p>
        <p v-if="notice" class="result ok" role="status">{{ notice }}</p>
        <div class="form-actions">
          <button class="btn btn-primary" type="submit" :disabled="saving !== ''">{{ saving === 'save' ? 'Saving…' : 'Save local plan' }}</button>
          <button
            v-if="draft.id && draft.id !== activePlanId"
            class="btn"
            type="button"
            :disabled="saving !== '' || dirty"
            @click="selected && requestActivate(selected)"
          >Make this plan active</button>
          <span v-else-if="draft.id && draft.id === activePlanId" class="active">This plan is active for {{ channel.title }}.</span>
          <span v-if="draft.id && dirty" class="hint">Save changes before making this plan active.</span>
        </div>
      </form>
    </template>
  </div>
</template>

<script setup lang="ts">
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
interface Draft {
  id: string
  name: string
  mode: 'weekly' | 'monthly'
  weekdays: number[]
  intervalWeeks: number
  monthlyDay: number
  timeLocal: string
  timezone: string
  startDate: string
  endDate: string
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, put } = useApi()
const { ask } = useConfirm()
const deviceTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const weekdays = [
  { value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
]

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

const emptyDraft = (): Draft => ({
  id: '', name: '', mode: 'weekly', weekdays: [], intervalWeeks: 1, monthlyDay: 1,
  timeLocal: '18:00', timezone: deviceTimezone, startDate: '', endDate: '',
})
const draft = ref<Draft>(emptyDraft())
const accountId = computed(() => channel.value ? `registry:${channel.value.channel_id}` : '')
const activePlanId = computed(() => active.value[`youtube:${accountId.value}`] || '')
const draftState = (value: Draft): string => JSON.stringify({ ...value, weekdays: [...value.weekdays].sort((a, b) => a - b) })
const dirty = computed(() => draftState(draft.value) !== cleanDraft.value)

function isCurrent(action: number, actionSlug: string): boolean { return action === revision && actionSlug === slug.value }
function errorMessage(error: any, fallback: string): string { return error?.data?.detail || error?.message || fallback }
function copyPlan(plan: UploadPlan): Draft {
  const schedule = plan.schedule || {} as UploadSchedule
  return {
    id: plan.id, name: plan.name, mode: schedule.weekdays?.length ? 'weekly' : 'monthly',
    weekdays: Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : [], intervalWeeks: Number(schedule.interval_weeks) || 1,
    monthlyDay: Number(schedule.monthly_day) || 1, timeLocal: schedule.time_local || '18:00', timezone: schedule.timezone || deviceTimezone,
    startDate: schedule.start_date || '', endDate: schedule.end_date || '',
  }
}
function seedDraft(): Draft {
  const schedule = cadence.value?.schedule
  if (!schedule) return emptyDraft()
  return {
    ...emptyDraft(), mode: Array.isArray(schedule.weekdays) && schedule.weekdays.length ? 'weekly' : 'monthly',
    weekdays: Array.isArray(schedule.weekdays) ? [...schedule.weekdays] : [], intervalWeeks: Number(schedule.interval_weeks) || 1,
    monthlyDay: Number(schedule.monthly_day) || 1, timeLocal: schedule.time_local || '18:00', timezone: schedule.timezone || deviceTimezone,
  }
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
  const confirmed = await ask({ title: 'Discard unsaved plan changes?', message, confirmLabel: 'Discard changes' })
  return !!confirmed && isCurrent(action, actionSlug)
}
async function requestNewDraft(): Promise<void> {
  const action = revision
  const actionSlug = slug.value
  if (!await discardDraft('Your current local plan edits have not been saved.', action, actionSlug)) return
  newDraft()
}
async function requestEdit(plan: UploadPlan): Promise<void> {
  const action = revision
  const actionSlug = slug.value
  if (!await discardDraft(`Your current local plan edits have not been saved. Open ${plan.name} instead?`, action, actionSlug)) return
  edit(plan)
}
function scheduleSummary(schedule: UploadSchedule): string {
  const time = `${schedule.time_local || '18:00'} ${schedule.timezone || 'UTC'}`
  if (schedule.weekdays?.length) {
    const days = schedule.weekdays.map(day => weekdays.find(item => item.value === day)?.label).filter(Boolean).join(', ')
    const interval = Math.max(1, Number(schedule.interval_weeks) || 1)
    return `${days} · ${time} · every ${interval} week${interval === 1 ? '' : 's'}`
  }
  return `Day ${schedule.monthly_day || 1} each month · ${time}`
}
function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true } catch { return false }
}
function validatedSchedule(): UploadSchedule | null {
  const value = draft.value
  const name = value.name.trim()
  if (!name) { formError.value = 'Give this plan a name.'; return null }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value.timeLocal)) { formError.value = 'Choose a valid local time.'; return null }
  if (!validTimezone(value.timezone)) { formError.value = 'Use an IANA timezone such as America/Los_Angeles.'; return null }
  if (value.startDate && value.endDate && value.startDate > value.endDate) { formError.value = 'The end date must be on or after the start date.'; return null }
  if (value.mode === 'weekly' && !value.weekdays.length) { formError.value = 'Pick at least one weekday.'; return null }
  if (value.mode === 'weekly' && (!Number.isInteger(value.intervalWeeks) || value.intervalWeeks < 1)) { formError.value = 'Choose every 1 or more weeks.'; return null }
  if (value.mode === 'monthly' && (!Number.isInteger(value.monthlyDay) || value.monthlyDay < 1 || value.monthlyDay > 31)) { formError.value = 'Choose a day from 1 through 31.'; return null }
  return {
    ...(selected.value?.schedule || {}), weekdays: value.mode === 'weekly' ? [...value.weekdays].sort((a, b) => a - b) : [],
    time_local: value.timeLocal, timezone: value.timezone, interval_weeks: value.mode === 'weekly' ? value.intervalWeeks : undefined,
    monthly_day: value.mode === 'monthly' ? value.monthlyDay : undefined,
    start_date: value.startDate || undefined, end_date: value.endDate || undefined,
  }
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
    notice.value = 'Local plan saved. It has not applied dates or changed YouTube.'
  } catch (error: any) {
    if (isCurrent(action, actionSlug)) formError.value = errorMessage(error, 'Could not save this local plan.')
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
    notice.value = `${plan.name} is now the active local plan for ${channel.value?.title}.`
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
      confirmLabel: 'Make saved plan active',
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
    if (isCurrent(action, actionSlug)) loadError.value = errorMessage(error, 'Could not load local upload plans.')
  } finally {
    if (isCurrent(action, actionSlug)) loading.value = false
  }
}

watch(slug, () => { void load() }, { immediate: true })
onBeforeRouteLeave(() => discardDraft('Your current local plan edits have not been saved. Leave this page?'))
onBeforeRouteUpdate(() => discardDraft('Your current local plan edits have not been saved. Switch projects anyway?'))
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
