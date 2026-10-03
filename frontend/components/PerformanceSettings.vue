<template>
  <!-- v1.4.249 — Performance & recovery, redesigned. The owner: "the performance
       is ugly. make it nicer" (nine dropdowns with a paragraph each, and four
       near-identical paid-replacement cards, each with its own Save).
       Now: one compact table of numbers with one-line hints (the long help is
       behind "More"), one table of paid replacements, and ONE Save. -->
  <div class="perf">
    <section class="perf-card" data-setting="throughput" aria-labelledby="perf-throughput-title">
      <header class="perf-card-head">
        <div>
          <h4 id="perf-throughput-title">How much runs at once</h4>
          <p>How many jobs Story Studio sends at a time. Raise a number when your Macs have room; lower it if work gets refused.</p>
        </div>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!concurrencyLoaded || saving" @click="useRecommended">Use Recommended</button>
      </header>

      <p v-if="concurrencyError" class="perf-error" role="alert">{{ concurrencyError }}</p>
      <table v-if="concurrencyLoaded" class="perf-table">
        <tbody>
          <template v-for="field in mainFields" :key="field.key">
            <PerfRow :field="field" :value="models[field.key]" :open="openHelp === field.key" :disabled="saving"
              @update="value => setValue(field, value)" @toggle="toggleHelp(field.key)" />
          </template>
        </tbody>
      </table>

      <AdvancedDisclosure v-if="concurrencyLoaded" label="Advanced: writing time limit and speed warnings">
        <table class="perf-table">
          <tbody>
            <template v-for="field in advancedFields" :key="field.key">
              <PerfRow :field="field" :value="models[field.key]" :open="openHelp === field.key" :disabled="saving"
                @update="value => setValue(field, value)" @toggle="toggleHelp(field.key)" />
            </template>
          </tbody>
        </table>
      </AdvancedDisclosure>
    </section>

    <section class="perf-card paid-replacement" data-setting="paid-replacement" aria-labelledby="perf-paid-title">
      <header class="perf-card-head">
        <div>
          <h4 id="perf-paid-title">Paid replacements after a confirmed failure</h4>
          <p>
            Off by default. When something fails, Story Studio first checks the original request really failed — it never
            guesses from time alone — and free retries always happen. Only then may it buy <strong>one</strong> paid
            replacement per failed item, within the credit limit you set here for each Story job.
          </p>
          <button type="button" class="perf-more" :aria-expanded="paidMoreOpen" @click="paidMoreOpen = !paidMoreOpen">{{ paidMoreOpen ? 'Less' : 'More' }}</button>
          <p v-if="paidMoreOpen" class="perf-more-text">
            Images: a failure that cost nothing is retried, with a pause between tries, until the image finishes or you
            pause, cancel, or turn this off. A failure that already used credits waits 30 minutes, checks the image is
            still missing, re-checks the price, and may then buy one replacement — maximum 1 per image.
            Subtitles, audio and writing: maximum 1 replacement per confirmed failed section or item.
          </p>
        </div>
      </header>

      <table class="perf-table paid-table">
        <thead>
          <tr><th scope="col">For</th><th scope="col">Automatic replacement</th><th scope="col">Credit limit per Story job</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in paidRows" :key="row.kind" :class="`paid-${row.kind}-replacement`" :data-kind="row.kind">
            <th scope="row">{{ row.label }}</th>
            <td>
              <div v-if="row.loaded" class="segmented" role="radiogroup" :aria-label="`${row.label}: automatic replacement`">
                <label :class="{ active: !row.enabled }">
                  <input type="radio" :name="`paid-${row.kind}-replacement-enabled`" value="false" :checked="!row.enabled" :disabled="saving" @change="setPaidEnabled(row, false)" /> Off
                </label>
                <label :class="{ active: row.enabled }">
                  <input type="radio" :name="`paid-${row.kind}-replacement-enabled`" value="true" :checked="row.enabled" :disabled="saving" @change="setPaidEnabled(row, true)" /> On
                </label>
              </div>
              <span v-else class="perf-muted">{{ row.loadError ? 'Saved state unavailable' : 'Loading…' }}</span>
            </td>
            <td>
              <span v-if="row.loaded && row.enabled" class="ceiling">
                <input
                  v-model="row.ceiling"
                  :name="`paid-${row.kind}-replacement-ceiling`"
                  type="number" min="1" step="1" required inputmode="numeric"
                  :aria-label="`${row.label}: maximum additional credits per Story job`"
                  :disabled="saving"
                  @input="row.error = ''"
                /> credits
              </span>
              <span v-else-if="row.loaded" class="perf-muted">—</span>
              <span v-if="row.error" class="perf-row-error" role="alert">{{ row.error }}</span>
              <span v-if="row.loadError" class="perf-row-error">{{ row.loadError }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <div class="perf-save-bar" :class="{ dirty }">
      <span class="perf-save-state" aria-live="polite">
        <template v-if="saveError"><span class="perf-error">{{ saveError }}</span></template>
        <template v-else-if="savedMessage">{{ savedMessage }}</template>
        <template v-else>{{ dirty ? 'You have unsaved changes.' : 'All changes saved.' }}</template>
      </span>
      <button class="btn btn-ghost btn-sm" type="button" :disabled="!dirty || saving" @click="revert">Revert</button>
      <button class="btn btn-primary btn-sm" type="button" :disabled="!dirty || saving" @click="save">{{ saving ? 'Saving…' : 'Save Changes' }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, reactive, ref, onMounted, type PropType } from 'vue'
import { THROUGHPUT_FIELDS, type ThroughputField, type ThroughputKey, throughputPayload, throughputFromServer } from '~/utils/performanceSettings'

interface PaidSetting { enabled: boolean; additional_credit_ceiling: number | null }
interface PaidRow {
  kind: 'image' | 'subtitle' | 'audio' | 'writing'
  label: string
  path: string
  loaded: boolean
  loadError: string
  enabled: boolean
  ceiling: string
  baseline: string
  error: string
}

const { get, put } = useApi()

// ── one row of the throughput table (local so the table stays one component) ──
const PerfRow = defineComponent({
  props: {
    field: { type: Object as PropType<ThroughputField>, required: true },
    value: { type: [String, Number] as PropType<string | number>, required: true },
    open: Boolean,
    disabled: Boolean,
  },
  emits: ['update', 'toggle'],
  setup(props, { emit }) {
    return () => {
      const f = props.field
      const isAuto = props.value === 'auto'
      const recommended = String(props.value) === String(f.recommended)
      const numeric = isAuto ? '' : String(props.value)
      const step = (dir: number) => {
        const base = isAuto ? Number(f.autoSeed ?? f.input.min) : Number(props.value) || f.input.min
        const next = Math.min(f.input.max, Math.max(f.input.min, Math.round((base + dir * f.input.step) * 10) / 10))
        emit('update', next)
      }
      const control = [
        f.allowsAuto ? h('select', {
          class: 'perf-auto', value: isAuto ? 'auto' : 'number', disabled: props.disabled,
          'aria-label': `${f.label}: mode`,
          onChange: (e: Event) => emit('update', (e.target as HTMLSelectElement).value === 'auto' ? 'auto' : Number(f.autoSeed)),
        }, [h('option', { value: 'auto' }, 'Auto'), h('option', { value: 'number' }, 'Number')]) : null,
        !isAuto ? h('span', { class: 'stepper' }, [
          h('button', { type: 'button', class: 'stepper-btn', disabled: props.disabled || Number(props.value) <= f.input.min, 'aria-label': `Lower ${f.label}`, onClick: () => step(-1) }, '−'),
          h('input', {
            type: 'number', class: 'stepper-input', value: numeric, min: f.input.min, max: f.input.max, step: f.input.step,
            disabled: props.disabled, 'aria-label': f.label, 'data-key': f.key,
            onInput: (e: Event) => { const raw = (e.target as HTMLInputElement).value.trim(); emit('update', raw === '' ? '' : Number(raw)) },
          }),
          h('button', { type: 'button', class: 'stepper-btn', disabled: props.disabled || Number(props.value) >= f.input.max, 'aria-label': `Raise ${f.label}`, onClick: () => step(1) }, '+'),
        ]) : null,
        f.unit && !isAuto ? h('span', { class: 'perf-unit' }, f.unit) : null,
      ]
      return [
        h('tr', { class: 'perf-row', 'data-key': f.key }, [
          h('th', { scope: 'row' }, [
            h('span', { class: 'perf-label' }, f.label),
            h('span', { class: 'perf-hint' }, f.hint),
          ]),
          h('td', { class: 'perf-control' }, control),
          h('td', { class: 'perf-rec' }, recommended
            ? h('span', { class: 'rec-mark', title: 'This is the recommended value' }, 'Recommended')
            : h('button', { type: 'button', class: 'rec-use', disabled: props.disabled, onClick: () => emit('update', f.recommended) }, `Recommended: ${f.recommendedLabel ?? f.recommended}`)),
          h('td', { class: 'perf-more-cell' }, h('button', { type: 'button', class: 'perf-more', 'aria-expanded': props.open, onClick: () => emit('toggle') }, props.open ? 'Less' : 'More')),
        ]),
        props.open ? h('tr', { class: 'perf-help-row' }, h('td', { colspan: 4 }, f.help)) : null,
      ]
    }
  },
})

const mainFields = THROUGHPUT_FIELDS.filter(f => !f.advanced)
const advancedFields = THROUGHPUT_FIELDS.filter(f => f.advanced)
const models = reactive<Record<ThroughputKey, string | number>>(Object.fromEntries(THROUGHPUT_FIELDS.map(f => [f.key, f.recommended])) as any)
const baseline = ref('')
const concurrencyLoaded = ref(false)
const concurrencyError = ref('')
const openHelp = ref<ThroughputKey | ''>('')
const paidMoreOpen = ref(false)
const saving = ref(false)
const saveError = ref('')
const savedMessage = ref('')

const paidRows = reactive<PaidRow[]>([
  { kind: 'image', label: 'Images', path: '/app-settings/paid-image-replacement' },
  { kind: 'subtitle', label: 'Subtitle sections', path: '/app-settings/paid-subtitle-replacement' },
  { kind: 'audio', label: 'Audio items', path: '/app-settings/paid-audio-replacement' },
  { kind: 'writing', label: 'Writing items', path: '/app-settings/paid-writing-replacement' },
].map(r => ({ ...r, loaded: false, loadError: '', enabled: false, ceiling: '', baseline: '', error: '' })) as PaidRow[])

const throughputSnapshot = () => JSON.stringify(throughputPayload(models))
const paidSnapshot = (row: PaidRow) => JSON.stringify({ enabled: row.enabled, ceiling: row.enabled ? String(row.ceiling) : '' })
const throughputDirty = computed(() => concurrencyLoaded.value && throughputSnapshot() !== baseline.value)
const paidDirtyRows = computed(() => paidRows.filter(row => row.loaded && paidSnapshot(row) !== row.baseline))
const dirty = computed(() => throughputDirty.value || paidDirtyRows.value.length > 0)

function isPaidSetting(s: PaidSetting): boolean {
  return typeof s?.enabled === 'boolean'
    && (s.enabled ? Number.isSafeInteger(s.additional_credit_ceiling) && (s.additional_credit_ceiling as number) > 0 : s.additional_credit_ceiling === null)
}
function applyPaid(row: PaidRow, s: PaidSetting): void {
  row.enabled = s.enabled
  row.ceiling = s.enabled ? String(s.additional_credit_ceiling) : ''
  row.baseline = paidSnapshot(row)
}
function setPaidEnabled(row: PaidRow, enabled: boolean): void {
  row.enabled = enabled
  row.error = ''
  savedMessage.value = ''
}
function setValue(field: ThroughputField, value: string | number): void {
  models[field.key] = value
  savedMessage.value = ''
}
function toggleHelp(key: ThroughputKey): void { openHelp.value = openHelp.value === key ? '' : key }
function useRecommended(): void {
  for (const f of THROUGHPUT_FIELDS) models[f.key] = f.recommended
  savedMessage.value = 'Recommended numbers filled in — press Save Changes to keep them.'
}
function revert(): void {
  if (baseline.value) Object.assign(models, throughputFromServer(JSON.parse(baseline.value)))
  for (const row of paidRows) {
    if (!row.loaded) continue
    const b = JSON.parse(row.baseline)
    row.enabled = b.enabled
    row.ceiling = b.ceiling
    row.error = ''
  }
  saveError.value = ''
  savedMessage.value = ''
}

async function load(): Promise<void> {
  try {
    Object.assign(models, throughputFromServer(await get<any>('/app-settings/concurrency')))
    baseline.value = throughputSnapshot()
    concurrencyLoaded.value = true
  } catch {
    // Showing defaults here looked like his own numbers, and Save then wrote
    // them over the real ones. Stay unloaded and say so.
    concurrencyError.value = 'Could not read your saved numbers, so they are not shown and cannot be saved. Close and reopen Settings to try again.'
  }
  await Promise.all(paidRows.map(async (row) => {
    try {
      const s = await get<PaidSetting>(row.path)
      if (!isPaidSetting(s)) throw new Error('invalid')
      applyPaid(row, s)
      row.loaded = true
    } catch {
      row.loadError = `Could not load this setting, so it stays as saved and cannot be changed until it loads.`
    }
  }))
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return
  saveError.value = ''
  savedMessage.value = ''
  // Validate everything first: nothing is saved while any row is invalid.
  let invalid = false
  for (const row of paidDirtyRows.value) {
    const n = Number(row.ceiling)
    if (row.enabled && !(Number.isSafeInteger(n) && n > 0)) {
      row.error = 'Enter a positive whole number of additional credits.'
      invalid = true
    }
  }
  if (throughputDirty.value) {
    for (const f of THROUGHPUT_FIELDS) {
      const v = models[f.key]
      if (v === 'auto' && f.allowsAuto) continue
      const n = Number(v)
      if (v === '' || !Number.isFinite(n) || n < f.input.min || n > f.input.max) {
        saveError.value = `${f.label}: choose a number from ${f.input.min} to ${f.input.max}.`
        invalid = true
        break
      }
    }
  }
  if (invalid) { if (!saveError.value) saveError.value = 'Nothing was saved — fix the highlighted row first.'; return }

  saving.value = true
  const done: string[] = []
  try {
    if (throughputDirty.value) {
      // Show what was ACTUALLY applied: the server clamps.
      const applied = await put<any>('/app-settings/concurrency', throughputPayload(models))
      Object.assign(models, throughputFromServer({ ...throughputPayload(models), ...(applied || {}) }))
      baseline.value = throughputSnapshot()
      done.push('job numbers')
    }
    for (const row of paidDirtyRows.value) {
      const saved = await put<PaidSetting>(row.path, {
        enabled: row.enabled,
        additional_credit_ceiling: row.enabled ? Number(row.ceiling) : null,
      })
      if (!isPaidSetting(saved)) throw new Error(`The saved ${row.label.toLowerCase()} setting came back invalid.`)
      applyPaid(row, saved)
      done.push(`${row.label.toLowerCase()} replacement`)
    }
    savedMessage.value = `Saved and in effect now: ${done.join(', ')}.`
  } catch (e: any) {
    saveError.value = `${done.length ? `Saved ${done.join(', ')}; then ` : ''}could not save: ${e?.data?.detail || e?.message || 'unknown error'}`
  } finally {
    saving.value = false
  }
}

onMounted(() => { void load() })
</script>

<style scoped>
.perf { display: grid; gap: 16px; min-width: 0; }
.perf-card { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); min-width: 0; }
.perf-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.perf-card-head h4 { margin: 0 0 4px; font-size: 14px; }
.perf-card-head p { margin: 0; max-width: 760px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.perf-table { width: 100%; border-collapse: collapse; }
.perf-table :deep(th), .perf-table :deep(td), .perf-table th, .perf-table td { padding: 9px 8px; border-top: 1px solid var(--border); text-align: left; vertical-align: middle; }
.perf-table thead th { border-top: 0; color: var(--text-muted); font-size: var(--font-xs); font-weight: 600; }
.perf-table :deep(.perf-label) { display: block; color: var(--text-primary); font-size: 13px; font-weight: 600; }
.perf-table :deep(.perf-hint) { display: block; margin-top: 2px; color: var(--text-muted); font-size: 12px; font-weight: 400; }
.perf-table :deep(.perf-control) { width: 1%; white-space: nowrap; }
.perf-table :deep(.stepper) { display: inline-flex; align-items: center; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; vertical-align: middle; }
.perf-table :deep(.stepper-btn) { width: 28px; height: 30px; border: 0; background: var(--bg-tertiary); color: var(--text-primary); font-size: 15px; cursor: pointer; }
.perf-table :deep(.stepper-btn:disabled) { opacity: .4; cursor: default; }
.perf-table :deep(.stepper-input) { width: 64px; height: 30px; border: 0; border-inline: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); text-align: center; font: inherit; -moz-appearance: textfield; }
.perf-table :deep(.stepper-input::-webkit-inner-spin-button) { -webkit-appearance: none; }
.perf-table :deep(.perf-auto) { margin-right: 6px; height: 32px; }
.perf-table :deep(.perf-unit) { margin-left: 6px; color: var(--text-muted); font-size: 12px; }
.perf-table :deep(.perf-rec) { width: 1%; white-space: nowrap; }
.perf-table :deep(.rec-mark) { color: var(--success); font-size: var(--font-xs); }
.perf-table :deep(.rec-use) { padding: 0; border: 0; background: none; color: var(--text-muted); font-size: var(--font-xs); text-decoration: underline dotted; cursor: pointer; }
.perf-table :deep(.perf-more-cell) { width: 1%; text-align: right; }
.perf-more, .perf-table :deep(.perf-more) { padding: 0; border: 0; background: none; color: var(--accent); font-size: 12px; cursor: pointer; }
.perf-table :deep(.perf-help-row td) { border-top: 0; padding-top: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.perf-more-text { margin-top: 6px !important; color: var(--text-secondary) !important; }
.paid-table th[scope="row"] { color: var(--text-primary); font-size: 13px; font-weight: 600; width: 28%; }
.segmented { display: inline-flex; padding: 2px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-tertiary); }
.segmented label { display: inline-flex; align-items: center; padding: 4px 12px; border-radius: 4px; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.segmented label.active { background: var(--accent); color: var(--accent-on); }
.segmented input { position: absolute; opacity: 0; width: 1px; height: 1px; pointer-events: none; }
.segmented { position: relative; }
.ceiling { display: inline-flex; align-items: center; gap: 6px; color: var(--text-muted); font-size: 12px; }
.ceiling input { width: 90px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font: inherit; }
.perf-muted { color: var(--text-muted); font-size: 12px; }
.perf-row-error { display: block; margin-top: 4px; color: var(--error); font-size: 12px; }
.perf-error { color: var(--error); font-size: 12px; margin: 0; }
.perf-save-bar {
  position: sticky; bottom: 10px; z-index: 3; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
}
.perf-save-bar.dirty { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.perf-save-state { flex: 1 1 auto; color: var(--text-secondary); font-size: 12px; }
</style>
