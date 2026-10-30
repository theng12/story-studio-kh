<!--
  Step 4 — Review (owner, 2026-10-30: "a grid of big finished posts as they'll actually look").

  Each card is the post as it will publish — the finished picture in its first frame, words burned in —
  not artwork plus separate text. Opening one shows it large with every chosen frame side by side, the
  words editable in place beside the re-lettered result, and the previous drawing when a redo is the
  reason it changed. A batch of 30 takes minutes: arrows move, A approves, R redraws, Space ticks.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="review" />

    <section class="card sp-section">
      <div class="sp-review-bar">
        <div class="sp-review-filters" role="tablist" aria-label="Which posts to show">
          <button
            v-for="filter in filters"
            :key="filter.key"
            type="button"
            class="sp-tab"
            :class="{ 'is-active': reviewFilter === filter.key }"
            role="tab"
            :aria-selected="reviewFilter === filter.key"
            @click="reviewFilter = filter.key"
          >{{ filter.label }} <span class="sp-count">{{ filter.count }}</span></button>
        </div>
        <p class="sp-help sp-review-line" role="status">{{ approvedCount }} of {{ posts.length }} approved</p>
      </div>

      <div v-if="reviewSelected.length" class="sp-review-batch">
        <span class="sp-help">{{ reviewSelected.length }} selected</span>
        <button type="button" class="btn btn-sm btn-primary" :disabled="approving" @click="approveSelected">
          {{ approving ? 'Approving…' : `Approve ${reviewSelected.length}` }}
        </button>
        <button type="button" class="btn btn-sm btn-secondary" :disabled="drawing || !canDraw" @click="redrawSelected">
          {{ drawing ? 'Redrawing…' : `Redo ${reviewSelected.length}` }}
        </button>
        <button type="button" class="btn btn-sm btn-ghost" @click="reviewSelected = []">Clear selection</button>
      </div>

      <p v-if="reviewNote" class="sp-note" :class="{ 'sp-note-error': reviewError }" role="status">{{ reviewNote }}</p>

      <p v-if="!reviewPosts.length" class="sp-help sp-empty">
        {{ emptyLine }}
      </p>

      <div v-else class="sp-review-grid">
        <article
          v-for="post in reviewPosts"
          :key="post.id"
          class="sp-review-card"
          :class="{ 'is-approved': !!post.approved_at, 'is-failed': reviewStatus(post) === 'failed', 'is-ticked': reviewSelected.includes(post.id) }"
        >
          <label class="sp-review-tick">
            <input
              type="checkbox"
              :checked="reviewSelected.includes(post.id)"
              :aria-label="`Select ${post.id}`"
              @change="toggleSelected(post.id)"
            >
          </label>
          <button type="button" class="sp-review-picture" :aria-label="`Open ${post.id} large`" @click="openPost(post)">
            <img
              v-if="cardUrl(post)"
              :src="cardUrl(post)!"
              :alt="post.panels[0]?.text || post.id"
              loading="lazy"
            >
            <span v-else class="sp-post-empty">Not drawn yet</span>
          </button>
          <div class="sp-review-meta">
            <span class="sp-pill" :class="statusClass(post)">{{ statusLabel(post) }}</span>
            <span class="sp-help sp-review-id">{{ post.id }} · {{ post.format_id }} · {{ post.option_id }}</span>
            <p v-if="reviewStatus(post) === 'failed'" class="sp-help sp-review-problem">{{ postState(post.id)?.problems[0] }}</p>
            <NuxtLink v-if="reviewStatus(post) === 'failed'" :to="stillPostTabRoute(slug, 'draw')" class="sp-link">Fix it on Draw →</NuxtLink>
          </div>
          <div class="sp-review-actions">
            <button type="button" class="btn btn-sm btn-primary" :disabled="!!post.approved_at || approving" @click="approveOne(post.id)">
              {{ post.approved_at ? 'Approved' : 'Approve' }}
            </button>
            <button type="button" class="btn btn-sm btn-secondary" :disabled="drawing || !canDraw" @click="redrawOne(post.id)">Redo</button>
          </div>
        </article>
      </div>
    </section>

    <!-- The post, large: every chosen frame, the words editable in place with the re-lettered result
         beside it, and the previous drawing when a redo changed it. -->
    <Teleport to="body">
      <div
        v-if="focused"
        class="sp-lightbox"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sp-lightbox-title"
        ref="dialogEl"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <div class="sp-lightbox-panel">
          <header class="sp-lightbox-head">
            <div>
              <strong id="sp-lightbox-title">{{ focused.id }}</strong>
              <span class="sp-help">{{ position + 1 }} of {{ reviewPosts.length }}</span>
            </div>
            <div class="sp-row">
              <button type="button" class="btn btn-sm btn-primary" :disabled="!!focused.approved_at || approving" @click="approveOne(focused.id)">
                {{ focused.approved_at ? 'Approved' : 'Approve (A)' }}
              </button>
              <button type="button" class="btn btn-sm btn-secondary" :disabled="drawing || !canDraw" @click="redrawOne(focused.id)">Redo (R)</button>
              <button type="button" class="btn btn-sm btn-ghost" @click="close">Close</button>
            </div>
          </header>

          <div class="sp-lightbox-body">
            <div class="sp-lightbox-pictures">
              <!-- Every chosen frame, side by side, as it will publish. -->
              <div class="sp-lightbox-frame-row">
                <section v-for="aspect in focused.aspects" :key="aspect" class="sp-lightbox-outframe" :data-aspect="aspect">
                  <p class="sp-label">{{ aspect }}</p>
                  <div class="sp-lightbox-frames">
                    <div v-for="(panel, index) in focused.panels" :key="`${panel.id}-${aspect}`" class="sp-lightbox-frame">
                      <img
                        v-if="finalUrl(focused, index, aspect)"
                        :src="finalUrl(focused, index, aspect)!"
                        :alt="panel.text"
                        class="sp-lightbox-image"
                      >
                      <p v-else class="sp-help sp-empty">Not rendered yet.</p>
                      <p v-if="focused.panels.length > 1" class="sp-help">{{ index === 0 ? 'Setup' : 'Punchline' }}</p>
                    </div>
                  </div>
                </section>
              </div>
              <div v-if="previousUrl" class="sp-lightbox-previous">
                <p class="sp-label">Previous drawing (kept in Trash)</p>
                <img :src="previousUrl" alt="The drawing this redo replaced" class="sp-lightbox-image sp-lightbox-old">
                <button v-if="hasCollapsedRedraw" type="button" class="sp-link" @click="showPrevious = !showPrevious">
                  {{ showPrevious ? 'Hide the previous drawing' : 'Show the previous drawing' }}
                </button>
              </div>
            </div>

            <div class="sp-lightbox-fields">
              <div v-for="(panel, index) in focused.panels" :key="panel.id" class="sp-panel-fields">
                <label class="sp-field">
                  <span class="sp-label">{{ focused.panels.length === 1 ? 'The words' : (index === 0 ? 'Setup' : 'Punchline') }}</span>
                  <textarea v-model="reword.panels[index]" class="textarea" rows="2" />
                </label>
              </div>
              <div class="sp-row">
                <button type="button" class="btn btn-primary btn-sm" :disabled="savingWords" @click="saveWords">
                  {{ savingWords ? 'Saving…' : 'Save and re-letter' }}
                </button>
                <NuxtLink :to="stillPostTabRoute(slug, 'publish')" class="btn btn-sm btn-ghost">Go to Publish →</NuxtLink>
              </div>
              <p v-if="wordNote" class="sp-note" :class="{ 'sp-note-error': wordError }" role="status">{{ wordNote }}</p>
              <p class="sp-help">
                Keys: ← → previous or next post · A approve · R redo · Space select · Esc close.
              </p>
            </div>
          </div>

          <button type="button" class="sp-lightbox-nav sp-lightbox-nav-prev" aria-label="Previous post" :disabled="position <= 0" @click="step(-1)">‹</button>
          <button type="button" class="sp-lightbox-nav sp-lightbox-nav-next" aria-label="Next post" :disabled="position >= reviewPosts.length - 1" @click="step(1)">›</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useApi } from '../../composables/useApi'
import { useStillPosts, type StillPost } from '../../composables/useStillPostsWorkspace'
import { stillPostTabRoute } from '../../utils/still-posts-flow'

const { put } = useApi()
const {
  slug, posts, approvedCount, reviewFilter, reviewPosts, reviewSelected,
  reviewStatus, postState, postImageUrl, finalUrl, draw, drawing, canDraw, load,
} = useStillPosts()

const filters = computed(() => [
  { key: 'needs-review' as const, label: 'Needs review', count: posts.value.filter(post => reviewStatus(post) === 'needs-review').length },
  { key: 'approved' as const, label: 'Approved', count: approvedCount.value },
  { key: 'complete' as const, label: 'Complete', count: posts.value.filter(post => !!postState(post.id)?.complete).length },
  { key: 'failed' as const, label: 'Failed', count: posts.value.filter(post => reviewStatus(post) === 'failed').length },
])
const emptyLine = computed(() => {
  if (!posts.value.length) return 'No posts yet. Write a batch on the Write step.'
  if (reviewFilter.value === 'failed') return 'Nothing failed. Every drawn post is complete in its chosen frames.'
  if (reviewFilter.value === 'approved') return 'Nothing approved yet.'
  if (reviewFilter.value === 'needs-review') return 'Nothing waiting for review. Everything drawn has been approved.'
  return 'Nothing here yet.'
})

function statusLabel(post: StillPost): string {
  const status = reviewStatus(post)
  if (status === 'approved') return 'Approved'
  if (status === 'failed') return 'Needs drawing'
  return 'Needs review'
}
function statusClass(post: StillPost): string {
  const status = reviewStatus(post)
  if (status === 'approved') return 'is-done'
  if (status === 'failed') return 'is-failed'
  return 'is-in-progress'
}

/** The card's picture is the finished post in its first frame — what it will publish as. */
function cardUrl(post: StillPost): string | null {
  return finalUrl(post, 0, post.aspects[0] || '1:1') || postImageUrl(post)
}

const reviewNote = ref('')
const reviewError = ref(false)
const approving = ref(false)

async function callApprovals(ids: string[], approved: boolean): Promise<void> {
  approving.value = true
  reviewNote.value = ''
  try {
    const response = await put<{ approved: string[], cleared: string[], refused: Array<{ id: string, reason: string }> }>(
      `/projects/${slug.value}/still-posts/approvals`, { post_ids: ids, approved },
    )
    await load()
    const refused = response.refused || []
    reviewError.value = refused.length > 0
    reviewNote.value = [
      approved && response.approved.length ? `${response.approved.length} approved.` : '',
      !approved && response.cleared.length ? `${response.cleared.length} approval(s) cleared.` : '',
      ...refused.map(entry => `${entry.id}: ${entry.reason}`),
    ].filter(Boolean).join(' ')
  } catch (error: any) {
    reviewError.value = true
    reviewNote.value = error?.data?.detail || error?.message || 'Could not update the approval.'
  } finally {
    approving.value = false
  }
}

async function approveSelected(): Promise<void> {
  const ids = [...reviewSelected.value]
  await callApprovals(ids, true)
  reviewSelected.value = []
}
async function approveOne(id: string): Promise<void> {
  await callApprovals([id], true)
}

async function redrawOne(id: string): Promise<void> {
  await draw(undefined, [id], true)
  reviewNote.value = 'Redo started. The old drawing moves to Trash; the new one appears when it is finished.'
  reviewError.value = false
}
async function redrawSelected(): Promise<void> {
  const ids = [...reviewSelected.value]
  if (!ids.length) return
  await draw(undefined, ids, true)
  reviewNote.value = `Redo started for ${ids.length} post(s). Their earlier drawings move to Trash.`
  reviewError.value = false
  reviewSelected.value = []
}

function toggleSelected(id: string): void {
  const index = reviewSelected.value.indexOf(id)
  if (index >= 0) reviewSelected.value.splice(index, 1)
  else reviewSelected.value.push(id)
}

// ── The post shown large ───────────────────────────────────────────────────

const focusedId = ref<string | null>(null)
const focused = computed<StillPost | null>(() => reviewPosts.value.find(post => post.id === focusedId.value) || null)
const position = computed(() => reviewPosts.value.findIndex(post => post.id === focusedId.value))
const showPrevious = ref(true)
void showPrevious
const reword = ref<{ panels: string[] }>({ panels: [] })
const savingWords = ref(false)
const wordNote = ref('')
const wordError = ref(false)

const dialogEl = ref<HTMLElement | null>(null)
// Focus the dialog when it opens, so the arrow, A and R keys reach it without a click first.
watch(focusedId, async (id) => {
  if (!id) return
  await nextTick()
  dialogEl.value?.focus()
})

function openPost(post: StillPost): void {
  focusedId.value = post.id
  reword.value = { panels: post.panels.map(panel => panel.text) }
  showPrevious.value = true
  wordNote.value = ''
  wordError.value = false
}
function close(): void {
  focusedId.value = null
}
function step(delta: number): void {
  const next = reviewPosts.value[position.value + delta]
  if (next) openPost(next)
}

/** The newest drawing a redo replaced, served from the channel's Trash. */
const latestRedraw = computed(() => {
  const list = focused.value?.redraws || []
  if (!list.length) return null
  return { record: list[list.length - 1]!, index: list.length - 1 }
})
const hasCollapsedRedraw = computed(() => (focused.value?.redraws?.length || 0) > 1)
const previousUrl = computed(() => {
  const entry = latestRedraw.value
  if (!entry || !focused.value) return null
  return `${fileBaseFor(focused.value)}/redraws/${entry.index}`
})
function fileBaseFor(post: StillPost): string {
  return `/api/projects/${slug.value}/still-posts/posts/${post.id}`
}

async function saveWords(): Promise<void> {
  const post = focused.value
  if (!post) return
  savingWords.value = true
  wordNote.value = ''
  try {
    const response = await put<{ post: StillPost, render_error: string | null, font_note?: string | null }>(
      `/api/projects/${slug.value}/still-posts/posts/${post.id}`,
      { panels: reword.value.panels.map(text => ({ text })) },
    )
    await load()
    // The saved post is a new post to approve (the words changed), and it is put back in focus.
    focusedId.value = response.post.id
    reword.value = { panels: response.post.panels.map(panel => panel.text) }
    wordError.value = !!response.render_error
    wordNote.value = [response.render_error
      ? `Saved. Nothing was re-lettered: ${response.render_error}`
      : 'Saved and re-lettered.', response.font_note].filter(Boolean).join(' ')
  } catch (error: any) {
    wordError.value = true
    wordNote.value = error?.data?.detail || error?.message || 'Could not save the words.'
  } finally {
    savingWords.value = false
  }
}

function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  // Typing in a field is typing, not a shortcut.
  if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) return
  const post = focused.value
  if (!post) return
  if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
  else if (event.key === 'Escape') { event.preventDefault(); close() }
  else if (event.key === 'a' || event.key === 'A') { if (!post.approved_at) void approveOne(post.id) }
  else if (event.key === 'r' || event.key === 'R') { if (canDraw.value) void redrawOne(post.id) }
  else if (event.key === ' ' || event.key === 'Spacebar') { event.preventDefault(); toggleSelected(post.id); void nextTick() }
}

defineExpose({ openPost, close, step, onKeydown })
</script>
