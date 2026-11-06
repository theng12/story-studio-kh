<template>
  <div class="fx-panel">
    <div class="fx-panel-head">
      <p class="fx-panel-intro">Every effect stacks with every other, on the whole episode, one scene, or every scene of a theme. Each card plays a 6-second clip Story rendered of that effect on this episode's scene, camera still; Camera motions shows the moves on their own.</p>
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
    </div>

    <section class="card fx-context">
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
        <span class="fx-label">Draft</span>
        <span :data-tone="draftTone">{{ draftText }}</span>
      </div>
    </section>

    <!-- E2–E4 (1.4.288) — scene analysis: per channel, off by default; depth is its own switch.
         Every control here is held in the draft and runs only when the host applies. -->
    <section class="card fx-analysis" aria-label="Scene analysis">
      <div class="fx-analysis-head">
        <b>Scene analysis</b>
        <small>Lets moves and effects understand each picture: real depth (3D photo, rack focus), the main subject (zoom to subject, guided tour) and outlines of sky, water, flames and plants. Each picture is analysed once on your Macs; renders only read the saved result.</small>
      </div>
      <label class="fx-switch"><input type="checkbox" :checked="shownSwitches.depth" :disabled="applying" @change="queueSwitch('depth', ($event.target as HTMLInputElement).checked)" /> Depth for this channel</label>
      <label class="fx-switch"><input type="checkbox" :checked="shownSwitches.vision" :disabled="applying" @change="queueSwitch('vision', ($event.target as HTMLInputElement).checked)" /> Subject and outlines for this channel</label>
      <div class="fx-analysis-run">
        <button
          type="button"
          class="btn btn-sm btn-secondary"
          :disabled="!canEdit || analysisBusy || (!shownSwitches.depth && !shownSwitches.vision)"
          @click="toggleAnalyse"
        >{{ analysisBusy ? 'Analysing…' : analyseQueued ? 'Analyses on Apply' : 'Analyse Scenes' }}</button>
        <span class="hint" role="status">{{ analysisLine }}</span>
      </div>
      <span v-if="analyseQueued && !analysisBusy" class="hint">Nothing runs until you apply this dialog — click the button again to take it off.</span>
      <span v-if="pendingSwitches" class="hint">The switch change is held until you apply this dialog.</span>
      <p v-if="(shownSwitches.depth && !analysis.models.depth) || (shownSwitches.vision && !analysis.models.vision)" class="hint fx-analysis-warn">
        Pick the scene-analysis models first: Settings → Connections → Scene analysis models. Until then renders use each move's plain version.
      </p>
    </section>

    <p v-if="loadError" class="fx-banner" data-tone="error">{{ loadError }}</p>
    <p v-else-if="readError" class="fx-banner" data-tone="warning">{{ readError }} Applying here writes a fresh copy.</p>
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
        <div v-if="!sections.length && library.length && activeTab !== 'motions' && activeTab !== 'transitions'" class="fx-empty">No effect matches “{{ search }}”.</div>
        <template v-if="activeTab === 'motions'">
          <p class="hint">How each scene picture moves. Pick them in Video Assembly → Scene Animation; these clips only show them.</p>
          <div class="fx-cat">{{ visibleFamilies.map(f => f.name).join(' · ') }}</div>
          <div v-for="family in visibleFamilies" :key="family.key" class="fx-family">
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
        <template v-if="activeTab === 'transitions'">
          <p class="hint">How one scene turns into the next. Pick them in Video Assembly → Transitions; these clips only show them. Click a card for the exact preview over this episode's scene and the next.</p>
          <div v-for="group in transitionGroups" :key="group.label">
            <div class="fx-cat">{{ group.label }}</div>
            <div class="fx-grid">
              <button v-for="tr in group.items" :key="tr.id" type="button" class="fx-card fx-motion" :class="{ sel: exactTransition === tr.id }" :title="tr.hint" @click="renderExactTransition(tr.id)">
                <div class="fx-im">
                  <GalleryClip :src="transitionClipUrl(tr.id)">
                    <EffectThumb :doc="null" :image="sceneImage" />
                  </GalleryClip>
                  <span v-if="tr.engine" class="fx-badge">Story engine</span>
                </div>
                <div class="fx-tx"><b>{{ tr.label }}</b><small>{{ tr.hint || '' }}</small></div>
              </button>
            </div>
          </div>
          <div v-if="exactTransitionUrl" class="fx-exact">
            <video :src="exactTransitionUrl" autoplay loop muted playsinline controls />
            <span class="hint">{{ exactTransitionInfo }}</span>
          </div>
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
                    <option v-for="name in outlines" :key="name" :value="name">{{ outlineLabel(name) }}</option>
                  </select>
                  <label class="btn btn-sm btn-ghost">Upload…<input type="file" accept="image/png,image/jpeg" hidden @change="uploadOutline" /></label>
                  <button type="button" class="btn btn-sm btn-ghost" :disabled="!targetScene.has_image" @click="drawing = !drawing">{{ drawing ? 'Close Drawing' : 'Draw…' }}</button>
                </span>
                <b />
              </div>
              <OutlineDrawer
                v-if="targetScene && drawing"
                :image-url="sceneImageUrl(targetScene.id)"
                :saving="applying"
                @save="saveDrawnOutline"
                @cancel="drawing = false"
              />
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
                <span class="hint">Keeps this effect and its settings to add anywhere later. No scene or time is saved. Saved when you apply.</span>
              </div>
              <div class="fx-btnhint">
                <button v-if="!editingUid" type="button" class="btn btn-primary" :disabled="!canEdit" @click="addSelected">Add to {{ targetShortLabel }}</button>
                <button v-else type="button" class="btn btn-primary" @click="finishEditing">Done</button>
                <span class="hint">{{ editingUid ? 'Changes stay in this dialog until you apply.' : addHint }}</span>
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
            <input v-model="file.custom_order" type="checkbox" :disabled="!canEdit || applying" />
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
            <span class="hint">Saves the effects and their settings — not the scene they are on. Saved when you apply.</span>
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
                <button
                  v-if="!preset.builtin"
                  type="button"
                  class="btn btn-sm btn-ghost"
                  :disabled="pendingDeletes.includes(preset.id)"
                  @click="deletePreset(preset)"
                >{{ pendingDeletes.includes(preset.id) ? 'Deletes on Apply' : 'Delete' }}</button>
              </span>
            </li>
          </ul>
        </section>
      </aside>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * EpisodeEffectsEditor — the Effects Library editor as a controlled draft
 * panel, extracted from pages/projects/[slug]/effects-library.vue (same
 * logic, same shared utils, same endpoints) so a host dialog — Video
 * Assembly's step 4 — can host it beside the overlay and logo controls.
 *
 * INTEGRATION API (host owns the dialog; this panel owns the draft):
 *   props  projectSlug  the channel (projects/:slug)
 *          episodeId    the episode being drafted; changing it discards the
 *                       draft and fences in-flight answers from the old scope
 *          sceneId      optional scene to target and preview over on load
 *   emits  'dirty-change'(dirty: boolean)   enable Apply while true
 *          'loading-change'(loading: boolean) hold Apply while true
 *   expose apply(): Promise<{ ok: boolean; error?: string }>
 *                    flushes the queued side-writes, PUTs the episode file
 *                    through the existing endpoint, resets the draft
 *          cancel(): void  drop the draft and the queued side-writes
 *
 * NOTHING PERSISTS UNTIL apply(). No autosave, no flush on episode load, no
 * flush on unmount — leaving the dialog without apply() is a cancel. Side
 * writes the page used to fire immediately (outline uploads, scene-analysis
 * switches and the analysis run, preset save/delete) are queued in memory and
 * run only inside apply(); previews (gallery clips, exact preview) use the
 * existing temp preview endpoints immediately and register nothing permanent.
 * Edits and queued writes are frozen while an apply is running, so a late
 * edit can never be marked saved by a submission it was not part of.
 * The exact preview keeps its renderer contract — always the Ken Burns slow
 * zoom — and says so in its hint instead of implying the episode's camera.
 * The canonical EpisodeEffectsFile shape, compact/normalize order and write
 * endpoint are untouched; this panel never invents a preview claim.
 */
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
import {
  adoptMasks,
  applyFilePayload,
  cloneEffectsFile,
  isDraftDirty,
  outlinePlaceholder,
  planOps,
  type EpisodeEffectsOp,
  type EpisodeEffectsOutlineOp,
  type EpisodeEffectsWriteOp,
} from '~/utils/episode-effects-draft'

const props = defineProps<{
  /** Channel (projects/:slug) the episode belongs to. */
  projectSlug: string
  /** Episode whose effects file this panel drafts. Changing it discards the draft. */
  episodeId: string
  /** Optional scene to target and preview over on first load. */
  sceneId?: string
}>()
const emit = defineEmits<{
  'dirty-change': [dirty: boolean]
  'loading-change': [loading: boolean]
}>()

const slug = computed(() => props.projectSlug)
const episodeId = computed(() => props.episodeId)
const { get, put, post } = useApi()
const { success, error: showError } = useToast()

const search = ref('')
const activeTab = ref('all')
const loading = ref(false)
const loadError = ref('')
const readError = ref('')
const hasScenePlan = ref(false)
const library = ref<LibraryEntry[]>([])
const scenes = ref<SceneRow[]>([])
/** The draft file — every edit lands here and nowhere else until apply(). */
const file = reactive<EpisodeEffectsFile>(emptyEffectsFile())
/** What the last load or apply read; cancel restores from it. */
const baseline = ref<EpisodeEffectsFile>(emptyEffectsFile())
/** Queued side-writes; only apply() may run them. */
const ops = ref<EpisodeEffectsOp[]>([])
/** The episode the loaded file belongs to; the apply PUT addresses it. */
const fileEpisode = ref('')
const targetKey = ref('episode')
const previewSceneId = ref('')
const applying = ref(false)
const applyError = ref('')
/** Bumps on every scope change so answers from the old scope are dropped. */
let scopeSeq = 0
let alive = true

const dirty = computed(() => isDraftDirty(baseline.value, file, ops.value))
watch(dirty, value => emit('dirty-change', value), { immediate: true })
watch(loading, value => emit('loading-change', value), { immediate: true })

const draftText = computed(() => {
  if (loading.value) return 'Loading this episode’s effects…'
  if (applying.value) return 'Applying…'
  if (applyError.value) return `Not applied: ${applyError.value}`
  if (dirty.value) return 'Unsaved changes — Apply in this dialog saves them.'
  return 'Saved with this episode. Video Assembly uses it on the next render.'
})
const draftTone = computed(() => (applyError.value ? 'error' : dirty.value ? 'pending' : 'success'))

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
/** The host may hand the panel a scene; follow it while the episode stands. */
watch(() => props.sceneId, (next) => {
  if (!next || !scenes.value.some(s => s.id === next)) return
  targetKey.value = `scene:${next}`
  previewSceneId.value = next
})
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
  ? 'No episode is loaded here — effects are saved with an episode.'
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
  if (applying.value) return
  const entry = selectedEntry.value
  const doc = selectedDoc.value
  if (!entry || !doc) return
  const next = resolveDoc(entry, { ...changedParams(entry, doc as any), [key]: value })!
  const params = changedParams(entry, next as any)
  if (editingRow.value) {
    if (Object.keys(params).length) editingRow.value.applied.params = params
    else delete editingRow.value.applied.params
  } else {
    draftParams.value = params
  }
  exactStale.value = !!exactUrl.value
}

// ── Outlines (queued: uploaded only inside apply()) ───────────────────────
const outlines = ref<string[]>([])
const loadedOutlines = ref<string[]>([])
const pendingOutlineLabels = ref<Record<string, string>>({})
let outlineSeq = 0
// E1 (1.4.287) — the outline drawing tool.
const drawing = ref(false)
function sceneImageUrl(sceneId: string): string {
  return `/api/projects/${encodeURIComponent(slug.value)}/scene-review/${encodeURIComponent(episodeId.value)}/image/${encodeURIComponent(sceneId)}`
}
function queueOutline(op: EpisodeEffectsOutlineOp): void {
  if (applying.value) return
  ops.value = [...ops.value, op]
  pendingOutlineLabels.value = { ...pendingOutlineLabels.value, [op.placeholder]: op.label }
  if (!outlines.value.includes(op.placeholder)) outlines.value = [...outlines.value, op.placeholder].sort()
  setOutline(op.placeholder)
}
function saveDrawnOutline(payload: { label: string; shapes: unknown[]; feather_px: number }): void {
  if (!targetScene.value || !episodeId.value) return
  queueOutline({
    kind: 'outline',
    placeholder: outlinePlaceholder(++outlineSeq),
    scene_id: targetScene.value.id,
    label: payload.label,
    shapes: payload.shapes,
    feather_px: payload.feather_px,
  })
  drawing.value = false
}
const outlineValue = computed(() => (selectedDoc.value as any)?.region?.mask || '')
function setOutline(name: string): void {
  setParam('region', name ? { mask: name } : undefined)
}
function outlineLabel(name: string): string {
  const pending = pendingOutlineLabels.value[name]
  return pending ? `${pending} (on apply)` : name
}
async function uploadOutline(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const picked = input.files?.[0]
  input.value = ''
  if (!picked || !targetScene.value || !episodeId.value) return
  const scope = scopeSeq
  const scene = targetScene.value
  const episode = episodeId.value
  const data_base64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(picked)
  }).catch(() => '')
  if (!data_base64) return
  // The read took time: only queue the outline if this scene's scope still owns the panel.
  if (scope !== scopeSeq || !alive || episodeId.value !== episode || targetScene.value?.id !== scene.id) return
  queueOutline({
    kind: 'outline',
    placeholder: outlinePlaceholder(++outlineSeq),
    scene_id: scene.id,
    label: picked.name.replace(/\.[^.]+$/, ''),
    data_base64,
  })
}

function fadeValue(which: 'in' | 'out'): number {
  const row = editingRow.value
  if (row) return (which === 'in' ? row.applied.fade_in_sec : row.applied.fade_out_sec) ?? (row.scope === 'episode' ? 0 : DEFAULT_SCENE_FADE_SEC)
  return draftFades[which]
}

function setFade(which: 'in' | 'out', value: number): void {
  if (applying.value) return
  const row = editingRow.value
  if (row) {
    if (which === 'in') row.applied.fade_in_sec = value
    else row.applied.fade_out_sec = value
  } else {
    draftFades[which] = value
  }
}

function addSelected(): void {
  if (applying.value) return
  const entry = selectedEntry.value
  if (!entry || !canEdit.value) return
  const [added] = addEffects(file, currentTarget.value, [{ id: entry.id, params: draftParams.value }])
  if (added && currentTarget.value.kind !== 'episode') {
    added.fade_in_sec = draftFades.in
    added.fade_out_sec = draftFades.out
  }
  success(`${entry.name} added to ${targetName.value.toLowerCase()} — Apply keeps it.`)
  if (added) editingUid.value = added.uid
}

function toggleRow(row: StackRow): void {
  if (applying.value) return
  row.applied.enabled = !row.applied.enabled
}

function removeRow(row: StackRow): void {
  if (applying.value) return
  const index = row.list.indexOf(row.applied)
  if (index >= 0) row.list.splice(index, 1)
  if (editingUid.value === row.applied.uid) finishEditing()
}

const dragging = ref<StackRow | null>(null)
const moveNote = ref('')
function dropOn(target: StackRow | null): void {
  if (applying.value) return
  const dragged = dragging.value
  dragging.value = null
  if (!dragged) return
  moveNote.value = moveRow(rows.value, dragged, target, file.custom_order) || ''
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

// ── Exact preview (renders immediately: it writes only the temp preview cache) ──
const exacting = ref(false)
const exactUrl = ref('')
const exactInfo = ref('')
const exactStale = ref(false)
/** Honest about the one thing the preview cannot show: its camera is fixed. */
const exactHint = computed(() => episodeId.value
  ? 'The real render engine at half size, over the chosen scene — about 1–3 s. The camera is always the slow zoom (Ken Burns), not necessarily the move Video Assembly will use.'
  : 'No episode is loaded here — the exact preview renders over one of its scenes.')

async function renderExact(): Promise<void> {
  if (!episodeId.value) return
  const scope = scopeSeq
  const destSlug = slug.value
  const episode = episodeId.value
  const scene = previewSceneId.value || undefined
  exacting.value = true
  try {
    const stack = rows.value.filter(r => r.applied.enabled && r.entry)
    const items = stack.map(r => ({ id: r.applied.id, params: r.applied.params || {} }))
    if (!editingRow.value && selectedEntry.value) items.push({ id: selectedEntry.value.id, params: draftParams.value })
    const result = await post(`/projects/${destSlug}/effects-library/${episode}/exact-preview`, {
      scene_id: scene,
      overlays: items,
      custom_order: file.custom_order,
      motion_id: 'ken-burns',
    })
    // The render takes seconds: it only shows if the same scope and preview scene still own the panel.
    if (scope !== scopeSeq || !alive || (previewSceneId.value || undefined) !== scene) return
    exactUrl.value = result.url
    exactStale.value = false
    exactInfo.value = `Rendered in ${(result.render_ms / 1000).toFixed(1)} s · ${result.width}×${result.height}, ${result.duration_sec} s`
      + (result.camera_engine === 'native' ? ' · camera by the native renderer' : result.camera_engine === 'ffmpeg' ? ' · camera by FFmpeg (the native renderer is not installed)' : '')
      + ' · camera: the slow zoom (Ken Burns)'
      + (result.backdrop === 'gradient' ? ' · over a gradient: this scene has no image yet.' : '.')
  } catch (e: any) {
    if (scope === scopeSeq && alive) showError(e?.data?.detail || 'The exact preview could not be rendered.')
  } finally {
    // A scope change clears exacting itself (clearDraft); never touch the new scope's state.
    if (scope === scopeSeq) exacting.value = false
  }
}

// ── Scope: load, clear, fence ────────────────────────────────────────────────
function clearDraft(): void {
  Object.assign(file, emptyEffectsFile())
  baseline.value = emptyEffectsFile()
  ops.value = []
  applyError.value = ''
  targetKey.value = 'episode'
  previewSceneId.value = ''
  outlines.value = []
  loadedOutlines.value = []
  pendingOutlineLabels.value = {}
  pendingSwitches.value = null
  pendingDeletes.value = []
  hasScenePlan.value = false
  finishEditing()
  exactUrl.value = ''
  exacting.value = false
  exactTransitionUrl.value = ''
  dragging.value = null
  moveNote.value = ''
}

async function load(): Promise<void> {
  const scope = ++scopeSeq
  // An episode change discards the draft — nothing from the last episode survives (AGENTS.md §4), said out loud.
  const hadDraft = dirty.value
  const hadEpisode = fileEpisode.value
  clearDraft()
  scenes.value = []
  fileEpisode.value = ''
  loadError.value = ''
  readError.value = ''
  loading.value = true
  if (hadDraft && hadEpisode) showError('The previous episode’s unsaved effects changes were discarded.')
  if (!episodeId.value) { loading.value = false; return }
  const episode = episodeId.value
  try {
    const data = await get(`/projects/${slug.value}/effects-library/${episode}`)
    if (scope !== scopeSeq) return // a newer scope owns the panel now
    library.value = data.overlays || []
    scenes.value = data.scenes || []
    outlines.value = data.outlines || []
    loadedOutlines.value = [...(data.outlines || [])]
    hasScenePlan.value = !!data.has_scene_plan
    readError.value = data.read_error || ''
    Object.assign(file, emptyEffectsFile(), data.file || {})
    baseline.value = cloneEffectsFile(file)
    fileEpisode.value = episode
    const wanted = (props.sceneId && scenes.value.some(s => s.id === props.sceneId))
      ? props.sceneId
      : scenes.value[0]?.id || ''
    previewSceneId.value = wanted
    targetKey.value = wanted ? `scene:${wanted}` : 'episode'
  } catch (e: any) {
    if (scope === scopeSeq) loadError.value = e?.data?.detail || 'This episode’s effects could not be loaded. The backend may still be starting.'
  } finally {
    if (scope === scopeSeq) loading.value = false
  }
}

async function loadLibraryOnly(): Promise<void> {
  // Channel-level catalogue: fenced on the channel, not the episode scope.
  const channel = slug.value
  try {
    const data = await get(`/projects/${channel}/video-editor/effects/catalog`)
    if (channel !== slug.value || !alive) return
    // Channel-level catalogue (motions and overlays offered), not episode state.
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

/** Families with only the strengths this channel offers (E2–E4: picture-aware moves need scene analysis on). */
const visibleFamilies = computed(() => motionFamilies.value
  .map(f => ({ ...f, members: f.members.filter(m => sceneMotions.value.some(x => x.id === m.id)) }))
  .filter(f => f.members.length))

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

// ── Transitions (E1, 1.4.287) ─────────────────────────────────────────────────
interface TransitionEntry { id: string; label: string; category: string; hint?: string; engine?: string }
const transitions = ref<TransitionEntry[]>([])
const TRANSITION_GROUPS: Record<string, string> = { fade: 'Fades', wipe: 'Wipes', slide: 'Slides', shape: 'Shapes', effect: 'Effects' }
const transitionGroups = computed(() => Object.entries(TRANSITION_GROUPS)
  .map(([key, label]) => ({ label, items: transitions.value.filter(t => t.category === key && (!search.value.trim() || t.label.toLowerCase().includes(search.value.trim().toLowerCase()))) }))
  .filter(group => group.items.length))
function transitionClipUrl(id: string): string {
  const ep = episodeId.value ? `&episode=${encodeURIComponent(episodeId.value)}` : ''
  return `/api/projects/${encodeURIComponent(slug.value)}/video-editor/preview-transition?type=${encodeURIComponent(id)}&duration=1.50${ep}&g=${galleryNonce.value}`
}
const exactTransition = ref('')
const exactTransitionUrl = ref('')
const exactTransitionInfo = ref('')
async function renderExactTransition(id: string): Promise<void> {
  if (!episodeId.value) { showError('No episode is loaded here — the exact preview uses two of its scenes.'); return }
  const scope = scopeSeq
  const destSlug = slug.value
  const episode = episodeId.value
  const scene = previewSceneId.value || undefined
  exactTransition.value = id
  exactTransitionInfo.value = 'Rendering…'
  try {
    const result = await post(`/projects/${destSlug}/effects-library/${episode}/exact-preview`, {
      transition_id: id, scene_id: scene, motion_id: 'ken-burns',
    })
    if (scope !== scopeSeq || !alive || (previewSceneId.value || undefined) !== scene) return
    exactTransitionUrl.value = result.url
    exactTransitionInfo.value = `Rendered in ${(result.render_ms / 1000).toFixed(1)} s · ${result.width}×${result.height}, ${result.duration_sec} s · this scene into the next, through the render's own transition builder · camera: the slow zoom (Ken Burns).`
  } catch (e: any) {
    if (scope !== scopeSeq || !alive) return
    exactTransitionInfo.value = ''
    showError(e?.data?.detail || 'The exact preview could not be rendered.')
  }
}
async function loadTransitions(): Promise<void> {
  // Channel-level catalogue: fenced on the channel, not the episode scope.
  const channel = slug.value
  try {
    const data = await get(`/projects/${channel}/video-editor/transitions/catalog`)
    if (channel !== slug.value || !alive) return
    transitions.value = data.transitions || []
  } catch { /* the gallery's other tabs still work */ }
}

async function loadInUse(): Promise<void> {
  // Channel-level badges: fenced on the channel, not the episode scope.
  const channel = slug.value
  try {
    const data = await get(`/projects/${channel}/effects-library-in-use`)
    if (channel !== slug.value || !alive) return
    inUse.value = data
  } catch { /* badges are a convenience */ }
}

// ── Scene analysis (E2–E4): held in the draft, run only inside apply() ──────
interface AnalysisState {
  switches: { depth: boolean; vision: boolean }
  models: { depth: string; vision: string }
  status: { state: string; total: number; done: number; failed: number; left: number; message: string }
  scenes: Array<{ scene_id: string; analysed: boolean; has_image: boolean; stale: boolean }>
}
const analysis = reactive<AnalysisState>({
  switches: { depth: false, vision: false },
  models: { depth: '', vision: '' },
  status: { state: 'idle', total: 0, done: 0, failed: 0, left: 0, message: '' },
  scenes: [],
})
/** The switch state this dialog shows: the queued change if one is waiting, else the channel's. */
const pendingSwitches = ref<{ depth: boolean; vision: boolean } | null>(null)
const shownSwitches = computed(() => pendingSwitches.value ?? analysis.switches)
const analysisBusy = computed(() => analysis.status.state === 'running' || analysis.status.state === 'queued')
const analyseQueued = computed(() => ops.value.some(op => op.kind === 'analyse'))
const analysisLine = computed(() => {
  if (!shownSwitches.value.depth && !shownSwitches.value.vision) return 'Off for this channel: no picture is analysed and these moves and effects are hidden.'
  const withImage = analysis.scenes.filter(s => s.has_image)
  const done = withImage.filter(s => s.analysed).length
  const stale = withImage.filter(s => s.stale).length
  const run = analysis.status.message && analysis.status.state !== 'idle' ? ` ${analysis.status.message}` : ''
  return `${done} of ${withImage.length} scene picture(s) analysed${stale ? ` (${stale} with an older model, kept until re-analysed)` : ''}.${run}`
})
let analysisTimer: ReturnType<typeof setTimeout> | null = null
async function loadAnalysis(): Promise<void> {
  if (analysisTimer) { clearTimeout(analysisTimer); analysisTimer = null }
  const scope = scopeSeq
  const episode = episodeId.value
  if (!episode) return
  try {
    const data = await get(`/projects/${slug.value}/effects-library/${episode}/scene-analysis`)
    // Scope covers channel and episode: the same episode id on another channel is a different answer.
    if (scope !== scopeSeq || !alive) return
    Object.assign(analysis, data)
    if (analysisBusy.value && alive) analysisTimer = setTimeout(loadAnalysis, 3000)
  } catch { /* the card stays as it was */ }
}
function queueSwitch(key: 'depth' | 'vision', value: boolean): void {
  const next = { ...shownSwitches.value, [key]: value }
  pendingSwitches.value = next
  ops.value = [...ops.value.filter(op => op.kind !== 'switches'), { kind: 'switches', switches: next }]
}
/** Queues the run (or takes it back) — nothing starts until the host applies. */
function toggleAnalyse(): void {
  if (applying.value) return
  if (!canEdit.value) return
  ops.value = analyseQueued.value
    ? ops.value.filter(op => op.kind !== 'analyse')
    : [...ops.value, { kind: 'analyse' }]
}

// ── Presets: listed and added in memory; save/delete queue for apply() ──────
const presetDraft = ref<Array<{ id: string; params?: Record<string, unknown> }>>([])
const presetOpts = {
  slug: slug.value,
  configKey: 'effect_stack',
  presetType: 'effect-stack' as const,
  snapshot: () => ({ effects: presetDraft.value }),
  apply: () => {},
  autoApplyOnLoad: false,
  builtInPresets: BUILT_IN_EFFECT_STACKS.map(stack => ({ id: stack.id, name: stack.name, data: { effects: stack.effects, description: stack.description }, builtin: true, type: 'effect-stack' as const })),
}
const stackPresets = usePresets<{ effects: Array<{ id: string; params?: Record<string, unknown> }> }>(presetOpts)
// usePresets reads opts.slug when it runs: keep it on the live channel and
// re-read that channel's presets when the host points the panel elsewhere.
watch(slug, value => {
  presetOpts.slug = value
  void stackPresets.load()
})
const savePresetFor = ref<'effect' | 'stack' | null>(null)
const presetName = ref('')
const pendingDeletes = ref<string[]>([])

function openSavePreset(kind: 'effect' | 'stack'): void {
  savePresetFor.value = kind
  presetName.value = kind === 'effect' ? (selectedEntry.value?.name || '') : ''
}

function savePreset(): void {
  if (applying.value) return
  const name = presetName.value.trim()
  if (!name) return
  let effects: Array<{ id: string; params?: Record<string, unknown> }>
  if (savePresetFor.value === 'effect') {
    if (!selectedEntry.value) return
    const params = editingRow.value ? editingRow.value.applied.params : draftParams.value
    effects = [{ id: selectedEntry.value.id, ...(params && Object.keys(params).length ? { params: { ...params } } : {}) }]
  } else {
    effects = presetItemsFromRows(rows.value)
  }
  ops.value = [...ops.value, { kind: 'preset-save', name, effects }]
  savePresetFor.value = null
  presetName.value = ''
  success(`Preset “${name}” will be saved when you apply.`)
}

function presetDescription(preset: { data: any }): string {
  if (preset.data?.description) return preset.data.description
  const names = (preset.data?.effects || []).map((item: any) => library.value.find(e => e.id === item.id)?.name || item.id)
  return names.join(' · ')
}

function applyPreset(preset: { name: string; data: any }): void {
  if (applying.value) return
  const items = (preset.data?.effects || []).filter((item: any) => library.value.some(e => e.id === item.id))
  const missing = (preset.data?.effects || []).length - items.length
  addEffects(file, currentTarget.value, items)
  success(`${preset.name}: ${items.length} effect${items.length === 1 ? '' : 's'} added to ${targetName.value.toLowerCase()}.`
    + (missing ? ` ${missing} not in this library (an uninstalled pack) and left out.` : ''))
}

function deletePreset(preset: { id: string; name: string }): void {
  if (applying.value) return
  if (pendingDeletes.value.includes(preset.id)) return
  pendingDeletes.value = [...pendingDeletes.value, preset.id]
  ops.value = [...ops.value, { kind: 'preset-delete', preset_id: preset.id, name: preset.name }]
}

// ── Apply / cancel: the only write paths ────────────────────────────────────
/** Every write addresses the destination captured when apply() started; late answers never touch the current analysis. */
async function runWriteOp(op: EpisodeEffectsWriteOp, dest: { slug: string; episode: string; scope: number }): Promise<void> {
  if (op.kind === 'switches') {
    const data = await put(`/projects/${dest.slug}/scene-analysis/switches`, op.switches)
    if (dest.scope !== scopeSeq || !alive) return
    analysis.switches = data.switches
    return
  }
  if (op.kind === 'analyse') {
    const data = await post(`/projects/${dest.slug}/effects-library/${dest.episode}/scene-analysis`, {})
    if (dest.scope !== scopeSeq || !alive) return
    analysis.status = data.status
    analysisTimer = setTimeout(loadAnalysis, 1500)
    return
  }
  if (op.kind === 'preset-save') {
    presetDraft.value = op.effects
    await stackPresets.saveAs(op.name)
    return
  }
  await stackPresets.setActive(op.preset_id)
  await stackPresets.remove()
}

/** The moves and effects offered follow the switches — re-read them after apply. */
async function refreshAfterSwitches(scope: number): Promise<void> {
  try {
    const catalog = await get(`/projects/${slug.value}/video-editor/effects/catalog`)
    if (scope !== scopeSeq || !alive) return
    sceneMotions.value = catalog.scene_motions || []
    if (episodeId.value) {
      const data = await get(`/projects/${slug.value}/effects-library/${episodeId.value}`)
      if (scope !== scopeSeq || !alive) return
      library.value = data.overlays || []
    } else {
      library.value = catalog.overlays || []
    }
    await loadAnalysis()
  } catch { /* the panel keeps its current catalog */ }
}

/**
 * The host's Apply: flush the queued side-writes, PUT the episode file
 * through the existing endpoint, then reset the draft. On failure the draft
 * stays exactly as it is and the error shows in the status line — nothing is
 * half-cleared, and a retry re-runs only what has not succeeded yet.
 *
 * The channel, episode and scope are captured once, before the first await:
 * every request addresses that destination and every state write after an
 * await is fenced, so a scope change stops the run instead of carrying the
 * old draft into the new episode. Draft mutators refuse while applying, so
 * nothing can arrive between this submission and the save that marks it clean.
 */
async function apply(): Promise<{ ok: boolean; error?: string }> {
  if (loading.value) return { ok: false, error: 'this episode’s effects are still loading' }
  if (applying.value) return { ok: false, error: 'an apply is already running' }
  if (!dirty.value) return { ok: true }
  const scope = scopeSeq
  const destSlug = slug.value
  const episode = fileEpisode.value
  const plan = planOps(file, ops.value)
  applying.value = true
  applyError.value = ''
  try {
    // 1. Outline uploads first: the file references their masks by placeholder.
    if (plan.outlines.length && !episode) return { ok: false, error: 'no episode is loaded for the outline' }
    for (const op of plan.outlines) {
      const body = op.data_base64 !== undefined
        ? { scene_id: op.scene_id, label: op.label, data_base64: op.data_base64 }
        : { scene_id: op.scene_id, label: op.label, shapes: op.shapes, feather_px: op.feather_px }
      const result = await post(`/projects/${destSlug}/effects-library/${episode}/outlines`, body)
      if (scope !== scopeSeq || !alive) return { ok: false, error: 'the episode changed while applying' }
      outlines.value = adoptMasks(file, outlines.value, { [op.placeholder]: result.mask })
      const nextLabels = { ...pendingOutlineLabels.value }
      delete nextLabels[op.placeholder]
      pendingOutlineLabels.value = nextLabels
      ops.value = ops.value.filter(queued => queued !== op)
    }
    // 2. The file itself — same shape, same compaction, same endpoint as the page.
    if (episode) {
      await put(`/projects/${destSlug}/effects-library/${episode}`, applyFilePayload(file))
      if (scope !== scopeSeq || !alive) return { ok: false, error: 'the episode changed while applying' }
    }
    // 3. The remaining writes, in planOps' fixed order.
    const ran = new Set<EpisodeEffectsWriteOp['kind']>()
    for (const op of plan.writes) {
      if (scope !== scopeSeq || !alive) return { ok: false, error: 'the episode changed while applying' }
      await runWriteOp(op, { slug: destSlug, episode, scope })
      ran.add(op.kind)
      ops.value = ops.value.filter(queued => queued !== op)
    }
    if (scope !== scopeSeq || !alive) return { ok: false, error: 'the episode changed while applying' }
    // An upload the file stopped referencing never happened — take its name back out of the list.
    const droppedOutlines = Object.keys(pendingOutlineLabels.value)
    if (droppedOutlines.length) outlines.value = outlines.value.filter(name => !droppedOutlines.includes(name))
    baseline.value = cloneEffectsFile(file)
    loadedOutlines.value = [...outlines.value]
    pendingOutlineLabels.value = {}
    pendingSwitches.value = null
    pendingDeletes.value = []
    ops.value = []
    applyError.value = ''
    if (episode) success('Effects saved with this episode. Video Assembly uses it on the next render.')
    if (ran.has('switches')) void refreshAfterSwitches(scope)
    return { ok: true }
  } catch (e: any) {
    const message = e?.data?.detail || e?.message || 'the save failed'
    // A failure that arrived after the scope moved belongs to the old draft, not the new one.
    if (scope === scopeSeq && alive) applyError.value = message
    return { ok: false, error: message }
  } finally {
    applying.value = false
  }
}

/** The host's Cancel: back to the loaded file, side-writes dropped. */
function cancel(): void {
  if (applying.value) return
  Object.assign(file, emptyEffectsFile(), baseline.value)
  ops.value = []
  outlines.value = [...loadedOutlines.value]
  pendingOutlineLabels.value = {}
  pendingSwitches.value = null
  pendingDeletes.value = []
  applyError.value = ''
  finishEditing()
  exactUrl.value = ''
  draftParams.value = {}
  draftFades.in = DEFAULT_SCENE_FADE_SEC
  draftFades.out = DEFAULT_SCENE_FADE_SEC
}

defineExpose({ apply, cancel })

watch(() => `${props.projectSlug}\u0000${props.episodeId}`, () => {
  void load()
  void loadAnalysis()
})

onMounted(() => {
  raf = requestAnimationFrame(frame)
  stackPresets.load()
  void loadLibraryOnly()
  void loadInUse()
  void loadTransitions()
  if (episodeId.value) { void load(); void loadAnalysis() }
})
onBeforeUnmount(() => {
  alive = false
  cancelAnimationFrame(raf)
  if (analysisTimer) clearTimeout(analysisTimer)
  // Deliberately no save flush: leaving without apply() is a cancel.
})
</script>

<style scoped>
.fx-panel { min-width: 0; }
.fx-panel-head { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; justify-content: space-between; }
.fx-panel-intro { margin: 0; max-width: 72ch; font-size: 13px; color: var(--text-secondary); }
.fx-hero-tools { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; min-width: 0; max-width: 100%; }
.fx-search { box-sizing: border-box; width: 220px; max-width: 100%; }
.fx-seg { display: inline-flex; flex-wrap: wrap; max-width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.fx-seg button { padding: 6px 12px; font-size: 12.5px; color: var(--text-secondary); background: none; border: 0; border-right: 1px solid var(--border); cursor: pointer; }
.fx-seg button:last-child { border-right: 0; }
.fx-seg button.on { background: var(--accent); color: var(--accent-on); font-weight: 600; }

.fx-context { display: grid; grid-template-columns: repeat(3, minmax(200px, 1fr)); gap: 14px; align-items: start; margin-top: 14px; }
.fx-context-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.fx-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.fx-save-state span[data-tone='error'] { color: var(--danger, #e66); }
.fx-save-state span[data-tone='pending'] { color: var(--warning, #e9b949); }
.fx-save-state span[data-tone='success'] { color: var(--text-secondary); }
.fx-analysis { display: flex; flex-wrap: wrap; gap: 10px 18px; align-items: center; margin-top: 14px; }
.fx-analysis-head { display: flex; flex-direction: column; gap: 2px; flex: 1 1 100%; min-width: 0; }
.fx-analysis-head small { color: var(--text-secondary); }
.fx-switch { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; }
.fx-analysis-run { display: flex; align-items: center; gap: 10px; flex: 1 1 320px; min-width: 0; }
.fx-analysis-warn { flex: 1 1 100%; margin: 0; }
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
@media (max-width: 680px) {
  .fx-context { grid-template-columns: minmax(0, 1fr); }
  .fx-analysis-run, .fx-preset-list li { flex-wrap: wrap; }
  .fx-param { grid-template-columns: 90px minmax(0, 1fr) 64px; gap: 6px; }
  .fx-inline { flex-wrap: wrap; }
}
</style>
