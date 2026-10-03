<template>
  <!-- Help under a control: one visible sentence, the rest behind "More".
       Pages stop being walls of text, and nothing is hidden in a tooltip —
       the first line always says what the control does.

       Usage:
         <HelpText>Retries a failed image once on the paid service.</HelpText>
         <HelpText>
           Retries a failed image once on the paid service.
           <template #more>It never runs twice for the same scene, and it is skipped when you have no credits.</template>
         </HelpText>
         <HelpText text="Short line." more="Longer explanation…" /> -->
  <p class="hint ds-help" :id="id">
    <slot>{{ text }}</slot>
    <template v-if="hasMore">
      <span v-if="expanded" class="ds-help-more">{{ ' ' }}<slot name="more">{{ more }}</slot></span>
      {{ ' ' }}<button
        type="button"
        class="link-btn ds-help-toggle"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >{{ expanded ? 'Less' : 'More' }}</button>
    </template>
  </p>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from 'vue'

const props = withDefaults(defineProps<{
  text?: string
  more?: string
  id?: string
}>(), { text: '', more: '', id: undefined })

const slots = useSlots()
const expanded = ref(false)
const hasMore = computed(() => Boolean(props.more || slots.more))
</script>
