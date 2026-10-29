<template>
  <div v-if="control" class="form-group delivery-instruction">
    <label :for="fieldId">
      {{ control.label }}
      <span class="field-hint">— how the words should be read, in your own words</span>
    </label>
    <textarea
      :id="fieldId"
      class="input delivery-instruction-text"
      rows="3"
      :maxlength="control.max_length ?? undefined"
      :value="modelValue"
      @input="onInput"
    ></textarea>
    <p class="text-muted text-xs hint-line">
      Optional.
      <template v-if="control.max_length !== null">
        <strong>{{ count.toLocaleString() }}</strong> / {{ control.max_length.toLocaleString() }} characters ·
      </template>
      Sent to {{ modelName || 'the selected model' }} as its own delivery instruction. Empty keeps the
      model's plain reading, and nothing is sent.
    </p>

    <!-- Only what the Gateway published for THIS model. No example, language
         rule, event syntax or link is written here: a model that publishes no
         guidance shows the box alone. -->
    <div v-if="guidance" class="delivery-guidance">
      <p class="text-muted text-xs hint-line">
        <strong>{{ modelName || 'This model' }}'s own guidance</strong><template v-if="guidance.kind || guidance.engineForm"> (
          <template v-if="guidance.kind">{{ guidance.kind }}</template>
          <template v-if="guidance.kind && guidance.engineForm"> · </template>
          <template v-if="guidance.engineForm">applied as {{ guidance.engineForm }}</template>
        )</template>
        — published by the Gateway, printed as published.
      </p>
      <p v-if="guidance.text" class="delivery-guidance-text">{{ guidance.text }}</p>
      <div v-if="guidance.examples.length" class="delivery-guidance-block">
        <p class="delivery-guidance-label">Example instructions</p>
        <ul class="delivery-guidance-list">
          <li v-for="(example, index) in guidance.examples" :key="`example-${index}`">{{ example }}</li>
        </ul>
      </div>
      <p v-if="guidance.languageRule" class="delivery-guidance-block">
        <span class="delivery-guidance-label">Language</span> {{ guidance.languageRule }}
      </p>
      <div v-if="guidance.inlineEvents.length" class="delivery-guidance-block">
        <p class="delivery-guidance-label">Inline vocal events</p>
        <ul class="delivery-guidance-list">
          <li v-for="(event, index) in guidance.inlineEvents" :key="`event-${index}`">
            <code v-if="event.syntax">{{ event.syntax }}</code>
            <template v-if="event.syntax && event.meaning"> — </template>
            <template v-if="event.meaning">{{ event.meaning }}</template>
            <span v-if="event.where" class="text-muted"> ({{ event.where }})</span>
          </li>
        </ul>
        <p class="text-muted text-xs hint-line">
          These are written by hand in the box above. Story Studio never inserts them into a script.
        </p>
      </div>
      <p v-if="guidance.note" class="text-muted text-xs hint-line">{{ guidance.note }}</p>
      <p v-if="guidance.sourceUrl" class="text-muted text-xs hint-line">
        Source:
        <a :href="guidance.sourceUrl" target="_blank" rel="noopener noreferrer">{{ guidance.sourceUrl }}</a>
      </p>
    </div>
  </div>
</template>

<script lang="ts">
/** Module scope, so each instance gets its own label-id prefix. */
let panels = 0
</script>

<script setup lang="ts">
/**
 * The optional "Delivery / emotion" direction for narration, drawn from the
 * selected model's OWN published control (owner, 2026-10-29).
 *
 * Everything shown here is published by the Gateway for that model: the label,
 * the character limit, and the guidance (free text, example instructions, a
 * language rule, the inline vocal events the engine accepts and the source
 * link). A model that publishes no guidance shows the box alone — there is no
 * fallback text, no example and no limit of Story Studio's own, and there is no
 * app-wide list of emotions anywhere.
 *
 * The parent decides whether the control is published at all; this component
 * only draws it and reports what was typed.
 */
import type { GenStudioDeliveryInstructionControl } from '~/utils/tts-controls'

const props = defineProps<{
  /** The selected model's published delivery/emotion control, or null when it publishes none. */
  control: GenStudioDeliveryInstructionControl | null
  /** What the customer typed. Resolved against the published limit by the page before sending. */
  modelValue: string
  /** For the wording only — the Gateway's own display name for the model. */
  modelName?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const fieldId = `delivery-instruction-${++panels}`

const guidance = computed(() => props.control?.guidance ?? null)

/** Counted in code points, the way the Gateway counts the limit. */
const count = computed(() => Array.from(props.modelValue).length)

function onInput(event: Event): void {
  emit('update:modelValue', (event.target as HTMLTextAreaElement).value)
}
</script>

<style scoped>
.hint-line { margin-top: 4px; }

.delivery-instruction-text {
  resize: vertical;
  min-height: 72px;
}

.delivery-guidance {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-subtle, var(--border));
  border-radius: var(--radius-sm, 6px);
  background: var(--surface-sunken, transparent);
}

.delivery-guidance-text {
  margin: 4px 0 0;
  font-size: var(--font-sm, 0.875rem);
}

.delivery-guidance-block { margin-top: 8px; }

.delivery-guidance-label {
  margin: 0;
  font-size: var(--font-xs, 0.75rem);
  font-weight: 600;
  color: var(--text-secondary);
}

.delivery-guidance-list {
  margin: 4px 0 0;
  padding-left: 18px;
  font-size: var(--font-sm, 0.875rem);
}

.delivery-guidance-list code {
  font-family: var(--font-mono, monospace);
  font-size: var(--font-xs, 0.75rem);
}
</style>
