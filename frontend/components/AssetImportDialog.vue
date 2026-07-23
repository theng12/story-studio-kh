<template>
  <Modal :visible="visible" size="lg" labelledby="asset-import-title" @close="onClose">
    <div class="dialog-head">
      <h2 id="asset-import-title">Import existing assets — {{ episodeCode }}</h2>
      <p class="text-muted dialog-sub">
        Pick files you already have on disk and we'll copy them into the right
        episode subfolder with the canonical name. Useful for pre-Story-Studio
        episodes whose files don't follow our naming convention yet.
      </p>
    </div>

    <!-- Tab strip ─────────────────────────────────────────────────────── -->
    <div class="tab-strip">
      <button
        v-for="t in tabs"
        :key="t.id"
        :class="['tab-btn', { active: activeTab === t.id }]"
        :title="t.hint"
        @click="setTab(t.id)"
      >
        <span class="tab-icon" aria-hidden="true">{{ t.icon }}</span>
        <span>{{ t.label }}</span>
        <span v-if="countForTab(t.id) > 0" class="tab-count">{{ countForTab(t.id) }}</span>
      </button>
    </div>

    <!-- File picker — native OS dialog via IPC (modern Electron strips
         File.path off renderer-side <input> elements, so we can't read
         absolute paths from a browser file input). The native dialog
         returns absolute paths the backend can copy/move from. -->
    <div class="picker-row">
      <button class="btn btn-secondary btn-sm" :disabled="picking" @click="pickViaNative">
        <LoadingSpinner v-if="picking" size="sm" />
        {{ activeFiles.length ? '+ Add more files' : 'Pick files…' }}
      </button>
      <span v-if="activeFiles.length" class="text-muted file-count">
        {{ activeFiles.length }} file{{ activeFiles.length === 1 ? '' : 's' }} selected
      </span>
      <button
        v-if="activeFiles.length"
        class="btn btn-ghost btn-sm"
        @click="clearActiveFiles"
        title="Drop selection for this tab; switch tabs without losing other tabs' selections"
      >Clear</button>
    </div>

    <!-- Tab body — picker + per-row mapping UI ────────────────────────── -->
    <div class="tab-body">

      <!-- AUDIO ────────────────────────────────────────────────────────── -->
      <div v-if="activeTab === 'audio'">
        <p v-if="!audioFiles.length" class="text-muted hint">
          Pick your audio files (one per chapter, plus introduction).
          Numbered names like <code>1.mp3</code>, <code>2.mp3</code>… auto-map
          to Chapter 1, Chapter 2… Re-map any row by changing its dropdown.
        </p>
        <div v-else class="map-table">
          <div class="map-row map-head">
            <span class="col-source">Source filename</span>
            <span class="col-arrow"></span>
            <span class="col-mapping">Maps to</span>
            <span class="col-act"></span>
          </div>
          <div v-for="(row, i) in audioFiles" :key="i" class="map-row">
            <span class="col-source" :title="row.path">{{ basename(row.path) }}</span>
            <span class="col-arrow">→</span>
            <select v-model="row.section_slug" class="select input-sm col-mapping">
              <option v-for="opt in audioOptions" :key="opt" :value="opt">
                {{ formatAudioSlug(opt) }}
              </option>
            </select>
            <button class="btn-icon" @click="audioFiles.splice(i, 1)" title="Remove this file">✕</button>
          </div>
        </div>
        <p v-if="audioFiles.length" class="text-muted hint">
          Files land at <code>{{ episodeCode }}_<em>{slug}</em>.mp3</code>
          inside the audio folder.
        </p>
      </div>

      <!-- SCENES ───────────────────────────────────────────────────────── -->
      <div v-if="activeTab === 'scene'">
        <p v-if="!sceneFiles.length" class="text-muted hint">
          Pick your scene image files. They'll be auto-numbered
          <code>Scene01</code>, <code>Scene02</code>… in the order you picked
          them. Drag rows below to reorder.
        </p>
        <div v-else class="map-table">
          <button
            class="btn btn-secondary btn-sm renumber-btn"
            @click="renumberScenes"
            title="Reset every scene number to its position in the list (1-based)"
          >
            🔢 Auto-number in order
          </button>
          <div class="map-row map-head">
            <span class="col-source">Source filename</span>
            <span class="col-arrow"></span>
            <span class="col-mapping">Maps to</span>
            <span class="col-act"></span>
          </div>
          <div v-for="(row, i) in sceneFiles" :key="i" class="map-row">
            <span class="col-source" :title="row.path">{{ basename(row.path) }}</span>
            <span class="col-arrow">→</span>
            <span class="col-mapping mono">
              {{ episodeCode }}_Scene{{ pad2(row.scene_number) }}_v1{{ extOf(row.path) }}
              <input
                v-model.number="row.scene_number"
                type="number"
                min="1"
                max="999"
                class="input input-xs scene-num-input"
                title="Override scene number"
              />
            </span>
            <button class="btn-icon" @click="sceneFiles.splice(i, 1)" title="Remove">✕</button>
          </div>
        </div>
      </div>

      <!-- THUMBNAILS ───────────────────────────────────────────────────── -->
      <div v-if="activeTab === 'thumb'">
        <p v-if="!thumbFiles.length" class="text-muted hint">
          Pick thumbnail images. Auto-numbered <code>Thumb01</code>,
          <code>Thumb02</code>… in selection order.
        </p>
        <div v-else class="map-table">
          <button class="btn btn-secondary btn-sm renumber-btn" @click="renumberThumbs">🔢 Auto-number in order</button>
          <div class="map-row map-head">
            <span class="col-source">Source</span>
            <span class="col-arrow"></span>
            <span class="col-mapping">Maps to</span>
            <span class="col-act"></span>
          </div>
          <div v-for="(row, i) in thumbFiles" :key="i" class="map-row">
            <span class="col-source" :title="row.path">{{ basename(row.path) }}</span>
            <span class="col-arrow">→</span>
            <span class="col-mapping mono">
              {{ episodeCode }}_Thumb{{ pad2(row.thumb_number) }}_v1{{ extOf(row.path) }}
              <input v-model.number="row.thumb_number" type="number" min="1" max="999" class="input input-xs scene-num-input" />
            </span>
            <button class="btn-icon" @click="thumbFiles.splice(i, 1)">✕</button>
          </div>
        </div>
      </div>

      <!-- VIDEO CLIPS ──────────────────────────────────────────────────── -->
      <div v-if="activeTab === 'video'">
        <p v-if="!videoFiles.length" class="text-muted hint">
          Pick per-scene video clips. Auto-numbered <code>Video01</code>,
          <code>Video02</code>…
        </p>
        <div v-else class="map-table">
          <button class="btn btn-secondary btn-sm renumber-btn" @click="renumberVideos">🔢 Auto-number in order</button>
          <div class="map-row map-head">
            <span class="col-source">Source</span>
            <span class="col-arrow"></span>
            <span class="col-mapping">Maps to</span>
            <span class="col-act"></span>
          </div>
          <div v-for="(row, i) in videoFiles" :key="i" class="map-row">
            <span class="col-source" :title="row.path">{{ basename(row.path) }}</span>
            <span class="col-arrow">→</span>
            <span class="col-mapping mono">
              {{ episodeCode }}_Video{{ pad2(row.scene_number) }}_v1{{ extOf(row.path) }}
              <input v-model.number="row.scene_number" type="number" min="1" max="999" class="input input-xs scene-num-input" />
            </span>
            <button class="btn-icon" @click="videoFiles.splice(i, 1)">✕</button>
          </div>
        </div>
      </div>

      <!-- FINAL VIDEO / MERGED AUDIO (single-file each) ────────────────── -->
      <div v-if="activeTab === 'final'">
        <p v-if="!finalFile" class="text-muted hint">
          Pick the assembled final video. Lands at
          <code>{{ episodeCode }}_final_video.{ext}</code>.
        </p>
        <div v-else class="map-table">
          <div class="map-row">
            <span class="col-source">{{ basename(finalFile) }}</span>
            <span class="col-arrow">→</span>
            <span class="col-mapping mono">
              {{ episodeCode }}_final_video{{ extOf(finalFile) }}
            </span>
            <button class="btn-icon" @click="finalFile = null">✕</button>
          </div>
        </div>
      </div>

      <div v-if="activeTab === 'merged'">
        <p v-if="!mergedFile" class="text-muted hint">
          Pick the unified narration mp3. Lands at
          <code>{{ episodeCode }}_merged_audio.mp3</code>.
        </p>
        <div v-else class="map-table">
          <div class="map-row">
            <span class="col-source">{{ basename(mergedFile) }}</span>
            <span class="col-arrow">→</span>
            <span class="col-mapping mono">{{ episodeCode }}_merged_audio.mp3</span>
            <button class="btn-icon" @click="mergedFile = null">✕</button>
          </div>
        </div>
      </div>

      <!-- OTHER (escape hatch) ─────────────────────────────────────────── -->
      <div v-if="activeTab === 'other'">
        <p v-if="!otherFiles.length" class="text-muted hint">
          For files that don't fit the standard slots. You'll set the
          destination subpath relative to the episode root for each one.
        </p>
        <div v-else class="map-table">
          <div class="map-row map-head">
            <span class="col-source">Source</span>
            <span class="col-arrow"></span>
            <span class="col-mapping">Subpath under episode dir</span>
            <span class="col-act"></span>
          </div>
          <div v-for="(row, i) in otherFiles" :key="i" class="map-row">
            <span class="col-source" :title="row.path">{{ basename(row.path) }}</span>
            <span class="col-arrow">→</span>
            <input
              v-model="row.dest_subpath"
              type="text"
              class="input input-sm col-mapping"
              :placeholder="`notes/${basename(row.path)}`"
            />
            <button class="btn-icon" @click="otherFiles.splice(i, 1)">✕</button>
          </div>
        </div>
      </div>

    </div>

    <!-- Mode + actions ─────────────────────────────────────────────────── -->
    <div class="dialog-foot">
      <label class="mode-toggle" :title="mode === 'copy' ? 'Originals stay in place; only copies land in the project.' : 'Originals are removed after a successful copy.'">
        <span class="mode-label">Mode</span>
        <select v-model="mode" class="select input-sm">
          <option value="copy">Copy (keep originals)</option>
          <option value="move">Move (delete originals)</option>
        </select>
      </label>
      <span class="text-muted total-summary">
        Total: <strong>{{ totalQueued }}</strong> file{{ totalQueued === 1 ? '' : 's' }} across all tabs
      </span>
      <div class="action-cluster">
        <button class="btn btn-secondary" :disabled="submitting" @click="onClose">Cancel</button>
        <button class="btn btn-primary" :disabled="submitting || totalQueued === 0" @click="submit">
          <LoadingSpinner v-if="submitting" size="sm" />
          {{ submitting ? 'Importing…' : `Import ${totalQueued} file${totalQueued === 1 ? '' : 's'}` }}
        </button>
      </div>
    </div>

    <!-- Result panel — populated after a successful import ─────────────── -->
    <div v-if="lastResult" class="result-panel">
      <h4 style="margin: 0 0 6px;">Import result</h4>
      <p class="text-muted hint">
        <strong>{{ lastResult.summary.copied + lastResult.summary.moved }}</strong> succeeded
        <span v-if="lastResult.summary.renamed">· {{ lastResult.summary.renamed }} auto-renamed (collision)</span>
        <span v-if="lastResult.summary.failed" style="color: var(--error)">
          · {{ lastResult.summary.failed }} failed
        </span>
      </p>
      <ul class="result-list">
        <li v-for="(it, i) in lastResult.items" :key="i" :class="['result-row', `status-${it.status}`]">
          <strong>{{ basename(it.source) }}</strong> →
          <code>{{ shortenPath(it.destination) }}</code>
          <span v-if="it.reason" class="reason text-muted">— {{ it.reason }}</span>
        </li>
      </ul>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Per-episode asset import dialog. Wraps the POST /import-assets endpoint
 * with a tabbed UI so the user can map weirdly-named source files to the
 * canonical Story Studio destinations in a single batch.
 *
 * Tab state survives switching: each tab keeps its own array of pending
 * files, so picking 12 scenes then switching to Audio doesn't blow them
 * away. The total counter at the bottom shows the cross-tab queue.
 *
 * Audio mapping defaults: when filenames look like `1.mp3` / `2.mp3`, the
 * dropdown pre-selects the matching chapter. The lowest-numbered file in
 * a set whose count == chapters+1 is hinted as "Introduction" so users
 * can one-click confirm a common pattern (1=intro, 2-N=chapters).
 *
 * Defensive notes:
 *  - We rely on Electron's File.path extension for absolute source paths.
 *    On a non-Electron env (browser), File.path is undefined and the
 *    dialog will surface a clear error. The pipeline-only-on-Electron
 *    architecture makes this acceptable.
 *  - Dest renames + collision handling are server-side; the client
 *    surfaces what the server reports back via the result panel.
 */

interface AudioRow { path: string; section_slug: string }
interface SceneRow { path: string; scene_number: number }
interface ThumbRow { path: string; thumb_number: number }
interface VideoRow { path: string; scene_number: number }
interface OtherRow { path: string; dest_subpath: string }

const props = defineProps<{
  visible: boolean
  slug: string
  episodeCode: string
  /** Optional — gives the audio dropdown an accurate chapter count. */
  chapterCount?: number
  /**
   * Optional pre-mapped items from a prior step (e.g. the Ideas-page
   * folder import inspector). When set, these populate the right tabs
   * automatically when the dialog opens so the user starts with a
   * complete mapping plan and only needs to tweak rows that look wrong.
   *
   * The shape mirrors the backend ImportItem discriminated union so it
   * can be passed straight through. Each entry carries an absolute
   * source_path the importer can copy/move from.
   */
  prefilledItems?: Array<any>
  /**
   * Hint at the default mode when the dialog opens. The folder-import
   * flow uses 'move' since the source files are sitting inside the
   * freshly-imported episode dir and need to land at canonical paths
   * within the SAME tree (move = no duplicate disk usage). Other entry
   * points stick with the safer 'copy' default.
   */
  defaultMode?: 'copy' | 'move'
  /**
   * Which tab the dialog opens on. Lets a generator page open the dialog
   * pre-focused on its own asset type (the Audio page → 'audio', the Scene
   * Generator → 'scene', etc.). Ignored when `prefilledItems` is set (the
   * folder-import flow lands on its busiest tab instead).
   */
  defaultTab?: 'audio' | 'scene' | 'thumb' | 'video' | 'final' | 'merged' | 'other'
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'imported', summary: any): void
}>()

const { post } = useApi()
const { success, error: showError } = useToast()

type TabId = 'audio' | 'scene' | 'thumb' | 'video' | 'final' | 'merged' | 'other'

interface TabMeta { id: TabId; label: string; icon: string; hint: string }
const tabs: TabMeta[] = [
  { id: 'audio',  label: 'Audio',     icon: '🎙', hint: 'Per-chapter narration files (.mp3)' },
  { id: 'scene',  label: 'Scenes',    icon: '🎨', hint: 'Background scene images' },
  { id: 'thumb',  label: 'Thumbs',    icon: '🖼', hint: 'Thumbnail images' },
  { id: 'video',  label: 'Video',     icon: '🎬', hint: 'Per-scene video clips' },
  { id: 'final',  label: 'Final',     icon: '🎞', hint: 'Assembled final video' },
  { id: 'merged', label: 'Merged',    icon: '🎛', hint: 'Unified narration mp3' },
  { id: 'other',  label: 'Other',     icon: '📁', hint: 'Anything else (escape hatch)' },
]

const activeTab = ref<TabId>('audio')
const submitting = ref(false)
const picking = ref(false)
const mode = ref<'copy' | 'move'>('copy')
const lastResult = ref<any>(null)

const audioFiles = ref<AudioRow[]>([])
const sceneFiles = ref<SceneRow[]>([])
const thumbFiles = ref<ThumbRow[]>([])
const videoFiles = ref<VideoRow[]>([])
const finalFile = ref<string | null>(null)
const mergedFile = ref<string | null>(null)
const otherFiles = ref<OtherRow[]>([])

// ── Helpers ───────────────────────────────────────────────────────────────
function basename(p: string): string { return p.replace(/^.*[\\/]/, '') }
function extOf(p: string): string {
  const i = p.lastIndexOf('.')
  return i >= 0 ? p.slice(i).toLowerCase() : ''
}
function pad2(n: number): string { return n < 10 ? `0${n}` : String(n) }
function shortenPath(p: string): string {
  // Show just the tail of long absolute paths so the result list stays readable.
  const parts = p.split(/[\\/]/)
  if (parts.length <= 4) return p
  return '…/' + parts.slice(-4).join('/')
}

const audioOptions = computed<string[]>(() => {
  const out = ['Introduction']
  const n = props.chapterCount && props.chapterCount > 0 ? props.chapterCount : 20
  for (let i = 1; i <= n; i++) out.push(`Chapter_${pad2(i)}`)
  return out
})

function formatAudioSlug(slug: string): string {
  if (slug === 'Introduction') return 'Introduction'
  const m = slug.match(/^Chapter_(\d+)$/)
  if (m) return `Chapter ${parseInt(m[1], 10)}`
  return slug
}

const totalQueued = computed(() =>
  audioFiles.value.length
  + sceneFiles.value.length
  + thumbFiles.value.length
  + videoFiles.value.length
  + (finalFile.value ? 1 : 0)
  + (mergedFile.value ? 1 : 0)
  + otherFiles.value.length,
)

function countForTab(id: TabId): number {
  switch (id) {
    case 'audio':  return audioFiles.value.length
    case 'scene':  return sceneFiles.value.length
    case 'thumb':  return thumbFiles.value.length
    case 'video':  return videoFiles.value.length
    case 'final':  return finalFile.value ? 1 : 0
    case 'merged': return mergedFile.value ? 1 : 0
    case 'other':  return otherFiles.value.length
  }
}

function multipleForTab(id: TabId): boolean {
  return id !== 'final' && id !== 'merged'
}

interface DialogFilter { name: string; extensions: string[] }
function filtersForTab(id: TabId): DialogFilter[] {
  switch (id) {
    case 'audio':  return [{ name: 'Audio', extensions: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'] }]
    case 'scene':
    case 'thumb':  return [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    case 'video':
    case 'final':  return [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v'] }]
    case 'merged': return [{ name: 'Audio', extensions: ['mp3', 'wav'] }]
    case 'other':  return [{ name: 'All Files', extensions: ['*'] }]
  }
}

function dialogTitleForTab(id: TabId): string {
  switch (id) {
    case 'audio':  return 'Pick audio files'
    case 'scene':  return 'Pick scene images'
    case 'thumb':  return 'Pick thumbnail images'
    case 'video':  return 'Pick per-scene video clips'
    case 'final':  return 'Pick the final assembled video'
    case 'merged': return 'Pick the unified narration mp3'
    case 'other':  return 'Pick files'
  }
}

const activeFiles = computed<unknown[]>(() => {
  switch (activeTab.value) {
    case 'audio':  return audioFiles.value
    case 'scene':  return sceneFiles.value
    case 'thumb':  return thumbFiles.value
    case 'video':  return videoFiles.value
    case 'final':  return finalFile.value ? [finalFile.value] : []
    case 'merged': return mergedFile.value ? [mergedFile.value] : []
    case 'other':  return otherFiles.value
  }
})

function setTab(id: TabId) { activeTab.value = id }

function clearActiveFiles() {
  switch (activeTab.value) {
    case 'audio':  audioFiles.value = []; break
    case 'scene':  sceneFiles.value = []; break
    case 'thumb':  thumbFiles.value = []; break
    case 'video':  videoFiles.value = []; break
    case 'final':  finalFile.value = null; break
    case 'merged': mergedFile.value = null; break
    case 'other':  otherFiles.value = []; break
  }
}

// ── File-pick handler — native dialog via IPC ─────────────────────────────
// Modern Electron strips File.path off renderer-side <input type="file">
// elements (security/Chromium alignment), so we can't read absolute paths
// from a browser file picker. The native dialog returns absolute paths
// the backend importer can copy/move from.
async function pickViaNative() {
  if (picking.value) return
  picking.value = true
  try {
    const tab = activeTab.value
    const r = await post<{ paths: string[] }>('/system/pick-files', {
      title: dialogTitleForTab(tab),
      buttonLabel: 'Add to import',
      filters: filtersForTab(tab),
    })
    const paths = r.paths || []
    if (!paths.length) return  // user cancelled
    // For single-file tabs, only honour the first path even if the
    // multi-select dialog (used for everything) returns more.
    const trimmed = multipleForTab(tab) ? paths : paths.slice(0, 1)
    ingestPaths(tab, trimmed)
  } catch (e: any) {
    showError(e?.data?.detail || 'File picker failed')
  } finally {
    picking.value = false
  }
}

// Audio auto-mapping — when filenames look like a number (1.mp3, 2.mp3),
// pre-select the matching chapter slug. If the count is exactly
// `chapters+1`, the lowest-numbered file is hinted as the introduction.
function ingestPaths(tab: TabId, paths: string[]) {
  if (tab === 'audio') {
    const numbered = paths.map(p => ({
      path: p,
      n: parseInt((basename(p).match(/(\d+)/) || [])[1] || '', 10),
    }))
    const allNumbered = numbered.every(r => Number.isFinite(r.n))
    const ch = props.chapterCount || 0
    const introHint = allNumbered && ch > 0 && numbered.length === ch + 1
    if (introHint) {
      // Sort by inferred number; the lowest goes to Introduction, the
      // rest fill chapters 1..N.
      numbered.sort((a, b) => a.n - b.n)
      audioFiles.value.push({ path: numbered[0].path, section_slug: 'Introduction' })
      for (let i = 1; i < numbered.length; i++) {
        audioFiles.value.push({ path: numbered[i].path, section_slug: `Chapter_${pad2(i)}` })
      }
    } else {
      const startIdx = audioFiles.value.length
      paths.forEach((p, i) => {
        const m = basename(p).match(/(\d+)/)
        const inferred = m ? parseInt(m[1], 10) : startIdx + i + 1
        const slug = inferred >= 1 && inferred <= 20
          ? `Chapter_${pad2(inferred)}`
          : `Chapter_${pad2(startIdx + i + 1)}`
        audioFiles.value.push({ path: p, section_slug: slug })
      })
    }
    return
  }
  if (tab === 'scene') {
    const startIdx = sceneFiles.value.length
    paths.forEach((p, i) => sceneFiles.value.push({ path: p, scene_number: startIdx + i + 1 }))
    return
  }
  if (tab === 'thumb') {
    const startIdx = thumbFiles.value.length
    paths.forEach((p, i) => thumbFiles.value.push({ path: p, thumb_number: startIdx + i + 1 }))
    return
  }
  if (tab === 'video') {
    const startIdx = videoFiles.value.length
    paths.forEach((p, i) => videoFiles.value.push({ path: p, scene_number: startIdx + i + 1 }))
    return
  }
  if (tab === 'final')  { finalFile.value = paths[0]; return }
  if (tab === 'merged') { mergedFile.value = paths[0]; return }
  if (tab === 'other') {
    paths.forEach(p => otherFiles.value.push({ path: p, dest_subpath: basename(p) }))
    return
  }
}

function renumberScenes() { sceneFiles.value.forEach((r, i) => r.scene_number = i + 1) }
function renumberThumbs() { thumbFiles.value.forEach((r, i) => r.thumb_number = i + 1) }
function renumberVideos() { videoFiles.value.forEach((r, i) => r.scene_number = i + 1) }

// ── Submit ────────────────────────────────────────────────────────────────
function buildItems(): any[] {
  const out: any[] = []
  for (const r of audioFiles.value) out.push({ type: 'audio',  source_path: r.path, section_slug: r.section_slug })
  for (const r of sceneFiles.value) out.push({ type: 'scene',  source_path: r.path, scene_number: r.scene_number })
  for (const r of thumbFiles.value) out.push({ type: 'thumb',  source_path: r.path, thumb_number: r.thumb_number })
  for (const r of videoFiles.value) out.push({ type: 'video',  source_path: r.path, scene_number: r.scene_number })
  if (finalFile.value)  out.push({ type: 'final',  source_path: finalFile.value })
  if (mergedFile.value) out.push({ type: 'merged', source_path: mergedFile.value })
  for (const r of otherFiles.value) {
    if (!r.dest_subpath.trim()) continue   // skip empty subpath rows
    out.push({ type: 'other', source_path: r.path, dest_subpath: r.dest_subpath.trim() })
  }
  return out
}

async function submit() {
  if (submitting.value || totalQueued.value === 0) return
  submitting.value = true
  lastResult.value = null
  try {
    const r = await post<any>(`/projects/${props.slug}/episodes/${props.episodeCode}/import-assets`, {
      mode: mode.value,
      items: buildItems(),
    })
    lastResult.value = r
    const ok = r.summary.copied + r.summary.moved
    success(`Imported ${ok} file${ok === 1 ? '' : 's'}${r.summary.renamed ? ` (${r.summary.renamed} auto-renamed)` : ''}${r.summary.failed ? `, ${r.summary.failed} failed` : ''}`)
    emit('imported', r.summary)
    // Clear queue on success so the user can stage another batch without
    // re-importing the same files.
    if (r.summary.failed === 0) {
      audioFiles.value = []
      sceneFiles.value = []
      thumbFiles.value = []
      videoFiles.value = []
      finalFile.value = null
      mergedFile.value = null
      otherFiles.value = []
    }
  } catch (e: any) {
    showError(e?.data?.detail || 'Import failed')
  } finally {
    submitting.value = false
  }
}

function onClose() {
  if (submitting.value) return
  emit('close')
}

// Reset the result panel when the dialog re-opens (so stale results from
// a previous session don't appear). Also ingest any pre-filled items
// the parent passed (folder-import flow uses this) so the dialog opens
// with the mapping pre-populated and only needs the user's review.
watch(() => props.visible, (v) => {
  if (!v) return
  lastResult.value = null
  if (props.defaultMode) mode.value = props.defaultMode
  if (Array.isArray(props.prefilledItems) && props.prefilledItems.length) {
    ingestPrefilled(props.prefilledItems)
  } else if (props.defaultTab) {
    // Open pre-focused on the page's asset type. Only when there's nothing
    // prefilled — the folder-import flow picks its own busiest tab.
    activeTab.value = props.defaultTab
  }
})

/**
 * Push pre-mapped items from an upstream step (folder import) directly
 * into the per-tab queues, bypassing the file-picker + auto-mapping
 * path. Each item is already shaped like a ready-to-submit ImportItem,
 * so we just copy its fields into the matching tab. Auto-switches to
 * the tab with the most items so the user lands on the part of the
 * mapping that matters most.
 */
function ingestPrefilled(items: Array<any>) {
  // Defensive: don't double-ingest if the dialog reopens for the same
  // batch. The folder-import flow always sends a fresh array, so we
  // wipe + re-fill rather than append.
  audioFiles.value = []
  sceneFiles.value = []
  thumbFiles.value = []
  videoFiles.value = []
  finalFile.value = null
  mergedFile.value = null
  otherFiles.value = []
  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.source_path) continue
    switch (it.type) {
      case 'audio':
        audioFiles.value.push({ path: it.source_path, section_slug: it.section_slug || 'Chapter_01' })
        break
      case 'scene':
        sceneFiles.value.push({ path: it.source_path, scene_number: Number(it.scene_number) || sceneFiles.value.length + 1 })
        break
      case 'thumb':
        thumbFiles.value.push({ path: it.source_path, thumb_number: Number(it.thumb_number) || thumbFiles.value.length + 1 })
        break
      case 'video':
        videoFiles.value.push({ path: it.source_path, scene_number: Number(it.scene_number) || videoFiles.value.length + 1 })
        break
      case 'final':
        finalFile.value = it.source_path
        break
      case 'merged':
        mergedFile.value = it.source_path
        break
      case 'other':
        otherFiles.value.push({ path: it.source_path, dest_subpath: it.dest_subpath || basename(it.source_path) })
        break
    }
  }
  // Land the user on the busiest tab so the first review surface
  // is the one that needs the most attention.
  const counts: Array<[TabId, number]> = [
    ['audio', audioFiles.value.length],
    ['scene', sceneFiles.value.length],
    ['thumb', thumbFiles.value.length],
    ['video', videoFiles.value.length],
    ['final', finalFile.value ? 1 : 0],
    ['merged', mergedFile.value ? 1 : 0],
    ['other', otherFiles.value.length],
  ]
  counts.sort((a, b) => b[1] - a[1])
  if (counts[0]?.[1] > 0) activeTab.value = counts[0][0]
}
</script>

<style scoped>
.dialog-head { margin-bottom: 12px; }
.dialog-sub { font-size: 13px; margin-top: 4px; }

/* Tab strip */
.tab-strip {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  border-bottom: 1px solid var(--border);
  padding-bottom: 6px;
  margin-bottom: 10px;
}
.tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  cursor: pointer;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  transition: color 0.12s, background 0.12s;
}
.tab-btn:hover { color: var(--text-primary); background: var(--bg-tertiary); }
.tab-btn.active {
  color: var(--accent);
  background: var(--bg-tertiary);
  border-color: var(--border);
  border-bottom-color: var(--bg-tertiary);
}
.tab-icon { font-size: 14px; }
.tab-count {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  font-size: var(--font-xs);
  font-weight: 600;
  border-radius: 999px;
  background: var(--accent-dim);
  color: var(--accent);
}

.picker-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.file-count { font-size: 12px; }

.tab-body { min-height: 180px; }
.hint { font-size: 12px; line-height: 1.4; }

.map-table { display: flex; flex-direction: column; gap: 4px; max-height: 320px; overflow-y: auto; padding: 4px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-tertiary); }
.map-row {
  display: grid;
  grid-template-columns: 1fr 24px 2fr 32px;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  font-size: 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-sm);
}
.map-row.map-head {
  font-size: var(--font-xs);
  font-weight: 600;
  color: var(--text-muted);
  background: transparent;
  padding-top: 0;
  padding-bottom: 4px;
}
.col-source { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.col-arrow { color: var(--text-muted); text-align: center; }
.col-mapping { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: var(--font-xs); }

.scene-num-input {
  display: inline-block;
  width: 50px;
  margin-left: 6px;
  padding: 1px 4px;
  font-size: var(--font-xs);
}

.renumber-btn { align-self: flex-start; margin-bottom: 6px; }

.dialog-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}
.mode-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.mode-label { color: var(--text-muted); }
.total-summary { font-size: 12px; }
.action-cluster { display: flex; gap: 8px; margin-left: auto; }

.result-panel {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.result-list { list-style: none; padding: 0; margin: 0; max-height: 180px; overflow-y: auto; }
.result-row {
  padding: 4px 0;
  font-size: var(--font-xs);
  border-bottom: 1px dashed rgba(255, 255, 255, 0.05);
}
.result-row:last-child { border-bottom: none; }
.result-row.status-failed { color: var(--error, #ef4444); }
.result-row code {
  font-size: var(--font-xs);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  color: var(--text-secondary);
}
.reason { font-size: var(--font-xs); }

.btn-icon {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 4px;
}
.btn-icon:hover { color: var(--text-primary); background: rgba(255, 255, 255, 0.04); }

.input-xs { padding: 1px 4px; font-size: var(--font-xs); height: 22px; }
</style>
