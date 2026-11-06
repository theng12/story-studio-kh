<template>
  <div />
</template>

<script setup lang="ts">
/**
 * The old Channel Characters address (1.4.384). The roster and the shared
 * record editor it held now live on the channel's Character Sheet, so this
 * route only forwards bookmarks and older in-app links there — with the
 * channel it was opened for, when it is real. No channel means no sheet: the
 * app's own channel chooser takes over instead of a guessed slug (see
 * frontend/utils/editor-redirect.ts).
 */
import { characterLibraryRedirect } from '~/utils/editor-redirect'

definePageMeta({ layout: 'dashboard' })
const route = useRoute()
const target = characterLibraryRedirect({
  channel: route.query.channel,
  project: route.query.project,
  episode: route.query.episode_id ?? route.query.episode,
})
await navigateTo({ path: target.path, query: target.query }, { replace: true, redirectCode: 301 })
</script>
