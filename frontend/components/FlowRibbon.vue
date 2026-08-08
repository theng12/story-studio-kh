<template>
  <nav v-if="currentStep" class="flow-ribbon" aria-label="Production workflow">
    <NuxtLink
      v-if="previousStep"
      :to="routeFor(previousStep)"
      class="flow-direction flow-previous"
      :title="`Previous: ${previousStep.label}`"
    >
      <span aria-hidden="true">←</span>
      <span><small>Previous</small><strong>{{ previousStep.label }}</strong></span>
    </NuxtLink>
    <span v-else class="flow-direction flow-placeholder" aria-hidden="true" />

    <div class="flow-current" aria-current="step">
      <span>Step {{ currentIndex }} of {{ steps.length }}</span>
      <strong>{{ currentStep.label }}</strong>
    </div>

    <NuxtLink
      v-if="nextStep"
      :to="routeFor(nextStep)"
      class="flow-direction flow-next"
      :title="`Next: ${nextStep.label}`"
    >
      <span><small>Next</small><strong>{{ nextStep.label }}</strong></span>
      <span aria-hidden="true">→</span>
    </NuxtLink>
    <span v-else class="flow-direction flow-placeholder" aria-hidden="true" />
  </nav>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useProjectFlow, type FlowStep, type VisualSource } from '~/composables/useProjectFlow'

const props = defineProps<{
  slug: string
  visualSource: VisualSource
}>()

const { steps, routeFor, currentIndex } = useProjectFlow(
  toRef(props, 'slug'),
  toRef(props, 'visualSource'),
)

const currentStep = computed<FlowStep | null>(() => steps.value[currentIndex.value - 1] || null)
const previousStep = computed<FlowStep | null>(() => steps.value[currentIndex.value - 2] || null)
const nextStep = computed<FlowStep | null>(() => steps.value[currentIndex.value] || null)
</script>

<style scoped>
.flow-ribbon {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
}

.flow-direction {
  display: flex;
  min-width: 0;
  min-height: 40px;
  align-items: center;
  gap: 9px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}
.flow-direction:hover { background: var(--bg-hover); color: var(--text-primary); }
.flow-direction > span:not([aria-hidden]) { display: flex; min-width: 0; flex-direction: column; }
.flow-direction small { color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.15; }
.flow-direction strong { overflow: hidden; color: var(--text-primary); font-size: var(--font-sm); text-overflow: ellipsis; white-space: nowrap; }
.flow-next { justify-content: flex-end; text-align: right; }

.flow-current {
  display: flex;
  min-width: 150px;
  flex-direction: column;
  align-items: center;
  padding: 3px 16px;
  border-right: 1px solid var(--border);
  border-left: 1px solid var(--border);
  text-align: center;
}
.flow-current span { color: var(--accent); font-size: var(--font-xs); font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.flow-current strong { font-size: var(--font-sm); }

@media (max-width: 680px) {
  .flow-ribbon { grid-template-columns: 1fr 1fr; }
  .flow-current { grid-column: 1 / -1; grid-row: 1; border: 0; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
  .flow-placeholder { display: none; }
  .flow-next { grid-column: 2; }
}
</style>
