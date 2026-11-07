<!--
  Review finals (owner, 2026-10-29; redesigned 2026-11-01; compact rows 2026-11-02; Pass + auto-pass 2026-11-07).

  One private, mobile-friendly page over the app's existing Tailscale path: the
  finished videos of every channel, newest unreviewed first.
  Each one streams through Story's own authenticated range route — the browser
  holds only the HttpOnly session cookie that server mode already issues, so no
  key or bearer ever reaches a URL or the page.

  A mark here is a REVIEW NOTE ONLY. It does not upload, schedule or publish
  anything, and no pipeline step reads it. A channel that never opts in looks
  exactly as it did before.

  New finals arrive by polling the same live route the rest of the app reads
  (20 s while the tab is visible), which also catches hand-imported finals that
  no job stream would announce.
-->
<template>
  <div class="rv-page page-frame">
    <PlainBackLink />
    <PageTitle
      title="Review finals"
      description="Finished videos, newest unreviewed first. A mark here is a review note only — it does not upload, schedule or publish."
    />
    <ApiDataStatus path="/review/finals" @retry="load" />

    <p v-if="loadError" class="rv-alert" role="alert">
      {{ loadError }}
      <button type="button" class="rv-retry" @click="load(false)">Retry</button>
    </p>

    <nav v-if="sortedChannels.length" class="rv-channels" aria-label="Channel filter">
      <button
        type="button"
        class="rv-chip"
        :class="{ 'rv-chip-active': !selectedChannel }"
        @click="selectedChannel = ''"
      >
        <span class="rv-chip-name">All channels</span>
        <span class="rv-chip-count">
          {{ unreviewedCount }} / {{ totalFinals }}
          <template v-if="totalAutoPassed > 0"> · {{ totalAutoPassed }} auto-passed</template>
        </span>
      </button>
      <button
        v-for="channel in sortedChannels"
        :key="channel.slug"
        type="button"
        class="rv-chip"
        :class="{ 'rv-chip-active': selectedChannel === channel.slug }"
        @click="selectedChannel = channel.slug"
      >
        <span class="rv-chip-name">{{ channel.name }}</span>
        <span class="rv-chip-count">
          {{ unreviewedByChannel(channel.slug) }} / {{ channel.final_count }}
          <template v-if="autoPassedByChannel(channel.slug) > 0"> · {{ autoPassedByChannel(channel.slug) }} auto-passed</template>
        </span>
      </button>
    </nav>

    <div v-if="selectedChannel" class="rv-channel-settings">
      <div class="rv-channel-switches">
        <label class="rv-toggle">
          <input
            type="checkbox"
            :checked="selectedChannelData?.review_enabled ?? false"
            :disabled="toggling.has(selectedChannel)"
            @change="onToggleSelected($event)"
          >
          <span>Review on for {{ selectedChannelData?.name }}</span>
        </label>
        <label class="rv-toggle" :class="{ 'rv-toggle-disabled': !selectedChannelData?.review_enabled }">
          <input
            type="checkbox"
            :checked="selectedChannelData?.auto_pass_enabled ?? false"
            :disabled="!selectedChannelData?.review_enabled || toggling.has(selectedChannel)"
            @change="onToggleAutoPassSelected($event)"
          >
          <span>Auto-pass finished videos</span>
        </label>
      </div>
      <p v-if="selectedChannelData?.error" class="rv-alert rv-alert-sm" role="alert">{{ selectedChannelData.error }}</p>
    </div>

    <p v-if="loading && !filteredFinals.length" class="rv-empty" role="status">Loading finished videos…</p>
    <p v-else-if="!totalFinals" class="rv-empty">
      No finished videos are waiting. Turn review on for a channel above to start seeing finished videos here.
    </p>
    <p v-else-if="!filteredFinals.length" class="rv-empty">
      {{ selectedChannelData ? `No finished videos for ${selectedChannelData.name}.` : 'No finished videos match this filter.' }}
    </p>

    <p v-else class="rv-summary" role="status">
      <span v-if="unreviewedInFilter > 0">
        {{ unreviewedInFilter }} video{{ unreviewedInFilter === 1 ? '' : 's' }} to review. Start with the top one.
      </span>
      <span v-else-if="autoPassedInFilter > 0">
        Nothing left to review. {{ autoPassedInFilter }} auto-passed — not reviewed by you.
      </span>
      <span v-else>All reviewed.</span>
    </p>

    <article
      v-for="item in filteredFinals"
      :key="`${item.channel_slug}/${item.episode_code}`"
      class="rv-row"
      :class="{ 'rv-row-reviewed': item.review.state !== 'not_reviewed' && item.review.state !== 'unreadable' }"
    >
      <div class="rv-row-head">
        <span class="rv-row-channel">{{ item.channel_name }}</span>
        <span class="rv-row-state" :data-state="markTone(item.review)">{{ stateShort(item.review) }}</span>
      </div>
      <h2 class="rv-row-title">{{ item.episode_code }} · {{ item.title }}</h2>
      <p class="rv-row-sub">{{ finishedAt(item.mtime_ms) }}</p>

      <video
        v-if="openRow === itemKey(item)"
        class="rv-video"
        :src="item.stream_url"
        controls
        preload="metadata"
        playsinline
      >
        This video cannot play in your browser.
      </video>

      <p v-if="item.review.state === 'unreadable'" class="rv-alert" role="alert">{{ item.review.error }}</p>
      <p v-if="item.review.state === 'stale'" class="rv-mark rv-mark-stale">
        This file changed since it was marked {{ item.review.decision === 'approved' ? 'passed' : item.review.decision === 'auto_passed' ? 'auto-passed' : 'as needing changes' }}. Watch it again, then mark it.
      </p>
      <p v-if="item.auto_pass_error" class="rv-alert" role="alert">{{ item.auto_pass_error }}</p>
      <p v-if="saveError[itemKey(item)]" class="rv-alert" role="alert">{{ saveError[itemKey(item)] }}</p>

      <div class="rv-row-actions">
        <button
          type="button"
          class="rv-btn rv-btn-play"
          :aria-expanded="openRow === itemKey(item)"
          :aria-label="`${openRow === itemKey(item) ? 'Close' : 'Play'} ${item.episode_code} ${item.title}`"
          @click="toggleRow(itemKey(item))"
        >{{ openRow === itemKey(item) ? 'Close' : 'Play' }}</button>
        <NuxtLink
          :to="`/projects/${item.channel_slug}/video-assembly?episode_id=${item.episode_code}`"
          class="rv-btn rv-btn-view"
        >View episode</NuxtLink>
        <button
          type="button"
          class="rv-btn rv-btn-ok"
          :class="{ chosen: currentDecision(item.review) === 'approved' }"
          :disabled="saving.has(itemKey(item))"
          @click="decide(item, 'approved')"
        >{{ saving.has(itemKey(item)) ? 'Saving…' : 'Pass' }}</button>
        <button
          type="button"
          class="rv-btn rv-btn-changes"
          :class="{ chosen: currentDecision(item.review) === 'needs_changes' }"
          :disabled="saving.has(itemKey(item))"
          @click="decide(item, 'needs_changes')"
        >{{ saving.has(itemKey(item)) ? 'Saving…' : 'Needs changes' }}</button>
        <button
          v-if="currentDecision(item.review) === 'auto_passed'"
          type="button"
          class="rv-btn rv-btn-clear"
          :disabled="saving.has(itemKey(item))"
          @click="clearDecision(item)"
        >{{ saving.has(itemKey(item)) ? 'Saving…' : 'Clear auto-pass' }}</button>
      </div>
    </article>

    <p class="rv-foot">
      Review marks are shown on the channel's Production Board and in Video Assembly. They never
      block a render, an upload or a schedule.
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type {
  FinalReviewChannel,
  FinalReviewDecision,
  FinalReviewItem,
  FinalReviewListResponse,
  FinalReviewState,
} from '@shared/final-review'
import { useApi } from '~/composables/useApi'
import { createVisibleInterval } from '~/composables/useVisibleInterval'

definePageMeta({ layout: 'default' })

const { get, post, put } = useApi()

const channels = ref<FinalReviewChannel[]>([])
const finals = ref<FinalReviewItem[]>([])
const loading = ref(true)
const loadError = ref('')
const saving = ref<Set<string>>(new Set())
const toggling = ref<Set<string>>(new Set())
const saveError = ref<Record<string, string>>({})
const selectedChannel = ref('')
const openRow = ref('')

const totalFinals = computed(() => finals.value.length)

const unreviewedCount = computed(() => {
  return finals.value.filter(item => item.review.state === 'not_reviewed').length
})

const totalAutoPassed = computed(() => {
  return finals.value.filter(item => item.review.state === 'current' && item.review.decision === 'auto_passed').length
})

const filteredFinals = computed(() => {
  const list = selectedChannel.value
    ? finals.value.filter(item => item.channel_slug === selectedChannel.value)
    : finals.value
  // Sort: unreviewed first, then by newest
  return [...list].sort((a, b) => {
    const aUnrev = a.review.state === 'not_reviewed' ? 0 : 1
    const bUnrev = b.review.state === 'not_reviewed' ? 0 : 1
    if (aUnrev !== bUnrev) return aUnrev - bUnrev
    return b.mtime_ms - a.mtime_ms
  })
})

const unreviewedInFilter = computed(() => {
  return filteredFinals.value.filter(item => item.review.state === 'not_reviewed').length
})

// Auto-passed finals leave the review count but must never read as reviewed
// by the owner (Brief H), so the summary names them when nothing is left.
const autoPassedInFilter = computed(() => {
  return filteredFinals.value.filter(item => item.review.state === 'current' && item.review.decision === 'auto_passed').length
})

/** Channels sorted unreviewed-first so a channel needing attention leads. */
const sortedChannels = computed(() => {
  return [...channels.value].sort((a, b) => {
    const aUn = unreviewedByChannel(a.slug)
    const bUn = unreviewedByChannel(b.slug)
    if (aUn !== bUn) return bUn - aUn
    return a.name.localeCompare(b.name)
  })
})

const selectedChannelData = computed(() => {
  return channels.value.find(c => c.slug === selectedChannel.value) || null
})

function unreviewedByChannel(slug: string): number {
  return finals.value.filter(item => item.channel_slug === slug && item.review.state === 'not_reviewed').length
}

function autoPassedByChannel(slug: string): number {
  return finals.value.filter(item => item.channel_slug === slug && item.review.state === 'current' && item.review.decision === 'auto_passed').length
}

/** One key per final: two channels can share an episode code (§4). */
function itemKey(item: FinalReviewItem): string {
  return `${item.channel_slug}/${item.episode_code}`
}

function toggleRow(key: string): void {
  openRow.value = openRow.value === key ? '' : key
}

async function load(quiet = false): Promise<void> {
  if (!quiet) loading.value = true
  try {
    const data = await get<FinalReviewListResponse>('/review/finals')
    channels.value = data.channels || []
    finals.value = data.finals || []
    loadError.value = ''
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'Could not load your finished videos.'
  } finally {
    loading.value = false
  }
}

async function decide(item: FinalReviewItem, decision: FinalReviewDecision): Promise<void> {
  const key = itemKey(item)
  if (saving.value.has(key)) return
  saving.value = new Set(saving.value).add(key)
  const cleared = { ...saveError.value }
  delete cleared[key]
  saveError.value = cleared
  try {
    // expected_* names the file the reviewer is looking at: if a re-render
    // landed while they watched, the server refuses instead of stamping the
    // mark onto bytes nobody saw.
    const result = await post<{ review: FinalReviewState }>(
      `/review/finals/${encodeURIComponent(item.channel_slug)}/${encodeURIComponent(item.episode_code)}`,
      { decision, expected_size: item.size, expected_mtime_ms: item.mtime_ms, expected_ino: item.ino },
    )
    item.review = result.review
    item.auto_pass_error = undefined
  } catch (e: any) {
    saveError.value = { ...saveError.value, [key]: e?.data?.detail || 'Could not save that mark.' }
    if (e?.status === 409 || e?.response?.status === 409) await load(true)
  } finally {
    const next = new Set(saving.value)
    next.delete(key)
    saving.value = next
  }
}

async function clearDecision(item: FinalReviewItem): Promise<void> {
  const key = itemKey(item)
  if (saving.value.has(key)) return
  saving.value = new Set(saving.value).add(key)
  const cleared = { ...saveError.value }
  delete cleared[key]
  saveError.value = cleared
  try {
    // Same identity check as a mark: a final that changed under the reviewer
    // gets a 409 instead of a clear landing on bytes they never watched.
    const result = await post<{ review: FinalReviewState }>(
      `/review/finals/${encodeURIComponent(item.channel_slug)}/${encodeURIComponent(item.episode_code)}`,
      { decision: 'clear', expected_size: item.size, expected_mtime_ms: item.mtime_ms, expected_ino: item.ino },
    )
    item.review = result.review
    item.auto_pass_error = undefined
  } catch (e: any) {
    saveError.value = { ...saveError.value, [key]: e?.data?.detail || 'Could not clear that mark.' }
    if (e?.status === 409 || e?.response?.status === 409) await load(true)
  } finally {
    const next = new Set(saving.value)
    next.delete(key)
    saving.value = next
  }
}

function onToggleSelected(event: Event): void {
  const channel = selectedChannelData.value
  if (channel) void toggleChannelReview(channel, (event.target as HTMLInputElement).checked)
}

function onToggleAutoPassSelected(event: Event): void {
  const channel = selectedChannelData.value
  if (channel) void toggleChannelAutoPass(channel, (event.target as HTMLInputElement).checked)
}

async function toggleChannelReview(channel: FinalReviewChannel, enabled: boolean): Promise<void> {
  if (toggling.value.has(channel.slug)) return
  toggling.value = new Set(toggling.value).add(channel.slug)
  try {
    await put(`/review/channels/${encodeURIComponent(channel.slug)}`, { enabled })
    await load(true)
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'Could not change that channel\'s review setting.'
  } finally {
    const next = new Set(toggling.value)
    next.delete(channel.slug)
    toggling.value = next
  }
}

async function toggleChannelAutoPass(channel: FinalReviewChannel, auto_pass: boolean): Promise<void> {
  if (toggling.value.has(channel.slug)) return
  toggling.value = new Set(toggling.value).add(channel.slug)
  try {
    await put(`/review/channels/${encodeURIComponent(channel.slug)}`, { auto_pass })
    await load(true)
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'Could not change that channel\'s auto-pass setting.'
  } finally {
    const next = new Set(toggling.value)
    next.delete(channel.slug)
    toggling.value = next
  }
}

function currentDecision(review: FinalReviewState): FinalReviewDecision | null {
  // A stale mark is about bytes nobody has watched, so no button reads as already chosen.
  return review.state === 'current' ? review.decision : null
}

function markTone(review: FinalReviewState): string {
  if (review.state === 'unreadable') return 'unreadable'
  if (review.state === 'stale') return 'stale'
  if (review.state === 'current') return review.decision
  return 'none'
}

/** Short state label for the compact row. */
function stateShort(review: FinalReviewState): string {
  if (review.state === 'not_reviewed') return 'Not reviewed'
  if (review.state === 'unreadable') return 'Could not be read'
  if (review.state === 'stale') return 'File changed'
  if (review.decision === 'approved') return 'Passed'
  if (review.decision === 'auto_passed') return 'Auto-passed'
  return 'Needs changes'
}

function finishedAt(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown time'
  return new Date(ms).toLocaleString()
}

const poller = createVisibleInterval(() => { void load(true) }, 20_000)

// If the selected channel is removed from the list, clear the filter.
watch(channels, (list) => {
  if (selectedChannel.value && !list.find(c => c.slug === selectedChannel.value)) {
    selectedChannel.value = ''
  }
})

onMounted(() => {
  void load()
  poller.start()
})
onUnmounted(() => poller.stop())
</script>

<style scoped>
/* The outer wrapper only: .page-frame owns width, margin and padding. It used
   to pin this page to a centred 720px column while publishing ran edge to edge.
   The flex column and its gap stay — that is this page's own vertical rhythm. */
.rv-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.rv-alert {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--danger, #c0392b);
  border-radius: 8px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: var(--font-sm);
}
.rv-alert-sm { margin-top: 6px; }

.rv-retry {
  margin-left: 8px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--font-xs);
  cursor: pointer;
}
.rv-retry:hover { background: var(--bg-secondary); }

.rv-channels {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0;
  margin: 0;
}

.rv-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 20px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--font-sm);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.rv-chip:hover { background: var(--bg-secondary); }
/* Scoped CSS appends [data-v-*] to the end, so `.rv-chip[data-v]:hover`
   outranks `.rv-chip-active[data-v]`. Without the matching hover, resting the
   mouse on the selected chip painted it --bg-secondary (#fff here) while its
   label stayed #fff — an invisible chip. Say so for the active one too. */
.rv-chip-active,
.rv-chip-active:hover {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
}
.rv-chip-name { font-weight: 500; }
.rv-chip-count { font-size: var(--font-xs); opacity: 0.8; }

.rv-channel-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-secondary);
}

.rv-channel-switches {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
}

.rv-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  cursor: pointer;
}
.rv-toggle input { width: 20px; height: 20px; }
.rv-toggle-disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.rv-empty { color: var(--text-secondary); text-align: center; padding: 24px 8px; margin: 0; }

.rv-summary {
  margin: 0;
  padding: 8px 0;
  font-size: var(--font-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.rv-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rv-row + .rv-row { margin-top: 8px; }
.rv-row-reviewed { opacity: 0.75; }
.rv-row-reviewed .rv-row-state[data-state='approved'] { color: var(--success); }
.rv-row-reviewed .rv-row-state[data-state='auto_passed'] { color: var(--accent, #2563eb); }
.rv-row-reviewed .rv-row-state[data-state='needs_changes'] { color: var(--error); }

.rv-row-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.rv-row-channel {
  margin: 0;
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--accent, #2563eb);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.rv-row-state {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-secondary);
  white-space: nowrap;
}
.rv-row-state[data-state='approved'] { color: var(--success); }
.rv-row-state[data-state='auto_passed'] { color: var(--accent, #2563eb); }
.rv-row-state[data-state='needs_changes'] { color: var(--error); }
.rv-row-state[data-state='stale'] { color: var(--warning); }
.rv-row-state[data-state='unreadable'] { color: var(--error); }

.rv-row-title { margin: 0; font-size: var(--font-sm); font-weight: 600; line-height: 1.35; }
.rv-row-sub { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); }
.rv-video { width: 100%; height: auto; border-radius: 8px; background: #000; margin: 4px 0; }

.rv-mark-stale { margin: 0; font-size: var(--font-xs); color: var(--warning); }

.rv-row-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
}
.rv-btn {
  flex: 1 1 auto;
  min-height: 36px;
  min-width: 0;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: var(--font-xs);
  font-weight: 600;
  cursor: pointer;
  text-align: center;
  white-space: nowrap;
  transition: opacity 0.15s, background 0.15s, border-color 0.15s;
}
.rv-btn:disabled { opacity: 0.6; cursor: default; }

/* Play is the emphasised primary button */
.rv-btn-play {
  background: var(--accent, #2563eb);
  border-color: var(--accent, #2563eb);
  color: #fff;
  font-weight: 650;
}
.rv-btn-play:hover:not(:disabled) {
  opacity: 0.9;
}

.rv-btn-view {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  text-decoration: none;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
}
.rv-btn-view:hover {
  background: var(--bg-secondary);
}

.rv-btn-ok.chosen { border-color: #1d7a46; background: #1d7a46; color: #fff; }
.rv-btn-changes.chosen { border-color: var(--danger, #c0392b); background: var(--danger, #c0392b); color: #fff; }

.rv-btn-clear {
  border-color: var(--border);
  background: var(--bg-secondary);
  color: var(--text-secondary);
}
.rv-btn-clear:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}

.rv-foot { margin: 0; color: var(--text-secondary); font-size: var(--font-xs); line-height: 1.45; }

/* 2x2 grid on mobile viewports (≤480px and specifically 375px) */
@media (max-width: 480px) {
  .rv-row-actions {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
  }
  .rv-btn {
    width: 100%;
    flex: none;
  }
  .rv-btn-clear {
    grid-column: 1 / -1;
  }
}
</style>
