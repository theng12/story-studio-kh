<template>
  <!-- v1.4.365 — the two optional layers are one page now, so this hand-off
       reports both and never claims a render is blocked: what you approved is
       mixed or drawn, and everything else is reported. -->
  <section class="sound-handoff">
    <div class="sound-handoff-copy">
      <span class="sound-kicker">Optional assembly layers</span>
      <h4>Sound &amp; Labels</h4>
      <p v-if="loading">Checking reviewed labels and sounds…</p>
      <p v-else-if="!labelsOn && !soundOn">Both are off — this video uses its original audio and no labels.</p>
      <p v-else-if="loadError">Could not read this episode's labels and sounds.</p>
      <p v-else>
        <template v-if="labelsOn">{{ labelsApproved }} label{{ labelsApproved === 1 ? '' : 's' }} will be drawn</template>
        <template v-if="labelsOn && soundOn"> · </template>
        <template v-if="soundOn">{{ soundsApproved }} sound{{ soundsApproved === 1 ? '' : 's' }} will be mixed</template>
        <template v-if="waiting"> · {{ waiting }} still awaiting review, not used</template>
      </p>
    </div>
    <div class="sound-handoff-actions">
      <span v-if="labelsOn || soundOn" :class="['sound-state', waiting ? 'is-warning' : 'is-ready']">{{ waiting ? 'Some awaiting review' : 'Ready' }}</span>
      <NuxtLink :to="`/projects/${slug}/sound-and-labels`" class="btn btn-secondary btn-sm">Open Sound &amp; Labels</NuxtLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useApi } from '../composables/useApi.js'

const props = defineProps<{ slug: string; episodeCode: string }>()
const { get } = useApi()
const loading = ref(false); const loadError = ref('')
const labelsOn = ref(false); const soundOn = ref(false)
const labelsApproved = ref(0); const soundsApproved = ref(0); const waiting = ref(0)
async function load(): Promise<void> {
  loadError.value = ''; labelsApproved.value = 0; soundsApproved.value = 0; waiting.value = 0
  if (!props.episodeCode) return
  loading.value = true
  try {
    const data = await get<any>(`/projects/${props.slug}/sound-and-labels/${props.episodeCode}`)
    labelsOn.value = data.config?.on_screen_text === true
    soundOn.value = data.config?.sound === true
    labelsApproved.value = data.readiness?.labels?.will_render || 0
    soundsApproved.value = data.readiness?.sound?.will_mix || 0
    // Everything the renderer will NOT use, kept as one count so the line says
    // what the episode will actually be rather than implying completeness.
    waiting.value = (data.labels?.cues || []).filter((cue: any) => cue.status === 'proposed').length
      + (data.sounds?.cues || []).filter((cue: any) => cue.status === 'proposed' || cue.status === 'matched').length
  } catch (error: any) { loadError.value = error?.data?.detail || 'Could not check Sound & Labels.' }
  finally { loading.value = false }
}
watch(() => props.episodeCode, load, { immediate: true })
</script>

<style scoped>
.sound-handoff { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:1rem 1.1rem; border:1px solid var(--border-color); border-radius:.55rem; background:var(--bg-secondary); }.sound-kicker { color:var(--accent-gold); font-size:.7rem; letter-spacing:.09em; font-weight:700; text-transform:uppercase; }.sound-handoff h4 { margin:.2rem 0; }.sound-handoff p { margin:0; color:var(--text-muted); font-size:.85rem; }.sound-handoff-actions { display:flex; align-items:center; gap:.65rem; white-space:nowrap; }.sound-state { border-radius:999px; padding:.2rem .5rem; font-size:.72rem; font-weight:700; }.is-ready { color:var(--success); background:color-mix(in srgb,var(--success) 12%,transparent); }.is-warning { color:var(--accent-gold); background:color-mix(in srgb,var(--accent-gold) 12%,transparent); }@media (max-width:700px){.sound-handoff{align-items:flex-start;flex-direction:column}.sound-handoff-actions{width:100%;justify-content:space-between}}
</style>
