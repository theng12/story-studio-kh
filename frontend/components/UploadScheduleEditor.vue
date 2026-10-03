<template>
  <!-- The one upload-schedule editor, used by Settings → Publishing and by
       Upload Center → Plans (v1.4.249). Both edit the same plan. -->
  <div class="schedule-editor">
    <label v-if="showName" class="se-field se-name">
      <span>Plan name</span>
      <input v-model="draft.name" required maxlength="120" autocomplete="off" placeholder="Weekly uploads" :disabled="disabled" />
    </label>

    <div class="se-field">
      <span>Repeats</span>
      <div class="se-mode" role="radiogroup" aria-label="Repeats">
        <label :class="{ active: draft.mode === 'weekly' }"><input v-model="draft.mode" type="radio" value="weekly" :disabled="disabled" /> Weekly</label>
        <label :class="{ active: draft.mode === 'monthly' }"><input v-model="draft.mode" type="radio" value="monthly" :disabled="disabled" /> Monthly</label>
      </div>
    </div>

    <div v-if="draft.mode === 'weekly'" class="se-field">
      <span>Days</span>
      <div class="se-days" aria-label="Weekly days">
        <button
          v-for="day in WEEKDAYS"
          :key="day.value"
          type="button"
          class="se-day"
          :class="{ on: draft.weekdays.includes(day.value) }"
          :aria-pressed="draft.weekdays.includes(day.value)"
          :disabled="disabled"
          @click="toggleDay(day.value)"
        >{{ day.label }}</button>
      </div>
    </div>

    <div class="se-row">
      <label v-if="draft.mode === 'weekly'" class="se-field">
        <span>Every</span>
        <select v-model.number="draft.intervalWeeks" :disabled="disabled">
          <option v-for="n in intervalChoices" :key="n" :value="n">{{ n === 1 ? 'week' : `${n} weeks` }}</option>
        </select>
      </label>
      <label v-else class="se-field">
        <span>Day of month</span>
        <input v-model.number="draft.monthlyDay" type="number" min="1" max="31" :disabled="disabled" />
      </label>
      <label class="se-field">
        <span>Time of day</span>
        <input v-model="draft.timeLocal" type="time" required :disabled="disabled" />
      </label>
      <label class="se-field se-tz">
        <span>Time zone</span>
        <select v-model="draft.timezone" :disabled="disabled">
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone.replace(/_/g, ' ') }}</option>
        </select>
      </label>
    </div>

    <div v-if="showDates" class="se-row">
      <label class="se-field"><span>Starts on (optional)</span><input v-model="draft.startDate" type="date" :disabled="disabled" /></label>
      <label class="se-field"><span>Ends on (optional)</span><input v-model="draft.endDate" type="date" :disabled="disabled" /></label>
    </div>

    <p class="se-maths">
      <template v-if="perMonth">About <strong>{{ perMonth }}</strong> {{ perMonth === 1 ? 'episode' : 'episodes' }} a month.</template>
      <template v-else>Pick at least one day — a schedule with no days never produces a slot.</template>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { WEEKDAYS, episodesPerMonth, scheduleFromDraft, timezoneOptions, type ScheduleDraft } from '~/utils/uploadPlanDraft'

const draft = defineModel<ScheduleDraft>({ required: true })
withDefaults(defineProps<{ disabled?: boolean; showName?: boolean; showDates?: boolean }>(), {
  disabled: false, showName: true, showDates: true,
})

const intervalChoices = computed(() => {
  const base = [1, 2, 3, 4]
  return base.includes(draft.value.intervalWeeks) ? base : [...base, draft.value.intervalWeeks].sort((a, b) => a - b)
})
const zones = computed(() => timezoneOptions(draft.value.timezone))
const perMonth = computed(() => {
  const result = scheduleFromDraft({ ...draft.value, name: draft.value.name || 'x' })
  return result.ok ? episodesPerMonth(result.schedule) : 0
})

function toggleDay(day: number): void {
  const next = draft.value.weekdays.includes(day)
    ? draft.value.weekdays.filter(d => d !== day)
    : [...draft.value.weekdays, day]
  draft.value.weekdays = next.sort((a, b) => a - b)
}
</script>

<style scoped>
.schedule-editor { display: grid; gap: 12px; min-width: 0; }
.se-field { display: grid; gap: 5px; min-width: 0; }
.se-field > span { color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.se-field input, .se-field select {
  min-width: 0; padding: 7px 9px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-primary); color: var(--text-primary); font: inherit; font-size: 13px;
}
.se-name input { max-width: 420px; }
.se-mode { display: inline-flex; justify-self: start; padding: 2px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-tertiary); position: relative; }
.se-mode label { padding: 4px 12px; border-radius: 4px; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.se-mode label.active { background: var(--accent); color: var(--accent-on); }
.se-mode input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.se-days { display: flex; flex-wrap: wrap; gap: 6px; }
.se-day {
  min-width: 46px; padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px;
  background: var(--bg-primary); color: var(--text-secondary); font: inherit; font-size: 12px; cursor: pointer;
}
.se-day.on { border-color: var(--accent); background: var(--accent); color: var(--accent-on); font-weight: 600; }
.se-day:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.se-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.se-tz { grid-column: span 2; }
.se-maths { margin: 0; color: var(--text-muted); font-size: 12px; }
@media (max-width: 700px) { .se-tz { grid-column: auto; } }
</style>
