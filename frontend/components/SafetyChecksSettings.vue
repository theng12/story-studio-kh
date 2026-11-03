<template>
  <div class="safety-checks">
    <header class="settings-card-head">
      <h3>Safety checks</h3>
      <p>
        Every check that can stop an episode, with one switch each, for this channel.
        <strong>Off</strong>: Story fixes it or carries on, and writes it in the job log.
        <strong>Warn</strong>: Story carries on and puts a warning on the job.
        <strong>Block</strong>: Story stops that episode until it is fixed.
        A few checks are fixed; each one says why.
      </p>
    </header>
    <p v-if="loadError" class="safety-error" role="alert">{{ loadError }}</p>
    <template v-for="group in groups" :key="group.name">
      <fieldset>
        <legend>{{ group.name }}</legend>
        <template v-for="check in group.checks" :key="check.id">
          <div class="safety-row" :data-testid="`safety-${check.id}`">
            <div class="safety-text">
              <span class="safety-name">{{ check.name }}</span>
              <span class="hint">{{ check.protects }}</span>
            </div>
            <span v-if="check.locked" class="safety-fixed" :title="check.locked_reason">{{ labels[check.locked] }} (fixed)<br><small>{{ check.locked_reason }}</small></span>
            <select v-else v-model="modes[check.id]" class="input" :aria-label="check.name" :disabled="saving" @change="save(check.id)">
              <option value="off">Off{{ check.default === 'off' ? ' (default)' : '' }}</option>
              <option value="warn">Warn{{ check.default === 'warn' ? ' (default)' : '' }}</option>
              <option value="block">Block{{ check.default === 'block' ? ' (default)' : '' }}</option>
            </select>
          </div>
          <div v-if="check.id === 'final_check'" class="safety-row" data-testid="safety-silence-min-sec">
            <div class="safety-text">
              <span class="safety-name">Flag narration silence longer than</span>
              <span class="hint">Silences up to this many seconds inside the speech are accepted; longer ones are flagged. The default is 10.</span>
            </div>
            <span class="safety-value">
              <input v-model.number="silenceMinSec" type="number" class="input" min="1" max="300" step="1"
                aria-label="Flag narration silence longer than, in seconds" :disabled="saving" @change="saveSilence">
              <span class="hint">seconds</span>
            </span>
          </div>
        </template>
      </fieldset>
    </template>
    <div v-if="checks.length" class="row">
      <button class="btn btn-secondary btn-sm" :disabled="saving" data-testid="safety-apply-all" @click="applyToAll">Apply These to All Channels</button>
      <button class="btn btn-sm" :disabled="saving" @click="resetDefaults">Back to Defaults</button>
    </div>
    <p v-if="result" class="hint" role="status">{{ result }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '~/composables/useApi'
import { useConfirm } from '~/composables/useConfirm'

type Mode = 'off' | 'warn' | 'block'
interface Check { id: string; group: string; name: string; protects: string; default: Mode; locked?: Mode; locked_reason?: string; mode: Mode }
const labels: Record<Mode, string> = { off: 'Off', warn: 'Warn', block: 'Block' }

const props = defineProps<{ slug: string }>()
const { get, put, post } = useApi()
const { ask } = useConfirm()
const checks = ref<Check[]>([])
const modes = ref<Record<string, Mode>>({})
/** The channel's narration-silence threshold in seconds; the server sends the one in force. */
const silenceMinSec = ref(10)
const loadError = ref('')
const saving = ref(false)
const result = ref('')

const groups = computed(() => {
  const out: { name: string; checks: Check[] }[] = []
  for (const check of checks.value) {
    let group = out.find(g => g.name === check.group)
    if (!group) out.push(group = { name: check.group, checks: [] })
    group.checks.push(check)
  }
  return out
})

const message = (error: any, fallback: string) => error?.data?.detail || error?.message || fallback

async function load() {
  loadError.value = ''
  try {
    const data = await get<{ checks: Check[]; silence_min_sec?: number }>(`/projects/${props.slug}/safety-checks`)
    checks.value = data.checks
    modes.value = Object.fromEntries(data.checks.map(check => [check.id, check.mode]))
    silenceMinSec.value = data.silence_min_sec ?? 10
  } catch (error) {
    loadError.value = message(error, 'Could not load the safety checks.')
  }
}

async function saveSilence() {
  saving.value = true
  result.value = ''
  try {
    await put(`/projects/${props.slug}/safety-checks`, { silence_min_sec: silenceMinSec.value })
    result.value = 'Saved for this channel.'
    await load()
  } catch (error) {
    result.value = message(error, 'Could not save.')
    await load()
  } finally {
    saving.value = false
  }
}

async function save(id: string) {
  saving.value = true
  result.value = ''
  try {
    await put(`/projects/${props.slug}/safety-checks`, { modes: { [id]: modes.value[id] } })
    result.value = 'Saved for this channel.'
  } catch (error) {
    result.value = message(error, 'Could not save.')
    await load()
  } finally {
    saving.value = false
  }
}

const switchable = () => Object.fromEntries(checks.value.filter(check => !check.locked).map(check => [check.id, modes.value[check.id]]))

async function applyToAll() {
  if (!await ask({ title: 'Apply to all channels?', message: 'Every channel on this Mac gets the switches shown here.', confirmLabel: 'Apply to All', danger: false })) return
  saving.value = true
  try {
    const data = await post<{ applied: string[] }>('/safety-checks/apply-to-all', { modes: switchable(), silence_min_sec: silenceMinSec.value })
    result.value = `Applied to ${data.applied.length} channel(s).`
  } catch (error) {
    result.value = message(error, 'Could not apply to all channels.')
  } finally {
    saving.value = false
  }
}

async function resetDefaults() {
  saving.value = true
  try {
    const defaults = Object.fromEntries(checks.value.filter(check => !check.locked).map(check => [check.id, check.default]))
    await put(`/projects/${props.slug}/safety-checks`, { modes: defaults, silence_min_sec: 10 })
    await load()
    result.value = 'This channel is back to the defaults.'
  } catch (error) {
    result.value = message(error, 'Could not reset.')
  } finally {
    saving.value = false
  }
}

watch(() => props.slug, load, { immediate: true })
</script>

<style scoped>
fieldset { border: 0; border-top: 1px solid var(--border); padding: 12px 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
legend { font-weight: 600; padding: 0; margin-bottom: 4px; }
.safety-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.safety-text { display: flex; flex-direction: column; min-width: 0; flex: 1 1 260px; }
.safety-name { font-weight: 500; }
.safety-fixed { color: var(--text-secondary); font-size: var(--font-sm); max-width: 320px; text-align: right; }
select.input { width: 160px; max-width: 100%; }
.safety-value { display: flex; align-items: center; gap: 6px; }
.safety-value input.input { width: 88px; }
.row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
.hint { color: var(--text-secondary); font-size: var(--font-sm); margin: 0; overflow-wrap: anywhere; }
.safety-error { color: var(--error, #ff9696); }
.settings-card-head h3 { margin: 0 0 6px; }
.settings-card-head p { margin: 0 0 12px; color: var(--text-secondary); font-size: var(--font-sm); line-height: 1.5; }
</style>
