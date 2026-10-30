<!--
  Step 5 — Publish. The export and posting for the post in focus. Nothing is sent by itself: Facebook
  posts only when the owner presses the button, and YouTube is prepared here and posted by hand.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="publish" />

    <section class="card sp-section">
      <StillPostsPostGrid />
    </section>

    <section v-if="selected" class="card sp-section sp-editor">
      <div class="sp-section-head">
        <div>
          <h3 class="sp-h3">{{ selected.id }}</h3>
          <p class="sp-help">Download the finished frames, or post them where the channel allows it.</p>
        </div>
        <div class="sp-row">
          <label class="sp-check">
            Frame
            <select v-model="previewAspect" class="select" aria-label="Frame to publish">
              <option v-for="aspect in selected.aspects" :key="aspect" :value="aspect">{{ aspect }}</option>
            </select>
          </label>
        </div>
      </div>

      <div class="sp-editor-grid">
        <div class="sp-editor-preview">
          <div v-for="(panel, index) in selected.panels" :key="panel.id" class="sp-preview-panel">
            <p class="sp-help">{{ selected.panels.length === 1 ? 'Final' : (index === 0 ? 'Setup' : 'Punchline') }}</p>
            <img
              v-if="finalUrl(selected, index, previewAspect)"
              :src="finalUrl(selected, index, previewAspect)!"
              :alt="panel.text"
              class="sp-preview-image"
            >
            <p v-else class="sp-help sp-empty">
              {{ finalState(selected, index, previewAspect) === 'stale' ? 'The words changed — re-letter it on Review.' : 'Not rendered yet.' }}
            </p>
            <a
              v-if="finalUrl(selected, index, previewAspect)"
              :href="`${fileBase(selected)}/${finalName(index, previewAspect)}?download=1`"
              class="sp-link"
            >
              Download {{ previewAspect }}
            </a>
          </div>
        </div>

        <div class="sp-editor-fields">
          <div class="sp-help">
            <p class="sp-label">YouTube (prepared by hand)</p>
            <p>YouTube Posts are published by you in YouTube Studio. Download the finished image, then copy the caption and attach the image there.</p>
            <button type="button" class="btn btn-secondary btn-sm" @click="copyPostCaption">Copy caption</button>
            <a class="sp-link" href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer">Open YouTube Studio to create a post</a>
            <p v-if="captionCopyStatus" role="status">{{ captionCopyStatus }}</p>
          </div>

          <div class="sp-help">
            <p class="sp-label">Facebook</p>
            <template v-if="socialOn">
              <button type="button" class="btn btn-secondary btn-sm" :disabled="publishBusy" @click="postSelectedToFacebook">
                {{ publishBusy ? 'Posting…' : (selectedPublish?.facebook ? 'Post to Facebook again (new image only)' : 'Post to Facebook') }}
              </button>
              <p v-if="selectedPublish?.facebook">
                Posted {{ new Date(selectedPublish.facebook.posted_at).toLocaleString() }}
                (<a :href="selectedPublish.facebook.permalink || '#'" target="_blank" rel="noopener noreferrer">{{ selectedPublish.facebook.post_id }}</a>).
              </p>
              <p v-else>Not sent yet.</p>
            </template>
            <p v-else>Facebook posting is off for this channel. Turn it on in Settings → Publishing; nothing posts by itself.</p>
            <p v-if="publishMessage" role="status">{{ publishMessage }}</p>
            <p v-else-if="selectedPublish?.last_failure?.facebook">
              Last attempt failed: {{ selectedPublish.last_failure.facebook.message }}
            </p>
          </div>

          <div class="sp-help">
            <p class="sp-label">Instagram</p>
            <p>
              Instagram needs a public image address, and Story Studio has no public image hosting, so it cannot post an image from this Mac.
              Post it by hand.
            </p>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import {
  useStillPosts,
} from '../../composables/useStillPostsWorkspace'

const {
  selected, socialOn, selectedPublish, publishBusy, publishMessage, postSelectedToFacebook,
  finalUrl, finalState, finalName, fileBase,
} = useStillPosts()

const previewAspect = ref('1:1')
const captionCopyStatus = ref('')

async function copyPostCaption(): Promise<void> {
  try {
    await navigator.clipboard.writeText(selected.value?.caption || '')
    captionCopyStatus.value = 'Caption copied. Paste it in YouTube Studio.'
  } catch {
    captionCopyStatus.value = 'Could not copy the caption. Select and copy it from the Review step.'
  }
}
</script>
