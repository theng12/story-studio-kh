<template>
  <div class="uc-comments">
    <p v-if="loading" class="hint">Loading the comment inbox…</p>
    <p v-else-if="loadError" class="result err">{{ loadError }}</p>

    <template v-else>
      <section class="panel header">
        <div>
          <span class="eyebrow">Inbox</span>
          <h3>{{ headline }}</h3>
          <p class="hint">
            Comments are read from a saved copy, so opening this costs nothing. Fetching them again
            is the only thing here that contacts YouTube.
          </p>
        </div>
        <div class="field-row">
          <button
            class="btn btn-sm"
            type="button"
            :disabled="busy !== '' || !inbox.channel_assigned"
            @click="refresh"
          >
            {{ busy === 'refresh' ? 'Fetching…' : 'Fetch comments from YouTube' }}
          </button>
        </div>
      </section>

      <!--
        Without an assigned channel there is no way to tell which videos are
        this project's, or which replies are ours — so the fetch is refused
        rather than guessed at. Say that here instead of on a failed click.
      -->
      <section v-if="!inbox.channel_assigned" class="panel hint-panel" role="status">
        <p class="hint">
          No YouTube channel is assigned to this project yet, so comments cannot be fetched.
          Assign a channel on the Upload Center overview first.
        </p>
      </section>

      <!-- Exactly what the sweep reported, never "some may be missing". -->
      <section v-if="inbox.partial" class="panel partial" role="status">
        <h3>{{ PARTIAL_HEADINGS[inbox.partial_reason || ''] || 'This is not the whole inbox' }}</h3>
        <p>{{ PARTIAL_BODIES[inbox.partial_reason || ''] || 'The last fetch stopped before it had seen everything.' }}</p>
        <p v-if="inbox.unreached_video_ids.length" class="hint">
          Never opened: {{ inbox.unreached_video_ids.join(', ') }}
        </p>
        <!--
          A different fact from the line above: these WERE read, and what is on
          screen for them is real — there is simply more behind it. Calling them
          "not reached" said the visible comments were not there.
        -->
        <p v-if="inbox.partially_read_video_ids.length" class="hint">
          Read, but has more than one fetch could return:
          {{ inbox.partially_read_video_ids.join(', ') }}
        </p>
      </section>

      <section v-if="inbox.comments_disabled_video_ids.length" class="panel hint-panel" role="status">
        <p class="hint">
          Comments are turned off on {{ inbox.comments_disabled_video_ids.length }} video(s):
          {{ inbox.comments_disabled_video_ids.join(', ') }}. Nobody can reply to those.
        </p>
      </section>

      <section class="panel views">
        <div class="field-row">
          <button
            v-for="option in VIEWS" :key="option.id" type="button"
            :class="['btn', 'btn-sm', view === option.id ? 'btn-primary' : '']"
            @click="view = option.id"
          >
            {{ option.label }} ({{ countFor(option.id) }})
          </button>
        </div>
        <div class="filters">
          <label>
            <span>Search</span>
            <input v-model="search" class="input" type="search" placeholder="Comment text or author" />
          </label>
          <label>
            <span>Video</span>
            <select v-model="videoFilter" class="input">
              <option value="">Any video</option>
              <option v-for="id in videoIds" :key="id" :value="id">{{ id }}</option>
            </select>
          </label>
          <label>
            <span>Author</span>
            <select v-model="authorFilter" class="input">
              <option value="">Any author</option>
              <option v-for="name in authors" :key="name" :value="name">{{ name }}</option>
            </select>
          </label>
          <label>
            <span>Since</span>
            <input v-model="sinceFilter" class="input" type="date" />
          </label>
          <button v-if="filtersActive" class="btn btn-ghost btn-sm" type="button" @click="clearFilters">
            Clear filters
          </button>
        </div>
      </section>

      <!-- Bulk approve/reject: preview with exact counts, then confirm. -->
      <section v-if="selected.size" class="panel bulk">
        <div>
          <span class="eyebrow">{{ selected.size }} selected</span>
          <h3>Approve or reject them together</h3>
          <p class="hint">Banning is never part of this — it is one author at a time.</p>
        </div>
        <div class="field-row">
          <button class="btn btn-sm" type="button" :disabled="busy !== ''" @click="previewBulk('approve')">
            Preview approving
          </button>
          <button class="btn btn-sm" type="button" :disabled="busy !== ''" @click="previewBulk('reject')">
            Preview rejecting
          </button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="selected.clear()">
            Clear selection
          </button>
        </div>
        <div v-if="bulkPreview" class="preview">
          <p>
            <b>{{ bulkPreview.counts.will_change }}</b> will change ·
            <b>{{ bulkPreview.counts.already }}</b> already that way ·
            <b>{{ bulkPreview.counts.unknown }}</b> not in this inbox
          </p>
          <div class="field-row">
            <button class="btn btn-sm btn-primary" type="button"
              :disabled="busy !== '' || bulkPreview.counts.will_change === 0" @click="applyBulk">
              {{ bulkPreview.action === 'approve' ? 'Approve' : 'Reject' }} {{ bulkPreview.counts.will_change }} now
            </button>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="bulkPreview = null">
              Cancel
            </button>
          </div>
        </div>
      </section>

      <section class="panel list">
        <div>
          <h3>{{ visible.length === 0 ? emptyHeadline : `${visible.length} comment${visible.length === 1 ? '' : 's'}` }}</h3>
          <p v-if="visible.length === 0" class="hint">{{ emptyBody }}</p>
        </div>

        <ul v-if="visible.length" class="comment-list">
          <li v-for="comment in visible" :key="comment.comment_id" class="comment">
            <div class="comment-head">
              <label class="pick">
                <input type="checkbox" :checked="selected.has(comment.comment_id)"
                  :aria-label="`Select comment by ${comment.author}`"
                  @change="toggle(comment.comment_id)" />
              </label>
              <!-- Author names are author-controlled too: text, never markup. -->
              <strong>{{ comment.author }}</strong>
              <span class="hint">{{ formatWhen(comment.published_at) }} · {{ comment.video_id }}</span>
            </div>
            <!-- Interpolation escapes. Nothing here renders HTML or markdown. -->
            <p class="comment-text">{{ comment.text }}</p>
            <!-- The whole thread, so a reply is written with its context. -->
            <ul v-if="comment.replies.length" class="replies">
              <li v-for="reply in comment.replies" :key="reply.comment_id">
                <strong>{{ reply.from_channel ? 'You' : reply.author }}</strong>
                <span class="reply-text">{{ reply.text }}</span>
              </li>
            </ul>
            <p v-else-if="comment.reply_count > 0" class="hint">
              {{ comment.reply_count }} repl{{ comment.reply_count === 1 ? 'y' : 'ies' }} on YouTube, not fetched here.
            </p>

            <div class="comment-actions">
              <button class="btn btn-ghost btn-sm" type="button"
                :disabled="busy !== '' || !comment.can_reply"
                :title="comment.can_reply ? '' : 'YouTube has closed replies on this thread.'"
                @click="replyingTo = comment.comment_id">Reply</button>
              <button v-if="comment.moderation_status !== 'published'" class="btn btn-ghost btn-sm"
                type="button" :disabled="busy !== ''" @click="moderate([comment.comment_id], 'approve')">Approve</button>
              <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''"
                @click="rejectComment(comment)">Reject</button>
              <button class="btn btn-ghost btn-sm danger" type="button" :disabled="busy !== ''"
                @click="banAuthor(comment)">Reject and ban author…</button>
            </div>
            <div v-if="replyingTo === comment.comment_id" class="reply">
              <p class="hint">Replying to <strong>{{ comment.author }}</strong></p>
              <textarea v-model="replyText" class="input" rows="3" placeholder="Write a reply…"></textarea>
              <div class="field-row">
                <button class="btn btn-sm btn-primary" type="button" :disabled="busy !== '' || !replyText.trim()"
                  @click="sendReply(comment)">Post reply</button>
                <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''"
                  @click="replyingTo = ''">Cancel</button>
              </div>
            </div>
          </li>
        </ul>
        <p v-if="actionResult" :class="['result', actionResult.kind]">{{ actionResult.message }}</p>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
interface Comment {
  comment_id: string
  video_id: string
  author: string
  text: string
  published_at: string
  moderation_status: string
  channel_replied: boolean
  reply_count: number
  replies: Array<{ comment_id: string; author: string; text: string; from_channel: boolean }>
  can_reply: boolean
}
interface Inbox {
  comments: Comment[]
  receipts: Array<{ receipt_id: string; outcome: string }>
  fetched_at: string | null
  partial: boolean
  partial_reason?: string
  unreached_video_ids: string[]
  partially_read_video_ids: string[]
  comments_disabled_video_ids: string[]
  never_fetched: boolean
  channel_assigned: boolean
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post } = useApi()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const view = ref<'published' | 'held' | 'needs_reply'>('needs_reply')
const replyingTo = ref('')
const search = ref('')
const videoFilter = ref('')
const authorFilter = ref('')
const sinceFilter = ref('')
const selected = reactive(new Set<string>())
const bulkPreview = ref<{ action: string; counts: { will_change: number; already: number; unknown: number } } | null>(null)
const replyText = ref('')
const actionResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)
const inbox = ref<Inbox>({
  comments: [], receipts: [], fetched_at: null, partial: false,
  unreached_video_ids: [], partially_read_video_ids: [],
  comments_disabled_video_ids: [], never_fetched: true,
  // Never rendered: the template waits for the load. Assumed-assigned so a
  // slow load cannot flash a "no channel" notice at a project that has one.
  channel_assigned: true,
})

const VIEWS = [
  { id: 'needs_reply' as const, label: 'Needs reply' },
  { id: 'published' as const, label: 'Published' },
  { id: 'held' as const, label: 'Held for review' },
]

/** Each reason gets its own words — they call for different responses. */
const PARTIAL_HEADINGS: Record<string, string> = {
  quota_exhausted: 'Today’s allowance ran out partway through',
  provider_error: 'YouTube stopped answering partway through',
  limit_reached: 'Only the first batch was fetched',
}
const PARTIAL_BODIES: Record<string, string> = {
  quota_exhausted: 'What you see below is what was fetched before the allowance ran out. The rest is not missing — it has not been looked at yet.',
  provider_error: 'What you see below is what was fetched before YouTube stopped answering. Fetch again to continue.',
  limit_reached: 'This is the newest batch, and it is as far as one fetch reaches. Fetching again re-reads the same batch rather than going further back, so it will not add older comments.',
}

function matchesView(comment: Comment, which: string): boolean {
  if (which === 'published') return comment.moderation_status === 'published'
  if (which === 'held') return comment.moderation_status === 'heldForReview'
  return comment.moderation_status === 'published' && !comment.channel_replied
}

/**
 * Filters run over the cached inbox, so narrowing costs nothing and never
 * spends quota. Search matches text OR author — both are the reader's words
 * for "find the one I remember".
 */
function matchesFilters(comment: Comment): boolean {
  const term = search.value.trim().toLowerCase()
  if (term && !comment.text.toLowerCase().includes(term) && !comment.author.toLowerCase().includes(term)) return false
  if (videoFilter.value && comment.video_id !== videoFilter.value) return false
  if (authorFilter.value && comment.author !== authorFilter.value) return false
  if (sinceFilter.value) {
    const since = Date.parse(`${sinceFilter.value}T00:00:00`)
    const at = Date.parse(comment.published_at)
    if (Number.isFinite(since) && Number.isFinite(at) && at < since) return false
  }
  return true
}

const filtersActive = computed(() =>
  !!search.value.trim() || !!videoFilter.value || !!authorFilter.value || !!sinceFilter.value)

function clearFilters(): void {
  search.value = ''
  videoFilter.value = ''
  authorFilter.value = ''
  sinceFilter.value = ''
}

const videoIds = computed(() => [...new Set(inbox.value.comments.map(c => c.video_id))].sort())
const authors = computed(() => [...new Set(inbox.value.comments.map(c => c.author))].sort())

const visible = computed(() =>
  inbox.value.comments.filter(c => matchesView(c, view.value) && matchesFilters(c)))

// The selection is only ever what the person can see: changing the view or any
// filter would otherwise leave hidden comments selected, and "Approve/Reject N
// now" would act on them.
watch([view, search, videoFilter, authorFilter, sinceFilter], () => {
  selected.clear()
  bulkPreview.value = null
})

// A half-written reply belongs to one comment; never carry it to another.
watch(replyingTo, () => { replyText.value = '' })

function toggle(commentId: string): void {
  // The preview counted the old selection — make it be asked for again.
  bulkPreview.value = null
  if (selected.has(commentId)) selected.delete(commentId)
  else selected.add(commentId)
}

/** No bulk action without exact counts by outcome, then a separate confirm. */
const previewBulk = (action: 'approve' | 'reject') => run('preview', async () => {
  const res = await post<{ counts: { will_change: number; already: number; unknown: number } }>(
    `/projects/${slug.value}/youtube/comments/moderate/preview`,
    { action, comment_ids: [...selected] },
  )
  bulkPreview.value = { action, counts: res.counts }
})

const applyBulk = () => run('bulk', async () => {
  const action = bulkPreview.value!.action as 'approve' | 'reject'
  await moderateIds([...selected], action)
  bulkPreview.value = null
  selected.clear()
})
// Deliberately unfiltered: the view counts say how much work exists, not how
// much a search happens to be showing.
const countFor = (which: string) => inbox.value.comments.filter(c => matchesView(c, which)).length

const headline = computed(() => {
  if (inbox.value.never_fetched) return 'Comments have not been fetched yet'
  return `Last fetched ${formatWhen(inbox.value.fetched_at)}`
})

/** Never-fetched, nothing-here, and none-in-this-view are three facts. */
const emptyHeadline = computed(() => {
  if (inbox.value.never_fetched) return 'Nothing fetched yet'
  if (!inbox.value.comments.length) return 'No comments on this channel’s videos'
  return 'Nothing in this view'
})
const emptyBody = computed(() => {
  if (inbox.value.never_fetched) return 'Fetch comments from YouTube to fill this inbox.'
  if (!inbox.value.comments.length) return 'The videos this project has published have no comments yet.'
  return 'Other views may still have comments waiting.'
})

function formatWhen(value: string | null | undefined): string {
  if (!value) return 'never'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'never' : parsed.toLocaleString()
}

async function load(): Promise<void> {
  try {
    inbox.value = await get<Inbox>(`/projects/${slug.value}/youtube/comments`)
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load the comment inbox.'
  } finally {
    loading.value = false
  }
}

async function run(key: string, fn: () => Promise<void>): Promise<void> {
  busy.value = key
  actionResult.value = null
  try {
    await fn()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'That did not work.' }
  } finally {
    busy.value = ''
  }
}

const refresh = () => run('refresh', async () => {
  const res = await post<{ fetched: number; partial: boolean }>(`/projects/${slug.value}/youtube/comments/refresh`, {})
  actionResult.value = {
    kind: res.partial ? 'warn' : 'ok',
    message: res.partial
      ? `Fetched ${res.fetched} so far — this is not the whole inbox.`
      : `Fetched ${res.fetched} comment(s).`,
  }
  await load()
})

async function moderateIds(commentIds: string[], action: 'approve' | 'reject'): Promise<void> {
  const res = await post<{ counts: { done: number; failed: number; unrecorded: number } }>(
    `/projects/${slug.value}/youtube/comments/moderate`, { action, comment_ids: commentIds },
  )
  actionResult.value = res.counts.unrecorded > 0
    ? { kind: 'warn', message: 'Done on YouTube, but Story Studio could not record it. Do not repeat it — check before acting again.' }
    : res.counts.failed > 0
      ? { kind: 'err', message: 'YouTube refused that.' }
      : { kind: 'ok', message: action === 'approve' ? 'Approved.' : 'Rejected and hidden, along with its replies.' }
  await load()
}

/** Reject without banning: confirmed, and says plainly what it does. */
const rejectComment = async (comment: Comment) => {
  const confirmed = await ask({
    title: `Reject ${comment.author}’s comment?`,
    message: 'This hides the comment on YouTube, along with its replies. The author is not banned and can keep commenting.',
    confirmLabel: 'Reject comment',
    danger: true,
  })
  if (!confirmed) return
  await moderate([comment.comment_id], 'reject')
}

const moderate = (commentIds: string[], action: 'approve' | 'reject') =>
  run(`mod-${commentIds[0]}`, () => moderateIds(commentIds, action))

/** Banning is individual, separately confirmed, and names the author. */
const banAuthor = (comment: Comment) => run(`ban-${comment.comment_id}`, async () => {
  const confirmed = await ask({
    title: `Ban ${comment.author}?`,
    message: `This rejects their comment and stops ${comment.author} commenting on this channel again. `
      + 'It applies to that one author, and Story Studio cannot undo it from here.',
    confirmLabel: 'Reject and ban',
    danger: true,
  })
  if (!confirmed) return
  await post(`/projects/${slug.value}/youtube/comments/ban`, { comment_id: comment.comment_id, confirm: true })
  actionResult.value = { kind: 'ok', message: `${comment.author} banned and their comment hidden.` }
  await load()
})

const sendReply = (comment: Comment) => run(`reply-${comment.comment_id}`, async () => {
  const res = await post<{ receipt: { outcome: string } }>(
    `/projects/${slug.value}/youtube/comments/reply`,
    { comment_id: comment.comment_id, text: replyText.value },
  )
  replyingTo.value = ''
  replyText.value = ''
  actionResult.value = res.receipt.outcome === 'unrecorded'
    ? { kind: 'warn', message: 'Reply posted, but Story Studio could not record it. Do not post it again without checking.' }
    : res.receipt.outcome === 'failed'
      ? { kind: 'err', message: 'YouTube refused that reply.' }
      : { kind: 'ok', message: 'Reply posted.' }
  await load()
})

onMounted(load)
</script>

<style scoped>
/* Declared so the @container rule applies; the repo-wide guard enforces it. */
.uc-comments { container-type: inline-size; container-name: uc-comments; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h3 { margin: 3px 0; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.partial h3 { color: var(--warning, #d97706); }
.field-row { display: flex; flex-wrap: wrap; gap: 7px; }

.comment-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.comment { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.comment > * { min-width: 0; }
.comment-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.comment-head strong { overflow-wrap: anywhere; }
/* Author text can be any length and any script; it must wrap, never overflow. */
.comment-text { margin: 0; color: var(--text-primary); font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; align-items: end; }
.filters label { display: grid; gap: 3px; font-size: var(--font-xs); color: var(--text-secondary); }
.bulk, .preview { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.pick { display: inline-flex; align-items: center; }
.replies { display: grid; gap: 4px; margin: 0; padding-left: 14px; list-style: none; border-left: 2px solid var(--border); }
.replies li { display: grid; gap: 1px; font-size: var(--font-xs); }
.reply-text { color: var(--text-secondary); white-space: pre-wrap; overflow-wrap: anywhere; }
.comment-actions .danger { color: var(--danger); }
.reply { display: grid; gap: 6px; }
.reply textarea { width: 100%; }

@container uc-comments (max-width: 620px) {
  .comment-actions .btn { flex: 1 1 auto; }
}
</style>
