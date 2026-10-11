<template>
  <div class="workspace-page effects-library-page">
    <WorkspaceHero
      eyebrow="Video · Atmosphere &amp; Light"
      title="Effects Library"
      description="Every effect stacks with every other, on the whole episode, one scene, or every scene of a theme. Each card plays a 6-second clip Story rendered of that effect on this episode's scene, camera still; Camera motions shows the moves on their own."
    >
      <template #aside>
        <div class="fx-hero-tools">
          <input v-model="search" type="search" class="input fx-search" placeholder="Search effects…" aria-label="Search effects" />
          <button type="button" class="btn btn-sm btn-secondary" :disabled="refreshing" @click="refreshPreviews">
            {{ refreshing ? 'Refreshing…' : 'Refresh Previews' }}
          </button>
          <span class="hint">Draws each clip again the next time it comes into view.</span>
          <div class="fx-seg" role="tablist" aria-label="Effect categories">
            <button
              v-for="tab in CATEGORY_TABS"
              :key="tab.key"
              type="button"
              role="tab"
              :aria-selected="activeTab === tab.key"
              :class="{ on: activeTab === tab.key }"
              @click="activeTab = tab.key"
            >{{ tab.label }}</button>
          </div>
        </div>
      </template>
    </WorkspaceHero>

    <section class="card fx-context">
      <div class="fx-context-field fx-episode">
        <span class="fx-label">Episode</span>
        <EpisodeSelector v-model="episodeId" :project-slug="slug" />
      </div>
      <label class="fx-context-field">
        <span class="fx-label">Add effects to</span>
        <select v-model="targetKey" class="select" :disabled="!episodeId || loading">
          <option value="episode">Whole episode</option>
          <option v-for="scene in scenes" :key="scene.id" :value="`scene:${scene.id}`">
            Scene {{ scene.scene_index }} · {{ formatClock(scene.start_sec) }}{{ scene.label ? ` · ${scene.label}` : '' }}
          </option>
          <option v-for="theme in themes" :key="theme" :value="`theme:${theme}`">Every “{{ theme }}” scene</option>
        </select>
        <span class="hint">What you add below goes here. A scene's effects fade in and out across its crossfades.</span>
      </label>
      <label class="fx-context-field">
        <span class="fx-label">Preview over</span>
        <select v-model="previewSceneId" class="select" :disabled="!scenes.length || targetScene !== null">
          <option v-for="scene in scenes" :key="scene.id" :value="scene.id">Scene {{ scene.scene_index }}{{ scene.label ? ` · ${scene.label}` : '' }}</option>
        </select>
        <span class="hint">{{ previewHint }}</span>
      </label>
      <div class="fx-context-field fx-save-state" role="status">
        <span class="fx-label">Saved with this episode</span>
        <span :data-tone="saveTone">{{ saveText }}</span>
        <button v-if="saveError" type="button" class="btn btn-sm btn-secondary" @click="saveNow">Try Saving Again</button>
      </div>
    </section>

    <p v-if="loadError" class="fx-banner" data-tone="error">{{ loadError }}</p>
    <p v-else-if="readError" class="fx-banner" data-tone="warning">{{ readError }} Saving here writes a fresh copy.</p>
    <p v-else-if="episodeId && !loading && !hasScenePlan" class="fx-banner" data-tone="info">
      This episode has no Scene Plan yet, so effects can go on the whole episode only. Build the Scene Plan (or the Episode Builder for music) to put effects on single scenes.
    </p>

    <div class="fx-layout">
      <div class="fx-library">
        <template v-for="section in sections" :key="section.label">
          <div class="fx-cat">{{ section.label }}</div>
          <div class="fx-grid">
            <button
              v-for="entry in section.entries"
              :key="entry.id"
              type="button"
              class="fx-card"
              :class="{ sel: selectedId === entry.id && !editingUid }"
              @click="selectEntry(entry)"
            >
              <div class="fx-im">
                <GalleryClip :src="clipUrl('overlay', entry.id, entry.document)">
                  <EffectThumb :doc="entry.document" :image="sceneImage" />
                </GalleryClip>
                <span class="fx-badge">{{ effectBadge(entry.document) }}</span>
                <span v-if="inUse.overlays.includes(entry.id)" class="fx-inuse" :title="inUseTitle">In use on this channel</span>
                <span v-if="entry.origin?.origin === 'content-pack'" class="fx-pack">from a pack</span>
              </div>
              <div class="fx-tx">
                <b>{{ entry.name }}</b>
                <small>{{ cardLine(entry) }}</small>
              </div>
            </button>
          </div>
        </template>
        <div v-if="!sections.length && library.length && activeTab !== 'motions'" class="fx-empty">No effect matches “{{ search }}”.</div>
        <template v-if="activeTab === 'motions'">
          <p class="hint">How each scene picture moves. Pick them in Video Assembly → Scene Animation; these clips only show them.</p>
          <div class="fx-cat">Zoom in · Zoom out · Breathe</div>
          <div v-for="family in motionFamilies" :key="family.key" class="fx-family">
            <div class="fx-family-head"><b>{{ family.name }}</b> <small>{{ family.description }}</small></div>
            <div class="fx-grid">
              <div v-for="member in family.members" :key="member.id" class="fx-card fx-motion">
                <div class="fx-im">
                  <GalleryClip :src="clipUrl('motion', member.id, motionDoc(member.id))">
                    <EffectThumb :doc="null" :image="sceneImage" />
                  </GalleryClip>
                  <span v-if="inUse.motions.includes(member.id)" class="fx-inuse" :title="inUseTitle">In use on this channel</span>
                </div>
                <div class="fx-tx"><b class="fx-strength">{{ member.strength }}</b></div>
              </div>
            </div>
          </div>
          <template v-for="group in motionGroups" :key="group.label">
            <div class="fx-cat">{{ group.label }}</div>
            <div class="fx-grid">
              <div v-for="m in group.motions" :key="m.id" class="fx-card fx-motion" :title="m.description">
                <div class="fx-im">
                  <GalleryClip :src="clipUrl('motion', m.id, m.document)">
                    <EffectThumb :doc="null" :image="sceneImage" />
                  </GalleryClip>
                  <span v-if="inUse.motions.includes(m.id)" class="fx-inuse" :title="inUseTitle">In use on this channel</span>
                </div>
                <div class="fx-tx"><b>{{ m.name }}</b><small>{{ m.description }}</small></div>
              </div>
            </div>
          </template>
        </template>
        <div v-if="showCamera" class="fx-cat">Camera</div>
        <div v-if="showCamera" class="fx-grid">
          <NuxtLink :to="`/projects/${slug}/video-assembly`" class="fx-card fx-camera">
            <div class="fx-im">
              <EffectThumb :doc="null" :image="sceneImage" />
              <span class="fx-badge">Native</span>
            </div>
            <div class="fx-tx">
              <b>Slow zoom + pan</b>
              <small>Every still gets it unless you pick another move in Video Assembly · about 6.5 min per 65-min episode</small>
            </div>
          </NuxtLink>
        </div>
        <p class="hint fx-foot">
          Minutes are what an effect adds to a 65-minute 1080p render on the M2 Max, from per-frame measurements; a stack runs mostly in series, so the panel adds them up.
          Rain, snow, fog and the other loops are drawn once in about two seconds and reused.
        </p>
      </div>

      <aside class="fx-side">
        <section class="card fx-editor">
          <template v-if="selectedEntry && selectedDoc">
            <div class="fx-editor-head">
              <h3>{{ selectedEntry.name }}</h3>
              <span class="ds-chip" data-tone="info">{{ editorChip }}</span>
            </div>
            <canvas ref="previewCanvas" class="fx-canvas" width="960" height="540" />
            <p class="hint">
              Live preview over <b>{{ previewSceneLabel }}</b> with {{ previewDocs.length === 1 ? 'this effect' : `this stack (${previewDocs.length} effects)` }} — it moves as you drag the sliders.
              <template v-if="notLive"> {{ selectedEntry.name }} is not drawn here; Render Exact Preview shows it.</template>
            </p>
            <p v-if="selectedEntry.approximation" class="fx-approx"><strong>Not exact:</strong> {{ selectedEntry.approximation }}</p>

            <div class="fx-params">
              <div v-for="field in fields" :key="field.key" class="fx-param">
                <span class="fx-param-label">{{ field.label }}</span>
                <template v-if="field.type === 'number'">
                  <input
                    type="range"
                    :min="field.min" :max="field.max" :step="field.step"
                    :value="paramValue(field.key)"
                    :aria-label="field.label"
                    @input="setParam(field.key, Number(($event.target as HTMLInputElement).value))"
                  />
                  <b>{{ amountText(field) }}</b>
                </template>
                <template v-else-if="field.type === 'color'">
                  <input type="color" :value="paramValue(field.key)" :aria-label="field.label" @input="setParam(field.key, ($event.target as HTMLInputElement).value.toUpperCase())" />
                  <b />
                </template>
                <template v-else-if="field.type === 'nullable-color'">
                  <span class="fx-inline">
                    <label class="checkbox-label"><input type="checkbox" :checked="!!paramValue(field.key)" @change="setParam(field.key, ($event.target as HTMLInputElement).checked ? '#8AB8FF' : null)" /> Use</label>
                    <input v-if="paramValue(field.key)" type="color" :value="paramValue(field.key)" :aria-label="field.label" @input="setParam(field.key, ($event.target as HTMLInputElement).value.toUpperCase())" />
                  </span>
                  <b>{{ paramValue(field.key) ? 'half the particles' : 'off' }}</b>
                </template>
                <template v-else-if="field.type === 'seed'">
                  <span class="fx-inline">
                    <input type="number" class="input input-sm fx-seed" :min="field.min" :max="field.max" :value="paramValue(field.key)" :aria-label="field.label" @change="setParam(field.key, Number(($event.target as HTMLInputElement).value))" />
                    <button type="button" class="btn btn-sm btn-ghost" @click="setParam(field.key, Math.floor(Math.random() * 99999))">Shuffle</button>
                  </span>
                  <b />
                </template>
                <template v-else-if="field.type === 'select'">
                  <select class="select select-sm" :value="paramValue(field.key)" :aria-label="field.label" @change="setParam(field.key, ($event.target as HTMLSelectElement).value)">
                    <option v-for="option in field.options" :key="option" :value="option">{{ field.option_labels?.[option] || option }}</option>
                  </select>
                  <b />
                </template>
                <template v-else>
                  <input type="text" class="input input-sm" :value="paramValue(field.key)" :aria-label="field.label" @input="setParam(field.key, ($event.target as HTMLInputElement).value)" />
                  <b />
                </template>
              </div>
              <div v-if="targetScene" class="fx-param">
                <span class="fx-param-label">Outline</span>
                <span class="fx-inline">
                  <select class="select select-sm" :value="outlineValue" aria-label="Outline" @change="setOutline(($event.target as HTMLSelectElement).value)">
                    <option value="">{{ 'motion' in selectedDoc ? 'None yet: upload one' : 'Whole picture' }}</option>
                    <option v-for="name in outlines" :key="name" :value="name">{{ name }}</option>
                  </select>
                  <label class="btn btn-sm btn-ghost">Upload…<input type="file" accept="image/png,image/jpeg" hidden @change="uploadOutline" /></label>
                </span>
                <b />
              </div>
              <template v-if="showFades">
                <div class="fx-param">
                  <span class="fx-param-label">Fade in</span>
                  <input type="range" min="0" max="10" step="0.5" :value="fadeValue('in')" aria-label="Fade in" @input="setFade('in', Number(($event.target as HTMLInputElement).value))" />
                  <b>{{ fadeValue('in') }} s</b>
                </div>
                <div class="fx-param">
                  <span class="fx-param-label">Fade out</span>
                  <input type="range" min="0" max="10" step="0.5" :value="fadeValue('out')" aria-label="Fade out" @input="setFade('out', Number(($event.target as HTMLInputElement).value))" />
                  <b>{{ fadeValue('out') }} s</b>
                </div>
              </template>
            </div>
            <p class="hint">{{ rebakeHint }}</p>

            <div class="fx-actions">
              <div class="fx-btnhint">
                <button type="button" class="btn btn-secondary" :disabled="exacting || !episodeId" @click="renderExact">
                  {{ exacting ? 'Rendering…' : 'Render Exact 6 s Preview' }}
                </button>
                <span class="hint">{{ exactHint }}</span>
              </div>
              <div class="fx-btnhint">
                <button type="button" class="btn btn-ghost" @click="openSavePreset('effect')">Save as Preset…</button>
                <span class="hint">Keeps this effect and its settings to add anywhere later. No scene or time is saved.</span>
              </div>
              <div class="fx-btnhint">
                <button v-if="!editingUid" type="button" class="btn btn-primary" :disabled="!canEdit" @click="addSelected">Add to {{ targetShortLabel }}</button>
                <button v-else type="button" class="btn btn-primary" @click="finishEditing">Done</button>
                <span class="hint">{{ editingUid ? 'Changes are saved as you make them.' : addHint }}</span>
              </div>
            </div>
            <div v-if="savePresetFor === 'effect'" class="fx-save-preset">
              <input v-model="presetName" class="input input-sm" placeholder="Preset name, e.g. Heavy rain" aria-label="Preset name" @keydown.enter="savePreset" />
              <button type="button" class="btn btn-sm btn-primary" :disabled="!presetName.trim()" @click="savePreset">Save</button>
              <button type="button" class="btn btn-sm btn-ghost" @click="savePresetFor = null">Cancel</button>
            </div>
            <div v-if="exactUrl" class="fx-exact">
              <video :src="exactUrl" autoplay loop muted playsinline controls />
              <span class="hint">{{ exactInfo }}<template v-if="exactStale"> The settings changed after this render — render again to see them.</template></span>
            </div>
          </template>
          <div v-else class="fx-editor-empty">
            <h3>Pick an effect</h3>
            <p class="hint">Choose any effect on the left to see it live over this episode's scene, adjust it, and add it to the whole episode, one scene or every scene of a theme.</p>
          </div>
        </section>

        <section class="card fx-stack">
          <h3>Stacking order · {{ targetName }}</h3>
          <p class="hint">Effects sit in groups, back to front. Drag inside a group, or turn on Custom order to place anything anywhere. Click an effect to change it.</p>
          <label class="checkbox-label">
            <input v-model="file.custom_order" type="checkbox" :disabled="!canEdit" @change="queueSave" />
            Custom order
          </label>
          <span class="hint fx-sub">{{ file.custom_order ? 'Renders exactly in the order below.' : 'Renders group by group: grade, atmosphere, weather, light particles, light, lens, overlays.' }}</span>
          <ul class="fx-rows" @dragover.prevent>
            <li class="fx-g">1 · Camera</li>
            <li class="fx-row fx-row-fixed">
              <span class="fx-handle" aria-hidden="true">⋮⋮</span>
              <span>Slow zoom + pan <small class="hint">(Video Assembly's camera move)</small></span>
              <span class="fx-scope">episode</span>
            </li>
            <template v-for="block in rowBlocks" :key="block.key">
              <li v-if="block.label" class="fx-g">{{ block.label }}</li>
              <li
                v-for="row in block.rows"
                :key="row.applied.uid"
                class="fx-row"
                :class="{ on: editingUid === row.applied.uid, off: !row.applied.enabled, missing: !row.entry }"
                :draggable="canEdit"
                @dragstart="dragging = row"
                @dragend="dragging = null"
                @drop.prevent="dropOn(row)"
              >
                <span class="fx-handle" aria-hidden="true">⋮⋮</span>
                <button type="button" class="fx-row-name" :disabled="!row.entry" @click="editRow(row)">
                  {{ row.entry?.name || `${row.applied.id} (not installed)` }}<small v-if="rowSummary(row)" class="hint"> · {{ rowSummary(row) }}</small>
                </button>
                <span class="fx-row-tools">
                  <span class="fx-scope">{{ row.scope }}</span>
                  <label class="fx-toggle" :title="row.applied.enabled ? 'On — click to switch off without removing' : 'Off — click to switch on'">
                    <input type="checkbox" :checked="row.applied.enabled" :aria-label="`${row.entry?.name || row.applied.id} on or off`" :disabled="!canEdit" @change="toggleRow(row)" />
                  </label>
                  <button type="button" class="btn btn-sm btn-ghost fx-remove" :aria-label="`Remove ${row.entry?.name || row.applied.id}`" :disabled="!canEdit" @click="removeRow(row)">Remove</button>
                </span>
              </li>
            </template>
            <li v-if="!rows.length" class="fx-row-empty hint">Nothing here yet — the scene renders with the camera move only.</li>
            <li v-if="dragging" class="fx-drop-end" @drop.prevent="dropOn(null)">Drop here to move to the end</li>
          </ul>
          <p v-if="moveNote" class="hint fx-note">{{ moveNote }}</p>
          <p class="hint">{{ costLine }}</p>
          <div class="fx-btnhint">
            <button type="button" class="btn btn-sm btn-secondary" :disabled="!rows.length" @click="openSavePreset('stack')">Save Stack as Preset…</button>
            <span class="hint">Saves the effects and their settings — not the scene they are on.</span>
          </div>
          <div v-if="savePresetFor === 'stack'" class="fx-save-preset">
            <input v-model="presetName" class="input input-sm" placeholder="Preset name, e.g. Rainy night" aria-label="Stack preset name" @keydown.enter="savePreset" />
            <button type="button" class="btn btn-sm btn-primary" :disabled="!presetName.trim()" @click="savePreset">Save</button>
            <button type="button" class="btn btn-sm btn-ghost" @click="savePresetFor = null">Cancel</button>
          </div>
        </section>

        <section class="card fx-presets">
          <h3>Presets</h3>
          <p class="hint">Starting stacks and the ones you saved. Adding one puts its effects on {{ targetName.toLowerCase() }}; it never removes anything.</p>
          <ul class="fx-preset-list">
            <li v-for="preset in stackPresets.presets.value" :key="preset.id">
              <div>
                <b>{{ preset.name }}</b>
                <small class="hint">{{ presetDescription(preset) }}</small>
              </div>
              <span class="fx-preset-actions">
                <button type="button" class="btn btn-sm btn-secondary" :disabled="!canEdit" @click="applyPreset(preset)">Add to {{ targetShortLabel }}</button>
                <button v-if="!preset.builtin" type="button" class="btn btn-sm btn-ghost" @click="deletePreset(preset)">Delete</button>
              </span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { BUILT_IN_EFFECT_STACKS } from '@shared/scene-effect-presets'
import { effectAmountLabel, effectBadge, effectParamFields, estimateStackMinutes, type ParamField } from '@shared/effect-params'
import { EFFECT_STACK_GROUPS, overlayStackGroup, type SceneOverlayDocument } from '@shared/scene-effects'
import { LOOP_VARIANT_INFO } from '@shared/effect-loops'
import { EffectCanvasRenderer, NOT_DRAWN_LIVE, SLOW_ZOOM } from '~/utils/effect-preview-canvas'
import {
  CATEGORY_TABS,
  DEFAULT_SCENE_FADE_SEC,
  documentVersion,
  GROUP_LABELS,
  addEffects,
  changedParams,
  compactFile,
  emptyEffectsFile,
  enabledDocs,
  formatClock,
  formatParam,
  moveRow,
  presetItemsFromRows,
  resolveDoc,
  sectionFor,
  stackRowsForTarget,
  targetLabel,
  type EffectTarget,
  type EpisodeEffectsFile,
  type LibraryEntry,
  type SceneRow,
  type StackRow,
} from '~/utils/effects-library'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Effects Library')

const route = useRoute()
const slug = computed(() => route.params.slug as string)
const { get, put, post } = useApi()
const { success, error: showError } = useToast()

const episodeId = ref((route.query.episode as string) || '')
const search = ref('')
const activeTab = ref('all')
const loading = ref(false)
const loadError = ref('')
const readError = ref('')
const hasScenePlan = ref(false)
const library = ref<LibraryEntry[]>([])
const scenes = ref<SceneRow[]>([])
const file = reactive<EpisodeEffectsFile>(emptyEffectsFile())
/** The episode the loaded file belongs to; saves address it, never the current selection. */
const fileEpisode = ref('')
const targetKey = ref('episode')
const previewSceneId = ref('')

// ── Library ───────────────────────────────────────────────────────────────
const sections = computed(() => sectionFor(library.value, activeTab.value, search.value))
const showCamera = computed(() => (activeTab.value === 'all' || activeTab.value === 'film')
  && (!search.value.trim() || /zoom|pan|camera/i.test(search.value)))
const themes = computed(() => [...new Set(scenes.value.map(s => s.theme).filter((t): t is string => !!t))])

const COST_REF = { durationSec: 65 * 60, fps: 24, w: 1920, h: 1080 }
function minutesText(min: number): string {
  if (min < 1) return 'under 1 min'
  return `+ about ${min < 3 ? min.toFixed(1) : Math.round(min)} min`
}
function cardLine(entry: LibraryEntry): string {
  const parts: string[] = []
  const amount = effectAmountLabel(entry.document)
  if (amount) parts.push(amount)
  else if (entry.description) parts.push(entry.description.split(/[.,—]/)[0]!.trim().toLowerCase())
  parts.push(minutesText(estimateStackMinutes([entry.document], COST_REF)))
  return parts.join(' · ')
}

// ── Target and preview scene ────────────────────────────────────────────────
const currentTarget = computed<EffectTarget>(() => {
  if (targetKey.value.startsWith('scene:')) return { kind: 'scene', id: targetKey.value.slice(6) }
  if (targetKey.value.startsWith('theme:')) return { kind: 'theme', theme: targetKey.value.slice(6) }
  return { kind: 'episode' }
})
const targetScene = computed(() => currentTarget.value.kind === 'scene' ? scenes.value.find(s => s.id === (currentTarget.value as any).id) ?? null : null)
const targetName = computed(() => targetLabel(currentTarget.value, scenes.value))
const targetShortLabel = computed(() => currentTarget.value.kind === 'theme' ? `“${(currentTarget.value as any).theme}” Scenes` : targetName.value)
const canEdit = computed(() => !!episodeId.value && !loading.value && fileEpisode.value === episodeId.value)

watch(targetScene, (scene) => { if (scene) previewSceneId.value = scene.id })
const previewScene = computed(() => scenes.value.find(s => s.id === previewSceneId.value) ?? null)
const previewSceneLabel = computed(() => previewScene.value
  ? `Scene ${previewScene.value.scene_index}${previewScene.value.label ? ` · ${previewScene.value.label}` : ''}`
  : 'a dusk gradient (no scene image yet)')
const previewHint = computed(() => !scenes.value.length
  ? 'No Scene Plan scenes yet — previews use a dusk gradient.'
  : targetScene.value ? 'Follows the scene you are adding to.' : 'Any scene, to judge the effect on a real picture.')

const sceneImage = ref<HTMLImageElement | null>(null)
watch([previewScene, episodeId], () => {
  const scene = previewScene.value
  if (!scene || !scene.has_image || !episodeId.value) { sceneImage.value = null; return }
  const img = new Image()
  img.onload = () => { if (previewScene.value?.id === scene.id) sceneImage.value = img }
  img.onerror = () => { sceneImage.value = null }
  img.src = `/api/projects/${encodeURIComponent(slug.value)}/scene-review/${encodeURIComponent(episodeId.value)}/image/${encodeURIComponent(scene.id)}`
})

// ── Selection and editing ──────────────────────────────────────────────────
const selectedId = ref('')
const editingUid = ref('')
const draftParams = ref<Record<string, unknown>>({})
const draftFades = reactive({ in: DEFAULT_SCENE_FADE_SEC, out: DEFAULT_SCENE_FADE_SEC })

const rows = computed<StackRow[]>(() => stackRowsForTarget(file, currentTarget.value, scenes.value, library.value))
const editingRow = computed(() => rows.value.find(r => r.applied.uid === editingUid.value) ?? null)
const selectedEntry = computed(() => library.value.find(e => e.id === selectedId.value) ?? null)
const selectedDoc = computed<SceneOverlayDocument | null>(() => {
  if (editingRow.value) return editingRow.value.doc
  return resolveDoc(selectedEntry.value, draftParams.value)
})
const fields = computed<ParamField[]>(() => selectedDoc.value ? effectParamFields(selectedDoc.value as any) : [])
const showFades = computed(() => editingRow.value ? editingRow.value.scope !== 'episode' : currentTarget.value.kind !== 'episode')
const notLive = computed(() => !!selectedDoc.value && NOT_DRAWN_LIVE.has(selectedDoc.value.kind))
const editorChip = computed(() => {
  const doc = selectedDoc.value
  if (!doc) return ''
  if (doc.kind === 'atmosphere-loop') return `${effectBadge(doc)} · ${doc.loop_sec} s, seamless`
  return effectBadge(doc)
})
const rebakeHint = computed(() => selectedDoc.value?.kind === 'atmosphere-loop'
  ? 'Colour, brightness and darkening change instantly. Amount, size, speed, wind and the rest re-make the loop for the render (about 2 s, once).'
  : 'Every change shows instantly here; the render uses exactly these values.')
const addHint = computed(() => !episodeId.value
  ? 'Pick an episode above first — effects are saved with an episode.'
  : currentTarget.value.kind === 'episode'
  ? 'Plays for the whole episode.'
  : `Plays on ${targetName.value.toLowerCase()} and fades over ${draftFades.in} s in, ${draftFades.out} s out.`)

function selectEntry(entry: LibraryEntry): void {
  selectedId.value = entry.id
  editingUid.value = ''
  draftParams.value = {}
  exactUrl.value = ''
}

function editRow(row: StackRow): void {
  if (!row.entry) return
  selectedId.value = row.entry.id
  editingUid.value = row.applied.uid
  exactUrl.value = ''
}

function finishEditing(): void {
  editingUid.value = ''
  draftParams.value = {}
}

function paramValue(key: string): any {
  return (selectedDoc.value as any)?.[key]
}

function amountText(field: ParamField): string {
  const doc = selectedDoc.value
  if (field.key === 'amount' && doc?.kind === 'atmosphere-loop' && LOOP_VARIANT_INFO[doc.variant].unit) {
    return effectAmountLabel(doc) || formatParam(field, paramValue(field.key))
  }
  return formatParam(field, paramValue(field.key))
}

function setParam(key: string, value: unknown): void {
  const entry = selectedEntry.value
  const doc = selectedDoc.value
  if (!entry || !doc) return
  const next = resolveDoc(entry, { ...changedParams(entry, doc as any), [key]: value })!
  const params = changedParams(entry, next as any)
  if (editingRow.value) {
    if (Object.keys(params).length) editingRow.value.applied.params = params
    else delete editingRow.value.applied.params
    queueSave()
  } else {
    draftParams.value = params
  }
  exactStale.value = !!exactUrl.value
}

// ── Outlines (living pictures, effects kept inside one part of a scene) ─────
const outlines = ref<string[]>([])
const outlineValue = computed(() => (selectedDoc.value as any)?.region?.mask || '')
function setOutline(name: string): void {
  setParam('region', name ? { mask: name } : undefined)
}
async function uploadOutline(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0]
  input.value = ''
  if (!picked || !targetScene.value || !episodeId.value) return
  try {
    const data_base64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(picked)
    })
    const result = await post(`/projects/${slug.value}/effects-library/${episodeId.value}/outlines`, {
      scene_id: targetScene.value.id, label: picked.name.replace(/\.[^.]+$/, ''), data_base64,
    })
    if (!outlines.value.includes(result.mask)) outlines.value = [...outlines.value, result.mask].sort()
    setOutline(result.mask)
  } catch (e: any) {
    showError(e?.data?.detail || 'The outline could not be uploaded.')
  }
}

function fadeValue(which: 'in' | 'out'): number {
  const row = editingRow.value
  if (row) return (which === 'in' ? row.applied.fade_in_sec : row.applied.fade_out_sec) ?? (row.scope === 'episode' ? 0 : DEFAULT_SCENE_FADE_SEC)
  return draftFades[which]
}

function setFade(which: 'in' | 'out', value: number): void {
  const row = editingRow.value
  if (row) {
    if (which === 'in') row.applied.fade_in_sec = value
    else row.applied.fade_out_sec = value
    queueSave()
  } else {
    draftFades[which] = value
  }
}

function addSelected(): void {
  const entry = selectedEntry.value
  if (!entry || !canEdit.value) return
  const [added] = addEffects(file, currentTarget.value, [{ id: entry.id, params: draftParams.value }])
  if (added && currentTarget.value.kind !== 'episode') {
    added.fade_in_sec = draftFades.in
    added.fade_out_sec = draftFades.out
  }
  queueSave()
  success(`${entry.name} added to ${targetName.value.toLowerCase()}.`)
  if (added) editingUid.value = added.uid
}

function toggleRow(row: StackRow): void {
  row.applied.enabled = !row.applied.enabled
  queueSave()
}

function removeRow(row: StackRow): void {
  const index = row.list.indexOf(row.applied)
  if (index >= 0) row.list.splice(index, 1)
  if (editingUid.value === row.applied.uid) finishEditing()
  queueSave()
}

const dragging = ref<StackRow | null>(null)
const moveNote = ref('')
function dropOn(target: StackRow | null): void {
  const dragged = dragging.value
  dragging.value = null
  if (!dragged) return
  moveNote.value = moveRow(rows.value, dragged, target, file.custom_order) || ''
  if (!moveNote.value) queueSave()
}

const rowBlocks = computed(() => {
  if (file.custom_order) return [{ key: 'custom', label: '', rows: rows.value }]
  const blocks: Array<{ key: string; label: string; rows: StackRow[] }> = []
  for (const row of rows.value) {
    const last = blocks[blocks.length - 1]
    if (last && last.key === row.group) last.rows.push(row)
    else blocks.push({ key: row.group, label: `${EFFECT_STACK_GROUPS.indexOf(row.group) + 1} · ${GROUP_LABELS[row.group]}`, rows: [row] })
  }
  return blocks
})

function rowSummary(row: StackRow): string {
  const doc = row.doc
  if (!doc) return ''
  if (doc.kind === 'atmosphere-loop') {
    const parts = [effectAmountLabel(doc)]
    if (LOOP_VARIANT_INFO[doc.variant].fields.includes('layers') && doc.layers > 1) parts.push(`${doc.layers} layers`)
    return parts.filter(Boolean).join(', ')
  }
  if (doc.kind === 'color-grade') return doc.preset.replace(/-/g, ' ')
  if (doc.kind === 'vignette') return doc.intensity < 0.6 ? 'soft' : 'heavy'
  if (doc.kind === 'film-grain') return doc.amount < 20 ? 'fine' : 'heavy'
  return ''
}

// ── Cost ──────────────────────────────────────────────────────────────────
const episodeSeconds = computed(() => scenes.value.reduce((max, s) => Math.max(max, s.end_sec), 0))
const costLine = computed(() => {
  const docs = enabledDocs(rows.value)
  if (!docs.length) return 'Nothing to add to the render time.'
  const per65 = estimateStackMinutes(docs, COST_REF)
  const here = episodeSeconds.value > 0 ? estimateStackMinutes(docs, { ...COST_REF, durationSec: episodeSeconds.value }) : null
  const fmt = (m: number) => m < 1 ? 'under a minute' : `about ${m < 3 ? m.toFixed(1) : Math.round(m)} minutes`
  return `This stack adds ${fmt(per65)} to a 65-minute 1080p render`
    + (here !== null && currentTarget.value.kind === 'episode' ? ` (${fmt(here)} for this ${formatClock(episodeSeconds.value)} episode).` : '.')
    + ' On one scene an effect costs less, but not in proportion: a loop keeps decoding outside its scene (measured: a third of the episode costs about two thirds).'
})

// ── Live preview ────────────────────────────────────────────────────────────
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const renderer = new EffectCanvasRenderer((w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }))
/** What the canvas draws: the target's stack, with the effect being picked placed where it would render. */
const previewDocs = computed<SceneOverlayDocument[]>(() => {
  const docs = enabledDocs(rows.value)
  if (editingRow.value || !selectedDoc.value) return docs
  const draft = selectedDoc.value
  const rank = (d: SceneOverlayDocument) => file.custom_order ? 0 : EFFECT_STACK_GROUPS.indexOf(overlayStackGroup(d))
  const at = docs.findIndex(d => rank(d) > rank(draft))
  return at < 0 ? [...docs, draft] : [...docs.slice(0, at), draft, ...docs.slice(at)]
})

let raf = 0
const started = performance.now()
function frame(now: number): void {
  raf = requestAnimationFrame(frame)
  if (document.hidden) return
  const ctx = previewCanvas.value?.getContext('2d')
  if (!ctx) return
  renderer.draw(ctx, sceneImage.value, previewDocs.value, (now - started) / 1000, SLOW_ZOOM)
}
watch(previewDocs, docs => renderer.prune(docs, 960, 540))

// ── Exact preview ─────────────────────────────────────────────────────────
const exacting = ref(false)
const exactUrl = ref('')
const exactInfo = ref('')
const exactStale = ref(false)
const exactHint = computed(() => episodeId.value
  ? 'The real render engine at half size, over the chosen scene with the slow zoom — about 1–3 s. What you see is what the video gets.'
  : 'Pick an episode above first — the exact preview renders over one of its scenes.')

async function renderExact(): Promise<void> {
  if (!episodeId.value) return
  exacting.value = true
  try {
    const stack = rows.value.filter(r => r.applied.enabled && r.entry)
    const items = stack.map(r => ({ id: r.applied.id, params: r.applied.params || {} }))
    if (!editingRow.value && selectedEntry.value) items.push({ id: selectedEntry.value.id, params: draftParams.value })
    const result = await post(`/projects/${slug.value}/effects-library/${episodeId.value}/exact-preview`, {
      scene_id: previewSceneId.value || undefined,
      overlays: items,
      custom_order: file.custom_order,
      motion_id: 'ken-burns',
    })
    exactUrl.value = result.url
    exactStale.value = false
    exactInfo.value = `Rendered in ${(result.render_ms / 1000).toFixed(1)} s · ${result.width}×${result.height}, ${result.duration_sec} s`
      + (result.camera_engine === 'native' ? ' · camera by the native renderer' : result.camera_engine === 'ffmpeg' ? ' · camera by FFmpeg (the native renderer is not installed)' : '')
      + (result.backdrop === 'gradient' ? ' · over a gradient: this scene has no image yet.' : '.')
  } catch (e: any) {
    showError(e?.data?.detail || 'The exact preview could not be rendered.')
  } finally {
    exacting.value = false
  }
}

// ── Loading and saving ──────────────────────────────────────────────────────
const saveState = ref<'idle' | 'pending' | 'saving' | 'saved' | 'error'>('idle')
const saveError = ref('')
const savedAt = ref('')
let saveTimer: ReturnType<typeof setTimeout> | null = null
const saveText = computed(() => {
  if (!episodeId.value) return 'Pick an episode to start.'
  if (saveState.value === 'saving' || saveState.value === 'pending') return 'Saving…'
  if (saveState.value === 'error') return `Not saved: ${saveError.value}`
  if (saveState.value === 'saved') return `Saved at ${savedAt.value}. Video Assembly uses it on the next render.`
  return 'Changes save by themselves and Video Assembly renders them.'
})
const saveTone = computed(() => saveState.value === 'error' ? 'error' : saveState.value === 'saved' ? 'success' : 'neutral')

function queueSave(): void {
  if (!canEdit.value) return
  saveState.value = 'pending'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 500)
}

async function saveNow(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  const episode = fileEpisode.value
  if (!episode) return
  saveState.value = 'saving'
  try {
    await put(`/projects/${slug.value}/effects-library/${episode}`, compactFile(JSON.parse(JSON.stringify(file))))
    if (fileEpisode.value !== episode) return
    saveState.value = 'saved'
    saveError.value = ''
    savedAt.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch (e: any) {
    saveState.value = 'error'
    saveError.value = e?.data?.detail || e?.message || 'the save failed'
  }
}

async function load(): Promise<void> {
  // An episode change REPLACES everything — nothing from the last episode stays (AGENTS.md §4).
  if (saveTimer && saveState.value === 'pending') await saveNow()
  Object.assign(file, emptyEffectsFile())
  fileEpisode.value = ''
  scenes.value = []
  finishEditing()
  exactUrl.value = ''
  loadError.value = ''
  readError.value = ''
  saveState.value = 'idle'
  if (!episodeId.value) return
  const episode = episodeId.value
  loading.value = true
  try {
    const data = await get(`/projects/${slug.value}/effects-library/${episode}`)
    if (episodeId.value !== episode) return
    library.value = data.overlays || []
    scenes.value = data.scenes || []
    outlines.value = data.outlines || []
    hasScenePlan.value = !!data.has_scene_plan
    readError.value = data.read_error || ''
    Object.assign(file, emptyEffectsFile(), data.file || {})
    fileEpisode.value = episode
    const firstScene = scenes.value[0]
    previewSceneId.value = firstScene?.id || ''
    targetKey.value = firstScene ? `scene:${firstScene.id}` : 'episode'
  } catch (e: any) {
    loadError.value = e?.data?.detail || 'This episode\'s effects could not be loaded. The backend may still be starting.'
  } finally {
    loading.value = false
  }
}

async function loadLibraryOnly(): Promise<void> {
  try {
    const data = await get(`/projects/${slug.value}/video-editor/effects/catalog`)
    if (!library.value.length) library.value = data.overlays || []
    sceneMotions.value = data.scene_motions || []
    motionFamilies.value = data.motion_families || []
  } catch { /* the episode load reports problems */ }
}

// ── Gallery (1.4.283) ───────────────────────────────────────────────────────
interface MotionEntry { id: string; name: string; description: string; category: string; document: unknown }
const sceneMotions = ref<MotionEntry[]>([])
const motionFamilies = ref<Array<{ key: string; name: string; description: string; members: Array<{ id: string; strength: string }> }>>([])
const inUse = ref<{ overlays: string[]; motions: string[]; source: string | null }>({ overlays: [], motions: [], source: null })
const inUseTitle = computed(() => inUse.value.source ? `A Pipeline batch on this channel renders it (Video Assembly preset "${inUse.value.source}").` : '')
const galleryNonce = ref(0)
const refreshing = ref(false)

function motionDoc(id: string): unknown {
  return sceneMotions.value.find(m => m.id === id)?.document
}
/** The catalogue already leaves out rotation and Pan Right's twin; the families have their own row. */
const motionGroups = computed(() => {
  const inFamily = new Set(motionFamilies.value.flatMap(f => f.members.map(m => m.id)))
  const rest = sceneMotions.value.filter(m => !inFamily.has(m.id))
  return [
    { label: 'Dolly', motions: rest.filter(m => m.category === 'zoom') },
    { label: 'Pans', motions: rest.filter(m => m.category === 'pan') },
    { label: 'Fades', motions: rest.filter(m => m.category === 'fade') },
    { label: 'Focus and still', motions: rest.filter(m => m.category === 'effect' || m.category === 'static' || m.category === 'ambient') },
  ].filter(group => group.motions.length)
})

function clipUrl(kind: 'overlay' | 'motion', id: string, doc: unknown): string {
  const episode = episodeId.value || '-'
  const scene = previewSceneId.value ? `&scene=${encodeURIComponent(previewSceneId.value)}` : ''
  return `/api/projects/${encodeURIComponent(slug.value)}/effects-library/${encodeURIComponent(episode)}/gallery/${kind}/${encodeURIComponent(id)}`
    + `?v=${documentVersion(doc)}-${galleryNonce.value}${scene}`
}

async function refreshPreviews(): Promise<void> {
  refreshing.value = true
  try {
    await post(`/projects/${slug.value}/effects-library/${episodeId.value || '-'}/gallery/refresh`, { scene: previewSceneId.value || undefined })
    galleryNonce.value++
    success('Previews will be drawn again as they come into view.')
  } catch (e: any) {
    showError(e?.data?.detail || 'The previews could not be refreshed.')
  } finally {
    refreshing.value = false
  }
}

async function loadInUse(): Promise<void> {
  try { inUse.value = await get(`/projects/${slug.value}/effects-library-in-use`) } catch { /* badges are a convenience */ }
}

watch(episodeId, () => { load() })

// ── Presets ───────────────────────────────────────────────────────────────
const presetDraft = ref<Array<{ id: string; params?: Record<string, unknown> }>>([])
const stackPresets = usePresets<{ effects: Array<{ id: string; params?: Record<string, unknown> }> }>({
  slug: slug.value,
  configKey: 'effect_stack',
  presetType: 'effect-stack',
  snapshot: () => ({ effects: presetDraft.value }),
  apply: () => {},
  autoApplyOnLoad: false,
  builtInPresets: BUILT_IN_EFFECT_STACKS.map(stack => ({ id: stack.id, name: stack.name, data: { effects: stack.effects, description: stack.description }, builtin: true, type: 'effect-stack' as const })),
})
const savePresetFor = ref<'effect' | 'stack' | null>(null)
const presetName = ref('')

function openSavePreset(kind: 'effect' | 'stack'): void {
  savePresetFor.value = kind
  presetName.value = kind === 'effect' ? (selectedEntry.value?.name || '') : ''
}

async function savePreset(): Promise<void> {
  const name = presetName.value.trim()
  if (!name) return
  if (savePresetFor.value === 'effect') {
    if (!selectedEntry.value) return
    const params = editingRow.value ? editingRow.value.applied.params : draftParams.value
    presetDraft.value = [{ id: selectedEntry.value.id, ...(params && Object.keys(params).length ? { params: { ...params } } : {}) }]
  } else {
    presetDraft.value = presetItemsFromRows(rows.value)
  }
  try {
    await stackPresets.saveAs(name)
    success(`Preset “${name}” saved.`)
    savePresetFor.value = null
  } catch (e: any) {
    showError(e?.data?.detail || 'The preset could not be saved.')
  }
}

function presetDescription(preset: { data: any }): string {
  if (preset.data?.description) return preset.data.description
  const names = (preset.data?.effects || []).map((item: any) => library.value.find(e => e.id === item.id)?.name || item.id)
  return names.join(' · ')
}

function applyPreset(preset: { name: string; data: any }): void {
  const items = (preset.data?.effects || []).filter((item: any) => library.value.some(e => e.id === item.id))
  const missing = (preset.data?.effects || []).length - items.length
  addEffects(file, currentTarget.value, items)
  queueSave()
  success(`${preset.name}: ${items.length} effect${items.length === 1 ? '' : 's'} added to ${targetName.value.toLowerCase()}.`
    + (missing ? ` ${missing} not in this library (an uninstalled pack) and left out.` : ''))
}

async function deletePreset(preset: { id: string; name: string }): Promise<void> {
  await stackPresets.setActive(preset.id)
  await stackPresets.remove()
  success(`Preset “${preset.name}” deleted.`)
}

onMounted(() => {
  raf = requestAnimationFrame(frame)
  stackPresets.load()
  loadLibraryOnly()
  loadInUse()
  if (episodeId.value) load()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (saveTimer && saveState.value === 'pending') saveNow()
})
</script>

<style scoped>
.fx-hero-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: flex-end; }
.fx-search { width: 220px; }
.fx-seg { display: inline-flex; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.fx-seg button { padding: 6px 12px; font-size: 12.5px; color: var(--text-secondary); background: none; border: 0; border-right: 1px solid var(--border); cursor: pointer; }
.fx-seg button:last-child { border-right: 0; }
.fx-seg button.on { background: var(--accent); color: var(--accent-on); font-weight: 600; }

.fx-context { display: grid; grid-template-columns: minmax(220px, 1.2fr) repeat(2, minmax(200px, 1fr)) minmax(200px, 1fr); gap: 14px; align-items: start; margin-top: 14px; }
.fx-context-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.fx-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.fx-save-state span[data-tone='error'] { color: var(--danger, #e66); }
.fx-save-state span[data-tone='success'] { color: var(--text-secondary); }
.fx-banner { margin: 12px 0 0; padding: 8px 12px; border-radius: var(--radius-sm); font-size: 13px; border: 1px solid var(--border); background: var(--surface-subtle, var(--bg-secondary)); }
.fx-banner[data-tone='error'] { border-color: color-mix(in srgb, var(--danger, #e66) 50%, var(--border)); }
.fx-banner[data-tone='warning'] { border-color: color-mix(in srgb, var(--warning, #e9b949) 50%, var(--border)); }

.fx-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(400px, 560px); gap: 18px; align-items: start; margin-top: 4px; }
.fx-cat { font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin: 16px 0 8px; }
.fx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 12px; }
.fx-card { text-align: left; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--bg-primary); color: var(--text-primary); cursor: pointer; display: flex; flex-direction: column; text-decoration: none; }
.fx-card:hover { border-color: var(--border-light); }
.fx-card.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.fx-im { position: relative; height: 92px; overflow: hidden; }
.fx-badge { position: absolute; left: 6px; bottom: 6px; font-size: var(--font-xs); font-weight: 700; padding: 1px 6px; border-radius: 999px; background: rgba(0, 0, 0, 0.6); color: #fff; }
.fx-inuse { position: absolute; left: 6px; top: 6px; font-size: var(--font-xs); font-weight: 700; padding: 1px 6px; border-radius: 999px; background: var(--accent); color: var(--accent-on); }
.fx-family { margin-bottom: 10px; }
.fx-family-head { margin: 4px 0 6px; font-size: 13px; }
.fx-family-head small { color: var(--text-muted); }
.fx-motion { cursor: default; }
.fx-strength { text-transform: capitalize; }
.fx-pack { position: absolute; right: 6px; top: 6px; font-size: var(--font-xs); padding: 1px 6px; border-radius: 999px; background: rgba(0, 0, 0, 0.55); color: #fff; }
.fx-tx { padding: 7px 9px 9px; display: flex; flex-direction: column; gap: 2px; }
.fx-tx b { font-size: 13px; }
.fx-tx small { font-size: var(--font-xs); color: var(--text-muted); line-height: 1.4; }
.fx-empty { color: var(--text-muted); font-size: 13px; margin-top: 16px; }
.fx-foot { margin-top: 12px; }

.fx-side { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; min-width: 0; }
.fx-side .card { padding: 18px 20px; }
.fx-editor-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.fx-editor-head h3, .fx-stack h3, .fx-presets h3 { margin: 0; font-size: 17px; }
.fx-canvas { display: block; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-md); margin-top: 10px; background: #0d1117; }
.fx-approx { font-size: 12px; margin: 6px 0 0; padding: 6px 8px; border-radius: 5px; background: rgba(255, 196, 0, 0.1); border-left: 2px solid rgba(255, 196, 0, 0.6); }
.fx-params { margin-top: 10px; }
.fx-param { display: grid; grid-template-columns: 120px minmax(0, 1fr) 92px; gap: 10px; align-items: center; font-size: 12.5px; margin: 6px 0; }
.fx-param input[type='range'] { width: 100%; accent-color: var(--accent); }
.fx-param b { font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
.fx-param-label { color: var(--text-primary); }
.fx-inline { display: inline-flex; gap: 8px; align-items: center; }
.fx-seed { width: 90px; }
.fx-actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 12px; align-items: flex-start; }
.fx-btnhint { display: flex; flex-direction: column; gap: 3px; max-width: 240px; }
.fx-btnhint .hint { margin: 0; }
.fx-save-preset { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.fx-save-preset .input { flex: 1; }
.fx-exact { margin-top: 12px; display: flex; flex-direction: column; gap: 4px; }
.fx-exact video { width: 100%; border-radius: var(--radius-md); background: #000; }
.fx-editor-empty h3 { margin: 0 0 6px; }

.fx-rows { list-style: none; padding: 0; margin: 8px 0 0; }
.fx-g { font-size: var(--font-xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-muted); padding: 10px 2px 2px; }
.fx-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 5px; font-size: 12.5px; background: var(--bg-primary); }
.fx-row.on { border-color: color-mix(in srgb, var(--accent) 60%, var(--border)); }
.fx-row.off { opacity: 0.55; }
.fx-row.missing { border-style: dashed; }
.fx-row[draggable='true'] { cursor: grab; }
.fx-handle { color: var(--text-muted); user-select: none; }
.fx-row-name { background: none; border: 0; padding: 0; text-align: left; color: var(--text-primary); font: inherit; cursor: pointer; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fx-row-tools { display: inline-flex; gap: 8px; align-items: center; }
.fx-scope { color: var(--text-muted); font-size: 12px; }
.fx-toggle input { accent-color: var(--accent); }
.fx-remove { padding: 2px 8px; }
.fx-row-empty { padding: 8px 2px; }
.fx-drop-end { margin-top: 6px; padding: 6px; border: 1px dashed var(--border-light); border-radius: var(--radius-sm); text-align: center; font-size: 12px; color: var(--text-muted); }
.fx-sub { display: block; margin-top: 2px; }
.fx-note { color: var(--warning, #e9b949); }
.fx-preset-list { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 8px; }
.fx-preset-list li { display: flex; justify-content: space-between; gap: 10px; align-items: center; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.fx-preset-list li > div { display: flex; flex-direction: column; min-width: 0; }
.fx-preset-actions { display: inline-flex; gap: 6px; flex-shrink: 0; }

@media (max-width: 1500px) {
  .fx-context { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 1240px) {
  .fx-layout { grid-template-columns: minmax(0, 1fr); }
}
</style>
