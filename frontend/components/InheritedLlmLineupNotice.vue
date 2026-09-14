<template>
  <WorkspaceNotice v-if="lineup?.enabled && lineup.models.length" tone="info" title="Shared LLM lineup is active">
    New writing jobs on this page inherit the project lineup ({{ lineup.models.length }} selected model{{ lineup.models.length === 1 ? '' : 's' }}).
    Per-stage overrides in Pipeline take precedence.
    <NuxtLink :to="`/projects/${projectSlug}/pipeline`">Review lineup in Pipeline →</NuxtLink>
  </WorkspaceNotice>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useProject } from '../composables/useProject.js'

const props = defineProps<{ projectSlug: string }>()
const { config, slug: currentProjectSlug } = useProject()
const lineup = computed(() => {
  // useProject clears config synchronously during a project switch. Keep the
  // identity check as well so a reused page can never render another project's
  // saved lineup while its own config request is still in flight.
  if (currentProjectSlug.value !== props.projectSlug) return null
  const value = config.value?.llm_lineup
  return value?.enabled === true && Array.isArray(value.models)
    ? { enabled: true, models: value.models.filter((model): model is string => typeof model === 'string' && !!model.trim()) }
    : null
})
</script>

<style scoped>
a { margin-left: 4px; font-weight: 600; }
</style>
