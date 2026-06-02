<template>
  <!-- v1.0.169 — Format-aware production flow ribbon. Shows the full,
       ordered creation chain for THIS project's format (scene-images /
       broll / timestamp-driven) so a user always sees where they are and
       what's next. Each node links to that step's page. The current page's
       node is highlighted; steps before it read as "done so far" (visited
       position, not asset-completion — that lives on the Pipeline page).
       Off-flow pages (Dashboard / Jobs / Settings / Library) show the
       ribbon with nothing highlighted, as a map. -->
  <nav v-if="steps.length" class="flow-ribbon" aria-label="Production flow">
    <ol class="flow-track">
      <li
        v-for="(step, i) in steps"
        :key="step.key"
        class="flow-node-wrap"
      >
        <NuxtLink
          :to="routeFor(step)"
          class="flow-node"
          :class="{
            'is-current': step.key === currentKey,
            'is-past': currentIndex > 0 && i < currentIndex - 1,
            'is-upcoming': currentIndex > 0 && i > currentIndex - 1,
          }"
          :aria-current="step.key === currentKey ? 'step' : undefined"
          :title="`Step ${i + 1} of ${steps.length}: ${step.label}`"
        >
          <span class="flow-num" aria-hidden="true">{{ i + 1 }}</span>
          <span class="flow-icon" aria-hidden="true">{{ step.icon }}</span>
          <span class="flow-label">{{ step.label }}</span>
        </NuxtLink>
        <span v-if="i < steps.length - 1" class="flow-sep" aria-hidden="true">›</span>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import { toRef } from 'vue'
import { useProjectFlow, type VisualSource } from '~/composables/useProjectFlow'

const props = defineProps<{
  slug: string
  visualSource: VisualSource
}>()

const { steps, routeFor, currentKey, currentIndex } = useProjectFlow(
  toRef(props, 'slug'),
  toRef(props, 'visualSource'),
)
</script>

<style scoped>
.flow-ribbon {
  /* v1.0.173 — full-visibility band above the page content.
     `flex-shrink: 0` is critical: .main-content is a column flex scroll
     container, so without it the column compresses this strip and the
     `overflow` then clips the pills to half-height (the bug from v1.0.169).
     A subtle surface + bottom border make it read as a distinct band, not
     floating pills. Horizontal scroll only kicks in when a long flow
     (timestamp = 11 steps) exceeds the width — never vertical clipping. */
  flex-shrink: 0;
  overflow-x: auto;
  overflow-y: visible;
  padding: 8px 10px;
  margin: 0 0 16px;         /* aligned with the page content; breathing room below */
  background: var(--bg-secondary, #1c1c1c);
  border: 1px solid var(--border, #2a2a2a);
  border-radius: var(--radius-sm, 6px);
  scrollbar-width: thin;
}
.flow-track {
  display: flex;
  align-items: center;
  gap: 2px;
  list-style: none;
  margin: 0;
  padding: 0;
  width: max-content;       /* let it exceed the viewport → scroll */
  min-width: 100%;
}
.flow-node-wrap {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}
.flow-node {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  text-decoration: none;
  color: var(--text-muted, #9a9a9a);
  font-size: 12px;
  white-space: nowrap;
  border: 1px solid transparent;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.flow-node:hover {
  background: var(--surface-2, #242424);
  color: var(--text, #e6e6e6);
}
.flow-num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  font-size: 10px;
  font-weight: 600;
  background: var(--surface-3, #333);
  color: var(--text-muted, #9a9a9a);
}
.flow-icon { font-size: 12px; }
.flow-label { font-weight: 500; }

/* Current step — ringed accent pill. */
.flow-node.is-current {
  background: rgba(240, 198, 116, 0.10);
  color: var(--text, #f2f2f2);
  border-color: var(--accent, #f0c674);
}
.flow-node.is-current .flow-num {
  background: var(--accent, #f0c674);
  color: #1a1a1a;
}

/* Steps before the current one — solid-ish, "you've passed this". */
.flow-node.is-past { color: var(--text, #cfcfcf); }
.flow-node.is-past .flow-num {
  background: rgba(46, 160, 67, 0.30);
  color: var(--success, #3fb950);
}

/* Upcoming steps stay muted (default color); no extra rule needed. */

.flow-sep {
  color: var(--border, #3a3a3a);
  font-size: 14px;
  padding: 0 1px;
  user-select: none;
}
</style>
