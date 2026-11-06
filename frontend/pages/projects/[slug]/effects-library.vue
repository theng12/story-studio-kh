<template>
  <div />
</template>

<script setup lang="ts">
/**
 * The old Effects Library address (1.4.384). The editor it held now lives in
 * Video Assembly Step 4 as a popup, so this route only forwards bookmarks and
 * older in-app links there — with the episode and scene it was opened on, when
 * they are real. No channel means no step: the app's own channel chooser takes
 * over instead of a guessed slug (see frontend/utils/editor-redirect.ts).
 */
import { effectsLibraryRedirect } from '~/utils/editor-redirect'

definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const target = effectsLibraryRedirect({
  channel: route.params.slug,
  episode: route.query.episode_id ?? route.query.episode,
  scene: route.query.scene,
})
await navigateTo({ path: target.path, query: target.query }, { replace: true, redirectCode: 301 })
</script>
