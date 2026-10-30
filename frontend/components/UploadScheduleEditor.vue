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
        <label :class="{ active: draft.mode === 'random' }"><input v-model="draft.mode" type="radio" value="random" :disabled="disabled" /> Random days</label>
        <label :class="{ active: draft.mode === 'weekly' }"><input v-model="draft.mode" type="radio" value="weekly" :disabled="disabled" /> Weekly days</label>
        <label :class="{ active: draft.mode === 'monthly' }"><input v-model="draft.mode" type="radio" value="monthly" :disabled="disabled" /> Monthly</label>
      </div>
    </div>

    <!-- The default every channel starts on (2026-10-31): three a week on days
         that are never back to back, each at a random time of day. -->
    <div v-if="draft.mode === 'random'" class="se-field">
      <span>Videos a week</span>
      <p class="se-note">
        {{ draft.perWeek }} a week, on days that are never back to back, each at a random time of day.
        The days and the time are drawn once and then stay with the episode.
      </p>
      <div class="se-row">
        <label class="se-field"><span>Random time between</span><input v-model="draft.windowStart" type="time" step="300" required :disabled="disabled" /></label>
        <label class="se-field"><span>and</span><input v-model="draft.windowEnd" type="time" step="300" required :disabled="disabled" /></label>
        <label class="se-field se-tz"><span>Time zone</span><select v-model="draft.timezone" :disabled="disabled">
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone.replace(/_/g, ' ') }}</option>
        </select></label>
      </div>
      <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="draft.mode = 'weekly'">Choose My Own Days and Times…</button>
    </div>

    <div v-else-if="draft.mode === 'weekly'" class="se-field">
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
          @click="draft.weekdays = toggled(draft.weekdays, day.value)"
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
      <label v-else-if="draft.mode === 'monthly'" class="se-field">
        <span>Day of month</span>
        <input v-model.number="draft.monthlyDay" type="number" min="1" max="31" :disabled="disabled" />
      </label>
      <label v-if="draft.mode === 'monthly'" class="se-field">
        <span>Time of day</span>
        <input v-model="draft.timeLocal" type="time" required :disabled="disabled" />
      </label>
      <label v-if="draft.mode === 'weekly'" class="se-field se-tz">
        <span>Time zone</span>
        <select v-model="draft.timezone" :disabled="disabled">
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone.replace(/_/g, ' ') }}</option>
        </select>
      </label>
    </div>

    <!-- The customer's own times of day: two times a day is 14 a week on 7 days. -->
    <div v-if="draft.mode === 'weekly'" class="se-field">
      <span>Times of day</span>
      <div class="se-times">
        <div v-for="(time, index) in draft.timesLocal" :key="index" class="se-time">
          <input v-model="draft.timesLocal[index]" type="time" required :disabled="disabled" />
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            :disabled="disabled || draft.timesLocal.length < 2"
            @click="draft.timesLocal.splice(index, 1)"
          >Remove</button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" :disabled="disabled" @click="addTime">Add Another Time</button>
      </div>
      <p class="se-note">{{ weeklyCount }} {{ weeklyCount === 1 ? 'video' : 'videos' }} a week.</p>
    </div>

    <div v-if="showDates" class="se-row">
      <label class="se-field"><span>Starts on (optional)</span><input v-model="draft.startDate" type="date" :disabled="disabled" /></label>
      <label class="se-field"><span>Ends on (optional)</span><input v-model="draft.endDate" type="date" :disabled="disabled" /></label>
    </div>

    <!-- v1.4.268: "then from <date>: <days> at <time>" — a later rhythm on the same plan. -->
    <template v-if="showDates && draft.mode !== 'random'">
      <fieldset v-for="(phase, index) in draft.phases" :key="index" class="se-phase">
        <legend>Then from {{ phase.startDate || '…' }}</legend>
        <div class="se-row">
          <label class="se-field"><span>Starts on</span><input v-model="phase.startDate" type="date" required :disabled="disabled" /></label>
          <label class="se-field"><span>Time of day</span><input v-model="phase.timeLocal" type="time" required :disabled="disabled" /></label>
          <label class="se-field"><span>Ends on (optional)</span><input v-model="phase.endDate" type="date" :disabled="disabled" /></label>
        </div>
        <div class="se-days" :aria-label="`Days from ${phase.startDate || 'the later date'}`">
          <button
            v-for="day in WEEKDAYS"
            :key="day.value"
            type="button"
            class="se-day"
            :class="{ on: phase.weekdays.includes(day.value) }"
            :aria-pressed="phase.weekdays.includes(day.value)"
            :disabled="disabled"
            @click="phase.weekdays = toggled(phase.weekdays, day.value)"
          >{{ day.label }}</button>
        </div>
        <button type="button" class="btn btn-ghost btn-sm se-remove" :disabled="disabled" @click="draft.phases.splice(index, 1)">Remove This Change</button>
      </fieldset>
      <button
        v-if="!draft.phases.length"
        type="button"
        class="btn btn-ghost btn-sm se-add"
        :disabled="disabled"
        @click="draft.phases.push({ startDate: '', endDate: '', weekdays: [...draft.weekdays], timeLocal: draft.timeLocal })"
      >Change the Schedule From a Later Date…</button>
    </template>

    <p class="se-maths">
      <template v-if="perMonth">About <strong>{{ perMonth }}</strong> {{ perMonth === 1 ? 'episode' : 'episodes' }} a month.</template>
      <template v-else-if="draft.mode === 'random'">Three a week, on days that are never back to back.</template>
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

/** Starting times for a second slot a day — the customer changes them. */
// model-drift-allow: clock times for a publishing slot; no model is involved
const TIME_SUGGESTIONS = ['20:00', '09:00', '14:00', '12:00', '18:00', '10:00', '16:00']

const intervalChoices = computed(() => {
  const base = [1, 2, 3, 4]
  return base.includes(draft.value.intervalWeeks) ? base : [...base, draft.value.intervalWeeks].sort((a, b) => a - b)
})
const zones = computed(() => timezoneOptions(draft.value.timezone))
const perMonth = computed(() => {
  const result = scheduleFromDraft({ ...draft.value, name: draft.value.name || 'x' })
  return result.ok ? episodesPerMonth(result.schedule) : 0
})
const weeklyCount = computed(() => draft.value.weekdays.length * Math.max(1, draft.value.timesLocal.length))

function toggled(days: number[], day: number): number[] {
  return (days.includes(day) ? days.filter(d => d !== day) : [...days, day]).sort((a, b) => a - b)
}

function addTime(): void {
  const used = new Set(draft.value.timesLocal)
  draft.value.timesLocal.push(TIME_SUGGESTIONS.find(time => !used.has(time)) || '12:00')
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
.se-times { display: grid; gap: 8px; justify-items: start; }
.se-time { display: flex; gap: 8px; align-items: center; }
.se-note { margin: 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.se-phase { display: grid; gap: 10px; min-width: 0; margin: 0; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; }
.se-phase legend { padding: 0 4px; color: var(--text-secondary); font-size: 12px; font-weight: 600; }
.se-remove, .se-add { justify-self: start; }
.se-maths { margin: 0; color: var(--text-muted); font-size: 12px; }
@media (max-width: 700px) { .se-tz { grid-column: auto; } }
</style>
