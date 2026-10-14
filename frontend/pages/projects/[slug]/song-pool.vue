<!--
  Song Pool (music format phase 1, mockup 02). Every song this channel owns, with its brief,
  measurements and episode history from `music-library/library.json`. Episodes draw from here and
  never make songs on their own; only Generate Songs / Fill Gaps / Regenerate make songs, on a click.
-->
<template>
  <div class="workspace-page">
    <WorkspaceHero
      eyebrow="Music · Your songs"
      title="Song Pool"
      description="Every song this channel owns. Episodes draw from here and never make songs on their own. Rejected songs move to the project trash — nothing is deleted."
    >
      <template #aside>
        <div class="mp-row" style="align-items: flex-start">
          <div class="mp-btnhint">
            <button type="button" class="btn btn-secondary" :disabled="!!data?.formula?.error || !!data?.active_batch" @click="openGenerate('fill-gaps')">Fill Gaps…</button>
            <span class="mp-hint">Makes songs for the combinations you have least of.</span>
          </div>
          <div class="mp-btnhint">
            <button type="button" class="btn btn-primary" :disabled="!!data?.formula?.error || !!data?.active_batch" @click="openGenerate('new')">Generate Songs…</button>
            <span class="mp-hint">{{ data?.active_batch ? 'A batch is already running — see below.' : 'You pick how many and the writing model next.' }}</span>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <p v-if="loadError" class="error-box" role="alert">{{ loadError }} <button type="button" class="btn btn-sm btn-ghost" @click="load">Retry</button></p>
    <p v-if="!data && !loadError" class="mp-hint">Loading the pool…</p>

    <template v-if="data">
      <div class="mp-kpis k4" style="margin-top: 16px">
        <div class="mp-kpi"><span>Songs</span><b>{{ data.stats.songs }}</b></div>
        <div class="mp-kpi"><span>Total length</span><b>{{ hm(data.stats.total_s) }}</b></div>
        <div class="mp-kpi" data-tone="success"><span>Free for the next episode</span><b>{{ data.stats.free_next }}</b></div>
        <div class="mp-kpi" data-tone="warning"><span>Rejected · in trash</span><b>{{ data.stats.rejected }}</b></div>
      </div>

      <WorkspaceNotice v-if="data.formula.error" title="No song formula yet" tone="warning" style="margin-top: 14px">
        {{ data.formula.error }}
        <template #actions>
          <NuxtLink :to="`/projects/${slug}/music-formula`" class="btn btn-sm btn-secondary">Open Music Formula</NuxtLink>
        </template>
      </WorkspaceNotice>

      <WorkspaceNotice v-if="batch" :title="batchTitle" tone="info" icon="♫" style="margin-top: 14px">
        {{ batchLine }}
        <span class="mp-meter" style="display: block; margin-top: 8px; max-width: 520px"><span :style="{ display: 'block', height: '100%', background: 'var(--accent)', width: `${batchPct}%` }" /></span>
        <template #actions>
          <div class="mp-btnhint">
            <button v-if="batch.status !== 'paused'" type="button" class="btn btn-secondary btn-sm" :disabled="batchBusy" @click="batchControl('pause')">Pause</button>
            <button v-else type="button" class="btn btn-secondary btn-sm" :disabled="batchBusy" @click="batchControl('resume')">Resume</button>
            <span class="mp-hint">{{ batch.status === 'paused' ? 'Picks up the songs not made yet.' : 'Finishes songs already on the fleet, starts no new ones.' }}</span>
          </div>
          <NuxtLink :to="`/projects/${slug}/jobs`" class="btn btn-ghost btn-sm">Open Job</NuxtLink>
        </template>
      </WorkspaceNotice>

      <section
        v-if="manualRedoPreference.enabled.value && eligibleManualSources.length"
        class="card workspace-section mp-card"
        style="margin-top: 14px"
        aria-labelledby="song-pool-manual-redo-title"
      >
        <h3 id="song-pool-manual-redo-title" style="margin: 0">Start a separate attempt for one unresolved song</h3>
        <p class="mp-hint">
          This copies one exact saved music request into a new batch. Existing songs, sibling takes, the old batch and its evidence stay untouched.
          The prior unresolved request may still have been charged.
        </p>
        <div class="mp-row" style="margin-top: 10px">
          <label class="mp-lbl" style="flex: 1">
            Unresolved song
            <select v-model="manualSourceChoice" class="mp-inp" style="width: 100%" @change="cancelPendingManualSong">
              <option value="">Choose one exact item…</option>
              <option v-for="source in eligibleManualSources" :key="`${source.source_job_id}:${source.source_item_key}`" :value="`${source.source_job_id}::${source.source_item_key}`">{{ source.label }}</option>
            </select>
          </label>
          <label class="mp-lbl" style="flex: 1">
            Music model
            <select v-model="manualMusicModelId" class="mp-inp" style="width: 100%">
              <option value="">Choose a current model…</option>
              <option v-for="model in musicModels" :key="model.id" :value="model.id">{{ model.display_name }}</option>
            </select>
          </label>
        </div>
        <p v-if="manualMusicModel" class="mp-hint" style="margin-top: 8px">
          <template v-if="manualMusicPriceClass !== 'unknown'">Published unit rate: <b>{{ manualMusicCost.text }}</b> · {{ manualMusicModel.display_name }}</template>
          <template v-else>This model has no clear published free or paid rate. A separate attempt cannot start.</template>
        </p>
        <p v-if="manualMusicLimits" class="mp-hint" style="margin-top: 4px">{{ manualMusicLimits }}</p>
        <label class="mp-lbl" style="display: flex; gap: 8px; align-items: center; margin-top: 10px">
          <input v-model="manualRedoChecked" type="checkbox">
          Keep the earlier batch and evidence, and start one separately identified music request.
        </label>
        <button
          type="button"
          class="btn btn-secondary"
          style="margin-top: 10px"
          :disabled="!manualRedoChecked || !selectedManualSource || !manualMusicModel || manualMusicPriceClass === 'unknown' || manualRedoPosting"
          @click="beginManualSongRedo"
        >{{ manualRedoPosting ? 'Starting…' : 'Start separate attempt' }}</button>
      </section>

      <section class="card workspace-section mp-card" style="margin-top: 14px">
        <div class="mp-row" style="justify-content: space-between">
          <div class="mp-row">
            <input v-model="q" class="mp-inp" style="width: 240px" placeholder="Search titles, briefs, scene ideas…" aria-label="Search songs">
            <button type="button" class="mp-chip" :class="{ on: fFree }" @click="fFree = !fFree">Free for Next Episode</button>
            <select v-model="fMood" class="mp-inp" aria-label="Mood"><option value="">Mood</option><option v-for="v in values('mood')" :key="v">{{ v }}</option></select>
            <select v-model="fEnsemble" class="mp-inp" aria-label="Ensemble"><option value="">Ensemble</option><option v-for="v in values('ensemble')" :key="v">{{ v }}</option></select>
            <select v-model="fBand" class="mp-inp" aria-label="Tempo"><option value="">Tempo</option><option v-for="b in bands" :key="b.id" :value="b.id">{{ b.label }}</option></select>
            <select v-model="fKey" class="mp-inp" aria-label="Key"><option value="">Key</option><option v-for="v in values('key')" :key="v">{{ v }}</option></select>
            <select v-model.number="fRating" class="mp-inp" aria-label="Rating"><option :value="0">Rating</option><option v-for="r in 5" :key="r" :value="r">{{ r }}★ and up</option></select>
            <button type="button" class="mp-chip" :class="{ on: fNever }" @click="fNever = !fNever">Never Played</button>
            <button type="button" class="mp-chip" :class="{ on: fRejected }" @click="fRejected = !fRejected">Rejected</button>
          </div>
          <select v-model="sort" class="mp-inp" aria-label="Sort">
            <option value="least">Sort: Least played</option><option value="newest">Sort: Newest</option><option value="rating">Sort: Rating</option>
            <option value="title">Sort: Title</option><option value="length">Sort: Length</option><option value="loud">Sort: Loudness</option>
          </select>
        </div>

        <div v-if="selected.size" class="mp-bulk mp-row" style="margin-top: 12px; justify-content: space-between">
          <span style="font-size: 13px"><b>{{ selected.size }} selected</b> · {{ clock(selectedSeconds) }} total</span>
          <div class="mp-row">
            <button type="button" class="btn btn-secondary btn-sm" :disabled="!canRegenerate || !!data.active_batch" @click="regenerate([...selected])">Regenerate {{ selected.size }}</button>
            <AddChip label="Add Tag…" placeholder="Tag for the selected songs" button-class="btn btn-secondary btn-sm" @add="addTag" />
            <button type="button" class="btn btn-danger btn-sm" @click="reject([...selected])">Reject {{ selected.size }}…</button>
            <span class="mp-hint" style="max-width: 300px; margin: 0">Regenerate keeps each brief and asks for a new take; the old take stays until you remove it.</span>
          </div>
        </div>

        <p v-if="!rows.length" class="mp-hint" style="margin-top: 14px">
          {{ data.pool.songs.length ? 'No song matches these filters.' : 'No songs yet. Generate Songs makes them on your fleet; audio files dropped into the folder also appear here.' }}
        </p>
        <table v-else class="mp-tbl" style="margin-top: 10px">
          <thead><tr>
            <th><input type="checkbox" :checked="allShownSelected" aria-label="Select all shown" @change="toggleAll"></th><th></th><th>Song</th><th>Sound</th>
            <th class="mp-num">Tempo</th><th>Key</th><th class="mp-num">Length</th><th class="mp-num">Loudness</th><th class="mp-num">Plays</th><th>Last used</th><th>Rating</th><th></th>
          </tr></thead>
          <tbody>
            <template v-for="s in shown" :key="s.id">
              <tr :class="{ sel: selected.has(s.id) }" :style="{ opacity: s.status !== 'ready' || !s.enabled ? 0.6 : 1 }">
                <td><input type="checkbox" :checked="selected.has(s.id)" :aria-label="`Select ${s.title}`" @change="toggle(s.id)"></td>
                <td><button type="button" class="mp-play" :class="{ on: playing === s.id }" :aria-label="playing === s.id ? 'Pause' : `Play ${s.title}`" :disabled="s.file_missing || s.status === 'rejected'" @click="play(s)">{{ playing === s.id ? '❚❚' : '▶' }}</button></td>
                <td class="mp-ttl" @click="expanded = expanded === s.id ? '' : s.id">
                  <b>{{ s.title }}</b>
                  <span>{{ subtitle(s) }}<template v-if="s.gap_s"> — <span class="mp-warn">{{ Math.round(s.gap_s) }} s of silence at {{ clock(s.gap_at_s || 0) }}</span></template><template v-if="s.file_missing"> — <span class="mp-warn">file not in the folder</span></template><template v-if="s.lyrics_check === 'passed'"> — sung, {{ Math.round((s.lyrics_match || 0) * 100) }}% of the words heard</template><template v-else-if="s.lyrics_check === 'failed'"> — <span class="mp-warn">sung, only {{ Math.round((s.lyrics_match || 0) * 100) }}% of the words heard</span></template><template v-else-if="s.lyrics_check === 'unchecked'"> — <span class="mp-warn">sung, words not checked</span></template></span>
                </td>
                <td><span v-if="s.ensemble" class="mp-chip sm">{{ short(s.ensemble) }}</span> <span v-if="s.mood" class="mp-chip sm">{{ s.mood }}</span></td>
                <td class="mp-num">{{ s.tempo_bpm || '—' }}</td>
                <td class="mp-nowrap">{{ s.key || '—' }}</td>
                <td class="mp-num">{{ s.duration_s ? clock(s.duration_s) : '—' }}</td>
                <td class="mp-num">{{ s.lufs != null ? s.lufs.toFixed(1) : '—' }}</td>
                <td class="mp-num">{{ s.episodes.length }}</td>
                <td>
                  <span v-if="last(s)">{{ last(s) }}</span><span v-else class="mp-muted">never</span>
                  <span v-if="inWindow(s)" class="ds-chip" data-tone="warning" style="margin-left: 4px">in window</span>
                  <span v-if="s.status === 'archived'" class="ds-chip" style="margin-left: 4px">archived</span>
                  <span v-if="s.status === 'rejected'" class="ds-chip" style="margin-left: 4px">in trash</span>
                  <span v-if="s.status === 'ready' && !s.enabled" class="ds-chip" style="margin-left: 4px">older take</span>
                </td>
                <td>
                  <span v-if="s.gap_s && !s.rating" class="ds-chip" data-tone="warning">Check by ear</span>
                  <span v-else class="mp-stars" role="group" :aria-label="`Rating for ${s.title}`">
                    <button v-for="n in 5" :key="n" type="button" :class="{ off: !(s.rating && n <= s.rating) }" :aria-label="`${n} star${n === 1 ? '' : 's'}`" @click="rate(s, s.rating === n ? null : n)">★</button>
                  </span>
                </td>
                <td class="mp-more">
                  <button type="button" class="btn btn-ghost btn-sm" :aria-expanded="menu === s.id" @click="menu = menu === s.id ? '' : s.id">More ▾</button>
                  <div v-if="menu === s.id" class="mp-menu" role="menu">
                    <button type="button" role="menuitem" @click="menu = ''; play(s)">Play</button>
                    <button type="button" role="menuitem" :disabled="!s.prompt || !!data.active_batch" @click="menu = ''; regenerate([s.id])">Regenerate</button>
                    <button type="button" role="menuitem" :disabled="!s.prompt || !!data.active_batch" @click="menu = ''; openEdit(s)">Edit Brief &amp; Regenerate…</button>
                    <button v-if="s.status === 'ready'" type="button" role="menuitem" @click="menu = ''; reject([s.id])">Reject…</button>
                    <button type="button" role="menuitem" @click="menu = ''; reveal()">Show in Finder</button>
                    <span v-if="!s.prompt" class="mp-hint">Added from the folder, so there is no brief to regenerate.</span>
                  </div>
                </td>
              </tr>
              <tr v-if="expanded === s.id" class="mp-detail">
                <td></td>
                <td colspan="11">
                  <div class="mp-row" style="align-items: flex-start; gap: 24px">
                    <div style="flex: 1; min-width: 320px">
                      <div class="mp-meter" style="height: 8px; margin-top: 8px"><div :style="{ width: `${playing === s.id ? progress * 100 : 0}%` }" /></div>
                      <div class="mp-hint">{{ playing === s.id ? `${clock(position)} / ${clock(s.duration_s || 0)} · listening` : `${clock(s.duration_s || 0)} · press ▶ to listen` }}</div>
                      <div v-if="s.prompt" style="margin-top: 10px; font-size: 13px">
                        <span class="mp-lbl">Brief sent to {{ modelName(s.music_model) }}</span>
                        <div class="mp-muted">{{ s.prompt }}</div>
                      </div>
                    </div>
                    <div style="flex: 1; min-width: 260px; font-size: 13px">
                      <span class="mp-lbl">Scene idea</span>
                      <div class="mp-muted">{{ s.scene_idea || 'None — this song was added from the folder.' }}</div>
                      <span class="mp-lbl" style="margin-top: 8px">Tags</span>
                      <div class="mp-muted">{{ s.tags.join(' · ') || '—' }}</div>
                    </div>
                    <div style="min-width: 240px; font-size: 13px">
                      <span class="mp-lbl">Used in</span>
                      <div class="mp-muted">{{ s.episodes.map((e: any) => e.code).join(' · ') || 'No episode yet' }}</div>
                      <span class="mp-lbl" style="margin-top: 8px">Made</span>
                      <div class="mp-muted">{{ made(s) }}</div>
                      <div class="mp-row" style="margin-top: 10px">
                        <button type="button" class="btn btn-secondary btn-sm" :disabled="!s.prompt || !!data.active_batch" @click="openEdit(s)">Edit Brief &amp; Regenerate…</button>
                      </div>
                      <div class="mp-hint">{{ s.episodes.length ? 'Used in an episode, so a rejected or replaced take is archived, not trashed.' : 'Not in any episode yet, so a rejected take moves to the project trash.' }}</div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
        <div v-if="rows.length > shown.length" class="mp-row" style="margin-top: 10px">
          <button type="button" class="btn btn-secondary btn-sm" @click="limit += 200">Show {{ Math.min(200, rows.length - shown.length) }} More</button>
          <span class="mp-hint" style="margin: 0">{{ shown.length }} of {{ rows.length }} shown.</span>
        </div>
        <div class="mp-hint" style="margin-top: 8px">
          More ▾ = Play · Regenerate · Edit Brief · Reject · Show in Finder. "In window" = used in the last {{ data.episode_defaults.no_repeat_episodes }} episodes, so the next draw skips it.
        </div>
      </section>
    </template>

    <audio ref="audioEl" preload="none" @timeupdate="onTime" @ended="playing = ''" @error="onAudioError" />

    <GenerateSongsDialog
      :visible="genOpen" :slug="slug" :mode="genMode" :initial-count="genCount"
      :formula-name="data?.formula?.name" :formula-error="data?.formula?.error" :song-formula="data?.formula?.song_formula"
      :missing="data?.stats?.missing" :needed="data?.stats?.needed" :average-song-s="data?.stats?.average_song_s"
      :average-generation-s="data?.stats?.average_generation_s"
      @close="genOpen = false" @started="onStarted"
    />

    <Modal :visible="!!editing" size="lg" labelledby="mp-edit-title" @close="editing = null">
      <template v-if="editing">
        <h2 id="mp-edit-title" style="margin: 0 0 4px">Edit Brief &amp; Regenerate</h2>
        <p class="mp-hint">Change any field; the prompt is rebuilt from them and a new take is made with a new seed. "{{ editing.title }}" stays, disabled, until you remove it.</p>
        <div class="mp-grid3" style="margin-top: 12px">
          <label v-for="f in editFields" :key="f.key" :style="{ gridColumn: f.wide ? '1 / -1' : undefined }">
            <span class="mp-lbl">{{ f.label }}</span>
            <textarea v-if="f.wide" v-model="edit[f.key]" class="mp-inp" rows="2" style="width: 100%" />
            <input v-else v-model="edit[f.key]" class="mp-inp" style="width: 100%" :type="f.num ? 'number' : 'text'">
          </label>
        </div>
        <p v-if="editError" class="error-box">{{ editError }}</p>
        <div class="mp-row" style="justify-content: flex-end; margin-top: 14px">
          <button type="button" class="btn btn-secondary" @click="editing = null">Cancel</button>
          <button type="button" class="btn btn-primary" :disabled="editBusy" @click="submitEdit">{{ editBusy ? 'Starting…' : 'Regenerate' }}</button>
        </div>
      </template>
    </Modal>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import GenerateSongsDialog from '~/components/music/GenerateSongsDialog.vue'
import AddChip from '~/components/music/AddChip.vue'
import { describeMusicUnitCost, type PricedMusicModel } from '../../../utils/genstudio-credit-cost.js'
import { UNCONFIRMED_SUBMISSION } from '../../../composables/useFreshGenerationAction'

definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })
useAppTitle('Song Pool')
const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, post, patch } = useApi()
const { success, error: showError, showAction } = useToast()
const { ask } = useConfirm()
const fresh = useFreshGenerationAction()
const manualRedoPreference = useManualGenerationRedoPreference()
const confirmation = useConfirmation()
const { jobs } = useJobs()

const data = ref<any>(null)
const loadError = ref('')
const q = ref('')
const fFree = ref(false)
const fMood = ref('')
const fEnsemble = ref('')
const fBand = ref('')
const fKey = ref('')
const fRating = ref(0)
const fNever = ref(false)
const fRejected = ref(false)
const sort = ref<'least' | 'newest' | 'rating' | 'title' | 'length' | 'loud'>('least')
const selected = ref(new Set<string>())
const expanded = ref('')
const menu = ref('')
const limit = ref(200)
const genOpen = ref(false)
const genMode = ref<'new' | 'fill-gaps'>('new')
const genCount = ref(0)
const batchBusy = ref(false)
interface SongPoolMusicModel extends PricedMusicModel {
  id: string
  display_name: string
  price_version: string
  chargeable?: boolean
  minimum_credits?: number | null
  max_title_characters?: number | null
  min_prompt_characters?: number | null
  max_prompt_characters?: number | null
  max_prompt_without_lyrics_characters?: number | null
  min_lyrics_characters?: number | null
  max_lyrics_characters?: number | null
  min_duration_seconds?: number | null
  max_duration_seconds?: number | null
}
interface ManualSongSource { source_job_id: string; source_item_key: string; label: string; eligible: boolean; reason: string }
interface PendingManualSong {
  projectSlug: string
  modelId: string
  sourceChoice: string
  body: Record<string, unknown>
  operationId: string
  attempted: boolean
  firstPostKey: string
}
const musicModels = ref<SongPoolMusicModel[]>([])
const manualSources = ref<ManualSongSource[]>([])
const manualSourceChoice = ref('')
const manualMusicModelId = ref('')
const manualRedoChecked = ref(false)
const manualRedoPosting = ref(false)
const pendingManualSong = ref<PendingManualSong | null>(null)
let manualSourcesSequence = 0
let manualPostingOperationId = ''

const eligibleManualSources = computed(() => manualSources.value.filter(source => source.eligible))
const selectedManualSource = computed(() => eligibleManualSources.value.find(source =>
  `${source.source_job_id}::${source.source_item_key}` === manualSourceChoice.value) || null)
const manualMusicModel = computed(() => musicModels.value.find(model => model.id === manualMusicModelId.value) || null)
const manualMusicCost = computed(() => describeMusicUnitCost(manualMusicModel.value))
const publishedRange = (label: string, minimum?: number | null, maximum?: number | null, unit = 'characters') => {
  if (typeof minimum === 'number' && typeof maximum === 'number') return `${label} ${minimum.toLocaleString()}–${maximum.toLocaleString()} ${unit}`
  if (typeof maximum === 'number') return `${label} up to ${maximum.toLocaleString()} ${unit}`
  if (typeof minimum === 'number') return `${label} at least ${minimum.toLocaleString()} ${unit}`
  return ''
}
const manualMusicLimits = computed(() => {
  const model = manualMusicModel.value
  if (!model) return ''
  const ranges = [
    publishedRange('title', null, model.max_title_characters),
    publishedRange('prompt', model.min_prompt_characters, model.max_prompt_characters),
    publishedRange('prompt without lyrics', model.min_prompt_characters, model.max_prompt_without_lyrics_characters),
    publishedRange('lyrics', model.min_lyrics_characters, model.max_lyrics_characters),
    publishedRange('duration', model.min_duration_seconds, model.max_duration_seconds, 'seconds'),
  ].filter(Boolean)
  return ranges.length ? `Published limits: ${ranges.join(' · ')}.` : ''
})
const manualMusicPriceClass = computed<'free' | 'paid' | 'unknown'>(() => {
  const model = manualMusicModel.value
  if (!model) return 'unknown'
  if (model.chargeable === true || (model.credits_per_request ?? 0) > 0 || (model.minimum_credits ?? 0) > 0
    || (model.standard_credits ?? 0) > 0 || (model.sale_credits ?? 0) > 0
    || Object.values(model.price_usd || {}).some(value => value > 0)
    || (model.price_variants || []).some(value => typeof value.usd === 'number' && value.usd > 0)) return 'paid'
  if (model.chargeable === false) return 'free'
  if (model.price_source === 'local' && model.credits_per_request === 0 && (model.minimum_credits ?? 0) === 0
    && (model.standard_credits === null || model.standard_credits === 0)
    && (model.sale_credits === null || model.sale_credits === 0)
    && !Object.values(model.price_usd || {}).some(value => value !== 0)
    && !(model.price_variants || []).some(value => typeof value.usd !== 'number' || value.usd !== 0)) return 'free'
  return 'unknown'
})

const songs = computed<any[]>(() => data.value?.pool?.songs || [])
const bands = computed<any[]>(() => data.value?.formula?.song_formula?.tempo_bands || [])
const windowCodes = computed<string[]>(() => data.value?.window || [])
const inWindow = (s: any) => s.episodes.some((e: any) => e.project_slug === slug.value && windowCodes.value.includes(e.code))
const last = (s: any) => s.episodes.reduce((a: any, e: any) => (!a || e.used_at > a.used_at ? e : a), null)?.code || ''
const values = (k: string) => [...new Set(songs.value.map(s => s[k]).filter(Boolean))].sort() as string[]
const drawable = (s: any) => s.status === 'ready' && s.enabled && !s.file_missing && s.duration_s > 0
const short = (e: string) => e.replace(/^Cello quartet$/i, 'Quartet')

const rows = computed(() => {
  const needle = q.value.trim().toLowerCase()
  const list = songs.value.filter(s => {
    if (fRejected.value ? s.status === 'ready' : s.status !== 'ready') return false
    if (fFree.value && !(drawable(s) && !inWindow(s))) return false
    if (fNever.value && s.episodes.length) return false
    if (fMood.value && s.mood !== fMood.value) return false
    if (fEnsemble.value && s.ensemble !== fEnsemble.value) return false
    if (fBand.value && s.tempo_band !== fBand.value) return false
    if (fKey.value && s.key !== fKey.value) return false
    if (fRating.value && !(s.rating >= fRating.value)) return false
    if (needle && ![s.title, s.line, s.scene_idea, s.prompt, ...(s.tags || [])].some(t => String(t || '').toLowerCase().includes(needle))) return false
    return true
  })
  const by: Record<string, (a: any, b: any) => number> = {
    least: (a, b) => a.episodes.length - b.episodes.length || String(b.created_at).localeCompare(String(a.created_at)),
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at)),
    rating: (a, b) => (b.rating || 0) - (a.rating || 0),
    title: (a, b) => a.title.localeCompare(b.title),
    length: (a, b) => (b.duration_s || 0) - (a.duration_s || 0),
    loud: (a, b) => (b.lufs ?? -99) - (a.lufs ?? -99),
  }
  return [...list].sort(by[sort.value])
})
const shown = computed(() => rows.value.slice(0, limit.value))
const allShownSelected = computed(() => shown.value.length > 0 && shown.value.every(s => selected.value.has(s.id)))
const selectedSongs = computed(() => songs.value.filter(s => selected.value.has(s.id)))
const selectedSeconds = computed(() => selectedSongs.value.reduce((t, s) => t + (s.duration_s || 0), 0))
const canRegenerate = computed(() => selectedSongs.value.length > 0 && selectedSongs.value.every(s => s.prompt))

const batch = computed(() => data.value?.active_batch || null)
const batchPct = computed(() => batch.value?.total ? Math.round((batch.value.saved / batch.value.total) * 100) : 0)
const batchTitle = computed(() => {
  const b = batch.value
  if (!b) return ''
  const waiting = Math.max(0, b.total - b.saved - b.failed - b.on_fleet)
  return `${b.mode === 'regenerate' ? 'Regenerating' : 'Making'} ${b.total} song${b.total === 1 ? '' : 's'} — ${b.saved} saved, ${b.on_fleet} on the fleet now, ${waiting} waiting${b.status === 'paused' ? ' (paused)' : ''}`
})
const batchLine = computed(() => {
  const b = batch.value
  if (!b) return ''
  const left = b.total - b.saved - b.failed
  const avg = data.value?.stats?.average_generation_s
  const eta = avg && left > 0 ? `About ${Math.max(1, Math.round((Math.ceil(left / Math.max(1, b.in_flight)) * avg) / 60))} minutes left at this pool's usual pace. ` : ''
  const writer = b.writer_model ? `Briefs written by ${b.writer_model}. ` : ''
  const dropped = b.dropped ? `${b.dropped} brief${b.dropped === 1 ? ' was' : 's were'} dropped for reading like existing songs (listed in the job).` : ''
  const failed = b.failed ? ` ${b.failed} failed — Retry on the Jobs page makes only those.` : ''
  return `${eta}${writer}${dropped}${failed}`.trim() || 'Songs appear below as they finish.'
})

function clock(sec: number) { const s = Math.round(sec || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
function hm(sec: number) { const m = Math.round((sec || 0) / 60); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} m` }
function subtitle(s: any) {
  if (!s.ensemble) return s.source === 'folder' ? 'Added from the folder' : ''
  const lower = (t?: string) => (t && t !== t.toUpperCase() ? t.toLowerCase() : t)
  return [s.ensemble, lower(s.texture), lower(s.structure)].filter(Boolean).join(', ') + (s.line ? ` — ${s.line}` : '')
}
function modelName(id?: string) { return musicModels.value.find(m => m.id === id)?.display_name || (id ? id.split('::').pop() : 'the song model') }
function made(s: any) {
  const d = new Date(s.created_at)
  return [isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), s.batch_id && `batch ${s.batch_id}`,
    s.seed != null && `seed ${s.seed}`, s.writer_model && `writer: ${s.writer_model}`, s.take_of && 'a retake'].filter(Boolean).join(' · ')
}

function toggle(id: string) { const n = new Set(selected.value); n.has(id) ? n.delete(id) : n.add(id); selected.value = n }
function toggleAll() {
  const n = new Set(selected.value)
  if (allShownSelected.value) shown.value.forEach(s => n.delete(s.id)); else shown.value.forEach(s => n.add(s.id))
  selected.value = n
}

let poll: ReturnType<typeof setInterval> | null = null
async function load() {
  const at = slug.value
  try {
    const r = await get<any>(`/projects/${at}/song-pool`)
    if (at !== slug.value) return
    data.value = r; loadError.value = ''
    const ids = new Set(r.pool.songs.map((s: any) => s.id))
    selected.value = new Set([...selected.value].filter(id => ids.has(id)))
  } catch (e: any) { if (at === slug.value) loadError.value = e?.data?.detail || e?.message || 'Could not load the song pool.' }
  if (poll) { clearInterval(poll); poll = null }
  if (data.value?.active_batch) poll = setInterval(load, 5000)
}

async function loadManualSources() {
  const projectSlug = slug.value
  const request = ++manualSourcesSequence
  if (!manualRedoPreference.enabled.value) { manualSources.value = []; return }
  try {
    const response = await get<{ sources: ManualSongSource[] }>(`/projects/${projectSlug}/song-pool/manual-redo-sources`)
    if (request === manualSourcesSequence && projectSlug === slug.value) {
      manualSources.value = Array.isArray(response.sources) ? response.sources : []
    }
  } catch {
    if (request === manualSourcesSequence && projectSlug === slug.value) manualSources.value = []
  }
}

function manualTargetKey() {
  return JSON.stringify({ projectSlug: slug.value, modelId: manualMusicModelId.value, sourceChoice: manualSourceChoice.value })
}

function manualFirstPostKey() {
  return JSON.stringify({ target: manualTargetKey(), priceVersion: manualMusicModel.value?.price_version || '', priceClass: manualMusicPriceClass.value })
}

function manualSubmissionMatches(submission: PendingManualSong): boolean {
  const pending = pendingManualSong.value
  return submission.projectSlug === slug.value && submission.modelId === manualMusicModelId.value
    && submission.sourceChoice === manualSourceChoice.value && pending?.operationId === submission.operationId
    && JSON.stringify(pending.body) === JSON.stringify(submission.body)
}

function cancelPendingManualSong() {
  const pending = pendingManualSong.value
  if (pending) fresh.complete(pending.operationId)
  pendingManualSong.value = null
  manualRedoPosting.value = false
  manualPostingOperationId = ''
}

async function submitManualSong(submission: PendingManualSong) {
  if (!manualSubmissionMatches(submission)) {
    showError('This Retry belongs to another project, model, or unresolved item. Review the current choice and start again.')
    return
  }
  if (!submission.attempted && submission.firstPostKey !== manualFirstPostKey()) {
    if (manualSubmissionMatches(submission)) cancelPendingManualSong()
    showError('The project, item, model, or published price changed. Review the current choice and start again.')
    return
  }
  submission.attempted = true
  manualRedoPosting.value = true
  manualPostingOperationId = submission.operationId
  try {
    await post(`/projects/${submission.projectSlug}/song-pool/generate`, { ...submission.body, operation_id: submission.operationId })
    if (manualSubmissionMatches(submission)) {
      fresh.complete(submission.operationId)
      pendingManualSong.value = null
      manualRedoChecked.value = false
      success('Separate song attempt queued. The old batch, songs, sibling takes, and evidence stay in place.')
      void loadManualSources()
    }
  } catch (error: any) {
    const detail = error?.data?.detail || error?.response?._data?.detail
    if (detail && manualSubmissionMatches(submission)) {
      fresh.complete(submission.operationId)
      pendingManualSong.value = null
      manualRedoChecked.value = false
      showError(detail)
    } else if (manualSubmissionMatches(submission)) {
      showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => submitManualSong(submission))
    }
  } finally {
    if (manualPostingOperationId === submission.operationId) {
      manualRedoPosting.value = false
      manualPostingOperationId = ''
    }
  }
}

async function beginManualSongRedo() {
  const source = selectedManualSource.value
  const model = manualMusicModel.value
  if (!source || !model || !manualRedoChecked.value || manualMusicPriceClass.value === 'unknown') return
  const paid = manualMusicPriceClass.value === 'paid'
  const body = JSON.parse(JSON.stringify({
    music_model: model.id,
    source_item_key: source.source_item_key,
    manual_redo: { intent: 'replace_unresolved', source_job_id: source.source_job_id },
    manual_music_payment: {
      version: 1, model_id: model.id, price_version: model.price_version, confirmed_paid_music: paid,
    },
  }))
  const operationId = fresh.begin(body, 'manual-song-pool-redo')
  const submission: PendingManualSong = {
    projectSlug: slug.value, modelId: model.id,
    sourceChoice: `${source.source_job_id}::${source.source_item_key}`,
    body, operationId, attempted: false, firstPostKey: manualFirstPostKey(),
  }
  pendingManualSong.value = submission
  if (paid) {
    const confirmed = await confirmation.confirmGeneration(submission.projectSlug, 'music', body, {
      action: 'Start a separate paid song request. The prior unresolved request may still have been charged.',
      details: [
        { label: 'Model', value: model.display_name },
        { label: 'Published unit rate', value: manualMusicCost.value.text },
      ],
      always: true,
    })
    if (!confirmed) {
      if (manualSubmissionMatches(submission)) cancelPendingManualSong()
      return
    }
  }
  if (!manualSubmissionMatches(submission)) return
  await submitManualSong(submission)
}

function openGenerate(mode: 'new' | 'fill-gaps', count = 0) { genMode.value = mode; genCount.value = count; genOpen.value = true }
function onStarted() { genOpen.value = false; success('Making songs on your fleet. They appear here as they finish.'); void load() }

async function batchControl(action: 'pause' | 'resume') {
  if (!batch.value) return
  batchBusy.value = true
  try { await post(`/projects/${slug.value}/jobs/${batch.value.job_id}/${action}`, {}); await load() }
  catch (e: any) { showError(e?.data?.detail || `Could not ${action} the batch`) }
  finally { batchBusy.value = false }
}

async function rate(s: any, rating: number | null) {
  const before = s.rating
  s.rating = rating
  try { await patch(`/projects/${slug.value}/song-pool/songs/${s.id}`, { rating }) }
  catch (e: any) { s.rating = before; showError(e?.data?.detail || 'Could not save the rating') }
}

async function addTag(tag: string) {
  for (const id of selected.value) await patch(`/projects/${slug.value}/song-pool/songs/${id}`, { add_tags: [tag] }).catch(() => null)
  await load()
}

async function reject(ids: string[]) {
  const picked = songs.value.filter(s => ids.includes(s.id) && s.status === 'ready')
  if (!picked.length) return
  const used = picked.filter(s => s.episodes.length).length
  const ok = await ask({
    title: `Reject ${picked.length} song${picked.length === 1 ? '' : 's'}?`,
    message: `${picked.length - used} will move to this project's _trash folder (nothing is deleted)${used ? `; ${used} used in an episode will be archived — kept so its tracklist stays true` : ''}. Rejected songs are never drawn again.`,
    confirmLabel: 'Reject', danger: true,
  })
  if (!ok) return
  try {
    await post(`/projects/${slug.value}/song-pool/reject`, { song_ids: picked.map(s => s.id) })
    selected.value = new Set(); success(`Rejected ${picked.length} song${picked.length === 1 ? '' : 's'}.`); await load()
  } catch (e: any) { showError(e?.data?.detail || 'Could not reject the songs') }
}

function rememberedMusicModel() { try { return localStorage.getItem(`story-studio:song-pool:music-model:${slug.value}`) || '' } catch { return '' } }
async function startRegenerate(ids: string[], briefEdits?: Record<string, unknown>) {
  const own = songs.value.find(s => ids.includes(s.id) && s.music_model)?.music_model
  const model = own || rememberedMusicModel()
  if (!model) { showError('Open Generate Songs once to pick the song model, then Regenerate.'); return false }
  const payload = { mode: 'regenerate', song_ids: ids, music_model: model, in_flight: Math.min(16, ids.length), ...(briefEdits ? { brief_edits: briefEdits } : {}) }
  const operationId = fresh.begin(payload)
  await post(`/projects/${slug.value}/song-pool/generate`, { ...payload, operation_id: operationId })
  fresh.complete(operationId)
  success(`Regenerating ${ids.length} song${ids.length === 1 ? '' : 's'}. The old take stays until you remove it.`)
  await load()
  return true
}
async function regenerate(ids: string[]) {
  try { await startRegenerate(ids) } catch (e: any) { showError(e?.data?.detail || 'Could not start the regenerate') }
}

const editing = ref<any>(null)
const edit = reactive<Record<string, any>>({})
const editError = ref('')
const editBusy = ref(false)
const editFields = [
  { key: 'title', label: 'Title' }, { key: 'ensemble', label: 'Ensemble' }, { key: 'mood', label: 'Mood' },
  { key: 'tempo_bpm', label: 'Tempo (BPM)', num: true }, { key: 'key', label: 'Key' }, { key: 'texture', label: 'Texture' },
  { key: 'structure', label: 'Structure' }, { key: 'length_s', label: 'Length (seconds)', num: true },
  { key: 'line', label: 'Descriptive line', wide: true }, { key: 'scene_idea', label: 'Scene idea', wide: true },
]
function openEdit(s: any) {
  editing.value = s; editError.value = ''
  for (const f of editFields) edit[f.key] = s[f.key] ?? (f.key === 'length_s' ? Math.round(s.duration_s || 0) : '')
}
async function submitEdit() {
  editBusy.value = true; editError.value = ''
  try {
    const edits: Record<string, unknown> = {}
    for (const f of editFields) edits[f.key] = f.num ? Number(edit[f.key]) : String(edit[f.key] || '').trim()
    if (await startRegenerate([editing.value.id], edits)) editing.value = null
  } catch (e: any) { editError.value = e?.data?.detail || 'Could not start the regenerate' }
  finally { editBusy.value = false }
}

async function reveal() {
  try { await post('/system/reveal-folder', { path: data.value?.folder }) } catch (e: any) { showError(e?.data?.detail || 'Could not open the folder') }
}

const audioEl = ref<HTMLAudioElement | null>(null)
const playing = ref('')
const progress = ref(0)
const position = ref(0)
function play(s: any) {
  const el = audioEl.value
  if (!el) return
  if (playing.value === s.id) { el.pause(); playing.value = ''; return }
  el.src = `/api/projects/${slug.value}/song-pool/songs/${s.id}/audio`
  playing.value = s.id; expanded.value = s.id; progress.value = 0
  el.play().catch(() => { playing.value = '' })
}
function onTime() { const el = audioEl.value; if (el?.duration) { position.value = el.currentTime; progress.value = el.currentTime / el.duration } }
function onAudioError() { if (playing.value) showError('That song could not be played. Its file may have been moved.'); playing.value = '' }

async function loadModels() {
  try {
    musicModels.value = (await get<{ models: SongPoolMusicModel[] }>('/app-settings/genstudio/music-models')).models || []
    const missing = !!manualMusicModelId.value && !musicModels.value.some(model => model.id === manualMusicModelId.value)
    const preservePending = missing && pendingManualSong.value?.attempted === true
      && pendingManualSong.value.modelId === manualMusicModelId.value
    if (!manualMusicModelId.value || (missing && !preservePending)) {
      manualMusicModelId.value = musicModels.value.find(model => model.price_source === 'local')?.id || ''
    }
  } catch { musicModels.value = [] }
}

watch(slug, () => {
  manualSourcesSequence++
  manualRedoPreference.reset()
  cancelPendingManualSong()
  manualSourceChoice.value = ''
  manualSources.value = []
  data.value = null
  selected.value = new Set()
  void load()
  void manualRedoPreference.load(slug.value).then(() => loadManualSources())
})
watch(manualMusicModelId, (current, previous) => { if (previous && current !== previous) cancelPendingManualSong() })
watch(() => jobs.value.map(job => [job.job_id, job.status, job.force_abandoned]), () => { void loadManualSources() })
watch(() => route.query.generate, (n) => { const c = Number(n); if (c > 0 && data.value && !data.value.formula?.error) openGenerate('new', Math.round(c)) })
onMounted(async () => {
  await load()
  void loadModels()
  void manualRedoPreference.load(slug.value).then(() => loadManualSources())
  const c = Number(route.query.generate)
  if (c > 0 && data.value && !data.value.formula?.error) openGenerate('new', Math.round(c))
})
onBeforeUnmount(() => { if (poll) clearInterval(poll); audioEl.value?.pause() })
</script>

<style src="~/assets/css/music-pool.css"></style>
<style scoped>
.mp-ttl { cursor: pointer; min-width: 280px; }
.mp-ttl b { display: block; font-size: 14px; }
.mp-ttl span { font-size: 12px; color: var(--text-muted); }
.mp-detail td { background: var(--surface-subtle, var(--bg-secondary)); }
.mp-bulk { border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border)); background: var(--accent-dim); border-radius: var(--radius-md); padding: 8px 12px; }
.mp-more { position: relative; white-space: nowrap; }
.mp-menu {
  position: absolute; right: 0; top: 100%; z-index: 20; display: flex; flex-direction: column; min-width: 220px;
  background: var(--bg-secondary); border: 1px solid var(--border); border-radius: var(--radius-md); padding: 6px; box-shadow: var(--shadow-md, 0 8px 24px rgba(0,0,0,.3));
}
.mp-menu button { text-align: left; background: none; border: 0; color: var(--text-primary); padding: 7px 10px; font-size: 13px; border-radius: var(--radius-sm); cursor: pointer; font-family: inherit; }
.mp-menu button:hover:not(:disabled) { background: var(--bg-tertiary); }
.mp-menu button:disabled { color: var(--text-muted); cursor: default; }
</style>
