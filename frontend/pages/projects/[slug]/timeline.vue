<template>
  <div class="workspace-page timeline-workspace">
    <WorkspaceHero
      eyebrow="Video · Optional"
      title="Episode Timeline"
      description="One timeline for this episode: every second belongs to one segment, each segment picks its media, and Preflight prices the whole thing before anything renders."
    />

    <div class="card tl-episode">
      <EpisodeSelector
        v-model="episodeId"
        :project-slug="slug"
        @episode-selected="onEpisodeSelected"
      />
      <h2 v-if="episodeTitle" class="tl-episode-title">{{ episodeTitle }}</h2>
      <p v-else-if="episodeId" class="muted">Episode {{ episodeId }}</p>
    </div>

    <p v-if="error" class="tl-error" role="alert">{{ error }}</p>
    <p v-if="status" class="tl-status" role="status">{{ status }}</p>

    <div v-if="loading" class="card muted">Loading this episode's timeline…</div>

    <!-- No timeline yet: build it from the scene plan, or say why not. -->
    <div v-else-if="!timeline" class="card tl-empty">
      <template v-if="canBuild && scenePlan">
        <p>
          This episode's scene plan has <strong>{{ scenePlan.scene_count }}</strong>
          {{ scenePlan.scene_count === 1 ? 'scene' : 'scenes' }} over
          <strong>{{ formatDuration(scenePlan.total_duration_sec) }}</strong>.
          The timeline starts from it — one segment per scene, each one ready to choose its media.
        </p>
        <button type="button" class="btn btn-primary" :disabled="busy" @click="build">
          {{ busy ? 'Building…' : 'Build timeline from Scene Plan' }}
        </button>
      </template>
      <template v-else>
        <p>{{ buildMessage }}</p>
      </template>
    </div>

    <template v-else>
      <!-- One preflight for the whole episode: credits and duration before any render. -->
      <section class="card tl-preflight" aria-label="Preflight">
        <div class="tl-preflight-head">
          <div>
            <span class="section-kicker">Before anything renders</span>
            <h2>Preflight</h2>
          </div>
          <div class="tl-preflight-controls">
            <label class="tl-field">
              <span>Image model</span>
              <select v-model="imageModelId" class="select" :disabled="imageModelsLoading">
                <option value="" disabled>{{ imageModelsLoading ? 'Loading models…' : 'Choose a model' }}</option>
                <option v-for="model in imageModels" :key="model.id" :value="model.id">
                  {{ model.display_name }}
                </option>
              </select>
            </label>
            <button
              type="button"
              class="btn btn-primary"
              :disabled="busy || !imageModelId"
              @click="runPreflight"
            >
              {{ busy ? 'Working…' : 'Preflight' }}
            </button>
          </div>
        </div>
        <p v-if="imageModelsError" class="tl-note">{{ imageModelsError }}</p>
        <p v-else-if="!imageModels.length && !imageModelsLoading" class="tl-note">
          No image models are published for this Mac yet.
        </p>

        <div v-if="preflight" class="tl-preflight-result">
          <div class="tl-metric">
            <span class="tl-metric-label">Maximum credits</span>
            <strong v-if="preflight.preflight.credits !== null" class="tl-metric-value">
              {{ preflight.preflight.credits }}
            </strong>
            <strong v-else class="tl-metric-value tl-unknown">
              {{ preflight.preflight.credits_note || 'price not published' }}
            </strong>
          </div>
          <div class="tl-metric">
            <span class="tl-metric-label">Estimated time</span>
            <strong class="tl-metric-value">{{ formatDuration(preflight.preflight.estimated_seconds) }}</strong>
          </div>
          <div class="tl-metric">
            <span class="tl-metric-label">Segments</span>
            <strong class="tl-metric-value">{{ preflight.preflight.segments }}</strong>
          </div>
          <div class="tl-metric">
            <span class="tl-metric-label">Assembly</span>
            <strong class="tl-metric-value">{{ formatDuration(preflight.preflight.assembly_seconds) }}</strong>
          </div>
          <p class="tl-note">
            Image: {{ preflight.image.price === 'published'
              ? `${preflight.image.credits_per_image} credits per still (${preflight.image.model_label || preflight.image.model_id})`
              : 'price not published' }}
            · Video: {{ preflight.video.price === 'published'
              ? `${preflight.video.credits_per_second} credits per second`
              : 'price not published' }}
            · Stock: 0 for local and free clips
          </p>
          <p class="tl-note">{{ preflight.timing_note }}</p>
          <p v-if="preflight.has_published_video_model" class="tl-note">
            The Gateway publishes a video model, so Text-to-video and Image-to-video are offered below.
          </p>
          <ul v-if="preflight.preflight.by_media" class="tl-by-media">
            <li v-for="(bucket, media) in preflight.preflight.by_media" :key="media">
              {{ mediaLabel(String(media)) }}: {{ bucket.segments }}
              {{ bucket.segments === 1 ? 'segment' : 'segments' }},
              {{ bucket.credits }} credits
            </li>
          </ul>
        </div>
      </section>

      <!-- The segmented timeline itself. -->
      <section class="card tl-list" aria-label="Segments">
        <div class="tl-list-head">
          <h2>Segments</h2>
          <span class="muted">
            {{ segments.length }} {{ segments.length === 1 ? 'segment' : 'segments' }} ·
            {{ formatDuration(timeline.total_duration_sec) }} · shares total 100%
          </span>
        </div>

        <ol class="tl-rows">
          <li v-for="(segment, index) in segments" :key="segment.id" class="tl-row">
            <div class="tl-row-head">
              <span class="tl-range">
                {{ formatClock(segment.start_sec) }}–{{ formatClock(segment.end_sec) }}
              </span>
              <span class="tl-share">{{ shares[index] ?? 0 }}%</span>
              <span class="tl-media-badge" :data-media="segment.media_type">
                {{ mediaLabel(segment.media_type) }}
              </span>
              <span v-if="segment.prompt" class="tl-prompt" :title="segment.prompt">
                {{ segment.prompt }}
              </span>
            </div>

            <div class="tl-row-controls">
              <label class="tl-field">
                <span>Media</span>
                <select
                  class="select"
                  :value="segment.media_type"
                  :disabled="busy"
                  @change="changeMedia(segment, index, $event)"
                >
                  <option value="t2i">Image (t2i)</option>
                  <option value="sketch">Sketch</option>
                  <option value="chart">Chart</option>
                  <option value="stock">Stock footage</option>
                  <option v-if="hasPublishedVideoModel" value="t2v">Text to video (t2v)</option>
                  <option v-if="hasPublishedVideoModel" value="i2v">Image to video (i2v)</option>
                </select>
              </label>

              <label class="tl-field tl-field-split">
                <span>Split at (seconds)</span>
                <input
                  v-model="splitAt[segment.id]"
                  type="number"
                  class="input"
                  :min="segment.start_sec"
                  :max="segment.end_sec"
                  step="0.1"
                  :disabled="busy"
                />
              </label>

              <div class="tl-row-actions">
                <!-- The row's one primary action. -->
                <button
                  type="button"
                  class="btn btn-primary btn-sm"
                  :disabled="busy"
                  @click="split(segment)"
                >
                  Split
                </button>
                <button
                  v-if="index < segments.length - 1 && mergeChoiceFor !== segment.id"
                  type="button"
                  class="btn btn-secondary btn-sm"
                  :disabled="busy"
                  @click="mergeNext(segment, index)"
                >
                  Merge with next
                </button>
              </div>
            </div>

            <!-- Two neighbouring segments that disagree on media: the choice is
                 the operator's, never decided here. -->
            <div v-if="mergeChoiceFor === segment.id" class="tl-merge-choice">
              <span class="tl-note">
                These two use different media — choose which one survives the merge.
              </span>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy"
                @click="mergeWith(segment, index, segment.media_type)"
              >
                Keep {{ mediaLabel(segment.media_type) }}
              </button>
              <button
                type="button"
                class="btn btn-ghost btn-sm"
                :disabled="busy"
                @click="mergeWith(segment, index, segments[index + 1].media_type)"
              >
                Keep {{ mediaLabel(segments[index + 1].media_type) }}
              </button>
              <button type="button" class="btn btn-ghost btn-sm" @click="mergeChoiceFor = ''">
                Cancel
              </button>
            </div>

            <!-- Chart data: type, labels and values, saved onto the segment. -->
            <div v-if="segment.media_type === 'chart'" class="tl-chart">
              <div class="tl-chart-head">
                <label class="tl-field">
                  <span>Chart type</span>
                  <select v-model="chartDraftFor(segment).kind" class="select select-sm" :disabled="busy">
                    <option value="bar">Bar</option>
                    <option value="line">Line</option>
                    <option value="pie">Pie</option>
                  </select>
                </label>
                <span class="tl-note">No credits — charts render locally.</span>
              </div>
              <div
                v-for="(label, rowIndex) in chartDraftFor(segment).labels"
                :key="rowIndex"
                class="tl-chart-row"
              >
                <input
                  v-model="chartDraftFor(segment).labels[rowIndex]"
                  type="text"
                  class="input input-sm"
                  placeholder="Label"
                  :disabled="busy"
                />
                <input
                  v-model.number="chartDraftFor(segment).values[rowIndex]"
                  type="number"
                  class="input input-sm"
                  placeholder="Value"
                  :disabled="busy"
                />
                <button
                  type="button"
                  class="btn-icon danger"
                  title="Remove this row"
                  :disabled="busy"
                  @click="removeChartRow(segment, rowIndex)"
                >&#10005;</button>
              </div>
              <div class="tl-chart-actions">
                <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="addChartRow(segment)">
                  Add row
                </button>
                <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="saveChart(segment)">
                  Save chart data
                </button>
              </div>
            </div>

            <!-- Stock: search the footage library and pick a clip. -->
            <div v-if="segment.media_type === 'stock' || stockFor === segment.id" class="tl-stock">
              <p v-if="footageState === 'missing'" class="tl-note">
                Footage client not connected yet — stock search will appear when the footage routes are in this build.
              </p>
              <template v-else>
                <div class="tl-stock-search">
                  <input
                    v-model="footageQuery"
                    type="search"
                    class="input input-sm"
                    placeholder="Search stock clips"
                    :disabled="busy"
                    @keyup.enter="searchFootage"
                  />
                  <button type="button" class="btn btn-secondary btn-sm" :disabled="busy" @click="searchFootage">
                    Search
                  </button>
                </div>
                <p v-if="footageError" class="tl-note tl-error">{{ footageError }}</p>
                <ul v-if="footageResults.length" class="tl-stock-results">
                  <li v-for="row in footageResults" :key="String(row.sha256 || row.title)">
                    <span class="tl-stock-title">{{ row.title || row.sha256 }}</span>
                    <span v-if="row.duration_seconds" class="muted">
                      {{ formatDuration(Number(row.duration_seconds)) }}
                    </span>
                    <span v-if="row.licence" class="muted">{{ row.licence }}</span>
                    <button
                      v-if="row.sha256"
                      type="button"
                      class="btn btn-secondary btn-sm"
                      :disabled="busy"
                      @click="pickFootage(segment, String(row.sha256))"
                    >
                      Use this clip
                    </button>
                  </li>
                </ul>
                <p v-else-if="footageSearched && !footageError" class="tl-note">
                  No clips matched. Try different words.
                </p>
                <p v-if="segment.footage_sha256" class="tl-note">
                  Chosen clip: <code>{{ segment.footage_sha256.slice(0, 12) }}…</code>
                </p>
              </template>
            </div>
          </li>
        </ol>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
definePageMeta({ layout: 'dashboard', key: route => String(route.params.slug || '') })

interface ChartDraft {
  kind: 'bar' | 'line' | 'pie'
  labels: string[]
  values: number[]
}

interface Segment {
  id: string
  start_sec: number
  end_sec: number
  media_type: string
  chart?: { kind: string; labels: string[]; values: number[] }
  footage_sha256?: string
  prompt?: string
}

interface Timeline {
  schema_version: number
  episode_id: string
  total_duration_sec: number
  segments: Segment[]
}

const route = useRoute()
const slug = computed(() => String(route.params.slug || ''))
const { get, post, patch } = useApi()

const episodeId = ref('')
const episodeTitle = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const status = ref('')

const timeline = ref<Timeline | null>(null)
const shares = ref<number[]>([])
const canBuild = ref(false)
const scenePlan = ref<{ scene_count: number; total_duration_sec: number } | null>(null)
const buildMessage = ref('Choose an episode to see its timeline.')

const preflight = ref<any>(null)
const hasPublishedVideoModel = ref(false)
const imageModels = ref<Array<{ id: string; display_name: string }>>([])
const imageModelsLoading = ref(false)
const imageModelsError = ref('')
const imageModelId = ref('')

const splitAt = ref<Record<string, number | string>>({})
const chartDrafts = ref<Record<string, ChartDraft>>({})
const mergeChoiceFor = ref('')
const stockFor = ref('')

const footageState = ref<'unknown' | 'ready' | 'missing'>('unknown')
const footageQuery = ref('')
const footageResults = ref<Array<Record<string, unknown>>>([])
const footageSearched = ref(false)
const footageError = ref('')

const segments = computed(() => timeline.value?.segments ?? [])

function detailOf(error: unknown): string {
  const e = error as any
  return String(e?.data?.detail || e?.message || 'Something went wrong. Please try again.')
}

function statusOf(error: unknown): number {
  const e = error as any
  return Number(e?.response?.status ?? e?.status ?? e?.statusCode ?? 0)
}

function mediaLabel(media: string): string {
  const labels: Record<string, string> = {
    t2i: 'Image', sketch: 'Sketch', chart: 'Chart', stock: 'Stock', t2v: 'Text to video', i2v: 'Image to video',
  }
  return labels[media] || media
}

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  if (!minutes) return `${rest} s`
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`
}

function formatClock(seconds: number): string {
  const value = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(value / 60)
  const rest = (value % 60).toFixed(1).replace(/\.0$/, '')
  return `${minutes}:${String(rest).padStart(4, '0')}`
}

function onEpisodeSelected(episode: any) {
  episodeTitle.value = String(episode?.title || '')
}

/** Every write answers with the saved timeline and its shares. */
function applyAnswer(answer: any) {
  if (answer?.timeline) {
    timeline.value = answer.timeline
    shares.value = answer.shares || []
    for (const segment of answer.timeline.segments) {
      if (!(segment.id in splitAt.value)) {
        splitAt.value[segment.id] = Math.round(((segment.start_sec + segment.end_sec) / 2) * 10) / 10
      }
      if (segment.media_type === 'chart' && segment.chart && !(segment.id in chartDrafts.value)) {
        chartDrafts.value[segment.id] = {
          kind: (segment.chart.kind as ChartDraft['kind']) || 'bar',
          labels: [...(segment.chart.labels || [])],
          values: [...(segment.chart.values || [])],
        }
      }
    }
  }
}

async function loadTimeline() {
  error.value = ''
  status.value = ''
  preflight.value = null
  mergeChoiceFor.value = ''
  stockFor.value = ''
  if (!episodeId.value) {
    timeline.value = null
    canBuild.value = false
    scenePlan.value = null
    buildMessage.value = 'Choose an episode to see its timeline.'
    return
  }
  loading.value = true
  try {
    const answer = await get(`/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline`)
    episodeTitle.value = String(answer.episode_title || episodeTitle.value || '')
    canBuild.value = answer.can_build === true
    scenePlan.value = answer.scene_plan || null
    buildMessage.value = String(answer.message || 'This episode has no timeline yet.')
    if (answer.timeline) applyAnswer(answer)
    else {
      timeline.value = null
      shares.value = []
    }
  } catch (e) {
    timeline.value = null
    error.value = detailOf(e)
  } finally {
    loading.value = false
  }
}

async function build() {
  busy.value = true
  error.value = ''
  status.value = 'Building the timeline from the scene plan…'
  try {
    const answer = await post(`/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline`)
    applyAnswer(answer)
    status.value = `Timeline built: ${answer.timeline.segments.length} segments.`
  } catch (e) {
    status.value = ''
    error.value = detailOf(e)
  } finally {
    busy.value = false
  }
}

async function saveSegment(segmentId: string, body: Record<string, unknown>): Promise<boolean> {
  if (!timeline.value) return false
  busy.value = true
  error.value = ''
  try {
    const answer = await patch(
      `/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline/segments/${encodeURIComponent(segmentId)}`,
      body,
    )
    applyAnswer(answer)
    status.value = 'Segment saved.'
    return true
  } catch (e) {
    status.value = ''
    error.value = detailOf(e)
    return false
  } finally {
    busy.value = false
  }
}

function starterChart(segment: Segment, index: number): ChartDraft {
  const label = segment.prompt ? segment.prompt.slice(0, 40) : `Segment ${index + 1}`
  return { kind: 'bar', labels: [label || `Segment ${index + 1}`], values: [0] }
}

async function changeMedia(segment: Segment, index: number, event: Event) {
  const select = event.target as HTMLSelectElement
  const next = select.value
  // Stock needs a clip before the segment can become one: open the picker
  // instead of writing a segment validation would refuse.
  if (next === 'stock') {
    select.value = segment.media_type
    stockFor.value = segment.id
    footageState.value = 'unknown'
    footageResults.value = []
    footageSearched.value = false
    footageError.value = ''
    return
  }
  if (next === segment.media_type) return
  const body: Record<string, unknown> = { media_type: next }
  if (next === 'chart') {
    const draft = starterChart(segment, index)
    chartDrafts.value[segment.id] = draft
    body.chart = draft
  }
  const ok = await saveSegment(segment.id, body)
  if (!ok) select.value = segment.media_type
}

function chartDraftFor(segment: Segment): ChartDraft {
  if (!chartDrafts.value[segment.id]) {
    chartDrafts.value[segment.id] = segment.chart
      ? { kind: (segment.chart.kind as ChartDraft['kind']) || 'bar', labels: [...segment.chart.labels], values: [...segment.chart.values] }
      : { kind: 'bar', labels: [''], values: [0] }
  }
  return chartDrafts.value[segment.id]!
}

function addChartRow(segment: Segment) {
  const draft = chartDraftFor(segment)
  if (draft.labels.length >= 24) return
  draft.labels.push('')
  draft.values.push(0)
}

function removeChartRow(segment: Segment, rowIndex: number) {
  const draft = chartDraftFor(segment)
  if (draft.labels.length <= 1) return
  draft.labels.splice(rowIndex, 1)
  draft.values.splice(rowIndex, 1)
}

async function saveChart(segment: Segment) {
  const draft = chartDraftFor(segment)
  const labels = draft.labels.map(label => String(label || '').trim())
  if (labels.some(label => !label)) {
    error.value = 'Every chart row needs a label.'
    return
  }
  await saveSegment(segment.id, {
    media_type: 'chart',
    chart: { kind: draft.kind, labels, values: draft.values.map(value => Number(value)) },
  })
}

async function searchFootage() {
  footageError.value = ''
  footageSearched.value = true
  const query = encodeURIComponent(footageQuery.value.trim())
  const candidates = [
    `/projects/${slug.value}/footage/search?q=${query}`,
    `/footage/search?q=${query}`,
  ]
  for (const path of candidates) {
    try {
      const answer = await get(path)
      const rows = (answer?.results || answer?.library || answer?.clips || []) as Array<Record<string, unknown>>
      footageResults.value = rows
      footageState.value = 'ready'
      return
    } catch (e) {
      if (statusOf(e) === 404) continue
      footageError.value = detailOf(e)
      return
    }
  }
  // Neither route exists in this build: say so rather than showing no clips.
  footageState.value = 'missing'
  footageResults.value = []
}

async function pickFootage(segment: Segment, sha256: string) {
  const ok = await saveSegment(segment.id, { media_type: 'stock', footage_sha256: sha256 })
  if (ok) stockFor.value = ''
}

async function split(segment: Segment) {
  const at = Number(splitAt.value[segment.id])
  if (!Number.isFinite(at)) {
    error.value = 'Enter the split point in seconds, inside the segment.'
    return
  }
  busy.value = true
  error.value = ''
  try {
    const answer = await post(
      `/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline/segments/${encodeURIComponent(segment.id)}/split`,
      { at_sec: at },
    )
    applyAnswer(answer)
    status.value = 'Segment split.'
  } catch (e) {
    error.value = detailOf(e)
  } finally {
    busy.value = false
  }
}

async function mergeNext(segment: Segment, index: number) {
  const neighbour = segments.value[index + 1]
  if (!neighbour) return
  if (neighbour.media_type !== segment.media_type) {
    // Different media: the service refuses to re-decide on its own, so the
    // choice is asked for here rather than guessed.
    mergeChoiceFor.value = segment.id
    return
  }
  await mergeWith(segment, index, undefined)
}

async function mergeWith(segment: Segment, index: number, mediaType: string | undefined) {
  const neighbour = segments.value[index + 1]
  if (!neighbour) return
  busy.value = true
  error.value = ''
  try {
    const answer = await post(`/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline/merge`, {
      first_id: segment.id,
      second_id: neighbour.id,
      ...(mediaType ? { media_type: mediaType } : {}),
    })
    applyAnswer(answer)
    mergeChoiceFor.value = ''
    status.value = 'Segments merged.'
  } catch (e) {
    error.value = detailOf(e)
  } finally {
    busy.value = false
  }
}

async function loadImageModels() {
  imageModelsLoading.value = true
  imageModelsError.value = ''
  try {
    const answer = await get('/app-settings/genstudio/image-models')
    imageModels.value = (answer?.models || []) as Array<{ id: string; display_name: string }>
    if (!imageModelId.value && imageModels.value.length) {
      imageModelId.value = imageModels.value[0]!.id
    }
  } catch (e) {
    imageModelsError.value = detailOf(e)
  } finally {
    imageModelsLoading.value = false
  }
}

async function runPreflight() {
  if (!imageModelId.value) return
  busy.value = true
  error.value = ''
  status.value = 'Pricing this timeline against the live Gateway catalogue…'
  try {
    const answer = await post(
      `/projects/${slug.value}/episodes/${encodeURIComponent(episodeId.value)}/timeline/preflight`,
      { image_model_id: imageModelId.value },
    )
    preflight.value = answer
    hasPublishedVideoModel.value = answer.has_published_video_model === true
    status.value = 'Preflight ready — nothing has been rendered.'
  } catch (e) {
    status.value = ''
    error.value = detailOf(e)
  } finally {
    busy.value = false
  }
}

watch(episodeId, () => {
  if (!episodeId.value) {
    loadTimeline()
    return
  }
  if (!imageModels.value.length && !imageModelsLoading.value) loadImageModels()
  loadTimeline()
})
</script>

<style scoped>
.tl-episode {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: 1rem;
}

.tl-episode-title {
  margin: 0;
  font-size: 1.15rem;
}

.tl-error {
  color: var(--danger, #c0392b);
  margin: 0 0 0.75rem;
}

.tl-status {
  margin: 0 0 0.75rem;
  color: var(--text-muted, #6b7280);
}

.tl-empty p {
  margin-bottom: 1rem;
}

.tl-preflight {
  margin-bottom: 1rem;
}

.tl-preflight-head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  align-items: flex-end;
  justify-content: space-between;
}

.tl-preflight-head h2 {
  margin: 0.15rem 0 0;
  font-size: 1.1rem;
}

.tl-preflight-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.tl-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.85rem;
  color: var(--text-muted, #6b7280);
}

.tl-field-split {
  max-width: 11rem;
}

.tl-preflight-result {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.75rem;
  margin-top: 1rem;
}

.tl-metric {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}

.tl-metric-label {
  font-size: 0.8rem;
  color: var(--text-muted, #6b7280);
}

.tl-metric-value {
  font-size: 1.25rem;
}

.tl-unknown {
  color: var(--text-muted, #6b7280);
  font-size: 1rem;
}

.tl-note {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 0.85rem;
  color: var(--text-muted, #6b7280);
}

.tl-by-media {
  grid-column: 1 / -1;
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.85rem;
  color: var(--text-muted, #6b7280);
}

.tl-list-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.tl-list-head h2 {
  margin: 0;
  font-size: 1.1rem;
}

.tl-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.tl-row {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.tl-row-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: baseline;
}

.tl-range {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}

.tl-share {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted, #6b7280);
}

.tl-media-badge {
  font-size: 0.8rem;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--surface-muted, #f3f4f6);
}

.tl-prompt {
  flex: 1 1 12rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.85rem;
  color: var(--text-muted, #6b7280);
}

.tl-row-controls {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.tl-row-actions {
  display: flex;
  gap: 0.5rem;
  margin-left: auto;
}

.tl-merge-choice {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}

.tl-chart,
.tl-stock {
  border-top: 1px dashed var(--border, #e5e7eb);
  padding-top: 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.tl-chart-head,
.tl-chart-actions,
.tl-stock-search {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: flex-end;
}

.tl-chart-row {
  display: grid;
  grid-template-columns: 1fr 8rem auto;
  gap: 0.5rem;
}

.tl-stock-results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.tl-stock-results li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem;
  align-items: center;
}

.tl-stock-title {
  font-weight: 600;
}
</style>
