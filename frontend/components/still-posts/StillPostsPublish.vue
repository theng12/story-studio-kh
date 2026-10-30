<!--
  Step 5 — Publish. Only APPROVED posts appear here. Each shows what has been sent, where, with the
  result and its link, or a plain "not sent" — nothing is ever sent by itself. YouTube is prepared here
  and posted by hand; Facebook posts only when its button is pressed. Export is always available.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="publish" />

    <section class="card sp-section">
      <div class="sp-section-head">
        <div>
          <h3 class="sp-h3">Approved posts <span class="sp-count">{{ approved.length }}</span></h3>
          <p class="sp-help">
            {{ socialOn ? 'Facebook posting is on for this channel.' : 'Posting is off for this channel, so export and post by hand.' }}
            Nothing is sent until you press a button.
          </p>
        </div>
        <p class="sp-help sp-review-line" role="status">{{ sentCount }} of {{ approved.length }} sent</p>
      </div>

      <div v-if="!approved.length" class="sp-empty-state">
        <p class="sp-help">Nothing approved yet. Approve posts on the Review step — only approved posts can be published.</p>
        <NuxtLink :to="stillPostTabRoute(slug, 'review')" class="btn btn-sm btn-secondary">Go to Review</NuxtLink>
      </div>

      <div v-else class="sp-publish-list">
        <article
          v-for="post in approved"
          :key="post.id"
          class="sp-publish-row"
          :class="{ 'is-selected': selectedId === post.id }"
        >
          <button type="button" class="sp-publish-thumb" :aria-label="`Show ${post.id}`" @click="select(post)">
            <img v-if="cardUrl(post)" :src="cardUrl(post)!" :alt="post.panels[0]?.text || post.id" loading="lazy">
            <span v-else class="sp-post-empty">Not drawn</span>
          </button>
          <div class="sp-publish-copy">
            <p class="sp-post-text">{{ post.panels[0]?.text }}</p>
            <p class="sp-help">{{ post.id }} · {{ post.aspects.join(', ') }}</p>
            <ul class="sp-publish-status">
              <li v-for="platform in platforms" :key="platform">
                <span class="sp-label">{{ platformLabel(platform) }}</span>
                <template v-if="recordFor(post.id)[platform]">
                  <span class="sp-pill is-done">Sent</span>
                  <a
                    v-if="recordFor(post.id)[platform]!.permalink"
                    :href="recordFor(post.id)[platform]!.permalink"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="sp-link"
                  >{{ new Date(recordFor(post.id)[platform]!.posted_at).toLocaleString() }}</a>
                  <span v-else class="sp-help">{{ new Date(recordFor(post.id)[platform]!.posted_at).toLocaleString() }}</span>
                </template>
                <span v-else-if="recordFor(post.id).last_failure?.[platform]" class="sp-pill is-failed">
                  Failed: {{ recordFor(post.id).last_failure![platform]!.message }}
                </span>
                <span v-else class="sp-pill is-not-started">Not sent</span>
              </li>
            </ul>
          </div>
          <div class="sp-publish-actions">
            <button v-if="post !== selected" type="button" class="btn btn-sm btn-secondary" @click="select(post)">Open</button>
            <button
              v-if="socialOn"
              type="button"
              class="btn btn-sm btn-primary"
              :disabled="publishBusy || !!recordFor(post.id).facebook"
              @click="publish(post)"
            >{{ recordFor(post.id).facebook ? 'Sent to Facebook' : (publishBusy && selectedId === post.id ? 'Posting…' : 'Post to Facebook') }}</button>
            <a
              v-if="exportUrl(post)"
              :href="exportUrl(post)!"
              class="btn btn-sm btn-ghost"
            >Download</a>
          </div>
        </article>
      </div>

      <p v-if="publishMessage" class="sp-note" role="status">{{ publishMessage }}</p>
    </section>

    <section v-if="selected" class="card sp-section">
      <div class="sp-section-head">
        <div>
          <h3 class="sp-h3">{{ selected.id }} — export</h3>
          <p class="sp-help">Every chosen frame, finished. These are the files that get posted.</p>
        </div>
      </div>
      <div class="sp-publish-frames">
        <figure v-for="aspect in selected.aspects" :key="aspect" class="sp-publish-frame">
          <img v-if="finalUrl(selected, 0, aspect)" :src="finalUrl(selected, 0, aspect)!" :alt="`${selected.id} ${aspect}`">
          <figcaption class="sp-help">{{ aspect }}</figcaption>
          <a v-if="finalUrl(selected, 0, aspect)" :href="`${fileBase(selected)}/${finalName(0, aspect)}?download=1`" class="sp-link">Download {{ aspect }}</a>
        </figure>
      </div>

      <div class="sp-publish-helpers">
        <div>
          <p class="sp-label">YouTube (prepared here, posted by hand)</p>
          <p class="sp-help">YouTube Posts are published by you in YouTube Studio. Download the finished image, copy the caption, and attach the image there.</p>
          <div class="sp-row">
            <button type="button" class="btn btn-sm btn-secondary" @click="copyCaption(selected)">Copy caption</button>
            <a class="sp-link" href="https://studio.youtube.com/" target="_blank" rel="noopener noreferrer">Open YouTube Studio</a>
          </div>
        </div>
        <div>
          <p class="sp-label">Instagram</p>
          <p class="sp-help">
            Instagram needs a public image address, and Story Studio has no public image hosting, so it cannot post
            an image from this Mac. Post it by hand.
          </p>
        </div>
        <p v-if="captionStatus" class="sp-help" role="status">{{ captionStatus }}</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { stillPostTabRoute } from '../../utils/still-posts-flow'
import { useStillPosts, type StillPost } from '../../composables/useStillPostsWorkspace'

const {
  slug, posts, publishes, selectedId, selectedPublish, socialOn, publishBusy, publishMessage,
  postSelectedToFacebook, finalUrl, finalName, fileBase, postImageUrl,
} = useStillPosts()

/** Only approved posts are published. */
const approved = computed(() => posts.value.filter(entry => !!entry.approved_at))
const sentCount = computed(() => approved.value.filter(entry => !!recordFor(entry.id).facebook).length)
const platforms = computed(() => (socialOn.value ? ['facebook'] as const : [] as const))
const selected = computed(() => approved.value.find(entry => entry.id === selectedId.value) || null)
const captionStatus = ref('')

function cardUrl(post: StillPost): string | null {
  return finalUrl(post, 0, post.aspects[0] || '1:1') || postImageUrl(post)
}
function exportUrl(post: StillPost): string | null {
  return finalUrl(post, 0, post.aspects[0] || '1:1')
    ? `${fileBase(post)}/${finalName(0, post.aspects[0] || '1:1')}?download=1`
    : null
}
function recordFor(postId: string) {
  return publishes.value[postId] || {}
}
function platformLabel(platform: string): string {
  return platform === 'facebook' ? 'Facebook' : platform
}
function select(post: StillPost): void {
  selectedId.value = post.id
}
async function publish(post: StillPost): Promise<void> {
  selectedId.value = post.id
  await postSelectedToFacebook()
}
async function copyCaption(post: StillPost): Promise<void> {
  try {
    await navigator.clipboard.writeText(post.caption || post.panels[0]?.text || '')
    captionStatus.value = 'Caption copied. Paste it in YouTube Studio.'
  } catch {
    captionStatus.value = 'Could not copy the caption. Select it on the Review step and copy it.'
  }
}

// The post in focus here is the selected APPROVED one; keep that true across a reload.
watch(approved, (list) => {
  if (selected.value) return
  selectedId.value = list[0]?.id || null
}, { immediate: true })
void selectedPublish
</script>
