<template>
  <div class="uc-reconcile">
    <p v-if="loading" class="hint">Loading what is not linked up…</p>
    <p v-else-if="loadError" class="result err">
      {{ loadError }}
      <button class="btn btn-sm" type="button" @click="retryLoad">Retry</button>
    </p>

    <template v-else>
      <!-- At the top so an undo failure is seen right next to the undo banners. -->
      <p v-if="actionResult" :class="['result', actionResult.kind]" role="status">{{ actionResult.message }}</p>

      <!--
        The promise Ideas and Settings make about Compact and Rebalance —
        "reversible for 30 days" — is honoured HERE. The routes behind it were
        deleted in the cutover while the sidecar kept being written, so the
        guarantee was still being made and could no longer be kept. A safety net
        on a destructive operation is not something to remove quietly.
      -->
      <section v-if="renumberUndo.available" class="panel undo" role="status">
        <div>
          <span class="eyebrow">Reversible</span>
          <h3>{{ renumberUndo.expired ? 'This renumber can no longer be undone' : 'A recent renumber can be undone' }}</h3>
          <p class="hint">
            {{ renumberUndo.renamed_count }} episode(s) renamed, {{ renumberUndo.adopted_count }} adopted.
            {{ renumberUndo.expired
              ? 'The 30-day window has passed, so the original numbering is no longer restorable.'
              : 'Undo puts every episode back to the numbering it had before.' }}
          </p>
        </div>
        <div class="field-row">
          <button
            v-if="!renumberUndo.expired"
            class="btn btn-sm"
            type="button"
            :disabled="renumberUndoBusy"
            @click="revertRenumber"
          >
            {{ renumberUndoBusy ? 'Undoing…' : 'Undo the Renumber' }}
          </button>
          <button class="btn btn-ghost btn-sm" type="button" :disabled="renumberUndoBusy" @click="dismissUndo">
            {{ renumberUndo.expired ? 'Dismiss' : 'Discard Undo' }}
          </button>
        </div>
      </section>

      <!--
        Rebalance's sibling banner. B3 restored reversibility for Compact and
        stopped there — but four of the nine repointed strings, and the release
        notes, are about REBALANCE, which moves folders on disk. Its routes
        already existed in routes/ideas.ts and nothing in the app called them,
        so the promise was still unkept for the more destructive of the two.
      -->
      <section v-if="reseasonUndo.available" class="panel undo" role="status">
        <div>
          <span class="eyebrow">Reversible</span>
          <h3>{{ reseasonUndo.expired ? 'This rebalance can no longer be undone' : 'A recent rebalance can be undone' }}</h3>
          <p class="hint">
            {{ reseasonUndo.moves_count }} episode folder(s) moved.
            {{ reseasonUndo.expired
              ? 'The 30-day window has passed, so the previous grouping is no longer restorable.'
              : 'Undo puts every episode folder back where it was.' }}
          </p>
        </div>
        <div class="field-row">
          <button
            v-if="!reseasonUndo.expired"
            class="btn btn-sm"
            type="button"
            :disabled="reseasonUndoBusy"
            @click="revertReseason"
          >
            {{ reseasonUndoBusy ? 'Undoing…' : 'Undo the Rebalance' }}
          </button>
        </div>
      </section>

      <section class="panel listing">
        <div>
          <span class="eyebrow">Channel listing</span>
          <h3>{{ listedCopy }}</h3>
          <p class="hint">
            This page matches your episodes to the videos on your YouTube channel. Refreshing the
            channel listing is the only thing here that contacts YouTube.
          </p>
        </div>
        <div class="field-row">
          <button class="btn btn-sm" type="button" :disabled="busy !== ''" @click="refreshRemote">
            {{ busy === 'refresh' ? 'Listing Videos…' : 'Refresh the Channel Listing' }}
          </button>
        </div>
      </section>

      <!-- Suggestions that link themselves, and those that do not. -->
      <section class="panel suggestions">
        <div>
          <span class="eyebrow">Suggestions</span>
          <h3>{{ candidates.length === 0 ? 'Nothing to suggest' : `${candidates.length} possible match${candidates.length === 1 ? '' : 'es'}` }}</h3>
          <p v-if="candidates.length === 0" class="hint">
            {{ nothingToSuggestCopy }}
          </p>
        </div>

        <div v-if="autoLinkable.length" class="bulk">
          <p class="hint">
            {{ autoLinkable.length }} of these can be linked without asking, because Story Studio
            already recorded the video for that episode.
          </p>
          <div class="field-row">
            <button class="btn btn-sm" type="button" :disabled="busy !== ''" @click="previewBulk">
              {{ busy === 'preview' ? 'Checking…' : 'Preview Linking Them' }}
            </button>
          </div>
          <!-- No bulk action without exact counts and a confirm. -->
          <div v-if="preview" class="preview">
            <p><b>{{ preview.counts.will_link }}</b> will be linked · <b>{{ preview.counts.already_linked }}</b> already linked ·
              <b>{{ preview.counts.cannot_link }}</b> cannot be linked without you</p>
            <ul v-if="preview.cannot_link.length" class="reasons">
              <li v-for="(row, i) in preview.cannot_link" :key="i">
                {{ row.episode_code }} → {{ row.video_id }}: {{ REASONS[row.reason] || row.reason }}
              </li>
            </ul>
            <div class="field-row">
              <button class="btn btn-sm btn-primary" type="button" :disabled="busy !== '' || preview.counts.will_link === 0"
                @click="applyBulk">Link {{ preview.counts.will_link }} now</button>
              <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="preview = null">Cancel</button>
            </div>
          </div>
        </div>

        <ul v-if="candidates.length" class="candidate-list">
          <li v-for="(candidate, i) in candidates" :key="i" class="candidate">
            <div>
              <strong>{{ candidate.episode_code }}</strong>
              <code class="muted">{{ candidate.video_id }}</code>
            </div>
            <div class="evidence">
              <span :class="['badge', candidate.auto_linkable ? 'exact' : 'suggestion']">
                {{ candidate.auto_linkable ? 'Recorded' : 'Not linked automatically' }}
              </span>
              <span class="hint">{{ candidate.reason }}</span>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="duplicates.length" class="panel duplicates">
        <div>
          <span class="eyebrow">Manual review elsewhere</span>
          <h3>{{ duplicates.length }} thing{{ duplicates.length === 1 ? '' : 's' }} more than one match could claim</h3>
          <p class="hint">
            These are not linked automatically. This bulk action cannot resolve an ambiguous match;
            settle it with the supported project records before returning here.
          </p>
        </div>
        <ul class="duplicate-list">
          <li v-for="(duplicate, i) in duplicates" :key="i">
            <strong>{{ duplicate.id }}</strong>
            <span class="hint">contested by {{ duplicate.competing.join(', ') }}</span>
          </li>
        </ul>
      </section>

      <section class="panel unmatched">
        <div>
          <span class="eyebrow">Unmatched</span>
          <h3>Nothing links these yet</h3>
        </div>
        <!--
          "In Story Studio only" means "YouTube does not have this". That is only
          true if the listing covered the whole channel — and it stops after a
          fixed number of pages. Say so, or the owner reads a paging limit as a
          missing upload.
        -->
        <p v-if="remoteTruncated" class="hint warn-text">
          The last listing did not reach older videos in this channel, so “In Story Studio only” below may
          name episodes whose videos simply were not listed. Another fetch starts at the newest videos again
          and will not reach the older ones.
        </p>
        <p class="hint"><b>In Story Studio only:</b> {{ localOnly.length ? localOnly.join(', ') : 'none' }}</p>
        <p class="hint"><b>On YouTube only:</b> {{ youtubeOnly.length ? youtubeOnly.join(', ') : 'none' }}</p>
        <ul v-if="youtubeOnly.length" class="orphan-list">
          <li v-for="videoId in youtubeOnly" :key="videoId">
            <code class="muted">{{ videoId }}</code>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="setAside(videoId, true)">
              Set Aside
            </button>
          </li>
        </ul>
        <p v-if="ignored.length" class="hint">
          <b>Set aside:</b> {{ ignored.join(', ') }} — kept out of the way, not lost.
        </p>
        <ul v-if="ignored.length" class="orphan-list">
          <li v-for="videoId in ignored" :key="videoId">
            <code class="muted">{{ videoId }}</code>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="setAside(videoId, false)">
              Bring Back
            </button>
          </li>
        </ul>
      </section>

      <section v-if="undoable.length" class="panel history">
        <div>
          <span class="eyebrow">Undo</span>
          <h3>Links made here</h3>
          <p class="hint">Every link made on this page can be undone.</p>
        </div>
        <ul class="history-list">
          <li v-for="decision in undoable" :key="decision.decision_id">
            <span>{{ decision.episode_code }} → {{ decision.next_video_id }}</span>
            <button class="btn btn-ghost btn-sm" type="button" :disabled="busy !== ''" @click="undo(decision)">
              {{ decision.previous_video_id ? `Undo (Back to ${decision.previous_video_id})` : 'Undo (Unlink)' }}
            </button>
          </li>
        </ul>
      </section>

    </template>
  </div>
</template>

<script setup lang="ts">
interface Candidate {
  episode_code: string
  video_id: string
  evidence: string
  reason: string
  auto_linkable: boolean
}
interface Decision {
  decision_id: string
  episode_code: string
  previous_video_id: string | null
  next_video_id: string
  rolled_back_at?: string
}
interface Preview {
  counts: { will_link: number; already_linked: number; cannot_link: number }
  cannot_link: Array<{ episode_code: string; video_id: string; reason: string }>
}

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, post, del } = useApi()
const { ask } = useConfirm()

const loading = ref(true)
const loadError = ref('')
const busy = ref('')
const candidates = ref<Candidate[]>([])
const localOnly = ref<string[]>([])
const remoteTruncated = ref(false)
const youtubeOnly = ref<string[]>([])
const duplicates = ref<Array<{ kind: string; id: string; competing: string[] }>>([])
const ignored = ref<string[]>([])
const history = ref<Decision[]>([])
const listedAt = ref<string | null>(null)
const preview = ref<Preview | null>(null)
const actionResult = ref<{ kind: 'ok' | 'warn' | 'err'; message: string } | null>(null)

const REASONS: Record<string, string> = {
  needs_confirmation: 'the evidence is a guess, so you decide',
  possible_duplicate_needs_review: 'more than one thing could claim this',
}

const autoLinkable = computed(() => candidates.value.filter(candidate => candidate.auto_linkable))
const undoable = computed(() => history.value.filter(decision => !decision.rolled_back_at))

/** Never imply the channel was listed when it never has been. */
const listedCopy = computed(() => {
  if (!listedAt.value) return 'This channel’s videos have not been listed yet'
  const parsed = new Date(listedAt.value)
  return Number.isNaN(parsed.getTime())
    ? 'This channel’s videos have not been listed yet'
    : `Channel listed ${parsed.toLocaleString()}`
})

/**
 * "Nothing to suggest" has three causes and they need different responses:
 * never listed, listed but nothing unlinked, listed and everything unmatched.
 */
const nothingToSuggestCopy = computed(() => {
  if (!listedAt.value) return 'Refresh the Channel Listing first — Story Studio has not seen this channel’s videos yet.'
  if (!localOnly.value.length && !youtubeOnly.value.length) return 'Every episode and every video is already linked.'
  return 'Nothing here matches anything else well enough to suggest. The unmatched items are listed below.'
})

interface UndoState {
  available: boolean
  expired?: boolean
  adopted_count?: number
  renamed_count?: number
}
const renumberUndo = ref<UndoState>({ available: false })
const renumberUndoBusy = ref(false)

async function loadUndo(): Promise<void> {
  try {
    renumberUndo.value = await get<UndoState>(`/projects/${slug.value}/upload/renumber-undo`)
  } catch {
    // Best effort: a missing undo record is the normal case, and failing to
    // read it must never stop Reconcile from loading.
    renumberUndo.value = { available: false }
  }
}

/** Put every episode back to the numbering it had before the renumber. */
async function revertRenumber(): Promise<void> {
  const confirmed = await ask({
    title: 'Undo the renumber?',
    message: 'Every episode goes back to the numbering it had before. Files are renamed back on disk.',
    confirmLabel: 'Undo',
  })
  if (!confirmed) return
  renumberUndoBusy.value = true
  actionResult.value = null
  try {
    await post(`/projects/${slug.value}/upload/renumber-undo/revert`, {})
    await loadUndo()
    await load()
  } catch (error: any) {
    // In-page result, not loadError: loadError replaces the whole page.
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Failed to undo the renumber.' }
  } finally {
    renumberUndoBusy.value = false
  }
}

/** Drop the undo record only after the remaining recovery window is acknowledged. */
async function dismissUndo(): Promise<void> {
  if (!renumberUndo.value.expired) {
    const confirmed = await ask({
      title: 'Discard this renumber undo?',
      message: 'This permanently removes the 30-day recovery record. This renumber can no longer be undone.',
      confirmLabel: 'Discard Undo',
    })
    if (!confirmed) return
  }
  renumberUndoBusy.value = true
  actionResult.value = null
  try {
    await del(`/projects/${slug.value}/upload/renumber-undo`)
    renumberUndo.value = { available: false }
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Could not discard the undo record.' }
  } finally {
    renumberUndoBusy.value = false
  }
}

interface ReseasonUndoState {
  available: boolean
  expired?: boolean
  moves_count?: number
}
const reseasonUndo = ref<ReseasonUndoState>({ available: false })
const reseasonUndoBusy = ref(false)

async function loadReseasonUndo(): Promise<void> {
  try {
    reseasonUndo.value = await get<ReseasonUndoState>(`/projects/${slug.value}/episodes/reseason-undo`)
  } catch {
    reseasonUndo.value = { available: false }
  }
}

/** Put every episode folder back where the rebalance moved it from. */
async function revertReseason(): Promise<void> {
  const confirmed = await ask({
    title: 'Undo the rebalance?',
    message: 'Every episode folder goes back to the grouping it had before. Folders are moved back on disk.',
    confirmLabel: 'Undo',
  })
  if (!confirmed) return
  reseasonUndoBusy.value = true
  actionResult.value = null
  try {
    await post(`/projects/${slug.value}/episodes/reseason-undo/revert`, {})
    await loadReseasonUndo()
    await load()
  } catch (error: any) {
    actionResult.value = { kind: 'err', message: error?.data?.detail || error?.message || 'Failed to undo the rebalance.' }
  } finally {
    reseasonUndoBusy.value = false
  }
}

async function load(): Promise<void> {
  try {
    const res = await get<any>(`/projects/${slug.value}/youtube/reconcile`)
    candidates.value = res.candidates ?? []
    localOnly.value = res.local_only ?? []
    remoteTruncated.value = res.remote_listing_truncated === true
    youtubeOnly.value = res.youtube_only ?? []
    duplicates.value = res.duplicates ?? []
    ignored.value = res.ignored_video_ids ?? []
    history.value = res.history ?? []
    listedAt.value = res.remote_listed_at ?? null
  } catch (error: any) {
    loadError.value = error?.data?.detail || error?.message || 'Could not load the YouTube matching page.'
  } finally {
    loading.value = false
  }
}

async function retryLoad(): Promise<void> {
  loadError.value = ''
  loading.value = true
  await load()
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

const refreshRemote = () => run('refresh', async () => {
  const res = await post<{ listed: number }>(`/projects/${slug.value}/youtube/reconcile/remote-refresh`, {})
  actionResult.value = { kind: 'ok', message: `Listed ${res.listed} video${res.listed === 1 ? '' : 's'} from this channel.` }
  await load()
})

const previewBulk = () => run('preview', async () => {
  preview.value = await post<Preview>(`/projects/${slug.value}/youtube/reconcile/preview`, {})
})

const applyBulk = () => run('apply', async () => {
  const res = await post<{ counts: { linked: number; refused: number } }>(
    `/projects/${slug.value}/youtube/reconcile/apply`, {},
  )
  preview.value = null
  actionResult.value = {
    kind: 'ok',
    message: `Linked ${res.counts.linked}. ${res.counts.refused} still need you.`,
  }
  await load()
})

const setAside = (videoId: string, ignore: boolean) => run(`aside-${videoId}`, async () => {
  await post(`/projects/${slug.value}/youtube/reconcile/ignore`, { video_id: videoId, ignored: ignore })
  await load()
})

const undo = (decision: Decision) => run(`undo-${decision.decision_id}`, async () => {
  await post(`/projects/${slug.value}/youtube/reconcile/rollback`, { decision_id: decision.decision_id })
  actionResult.value = { kind: 'ok', message: `${decision.episode_code} put back the way it was.` }
  await load()
})

onMounted(async () => { await load(); await loadUndo(); await loadReseasonUndo() })
</script>

<style scoped>
/* Declared so the @container rule below applies; the repo-wide guard enforces it. */
.uc-reconcile { container-type: inline-size; container-name: uc-reconcile; display: grid; gap: 14px; min-width: 0; }
.panel { display: grid; gap: 10px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--bg-secondary); }
.panel h3 { margin: 3px 0; }
.panel p { margin: 4px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.5; }
.eyebrow { color: var(--accent); font-size: var(--font-xs); font-weight: 700; letter-spacing: .11em; text-transform: uppercase; }
.hint { color: var(--text-muted); font-size: var(--font-xs); }
.muted { color: var(--text-muted); font-size: var(--font-xs); overflow-wrap: anywhere; }
.result { font-size: var(--font-xs); }
.result.ok { color: var(--success); } .result.warn { color: var(--warning, #d97706); } .result.err { color: var(--danger); }
.field-row { display: flex; flex-wrap: wrap; gap: 7px; }

.bulk, .preview { display: grid; gap: 8px; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.preview p { color: var(--text-secondary); font-size: var(--font-xs); }
.reasons { display: grid; gap: 3px; margin: 0; padding-left: 18px; color: var(--text-muted); font-size: var(--font-xs); }

.candidate-list, .duplicate-list, .orphan-list, .history-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.candidate, .duplicate-list li, .orphan-list li, .history-list li {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 10px;
  padding: 8px 10px; border-radius: var(--radius-sm); background: var(--bg-tertiary); font-size: 13px;
}
.candidate > *, .orphan-list li > *, .history-list li > * { min-width: 0; }
.evidence { display: grid; gap: 2px; justify-items: end; text-align: right; }
.badge { padding: 2px 8px; border-radius: 999px; font-size: var(--font-xs); font-weight: 700; }
.badge.exact { background: rgba(80, 160, 120, .16); color: var(--success); }
.badge.suggestion { background: rgba(217, 119, 6, .16); color: var(--warning, #d97706); }

@container uc-reconcile (max-width: 640px) {
  .candidate, .duplicate-list li, .orphan-list li, .history-list li { grid-template-columns: 1fr; }
  .evidence { justify-items: start; text-align: left; }
}
</style>
