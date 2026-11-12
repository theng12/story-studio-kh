<!--
  v1.0.310 — per-episode "Import" affordance for generator pages.

  Drops an Import button next to a page's Generate button and wires up the
  shared AssetImportDialog, scoped to the page's current episode + its asset
  type (Audio page → 'audio', Thumbnail Generator → 'thumb', …).

  Why this exists: the Assets page imports assets too, but it scans EVERY
  episode's assets first — several minutes on a 400+ episode channel. This
  button opens the same import dialog directly for the one episode you're
  already working on, with no project-wide scan. The dialog POSTs straight to
  /import-assets; nothing here loads the asset catalogue.

  The dialog stays open after a successful import (it shows a result panel and
  clears its queue) so you can stage another file; this wrapper just relays the
  `imported` event up so the page can refresh its own status card.
-->
<template>
  <span class="episode-import">
    <button
      type="button"
      class="btn btn-secondary btn-sm"
      :disabled="!episodeCode"
      :title="episodeCode
        ? `Import an existing ${tabNoun} file for ${episodeCode} (e.g. one you rendered elsewhere) into this episode — no project-wide scan.`
        : 'Pick an episode first.'"
      @click="open = true"
    >
      <span aria-hidden="true">⬆</span> {{ label }}
    </button>
    <AssetImportDialog
      :visible="open"
      :slug="slug"
      :episode-code="episodeCode"
      :default-tab="defaultTab"
      :chapter-count="chapterCount"
      @close="open = false"
      @imported="emit('imported', $event)"
    />
  </span>
</template>

<script setup lang="ts">
import AssetImportDialog from './AssetImportDialog.vue'

const props = withDefaults(defineProps<{
  slug: string
  /** Current episode code (e.g. "TN0161"). Empty disables the button. */
  episodeCode: string
  /** Tab the dialog opens on — the page's own asset type. */
  defaultTab?: 'audio' | 'scene' | 'thumb' | 'video' | 'final' | 'merged' | 'other'
  /** Chapter count for the audio tab's section dropdown (audio page only). */
  chapterCount?: number
  /** Button label. */
  label?: string
}>(), {
  label: 'Import',
  defaultTab: 'other',
})

const emit = defineEmits<{ (e: 'imported', summary: any): void }>()

const open = ref(false)

// Friendly noun for the tooltip, derived from the tab.
const tabNoun = computed(() => {
  switch (props.defaultTab) {
    case 'audio': return 'chapter audio'
    case 'scene': return 'scene image'
    case 'thumb': return 'thumbnail'
    case 'video': return 'video clip'
    case 'final': return 'final video'
    case 'merged': return 'merged narration'
    default: return 'asset'
  }
})
</script>

<style scoped>
.episode-import { display: inline-flex; }
</style>
