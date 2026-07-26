<template>
  <section class="sound-handoff">
    <div class="sound-handoff-copy">
      <span class="sound-kicker">Optional assembly layer</span>
      <h4>Sound Design</h4>
      <p v-if="loading">Checking reviewed sound cues…</p>
      <p v-else-if="!config.enabled">Off — this video will use its original assembled audio.</p>
      <p v-else-if="loadError">Sound Design needs attention before Final Video can render.</p>
      <p v-else-if="validation.length">{{ validation[0]?.detail }}</p>
      <p v-else>{{ approved }} approved cue{{ approved === 1 ? '' : 's' }} will be mixed beneath narration with the saved ducking profile.</p>
    </div>
    <div class="sound-handoff-actions">
      <span v-if="config.enabled" :class="['sound-state', validation.length || loadError ? 'is-warning' : 'is-ready']">{{ validation.length || loadError ? 'Review required' : 'Ready' }}</span>
      <NuxtLink :to="`/projects/${slug}/sound-design`" class="btn btn-secondary btn-sm">{{ config.enabled ? 'Review Sound Design' : 'Open Sound Design' }}</NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps<{ slug: string; episodeCode: string }>()
const { get } = useApi()
const loading = ref(false); const loadError = ref(''); const config = ref({ enabled: false }); const validation = ref<Array<{ detail: string }>>([]); const approved = ref(0)
async function load(): Promise<void> {
  loadError.value = ''; validation.value = []; approved.value = 0
  if (!props.episodeCode) return
  loading.value = true
  try {
    const data = await get<any>(`/projects/${props.slug}/sound-design/${props.episodeCode}`)
    config.value = data.config || { enabled: false }
    validation.value = data.validation || []
    approved.value = data.timeline?.cues?.filter((cue: any) => cue.status === 'approved').length || 0
  } catch (error: any) { loadError.value = error?.data?.detail || 'Could not check Sound Design.' }
  finally { loading.value = false }
}
watch(() => props.episodeCode, load, { immediate: true })
</script>

<style scoped>
.sound-handoff { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; border:1px solid var(--border-color); border-radius:.55rem; background:var(--bg-secondary); }.sound-kicker { color:var(--accent-gold); font-size:.7rem; letter-spacing:.09em; font-weight:700; text-transform:uppercase; }.sound-handoff h4 { margin:.2rem 0; }.sound-handoff p { margin:0; color:var(--text-muted); font-size:.85rem; }.sound-handoff-actions { display:flex; align-items:center; gap:.65rem; white-space:nowrap; }.sound-state { border-radius:999px; padding:.2rem .5rem; font-size:.72rem; font-weight:700; }.is-ready { color:var(--success); background:color-mix(in srgb,var(--success) 12%,transparent); }.is-warning { color:var(--accent-gold); background:color-mix(in srgb,var(--accent-gold) 12%,transparent); }@media (max-width:700px){.sound-handoff{align-items:flex-start;flex-direction:column}.sound-handoff-actions{width:100%;justify-content:space-between}}
</style>
