<!--
  The channel's logo, picked as a file — never typed as a path. The stored value may be portable
  (`${CHANNEL}/assets/…`); the name is shown so it can be recognised, and the picture itself is shown
  once it is set.
-->
<template>
  <div class="sp-field">
    <span class="sp-label">Logo</span>
    <div class="sp-logo-row">
      <img v-if="logoReady" :src="logoSrc" :alt="`This channel's logo (${fileName})`" class="sp-logo-preview">
      <span v-else class="sp-logo-placeholder" aria-hidden="true">No logo</span>
      <div class="sp-logo-controls">
        <FilePicker
          v-model="model"
          title="Choose the channel's logo"
          :filters="[{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]"
          aria-label="Logo file"
          clearable
        />
        <span class="sp-help">
          <template v-if="fileName">{{ fileName }}<template v-if="logoReady"> is set.</template></template>
          <template v-else>The logo layer draws nothing until you pick a file.</template>
          Stored with the channel, never typed as a path.
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const { slug, workspace, logoDraft } = useStillPosts()
const model = computed({
  get: () => logoDraft.value,
  set: (value: string) => { logoDraft.value = value },
})
const fileName = computed(() => logoDraft.value.split('/').pop() || '')
const logoReady = computed(() => !!workspace.value?.config.logo_ready)
const logoSrc = computed(() => `/api/projects/${slug.value}/still-posts/logo?v=${encodeURIComponent(workspace.value?.config.logo_path || '')}`)
</script>
