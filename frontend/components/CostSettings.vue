<template>
  <section class="perf-card cost-settings" data-setting="cost" aria-labelledby="perf-cost-title">
    <header class="perf-card-head">
      <div>
        <h4 id="perf-cost-title">Electricity and Mac power (cost estimates)</h4>
        <p>
          The episode cost report estimates local compute from how long a job ran and how much power its Mac drew.
          These figures are estimates, not measured consumption — change them to match your tariff and your Macs.
        </p>
      </div>
    </header>

    <p v-if="loadError" class="cost-error" role="alert">{{ loadError }}</p>
    <p v-else-if="!loaded" class="cost-worked">Loading cost settings…</p>
    <template v-else>
      <table class="cost-table">
        <tbody>
          <tr>
            <th scope="row">
              <span class="cost-label">Electricity price</span>
              <span class="cost-hint">Default 720 KHR per kWh (about US$0.18).</span>
            </th>
            <td>
              <input
                v-model.number="electricityKhr"
                class="input cost-input"
                type="number" min="0" step="1" inputmode="numeric"
                aria-label="Electricity price in KHR per kWh"
                :disabled="saving"
              />
              <span class="cost-unit">KHR / kWh</span>
              <span class="cost-conversion">≈ {{ usdPerKwh }}</span>
            </td>
          </tr>
          <tr>
            <th scope="row">
              <span class="cost-label">Exchange rate</span>
              <span class="cost-hint">Used only to show the local cost in dollars.</span>
            </th>
            <td>
              <input
                v-model.number="khrPerUsd"
                class="input cost-input"
                type="number" min="1" step="1" inputmode="numeric"
                aria-label="Exchange rate in riel per US dollar"
                :disabled="saving"
              />
              <span class="cost-unit">KHR / USD</span>
            </td>
          </tr>
          <tr v-for="cls in classes" :key="cls.key">
            <th scope="row">
              <span class="cost-label">{{ cls.label }}</span>
              <span class="cost-hint">{{ cls.hint }}</span>
            </th>
            <td>
              <input
                v-model.number="watts[cls.key]"
                class="input cost-input"
                type="number" min="0" step="1" inputmode="decimal"
                :aria-label="`${cls.label}: estimated power draw in watts`"
                :disabled="saving"
              />
              <span class="cost-unit">W (estimate)</span>
            </td>
          </tr>
        </tbody>
      </table>

      <p class="cost-worked" role="status">
        A one-hour job on the default {{ watts['mac-mini'] }} W Mac mini costs about
        {{ workedExample }} in electricity at this price.
      </p>

      <div class="cost-save-bar" :class="{ dirty }">
        <span class="cost-save-state" aria-live="polite">
          <template v-if="saveError"><span class="cost-error">{{ saveError }}</span></template>
          <template v-else-if="savedMessage">{{ savedMessage }}</template>
          <template v-else>{{ dirty ? 'You have unsaved changes.' : 'All changes saved.' }}</template>
        </span>
        <button class="btn btn-ghost btn-sm" type="button" :disabled="!dirty || saving" @click="revert">Revert</button>
        <button class="btn btn-primary btn-sm" type="button" :disabled="!dirty || saving" @click="save">
          {{ saving ? 'Saving…' : 'Save Changes' }}
        </button>
      </div>
    </template>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

interface CostSettingsPayload {
  electricity_khr_per_kwh: number
  khr_per_usd: number
  mac_power_watts: Record<string, number>
}

const { get, put } = useApi()

const classes = [
  { key: 'mac-mini', label: 'Mac mini', hint: 'Under a render load.' },
  { key: 'mac-studio', label: 'Mac Studio', hint: 'Under a render load.' },
  { key: 'macbook-pro', label: 'MacBook Pro', hint: 'Under a render load, on the charger.' },
  { key: 'mac-pro', label: 'Mac Pro', hint: 'Under a render load.' },
  { key: 'default', label: 'Any other Mac', hint: 'Used when the Mac model is not known.' },
]

const loaded = ref(false)
const loadError = ref('')
const electricityKhr = ref<number | string>(720)
const khrPerUsd = ref<number | string>(4000)
const watts = reactive<Record<string, number | string>>({
  'mac-mini': 35, 'mac-studio': 85, 'macbook-pro': 50, 'mac-pro': 150, default: 45,
})
const baseline = ref('')
const saving = ref(false)
const saveError = ref('')
const savedMessage = ref('')

const snapshot = computed(() => JSON.stringify({
  electricity_khr_per_kwh: Number(electricityKhr.value),
  khr_per_usd: Number(khrPerUsd.value),
  mac_power_watts: Object.fromEntries(classes.map(c => [c.key, Number(watts[c.key])])),
}))
const dirty = computed(() => loaded.value && baseline.value !== '' && snapshot.value !== baseline.value)

const usdPerKwh = computed(() => {
  const rate = Number(khrPerUsd.value)
  const price = Number(electricityKhr.value)
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(price)) return '—'
  // model-drift-allow: formats a charge the Gateway already recorded, or an owner-entered electricity price, in US dollars; no catalogue price
  return `US$${(price / rate).toFixed(3)} / kWh`
})

const workedExample = computed(() => {
  const mini = Number(watts['mac-mini'])
  const price = Number(electricityKhr.value)
  const rate = Number(khrPerUsd.value)
  if (!Number.isFinite(mini) || !Number.isFinite(price) || !Number.isFinite(rate) || rate <= 0) return '—'
  const kwh = mini / 1000
  const khr = kwh * price
  return `${Math.round(khr)} KHR (US$${(khr / rate).toFixed(2)})`
})

function apply(payload: CostSettingsPayload): void {
  electricityKhr.value = payload.electricity_khr_per_kwh
  khrPerUsd.value = payload.khr_per_usd
  for (const c of classes) {
    const v = payload.mac_power_watts?.[c.key]
    if (typeof v === 'number') watts[c.key] = v
  }
  baseline.value = snapshot.value
}

async function load(): Promise<void> {
  try {
    const payload = await get<CostSettingsPayload>('/app-settings/cost')
    if (typeof payload?.electricity_khr_per_kwh !== 'number' || typeof payload?.khr_per_usd !== 'number') throw new Error('invalid')
    apply(payload)
    loaded.value = true
  } catch {
    loadError.value = 'Could not read the saved cost settings, so they are not shown and cannot be changed. Close and reopen Settings to try again.'
  }
}

function revert(): void {
  if (baseline.value) apply(JSON.parse(baseline.value) as CostSettingsPayload)
  saveError.value = ''
  savedMessage.value = ''
}

async function save(): Promise<void> {
  if (!dirty.value || saving.value) return
  saveError.value = ''
  savedMessage.value = ''
  const price = Number(electricityKhr.value)
  const rate = Number(khrPerUsd.value)
  if (!Number.isFinite(price) || price < 0) { saveError.value = 'Electricity price must be zero or more.'; return }
  if (!Number.isFinite(rate) || rate <= 0) { saveError.value = 'Exchange rate must be more than zero.'; return }
  for (const c of classes) {
    const v = Number(watts[c.key])
    if (!Number.isFinite(v) || v < 0) { saveError.value = `${c.label} power must be zero or more.`; return }
  }
  saving.value = true
  try {
    const payload = await put<CostSettingsPayload>('/app-settings/cost', {
      electricity_khr_per_kwh: price,
      khr_per_usd: rate,
      mac_power_watts: Object.fromEntries(classes.map(c => [c.key, Number(watts[c.key])])),
    })
    apply(payload)
    savedMessage.value = 'Saved. Episode costs re-read these figures.'
  } catch (e: any) {
    saveError.value = e?.data?.detail || e?.message || 'Could not save the cost settings.'
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.cost-settings { display: grid; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary); min-width: 0; }
.cost-settings h4 { margin: 0 0 4px; font-size: 14px; }
.cost-settings header p { margin: 0; max-width: 760px; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.cost-table { width: 100%; border-collapse: collapse; }
.cost-table th, .cost-table td { padding: 9px 8px; border-top: 1px solid var(--border); text-align: left; vertical-align: middle; }
.cost-table th[scope='row'] { width: 44%; font-weight: 600; }
.cost-label { display: block; font-size: 13px; }
.cost-hint { display: block; margin-top: 2px; font-size: 12px; font-weight: 400; }
.cost-input { width: 110px; }
.cost-unit { margin-left: 6px; color: var(--text-secondary); font-size: var(--font-xs); }
.cost-conversion { margin-left: 8px; color: var(--text-muted); font-size: var(--font-xs); }
.cost-worked { margin: 10px 0 0; color: var(--text-muted); font-size: 12px; }
.cost-save-bar {
  position: sticky; bottom: 10px; z-index: 3; display: flex; align-items: center; gap: 8px;
  padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg-secondary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
}
.cost-save-bar.dirty { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.cost-save-state { flex: 1 1 auto; color: var(--text-secondary); font-size: 12px; }
.cost-error { color: var(--error); font-size: 12px; margin: 0; }
</style>
