<!--
  The head of every Still Posts step: where it is, its honest state, the one sentence that says why,
  and the next step. Every step uses it, so the page reads the same wherever a person is.
-->
<template>
  <header class="sp-stephead">
    <div class="sp-stephead-copy">
      <p class="sp-kicker">Step {{ index + 1 }} of {{ total }}</p>
      <h2 class="sp-h2">{{ STILL_POST_TAB_LABELS[tab] }}</h2>
      <p class="sp-help sp-stephead-reason" role="status">{{ status?.reason }}</p>
    </div>
    <div class="sp-stephead-side">
      <span v-if="status" class="sp-pill" :class="`is-${status.state}`">{{ STILL_POST_STATE_LABELS[status.state] }}</span>
      <NuxtLink v-if="next" :to="stillPostTabRoute(slug, next)" class="btn btn-sm btn-secondary sp-next">
        Next: {{ STILL_POST_TAB_LABELS[next] }} →
      </NuxtLink>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  nextStillPostTab,
  STILL_POST_STATE_LABELS,
  STILL_POST_TAB_LABELS,
  STILL_POST_TABS,
  stillPostTabRoute,
  type StillPostTab,
} from '../../utils/still-posts-flow'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const props = defineProps<{ tab: StillPostTab }>()

const { slug, stepStates } = useStillPosts()
const index = computed(() => STILL_POST_TABS.indexOf(props.tab))
const total = STILL_POST_TABS.length
const status = computed(() => stepStates.value.find(entry => entry.tab === props.tab) || null)
const next = computed(() => nextStillPostTab(props.tab))
</script>
