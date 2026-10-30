<!--
  The five-step rail at the top of the Still Posts page. Each step is a link to its tab, and each shows
  its honest state. The sidebar's WORKFLOW section lists the same five steps; this rail says how far
  each one has got.
-->
<template>
  <nav class="sp-rail" aria-label="Still Posts steps">
    <ol class="sp-rail-list">
      <li v-for="(entry, index) in stepStates" :key="entry.tab">
        <NuxtLink
          :to="stillPostTabRoute(slug, entry.tab)"
          class="sp-rail-step"
          :class="[`is-${entry.state}`, { 'is-active': active === entry.tab }]"
          :aria-current="active === entry.tab ? 'step' : undefined"
          :title="entry.reason"
        >
          <span class="sp-rail-number" aria-hidden="true">{{ index + 1 }}</span>
          <span class="sp-rail-label">{{ STILL_POST_TAB_LABELS[entry.tab] }}</span>
          <span class="sp-rail-state">{{ STILL_POST_STATE_LABELS[entry.state] }}</span>
        </NuxtLink>
      </li>
    </ol>
  </nav>
</template>

<script setup lang="ts">
import {
  STILL_POST_STATE_LABELS,
  STILL_POST_TAB_LABELS,
  stillPostTabRoute,
  type StillPostTab,
} from '../../utils/still-posts-flow'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

defineProps<{ active: StillPostTab }>()

const { slug, stepStates } = useStillPosts()
</script>
