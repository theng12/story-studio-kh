<template>
  <div class="workspace-page sound-labels-workspace">
    <WorkspaceHero
      eyebrow="Editorial · Optional"
      title="Sound & Labels"
      description="The words and the sounds that sit over your finished narration. Approve what you want; everything you leave alone is simply not drawn or mixed."
    >
      <template #aside>
        <div class="workspace-metrics">
          <span class="workspace-metric"><strong>{{ labelApproved }}</strong> labels</span>
          <span class="workspace-metric"><strong>{{ soundApproved }}</strong> sounds</span>
          <span class="workspace-metric" :data-tone="waitingCount ? 'warning' : 'success'"><strong>{{ waitingCount }}</strong> to review</span>
        </div>
      </template>
    </WorkspaceHero>

    <div class="workspace-command-surface">
      <TopActionBar
        :project-slug="slug"
        v-model:episode-id="episodeId"
        filter-field="scene_plan"
        :presets="activePresets"
        generate-label="Propose labels & sounds"
        generate-loading-label="Proposing…"
        :generate-loading="proposing || jobActive"
        :generate-disabled="!config.on_screen_text || !episodeId || !form.model"
        :generate-status="proposalStatus"
        @generate="propose"
      />
    </div>

    <!-- ── The two switches ─────────────────────────────────────────────── -->
    <section class="card sl-switches">
      <div class="sl-switch-copy">
        <span class="section-kicker">What this channel uses</span>
        <h2>On-screen text and sound</h2>
        <p>
          Two independent layers. Turn one off and the episode renders exactly as it did
          before that layer existed. Neither is ever a reason to refuse a render: what you
          approve is drawn or mixed, and everything else is reported.
        </p>
      </div>
      <div class="sl-switch-row">
        <label class="sl-switch">
          <input
            type="checkbox" :checked="config.on_screen_text" :disabled="savingConfig"
            @change="setSwitch('on_screen_text', ($event.target as HTMLInputElement).checked)"
          />
          <span>On-screen text<small>{{ config.on_screen_text ? 'Labels are drawn' : 'No labels' }}</small></span>
        </label>
        <label class="sl-switch">
          <input
            type="checkbox" :checked="config.sound" :disabled="savingConfig"
            @change="setSwitch('sound', ($event.target as HTMLInputElement).checked)"
          />
          <span>Sound<small>{{ config.sound ? 'Beds and spots are mixed' : 'Narration only' }}</small></span>
        </label>
      </div>
    </section>

    <section class="card sl-transitions">
      <h2>Transition sounds</h2>
      <p>Automatically plays a short sound at each scene change. Separate from scene sound effects; no review is needed.</p>
      <div v-if="transitionError" role="alert">{{ transitionError }}</div>
      <div class="sl-transition-controls">
        <label><input type="checkbox" :checked="transitionChannel.enabled" @change="saveTransitionChannel({ enabled: ($event.target as HTMLInputElement).checked })" /> On for this channel</label>
        <label>Channel set <select class="select" :value="transitionChannel.set_id" @change="saveTransitionChannel({ set_id: ($event.target as HTMLSelectElement).value })"><option v-for="set in transitionSets.filter(s => s.enabled)" :key="set.id" :value="set.id">{{ set.name }}</option></select></label>
        <template v-if="episodeId">
          <label>Episode <select class="select" :value="transitionOverride.enabled === undefined ? 'channel' : String(transitionOverride.enabled)" @change="setTransitionEnabled(($event.target as HTMLSelectElement).value)"><option value="channel">Follow channel</option><option value="true">On</option><option value="false">Off</option></select></label>
          <label>Episode set <select class="select" :value="transitionOverride.set_id || ''" @change="saveTransitionOverride({ set_id: ($event.target as HTMLSelectElement).value || undefined })"><option value="">Follow channel</option><option v-for="set in transitionSets.filter(s => s.enabled)" :key="set.id" :value="set.id">{{ set.name }}</option></select></label>
          <label>Volume (dB, -45 to -3) <input class="input" type="number" min="-45" max="-3" :value="transitionEffective.gain_db" @change="saveTransitionOverride({ gain_db: Number(($event.target as HTMLInputElement).value) })" /></label>
          <button class="btn btn-secondary btn-sm" @click="saveTransitionOverride({ shuffle: (transitionOverride.shuffle || 0) + 1 })">Shuffle sounds</button>
        </template>
      </div>
      <p v-if="selectedTransitionSet">{{ selectedTransitionSet.clips.length }} clips in {{ selectedTransitionSet.name }}<span v-if="!selectedTransitionSet.clips.length"> — this set is empty, so nothing will play.</span></p>
      <p v-for="missing in selectedTransitionSet?.missing || []" :key="missing" role="status">Pinned sound unavailable: {{ missing }}</p>
      <p v-for="note in transitionNotes" :key="note">{{ note }}</p>
      <div v-if="selectedTransitionSet?.clips.length"><button class="btn btn-secondary btn-sm" @click="playTransition(selectedTransitionSet.clips[0]!)">Hear a sample</button></div>
      <details v-if="selectedTransitionSet"><summary>Choose sounds in this set</summary><div v-for="clip in transitionClips" :key="transitionKey(clip)" class="sl-transition-clip"><span>{{ clip.label }}</span><button class="btn btn-secondary btn-sm" @click="playTransition(clip)">Play</button><button class="btn btn-secondary btn-sm" @click="toggleTransitionClip(clip)">{{ selectedTransitionSet.clips.some(c => transitionKey(c) === transitionKey(clip)) ? 'Remove' : 'Pin' }}</button></div></details>
    </section>

    <WorkspaceNotice v-if="!config.on_screen_text && !config.sound" tone="info" title="Both layers are off">
      Pick an episode and save a preset whenever you like. Turn a layer on only when its
      approved items should become part of the finished video.
    </WorkspaceNotice>

    <template v-else>
      <!-- A read REPORTS what the renderer would refuse; it never hides the rows
           behind the refusal. This is the renderer's own sentence, said before
           the render rather than after it. -->
      <WorkspaceNotice v-if="refusedNote" tone="warning" title="Final Video will not use these yet">
        {{ refusedNote }}
      </WorkspaceNotice>
      <WorkspaceNotice v-if="loadError" tone="warning" :title="/Scene Plan/.test(loadError) ? 'Sound & Labels needs a Scene Plan' : 'This episode could not be opened'">
        {{ loadError }}
      </WorkspaceNotice>
      <WorkspaceNotice v-else-if="loading" tone="info" title="Loading this episode…" />
      <WorkspaceNotice v-else-if="movedNotes.length" tone="info" title="Some items moved with their scene">
        <span v-for="(line, i) in movedNotes" :key="i" class="sl-issue">• {{ line }}</span>
        <button class="btn btn-sm btn-secondary sl-accept" @click="acceptMoves">Keep these times</button>
      </WorkspaceNotice>

      <!-- ── Proposal setup (advanced) ──────────────────────────────────── -->
      <section class="card sl-setup">
        <div>
          <span class="section-kicker">Proposal setup</span>
          <h2>Where labels and sounds come from</h2>
          <p>Saved in presets. The model only proposes; it never changes your narration or approved timing.</p>
        </div>
        <div class="sl-setup-controls">
          <ModelSelector v-model="form.model" :project-slug="slug" writing-step label="Proposal model" />
          <label>Density
            <select v-model="form.density" class="select">
              <option value="restrained">Restrained — only key orientation</option>
              <option value="standard">Standard — useful context</option>
              <option value="editorial">Editorial — more frequent labels</option>
            </select>
          </label>
          <label>Default corner
            <select v-model="form.placement" class="select">
              <option v-for="corner in CORNERS" :key="corner" :value="corner">{{ cornerLabel(corner) }}</option>
            </select>
          </label>
          <label class="sl-auto-approve">
            <input v-model="form.auto_approve" type="checkbox" @change="onAutoApproveEdited" />
            <span>
              <strong>Auto-approve safe labels</strong>
              <small>Off by default. A label must still pass the same checks as manual review; one that fails waits here for you. Sounds are NEVER auto-approved.</small>
            </span>
          </label>
          <WorkspaceNotice
            v-if="autoApproveNotice"
            class="sl-auto-approve-notice"
            :tone="autoApproveNotice.on ? 'warning' : 'info'"
            :title="autoApproveNotice.on
              ? (autoApproveNotice.changed ? 'That preset switched on Auto-approve safe labels' : 'That preset keeps Auto-approve safe labels on')
              : (autoApproveNotice.changed ? 'That preset switched off Auto-approve safe labels' : 'That preset keeps Auto-approve safe labels off')"
          >
            A preset carries this setting along with the model and density, so choosing one for
            its model changes this too. {{ autoApproveNotice.on
              ? 'Labels that pass every check will be approved without you looking at them — sounds never are.'
              : 'Every proposed label will wait for your approval.' }}
            Untick or tick it above to change it; save over the preset to keep that.
          </WorkspaceNotice>
        </div>
      </section>

      <!-- ── The one list ───────────────────────────────────────────────── -->
      <section v-if="timelineRows" class="card sl-list">
        <div class="sl-list-heading">
          <div><span class="section-kicker">Timeline</span><h2>{{ timelineRows.length }} item{{ timelineRows.length === 1 ? '' : 's' }}</h2></div>
          <div class="sl-list-actions">
            <span class="sl-save-state" :data-state="saveState" role="status">{{ saveStateLabel }}</span>
            <button v-if="proposedLabels.length" class="btn btn-secondary btn-sm" :disabled="saving || jobActive" title="Approves the labels still awaiting review. Sounds and anything you turned off are left alone." @click="approveAllLabels">Approve all {{ proposedLabels.length }} labels</button>
            <button class="btn btn-secondary btn-sm" :disabled="saving" @click="saveNow(true)">Save changes</button>
          </div>
        </div>
        <p v-if="jobActive" class="sl-job-lock" role="status">A proposal is running — edits are paused until it finishes.</p>
        <p v-if="!timelineRows.length" class="text-muted">Nothing here yet. That is valid — this episode will render exactly as it does now.</p>

        <ol v-else class="sl-timeline">
          <li v-for="row in timelineRows" :key="row.key" class="sl-row" :class="[`is-${row.status}`, `is-${row.side}`]">
            <div class="sl-time">{{ time(row.start_sec) }}<template v-if="row.end_sec !== undefined">–{{ time(row.end_sec) }}</template></div>
            <div class="sl-what">
              <span class="sl-badge" :class="`sl-badge-${row.side}`">{{ row.side === 'label' ? 'Label' : row.kind === 'bed' ? 'Bed' : 'Spot' }}</span>
              <strong>{{ row.title || (row.side === 'label' ? 'Untitled label' : 'Untitled sound') }}</strong>
              <span v-if="row.side === 'label' && row.subtitle" class="sl-subtitle">{{ row.subtitle }}</span>
              <span v-if="row.side === 'sound' && row.credit" class="sl-credit">{{ creditLine(row.credit) }}</span>
            </div>
            <div class="sl-scene" :title="row.scene_id ? `Scene ${row.scene_id}` : 'No scene — these times are absolute'">
              {{ sceneLabel(row.scene_id) }}
            </div>
            <div class="sl-status" :data-tone="row.status === 'approved' ? 'success' : row.status === 'disabled' || row.status === 'excluded' ? 'muted' : 'warning'">
              {{ statusLabel(row) }}
            </div>
            <div class="sl-row-actions">
              <button
                v-if="row.side === 'sound' && row.clip"
                class="btn btn-sm btn-secondary sl-play" :class="{ 'is-playing': playing === row.key }"
                :title="playing === row.key ? 'Stop' : 'Play this sound'"
                @click="togglePlay(row)"
              >{{ playing === row.key ? '■' : '▶' }}</button>
              <button
                v-if="row.status !== 'approved'"
                class="btn btn-sm btn-primary" :disabled="row.side === 'sound' && !row.clip"
                :title="row.side === 'sound' && !row.clip ? 'Choose a sound first' : 'Draw / mix this item'"
                @click="setStatus(row, row.side === 'label' ? 'approved' : 'approved')"
              >Approve</button>
              <button v-else class="btn btn-sm btn-secondary" @click="setStatus(row, row.side === 'label' ? 'proposed' : 'proposed')">Unapprove</button>
              <button class="btn btn-sm btn-secondary" @click="setStatus(row, row.side === 'label' ? 'disabled' : 'excluded')">Turn off</button>
            </div>

            <p v-for="(issue, i) in rowNotes(row)" :key="i" class="sl-note">{{ issue }}</p>

            <!-- A label card: text + corner + sound-with-this-label. Everything else under Advanced. -->
            <div v-if="row.side === 'label'" class="sl-editor">
              <div class="sl-editor-main">
                <input v-model="row.cue.title" class="input" maxlength="80" placeholder="Main label" @input="markDirty()" />
                <input v-model="row.cue.subtitle" class="input" maxlength="100" placeholder="Optional second line" @input="markDirty()" />
                <select
                  class="select select-sm" :value="hasPreciseCuePosition(row.cue) ? '' : row.cue.placement"
                  :title="ignoresCorner(row.cue) ? 'A chapter plate is drawn centred, so the corner does not move it.' : 'Quick corner preset'"
                  @change="useCueCorner(row.cue, ($event.target as HTMLSelectElement).value as any)"
                >
                  <option v-if="hasPreciseCuePosition(row.cue)" value="" disabled>Placed by hand</option>
                  <option v-for="corner in CORNERS" :key="corner" :value="corner">{{ cornerLabel(corner) }}</option>
                </select>
                <label class="sl-inline-check" :title="soundForLabel(row.cue) ? 'This label already has a sound on the same moment.' : 'Adds a sound proposal that plays while this label is on screen.'">
                  <input
                    type="checkbox" :checked="!!soundForLabel(row.cue)" :disabled="!config.sound"
                    @change="toggleSoundWithLabel(row.cue, ($event.target as HTMLInputElement).checked)"
                  />
                  <span>Sound with this label</span>
                </label>
              </div>
              <AdvancedDisclosure label="Advanced" :persist-key="`sl-advanced-${slug}`">
                <div class="sl-advanced">
                  <label>Scene
                    <select
                      class="select select-sm" :value="row.cue.scene_id"
                      @change="setLabelScene(row.cue, ($event.target as HTMLSelectElement).value)"
                    >
                      <option v-for="scene in scenes" :key="scene.id" :value="scene.id">{{ sceneOption(scene) }}</option>
                    </select>
                  </label>
                  <label>Starts on the words
                    <input :value="row.cue.anchor_word || ''" class="input" maxlength="80" placeholder="e.g. the temple was built" @input="setAnchorWord(row.cue, ($event.target as HTMLInputElement).value)" />
                  </label>
                  <label>Kind
                    <select v-model="row.cue.kind" class="select select-sm" @change="markDirty()"><option value="location_date">Location / date</option><option value="historical_context">Historical context</option><option value="person">Person</option><option value="chapter">Chapter</option></select>
                  </label>
                  <label>Treatment
                    <select v-model="row.cue.template" class="select select-sm" @change="markDirty()"><option value="documentary-label">Documentary label</option><option value="map-pin">Location pin</option><option value="archival-caption">Archival caption</option><option value="chapter-plate">Chapter plate</option></select>
                  </label>
                  <label>Transition
                    <select :value="row.cue.entrance" class="select select-sm" @change="setTransition(row.cue, ($event.target as HTMLSelectElement).value)"><option value="fade">Fade</option><option value="dissolve">Dissolve</option><option value="slide">Slide</option></select>
                  </label>
                  <label>Start (s)
                    <input v-model.number="row.cue.start_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" />
                  </label>
                  <label>End (s)
                    <input v-model.number="row.cue.end_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" />
                  </label>
                  <label>Across (%)
                    <input class="input input-time" type="number" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5" :value="cuePosition(row.cue).xPct" @input="setCueAxis(row.cue, 'x', Number(($event.target as HTMLInputElement).value))" />
                  </label>
                  <label>Down (%)
                    <input class="input input-time" type="number" :min="CUE_SAFE_MARGIN_PCT" :max="100 - CUE_SAFE_MARGIN_PCT" step="0.5" :value="cuePosition(row.cue).yPct" @input="setCueAxis(row.cue, 'y', Number(($event.target as HTMLInputElement).value))" />
                  </label>
                </div>
                <div class="sl-label-preview">
                  <span class="sl-preview-caption">Preview over the real scene image</span>
                  <div class="sl-frame">
                    <!-- An image that fails to load falls back to the same
                         honest empty state as one that does not exist. A
                         broken-image icon would read as a bug, not as "this
                         scene has no picture yet". -->
                    <img
                      v-if="sceneImageUrl(row.cue.scene_id) && !failedPreviews.has(row.cue.scene_id)"
                      :src="sceneImageUrl(row.cue.scene_id)" alt="" class="sl-frame-image"
                      @error="failedPreviews.add(row.cue.scene_id); failedPreviews = new Set(failedPreviews)"
                    />
                    <div v-else class="sl-frame-empty">{{ sceneImageUrl(row.cue.scene_id) ? 'No scene image yet' : 'No scene chosen' }}</div>
                    <div class="sl-frame-cue" :class="`preview-${row.cue.template}`" :style="cueChipStyle(row.cue)">
                      <span>{{ row.cue.template === 'map-pin' ? '●' : row.cue.template === 'chapter-plate' ? 'CHAPTER' : row.cue.template === 'archival-caption' ? 'ARCHIVE' : 'CONTEXT' }}</span>
                      <strong>{{ row.cue.title || 'Cue title' }}</strong>
                      <small v-if="row.cue.subtitle">{{ row.cue.subtitle }}</small>
                    </div>
                  </div>
                </div>
              </AdvancedDisclosure>
            </div>

            <!-- A sound card: what, which clip, level, play. -->
            <div v-else class="sl-editor">
              <div class="sl-editor-main">
                <input v-model="row.cue.label" class="input" maxlength="120" placeholder="e.g. distant bells, page turn" @input="markDirty()" />
                <select class="select clip-picker" :value="clipKey(row.cue)" @change="chooseClip(row.cue, ($event.target as HTMLSelectElement).value)">
                  <option value="">— choose a sound —</option>
                  <optgroup v-for="group in pickerGroups" :key="group.label" :label="group.label">
                    <option v-for="option in group.options" :key="option.value" :value="option.value">{{ option.label }}</option>
                  </optgroup>
                </select>
                <button class="btn btn-sm btn-secondary" :disabled="searchingLibrary" @click="searchGateway(row)" title="Search the Gateway’s shared library — CC0 first, with the licence and author kept with the clip.">
                  {{ searchingLibrary ? 'Searching…' : 'Search Gateway library' }}
                </button>
              </div>
              <p v-if="!config.sound" class="sl-note">Sound is switched off for this project, so nothing here is mixed.</p>
              <WorkspaceNotice v-for="(reason, i) in unavailablePools" :key="`u${i}`" tone="warning" :title="`${reason.name} is unavailable`">
                {{ reason.reason }}. Its clips are not listed; nothing was removed.
              </WorkspaceNotice>
              <WorkspaceNotice v-if="libraryNote" tone="info" title="Gateway library">{{ libraryNote }}</WorkspaceNotice>
              <ul v-if="libraryHits.length" class="sl-hits">
                <li v-for="hit in libraryHits" :key="`${hit.source}:${hit.source_id}`">
                  <span class="sl-hit-title">{{ hit.title }}</span>
                  <span class="sl-hit-meta">{{ hit.author ? `by ${hit.author} · ` : '' }}{{ hit.licence.toUpperCase() }}</span>
                  <a v-if="hit.source_url" :href="hit.source_url" target="_blank" rel="noreferrer noopener" class="sl-hit-link">source</a>
                  <button class="btn btn-sm btn-secondary" @click="keepLibraryHit(row.cue as SoundCue, hit)">Use this</button>
                </li>
              </ul>
              <AdvancedDisclosure label="Advanced" :persist-key="`sl-advanced-${slug}`">
                <div class="sl-advanced">
                  <label>Kind
                    <select v-model="row.cue.kind" class="select select-sm" @change="onKindChange(row.cue)"><option value="bed">Ambient bed</option><option value="spot">Spot effect</option></select>
                  </label>
                  <label v-if="row.cue.kind === 'bed'">End (s)
                    <input v-model.number="row.cue.end_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" />
                  </label>
                  <label>Start (s)
                    <input v-model.number="row.cue.start_sec" class="input input-time" type="number" step="0.1" @input="markDirty()" />
                  </label>
                  <label>Level (dB)
                    <input v-model.number="row.cue.gain_db" class="input input-gain" type="number" min="-45" max="-3" step="1" @input="markDirty()" />
                  </label>
                  <label>Scene
                    <select class="select select-sm" :value="row.cue.scene_id || ''" @change="setSoundScene(row.cue, ($event.target as HTMLSelectElement).value)">
                      <option value="">— none (absolute time) —</option>
                      <option v-for="scene in scenes" :key="scene.id" :value="scene.id">{{ sceneOption(scene) }}</option>
                    </select>
                  </label>
                  <label>Starts on the words
                    <input :value="row.cue.anchor_word || ''" class="input" maxlength="80" placeholder="leave blank to keep absolute time" @input="setAnchorWord(row.cue, ($event.target as HTMLInputElement).value)" />
                  </label>
                </div>
              </AdvancedDisclosure>
            </div>
          </li>
        </ol>

        <!-- The mix settings, now actually honest about which ones do something. -->
        <AdvancedDisclosure label="Sound mix settings" :persist-key="`sl-mix-${slug}`">
          <!-- The mix is its own reusable preset: the levels, the spot cap and
               the ducking travel together and belong to no episode. The page
               mounts this controller for its values; without a picker there was
               no way to save or apply one. -->
          <PresetPicker
            class="sl-mix-presets"
            label="Sound mix preset"
            hint="Captures the levels, the per-minute spot cap and the ducking below."
            :presets="soundPresets.presets.value"
            :active-id="soundPresets.activeId.value"
            @update:active-id="soundPresets.setActive"
            @apply="soundPresets.applyActive(); success('Sound mix preset applied')"
            @overwrite="finishPreset(soundPresets.overwrite(), 'Sound mix preset saved')"
            @save-as="(n: string) => finishPreset(soundPresets.saveAs(n), 'Sound mix preset saved')"
            @rename="(n: string) => finishPreset(soundPresets.rename(n), `Renamed to ${n}`)"
            @delete="finishPreset(soundPresets.remove(), 'Sound mix preset deleted')"
          />
          <div class="sl-mix">
            <label>Maximum spots per minute
              <input v-model.number="settings.max_spots_per_minute" class="input" type="number" min="1" max="12" @input="markDirty()" />
              <small>Over this, the extra spots are left out of the mix and said so on the row.</small>
            </label>
            <label>Ambient bed level (dB)
              <input v-model.number="settings.default_bed_gain_db" class="input" type="number" min="-45" max="-6" step="1" @input="markDirty()" />
            </label>
            <label>Spot effect level (dB)
              <input v-model.number="settings.default_spot_gain_db" class="input" type="number" min="-35" max="-3" step="1" @input="markDirty()" />
            </label>
            <label>Bed ducking
              <select v-model="settings.ducking_profile" class="select" @change="markDirty()"><option value="gentle">Gentle — light narration protection</option><option value="standard">Standard — clearer narration</option><option value="strong">Strong — narration first</option></select>
            </label>
          </div>
        </AdvancedDisclosure>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { UNCONFIRMED_SUBMISSION } from '~/composables/useFreshGenerationAction'
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue'
import { storedPresetAutoApprove } from '../../../utils/contextual-cues.js'
import {
  CONTEXTUAL_CUE_CORNERS,
  CONTEXTUAL_CUE_CORNER_LABELS,
  CUE_SAFE_MARGIN_PCT,
  clampCuePct,
  hasPreciseCuePosition,
  isContextualCueCorner,
  nearestCueCorner,
  resolveContextualCuePosition,
  type ContextualCueCorner,
} from '@shared/contextual-cue-position'

definePageMeta({ layout: 'dashboard' })
useAppTitle('Sound & Labels')

type LabelStatus = 'proposed' | 'approved' | 'disabled'
type SoundStatus = 'proposed' | 'matched' | 'approved' | 'excluded'
type Credit = { licence: string; licence_version?: string; author?: string; source_url?: string; source?: string; title?: string }
type LabelCue = {
  id: string; scene_id: string; anchor_word?: string; anchor_offset_sec?: number
  start_sec: number; end_sec: number; title: string; subtitle?: string
  kind: 'location_date' | 'historical_context' | 'person' | 'chapter'; placement: ContextualCueCorner
  position_x_pct?: number | null; position_y_pct?: number | null
  template: 'documentary-label' | 'map-pin' | 'archival-caption' | 'chapter-plate'
  entrance: 'fade' | 'slide' | 'dissolve'; exit: 'fade' | 'slide' | 'dissolve'
  status: LabelStatus; created_at: string; updated_at: string
}
type SoundCue = {
  id: string; kind: 'bed' | 'spot'; label: string
  scene_id?: string; anchor_word?: string; anchor_offset_sec?: number
  start_sec: number; end_sec?: number
  source?: 'pool' | 'gateway'; pool_id?: string; clip: string; credit?: Credit
  gain_db: number; status: SoundStatus; created_at: string; updated_at: string
}
type LabelTimeline = { schema_version: 1 | 2; generated_at: string; source_scene_plan_generated_at: string; cues: LabelCue[]; auto_approval_holds?: Array<{ cue_id: string; reasons: string[] }> }
type SoundTimeline = { schema_version: 1 | 2; generated_at: string; source_scene_plan_generated_at: string; settings: Settings; cues: SoundCue[] }
type Settings = { max_spots_per_minute: number; default_bed_gain_db: number; default_spot_gain_db: number; ducking_profile: 'gentle' | 'standard' | 'strong' }
type Scene = { id: string; scene_index: number; start_sec: number; end_sec: number; transcript_segment: string }
type PoolClip = { source: 'pool'; pool_id: string; filename: string; tags: string[] }
type LibraryHit = { source: string; source_id: string; title: string; author?: string | null; licence: string; source_url?: string | null }
/**
 * One row. A DISCRIMINATED union on `side`, so a label row's `cue` is a
 * `LabelCue` and a sound row's is a `SoundCue` — the two shapes share a start
 * time and nothing else, and letting TypeScript see that keeps the two editors
 * from reading each other's fields.
 */
type Row = {
  key: string; status: string; start_sec: number; end_sec?: number; title: string
} & (
  | { side: 'label'; cue: LabelCue; subtitle?: string; scene_id?: string }
  | { side: 'sound'; cue: SoundCue; kind: 'bed' | 'spot'; scene_id?: string; clip?: string; credit?: Credit }
)
type ProbeForm = { model: string; density: 'restrained' | 'standard' | 'editorial'; placement: ContextualCueCorner; auto_approve: boolean }

const route = useRoute()
const slug = computed(() => String(route.params.slug))
const { get, post, put } = useApi()
const freshAction = useFreshGenerationAction()
const { success, info, error: showError, showAction } = useToast()
const { isJobActiveFor } = useJobs()

type TransitionClip = { source: 'pool' | 'gateway'; pool_id?: string; clip: string; label: string; tags: string[] }
type TransitionSet = { id: string; name: string; enabled: boolean; terms: string[]; pinned: TransitionClip[]; excluded: string[]; clips: TransitionClip[]; missing: string[] }
type TransitionSettings = { enabled: boolean; set_id: string; gain_db: number; shuffle?: number }
const transitionChannel = ref<TransitionSettings>({ enabled: false, set_id: 'mixed', gain_db: -12 })
const transitionEffective = ref<TransitionSettings>({ enabled: false, set_id: 'mixed', gain_db: -12 })
const transitionOverride = ref<Partial<TransitionSettings>>({})
const transitionSets = ref<TransitionSet[]>([])
const transitionClips = ref<TransitionClip[]>([])
const transitionNotes = ref<string[]>([])
const transitionError = ref('')
const selectedTransitionSet = computed(() => transitionSets.value.find(set => set.id === (episodeId.value ? transitionEffective.value.set_id : transitionChannel.value.set_id)))
const transitionKey = (clip: TransitionClip) => JSON.stringify([clip.source, clip.pool_id || '', clip.clip])
let transitionEpoch = 0
async function loadTransitions(): Promise<void> {
  const epoch = ++transitionEpoch
  const project = slug.value, episode = episodeId.value
  transitionOverride.value = {}
  transitionSets.value = []
  transitionClips.value = []
  transitionNotes.value = []
  transitionError.value = ''
  try {
    const base = `/projects/${encodeURIComponent(project)}/sound-and-labels`
    const [configResult, library, episodeResult] = await Promise.all([
      get<any>(`${base}/transitions/config`), get<any>(`${base}/transitions/library`),
      episode ? get<any>(`${base}/${encodeURIComponent(episode)}/transitions`) : Promise.resolve(null),
    ])
    if (epoch !== transitionEpoch) return
    transitionChannel.value = configResult.settings
    transitionSets.value = library.sets
    transitionClips.value = library.clips
    transitionNotes.value = library.notes
    transitionOverride.value = episodeResult?.override || {}
    transitionEffective.value = episodeResult?.settings || configResult.settings
  } catch (error: any) { if (epoch === transitionEpoch) transitionError.value = error?.data?.detail || error?.message || 'Could not load transition sounds.' }
}
async function saveTransitionChannel(settings: Partial<TransitionSettings>): Promise<void> {
  try { await put(`/projects/${encodeURIComponent(slug.value)}/sound-and-labels/transitions/config`, { settings }); await loadTransitions() }
  catch (error: any) { transitionError.value = error?.data?.detail || error?.message || 'Could not save channel settings.' }
}
async function saveTransitionOverride(patch: Partial<TransitionSettings>): Promise<void> {
  if (!episodeId.value) return
  try { await put(`/projects/${encodeURIComponent(slug.value)}/sound-and-labels/${encodeURIComponent(episodeId.value)}/transitions`, { ...transitionOverride.value, ...patch }); await loadTransitions() }
  catch (error: any) { transitionError.value = error?.data?.detail || error?.message || 'Could not save episode settings.' }
}
function setTransitionEnabled(value: string): void { void saveTransitionOverride({ enabled: value === 'channel' ? undefined : value === 'true' }) }
function playTransition(clip: TransitionClip): void {
  audio?.pause()
  const root = `/projects/${encodeURIComponent(slug.value)}/sound-and-labels/sounds`
  const url = clip.source === 'gateway' ? `${root}/library-audio/${encodeURIComponent(clip.clip)}` : `${root}/pool-audio/${encodeURIComponent(clip.pool_id || '')}/${encodeURIComponent(clip.clip)}`
  audio = new Audio(url)
  void audio.play().catch(() => showError(`Could not play ${clip.label}.`))
}
async function toggleTransitionClip(clip: TransitionClip): Promise<void> {
  const current = selectedTransitionSet.value
  if (!current) return
  const key = transitionKey(clip)
  const included = current.clips.some(item => transitionKey(item) === key)
  const sets = transitionSets.value.map(({ clips: _clips, missing: _missing, ...set }) => set.id === current.id ? {
    ...set,
    pinned: included ? set.pinned.filter(item => transitionKey(item) !== key) : [...set.pinned.filter(item => transitionKey(item) !== key), clip],
    excluded: included ? [...new Set([...set.excluded, key])] : set.excluded.filter(item => item !== key),
  } : set)
  try { await put(`/projects/${encodeURIComponent(slug.value)}/sound-and-labels/transitions/config`, { sets }); await loadTransitions() }
  catch (error: any) { transitionError.value = error?.data?.detail || error?.message || 'Could not save the set.' }
}

const episodeId = ref('')
const config = ref({ on_screen_text: false, sound: false })
const labels = ref<LabelTimeline | null>(null)
const sounds = ref<SoundTimeline | null>(null)
const scenes = ref<Scene[]>([])
const validation = ref<{ labels: Array<{ cue_id?: string; detail: string; severity?: string }>; sound: Array<{ cue_id?: string; detail: string; severity?: string }> }>({ labels: [], sound: [] })
const movedNotes = ref<string[]>([])
/** The renderer's own refusal sentence for a defect only a fix can clear. */
const refuses = ref<{ labels?: string; sound?: string }>({})
const refusedNote = computed(() => [refuses.value.labels, refuses.value.sound].filter(Boolean).join(' '))
const settings = ref<Settings>({ max_spots_per_minute: 3, default_bed_gain_db: -20, default_spot_gain_db: -12, ducking_profile: 'gentle' })
const poolClips = ref<PoolClip[]>([])
const unavailablePools = ref<Array<{ id: string; name: string; reason: string }>>([])
const libraryHits = ref<LibraryHit[]>([])
const libraryNote = ref('')
const searchingLibrary = ref(false)
const loadError = ref('')
const loading = ref(false)
const saving = ref(false)
const savingConfig = ref(false)
const dirty = ref(false)
useUnsavedGuard(dirty, 'labels and sound')
const savedAt = ref('')
const saveError = ref('')
const proposing = ref(false)
const playing = ref('')
/** Scene ids whose preview image did not load. Never retried on every render. */
const failedPreviews = ref<Set<string>>(new Set())
const form = ref<ProbeForm>({ model: '', density: 'restrained', placement: 'top-right', auto_approve: false })
useRememberedForm('sound-and-labels', slug, form, { include: ['model', 'density', 'placement', 'auto_approve'], version: 1 })
const autoApproveNotice = ref<{ on: boolean; changed: boolean } | null>(null)
function onAutoApproveEdited(): void { autoApproveNotice.value = null }

let scopeEpoch = 0
let projectEpoch = 0
let loadSequence = 0
const jobActive = computed(() => isJobActiveFor(episodeId.value, ['contextual_cues']))
const CORNERS = CONTEXTUAL_CUE_CORNERS
const cornerLabel = (corner: ContextualCueCorner): string => CONTEXTUAL_CUE_CORNER_LABELS[corner]

const timelineRows = computed<Row[] | null>(() => {
  if (!labels.value && !sounds.value) return null
  const rows: Row[] = []
  for (const cue of labels.value?.cues || []) {
    rows.push({ key: `l:${cue.id}`, side: 'label', cue, status: cue.status, start_sec: cue.start_sec, end_sec: cue.end_sec, title: cue.title, subtitle: cue.subtitle, scene_id: cue.scene_id })
  }
  for (const cue of sounds.value?.cues || []) {
    rows.push({
      key: `s:${cue.id}`, side: 'sound', cue, status: cue.status, start_sec: cue.start_sec,
      end_sec: cue.kind === 'bed' ? cue.end_sec : undefined, title: cue.label,
      kind: cue.kind, scene_id: cue.scene_id, clip: cue.clip, credit: cue.credit,
    })
  }
  // ONE list, in time order. A label and a sound on the same moment sit
  // together because that is what they are: two things happening at once.
  return rows.sort((a, b) => a.start_sec - b.start_sec || (a.side === 'label' ? -1 : 1))
})
const labelApproved = computed(() => labels.value?.cues.filter(cue => cue.status === 'approved').length || 0)
const soundApproved = computed(() => sounds.value?.cues.filter(cue => cue.status === 'approved').length || 0)
const proposedLabels = computed(() => labels.value?.cues.filter(cue => cue.status === 'proposed') || [])
const waitingCount = computed(() => proposedLabels.value.length + (sounds.value?.cues.filter(cue => cue.status === 'proposed' || cue.status === 'matched').length || 0))
const proposalStatus = computed(() => {
  if (!config.value.on_screen_text) return 'Turn on On-screen text first.'
  if (!episodeId.value) return 'Choose an episode with a Scene Plan.'
  if (!form.value.model) return 'Choose a live Gateway model.'
  return 'Proposes labels and, when Sound is on, sounds in the same pass. Approved items are left alone.'
})
const pickerGroups = computed(() => {
  const groups: Array<{ label: string; options: Array<{ value: string; label: string }> }> = []
  if (poolClips.value.length) {
    groups.push({
      label: 'Your sound folders',
      options: poolClips.value.map(clip => ({ value: `pool:${clip.pool_id}:${clip.filename}`, label: `${clip.filename}${clip.tags.length ? ` · ${clip.tags.join(', ')}` : ''}` })),
    })
  }
  // Every Gateway clip this episode already keeps, so a repeat pick is one
  // click and costs no second download.
  const kept = new Map<string, { title: string; author?: string; licence: string }>()
  for (const cue of sounds.value?.cues || []) {
    if (cue.source === 'gateway' && cue.clip && cue.credit) {
      kept.set(cue.clip, { title: cue.credit.title || cue.clip.slice(0, 12), author: cue.credit.author, licence: cue.credit.licence })
    }
  }
  if (kept.size) {
    groups.push({
      label: 'Already in the Gateway library',
      options: [...kept.entries()].map(([sha, meta]) => ({
        value: `gateway:${sha}`,
        label: `${meta.title}${meta.author ? ` · ${meta.author}` : ''} (${meta.licence.toUpperCase()})`,
      })),
    })
  }
  return groups
})

function time(value: number): string { const whole = Math.max(0, Math.floor(value || 0)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}` }
function sceneLabel(id?: string): string {
  if (!id) return '—'
  const scene = scenes.value.find(row => row.id === id)
  // An id the current plan no longer has is NAMED, not blanked: the cue is
  // orphaned, and an em dash would read as "this one has no scene".
  return scene ? `Scene ${scene.scene_index || scenes.value.indexOf(scene) + 1}` : 'Scene missing'
}
function sceneOption(scene: Scene): string { return `${scene.scene_index || scenes.value.indexOf(scene) + 1}. ${time(scene.start_sec)}–${time(scene.end_sec)}${scene.transcript_segment ? ` · ${scene.transcript_segment.slice(0, 40)}` : ''}` }
function sceneImageUrl(id?: string): string { return id ? `/api/projects/${encodeURIComponent(slug.value)}/scene-review/${encodeURIComponent(episodeId.value)}/image/${encodeURIComponent(id)}` : '' }
function creditLine(credit?: Credit): string {
  if (!credit) return ''
  return `${credit.title || ''}${credit.author ? ` by ${credit.author}` : ''} (${credit.licence.toUpperCase()}${credit.licence_version ? ` ${credit.licence_version}` : ''})`
}
function statusLabel(row: Row): string {
  if (row.side === 'label') return row.status === 'approved' ? 'drawn' : row.status === 'disabled' ? 'off' : 'waiting'
  if (row.status === 'approved') return 'mixed'
  if (row.status === 'excluded') return 'off'
  return row.clip ? 'ready to review' : 'choose a sound'
}
function rowNotes(row: Row): string[] {
  const notes: string[] = []
  const issues = row.side === 'label' ? validation.value.labels : validation.value.sound
  for (const issue of issues) if (issue.cue_id === row.cue.id) notes.push(issue.detail)
  return notes
}
function soundForLabel(cue: LabelCue): SoundCue | undefined {
  return sounds.value?.cues.find(sound => sound.scene_id === cue.scene_id && sound.status !== 'excluded'
    && Math.abs(sound.start_sec - cue.start_sec) < 0.75)
}
function cuePosition(cue: Pick<LabelCue, 'placement' | 'position_x_pct' | 'position_y_pct'>) { return resolveContextualCuePosition(cue) }
function cueChipStyle(cue: Pick<LabelCue, 'placement' | 'position_x_pct' | 'position_y_pct'>) {
  const { xPct, yPct } = cuePosition(cue)
  const tx = xPct <= 33 ? '0%' : xPct >= 67 ? '-100%' : '-50%'
  const ty = yPct <= 33 ? '0%' : yPct >= 67 ? '-100%' : '-50%'
  return { left: `${xPct}%`, top: `${yPct}%`, transform: `translate(${tx}, ${ty})` }
}
const ignoresCorner = (cue: LabelCue): boolean => cue.template === 'chapter-plate' && !hasPreciseCuePosition(cue)
function clipKey(cue: SoundCue): string { return cue.clip ? `${cue.source === 'gateway' ? 'gateway' : 'pool'}:${cue.source === 'gateway' ? cue.clip : `${cue.pool_id || ''}:${cue.clip}`}` : '' }

// ── Edits ────────────────────────────────────────────────────────────────

/** How long an edit waits before it is written. Named, so the figure is one place. */
const AUTO_SAVE_DELAY_MS = 800

function markDirty(): void { dirty.value = true; editSeq += 1; if (autoSaveTimer) clearTimeout(autoSaveTimer); autoSaveTimer = setTimeout(() => { autoSaveTimer = null; void saveNow(false) }, AUTO_SAVE_DELAY_MS) }

function setLabelScene(cue: LabelCue, sceneId: string): void {
  const scene = scenes.value.find(row => row.id === sceneId)
  if (!scene) return
  // §4: an episode change replaces or blanks — a SCENE change is the same rule
  // one level down. The label moves into the new scene's window rather than
  // keeping absolute seconds that now point outside it.
  const duration = Math.max(2.25, Math.min(cue.end_sec - cue.start_sec, scene.end_sec - scene.start_sec))
  cue.scene_id = scene.id
  cue.anchor_offset_sec = 0.15
  cue.start_sec = Number((scene.start_sec + 0.15).toFixed(3))
  cue.end_sec = Number((cue.start_sec + duration).toFixed(3))
  markDirty()
}
function setSoundScene(cue: SoundCue, sceneId: string): void {
  if (!sceneId) { cue.scene_id = undefined; markDirty(); return }
  const scene = scenes.value.find(row => row.id === sceneId)
  if (!scene) return
  cue.scene_id = scene.id
  cue.anchor_offset_sec = 0.15
  cue.start_sec = Number((scene.start_sec + 0.15).toFixed(3))
  if (cue.kind === 'bed') cue.end_sec = Number(Math.min(scene.end_sec, cue.start_sec + 20).toFixed(3))
  markDirty()
}
function setAnchorWord(cue: LabelCue | SoundCue, value: string): void {
  const word = value.trim()
  if (word) cue.anchor_word = word
  else delete cue.anchor_word
  markDirty()
}
function setCuePosition(cue: LabelCue, xPct: number, yPct: number): void {
  cue.position_x_pct = Number(clampCuePct(xPct).toFixed(1))
  cue.position_y_pct = Number(clampCuePct(yPct).toFixed(1))
  cue.placement = nearestCueCorner(cue.position_x_pct, cue.position_y_pct)
  markDirty()
}
function useCueCorner(cue: LabelCue, corner: ContextualCueCorner): void {
  cue.placement = corner; cue.position_x_pct = null; cue.position_y_pct = null; markDirty()
}
function setCueAxis(cue: LabelCue, axis: 'x' | 'y', value: number): void {
  const current = cuePosition(cue)
  setCuePosition(cue, axis === 'x' ? value : current.xPct, axis === 'y' ? value : current.yPct)
}
function setTransition(cue: LabelCue, value: string): void {
  const transition = value === 'slide' || value === 'dissolve' ? value : 'fade'
  cue.entrance = transition; cue.exit = transition; markDirty()
}
function setStatus(row: Row, status: string): void {
  if (row.side === 'label') (row.cue as LabelCue).status = status as LabelStatus
  else (row.cue as SoundCue).status = status as SoundStatus
  markDirty()
}
function onKindChange(cue: SoundCue): void {
  if (cue.kind === 'bed' && !cue.end_sec) cue.end_sec = Number((cue.start_sec + 20).toFixed(3))
  if (cue.kind === 'spot') delete cue.end_sec
  cue.status = cue.clip ? 'matched' : 'proposed'
  markDirty()
}
function approveAllLabels(): void {
  for (const cue of proposedLabels.value) cue.status = 'approved'
  success(`Approved ${proposedLabels.value.length} label${proposedLabels.value.length === 1 ? '' : 's'}. Sounds and anything you turned off were left alone.`)
  markDirty()
}

/** Add (or drop) the sound that goes with one label. */
function toggleSoundWithLabel(cue: LabelCue, on: boolean): void {
  const existing = soundForLabel(cue)
  if (!on) {
    if (existing) existing.status = 'excluded'
    markDirty()
    return
  }
  if (existing) { existing.status = 'proposed'; markDirty(); return }
  const timeline = ensureSounds()
  timeline.cues.push({
    id: `sound-${cue.id}-${Date.now()}`,
    kind: 'spot', label: cue.title || 'Sound with this label',
    scene_id: cue.scene_id,
    ...(cue.anchor_word ? { anchor_word: cue.anchor_word } : {}),
    anchor_offset_sec: cue.anchor_offset_sec ?? 0.15,
    start_sec: cue.start_sec,
    source: 'pool', clip: '',
    gain_db: settings.value.default_spot_gain_db,
    status: 'proposed', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  markDirty()
}

async function chooseClip(cue: SoundCue, value: string): Promise<void> {
  if (!value) { cue.clip = ''; cue.pool_id = undefined; cue.source = 'pool'; cue.credit = undefined; cue.status = 'proposed'; markDirty(); return }
  const [kind, ...rest] = value.split(':')
  if (kind === 'pool') {
    const [poolId, ...name] = rest
    cue.source = 'pool'; cue.pool_id = poolId; cue.clip = name.join(':'); cue.credit = undefined; cue.status = 'matched'; markDirty(); return
  }
  // A kept Gateway clip: the credit is the one the Gateway answered when it was
  // downloaded, read off the cue that already used it. Nothing is inferred.
  const sha256 = rest.join(':')
  const source = (sounds.value?.cues || []).find(row => row.source === 'gateway' && row.clip === sha256)?.credit
  if (!source) { showError('That library sound is no longer on this episode. Search the library again.'); return }
  cue.source = 'gateway'; cue.pool_id = undefined; cue.clip = sha256; cue.credit = source; cue.status = 'matched'; markDirty()
}

async function searchGateway(row: Row): Promise<void> {
  if (row.side !== 'sound') return
  searchingLibrary.value = true
  libraryNote.value = ''
  try {
    const cue = row.cue as SoundCue
    const data = await get<any>(`/projects/${slug.value}/sound-and-labels/sounds/library?q=${encodeURIComponent(cue.label)}`)
    // Search hits are not yet files. `chooseClip` keeps the one picked, which
    // downloads it once and hands back the sha and the real credit.
    libraryHits.value = (data.results || []).map((result: any) => ({
      source: result.source, source_id: result.source_id, title: result.title,
      author: result.author, licence: result.licence, source_url: result.source_url,
    }))
    libraryNote.value = data.note || (libraryHits.value.length
      ? `${libraryHits.value.length} result(s) — pick one from the list below.`
      : '')
  } catch (cause: any) {
    libraryNote.value = cause?.data?.detail || 'The Gateway library could not be searched.'
  } finally { searchingLibrary.value = false }
}

async function keepLibraryHit(cue: SoundCue, hit: LibraryHit): Promise<void> {
  try {
    const kept = await post<any>(`/projects/${slug.value}/sound-and-labels/${episodeId.value}/sounds/keep`, { source: hit.source, source_id: hit.source_id })
    cue.source = 'gateway'; cue.pool_id = undefined; cue.clip = kept.sha256
    cue.credit = kept.credit; cue.status = 'matched'
    if (cue.kind === 'bed' && kept.duration_sec && (!cue.end_sec || cue.end_sec <= cue.start_sec)) {
      cue.end_sec = Number((cue.start_sec + kept.duration_sec).toFixed(3))
    }
    markDirty()
    success(`Kept “${hit.title}” with its licence and author recorded.`)
  } catch (cause: any) {
    showError(cause?.data?.detail || 'That sound could not be kept.')
  }
}

function ensureSounds(): SoundTimeline {
  if (!sounds.value) {
    sounds.value = {
      schema_version: 2, generated_at: new Date().toISOString(), source_scene_plan_generated_at: '',
      settings: { ...settings.value }, cues: [],
    }
  }
  return sounds.value
}

// ── Load / save ──────────────────────────────────────────────────────────

let autoSaveTimer: ReturnType<typeof setTimeout> | null = null
let editSeq = 0
let saveTail: Promise<void> = Promise.resolve()

function isCurrentScope(project: string, episode: string, epoch: number): boolean {
  return scopeEpoch === epoch && slug.value === project && episodeId.value === episode
}

async function loadConfig(): Promise<void> {
  const project = slug.value
  const epoch = projectEpoch
  try {
    const data = await get<any>(`/projects/${project}/sound-and-labels/config`)
    if (projectEpoch !== epoch || slug.value !== project) return
    config.value = { on_screen_text: data.on_screen_text === true, sound: data.sound === true }
  } catch (cause: any) {
    if (projectEpoch === epoch && slug.value === project) showError(cause?.data?.detail || 'Could not load this channel’s switches.')
  }
}

/**
 * The switches write ONLY the one that changed.
 *
 * Reading `config` back from a two-field payload and re-sending both would let
 * a stale value on screen overwrite the other switch — the same shape as
 * AGENTS.md §4's "a value belonging to one episode reaching another", one level
 * up. The route names each key explicitly for the same reason.
 */
async function setSwitch(key: 'on_screen_text' | 'sound', value: boolean): Promise<void> {
  const project = slug.value
  const epoch = projectEpoch
  const previous = { ...config.value }
  config.value = { ...config.value, [key]: value }
  savingConfig.value = true
  try {
    const data = await put<any>(`/projects/${project}/sound-and-labels/config`, { [key]: value })
    if (projectEpoch !== epoch || slug.value !== project) return
    config.value = { on_screen_text: data.on_screen_text === true, sound: data.sound === true }
    success(key === 'on_screen_text'
      ? (value ? 'On-screen text on — approved labels are drawn.' : 'On-screen text off — no labels are drawn.')
      : (value ? 'Sound on — approved beds and spots are mixed.' : 'Sound off — narration only.'))
  } catch (cause: any) {
    if (projectEpoch === epoch && slug.value === project) {
      config.value = previous
      showError(cause?.data?.detail || 'Could not save that switch.')
    }
  } finally { savingConfig.value = false }
}

async function loadEpisode(): Promise<void> {
  const project = slug.value
  const episode = episodeId.value
  const epoch = scopeEpoch
  const request = ++loadSequence
  await saveNow(false)
  if (!isCurrentScope(project, episode, epoch)) return
  if (dirty.value || saveError.value) {
    loadError.value = `Changes to this episode are still on the page. Save them before opening ${episode}.`
    return
  }
  // §4 — an episode change REPLACES this page's episode state. Every field
  // below is blanked first and then filled from THIS episode's own answer, so
  // nothing can survive from the last one. The MIX SETTINGS are the exception
  // that proves the rule: they belong to the sound timeline, not the page, and
  // are read from it — the leak the audit found was a remembered form carrying
  // one episode's settings into another, which is why they are not remembered.
  labels.value = null; sounds.value = null; scenes.value = []; movedNotes.value = []
  // §4 — a preview that FAILED for one episode must not suppress the same
  // scene id in the next one, which may well have its own picture.
  failedPreviews.value = new Set()
  validation.value = { labels: [], sound: [] }
  poolClips.value = []; unavailablePools.value = []; libraryHits.value = []; libraryNote.value = ''
  settings.value = { max_spots_per_minute: 3, default_bed_gain_db: -20, default_spot_gain_db: -12, ducking_profile: 'gentle' }
  refuses.value = {}
  loadError.value = ''; dirty.value = false; saveError.value = ''; savedAt.value = ''
  if (!episode) return
  loading.value = true
  try {
    const [data, available] = await Promise.all([
      get<any>(`/projects/${project}/sound-and-labels/${episode}`),
      get<any>(`/projects/${project}/sound-and-labels/${episode}/sounds/available`).catch(() => ({ pool_clips: [], unavailable: [] })),
    ])
    if (request !== loadSequence || !isCurrentScope(project, episode, epoch)) return
    config.value = { on_screen_text: data.config?.on_screen_text === true, sound: data.config?.sound === true }
    labels.value = data.labels || null
    sounds.value = data.sounds || null
    if (sounds.value?.settings) settings.value = { ...sounds.value.settings }
    scenes.value = data.scenes || []
    validation.value = data.validation || { labels: [], sound: [] }
    movedNotes.value = data.moved_notes || []
    refuses.value = {
      ...(data.readiness?.labels?.refuses ? { labels: data.readiness.labels.refuses } : {}),
      ...(data.readiness?.sound?.refuses ? { sound: data.readiness.sound.refuses } : {}),
    }
    poolClips.value = available.pool_clips || []
    unavailablePools.value = available.unavailable || []
  } catch (cause: any) {
    if (request === loadSequence && isCurrentScope(project, episode, epoch)) loadError.value = cause?.data?.detail || 'Could not load this episode.'
  } finally {
    if (request === loadSequence && isCurrentScope(project, episode, epoch)) loading.value = false
  }
}

function saveNow(announce = false): Promise<void> {
  if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null }
  const run = saveTail.then(() => writeTimeline(announce), () => writeTimeline(announce))
  saveTail = run.then(() => undefined, () => undefined)
  return run
}

async function writeTimeline(announce: boolean): Promise<void> {
  // Pressing Save with nothing outstanding confirms that, rather than doing
  // visibly nothing — a button that looks broken is its own defect. Only the
  // manual press (announce) says it; the debounce stays silent.
  if (!dirty.value || !episodeId.value) {
    if (announce && episodeId.value) {
      if (saveError.value) showError(saveError.value)
      else success('Everything here is already saved.')
    }
    return
  }
  const project = slug.value
  const episode = episodeId.value
  const epoch = scopeEpoch
  const sentAt = editSeq
  const labelPayload = labels.value ? JSON.parse(JSON.stringify(labels.value.cues)) : null
  const soundPayload = sounds.value ? JSON.parse(JSON.stringify(sounds.value.cues)) : null
  const mixSettings = { ...settings.value }
  saving.value = true
  try {
    // ONE write for both halves, in order, so a save cannot store a label whose
    // sound it then failed to store.
    if (labelPayload) {
      const result = await put<any>(`/projects/${project}/sound-and-labels/${episode}/labels`, { cues: labelPayload })
      if (isCurrentScope(project, episode, epoch) && editSeq === sentAt) labels.value = result.timeline
      validation.value = { ...validation.value, labels: result.validation || [] }
    }
    if (soundPayload) {
      const result = await put<any>(`/projects/${project}/sound-and-labels/${episode}/sounds`, { cues: soundPayload, settings: mixSettings })
      if (isCurrentScope(project, episode, epoch) && editSeq === sentAt) { sounds.value = result.timeline; if (result.timeline?.settings) settings.value = { ...result.timeline.settings } }
      validation.value = { ...validation.value, sound: result.validation || [] }
    }
    if (editSeq === sentAt) {
      dirty.value = false
      saveError.value = ''
      savedAt.value = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
    if (announce) success('Saved')
  } catch (cause: any) {
    // Keep every edit on screen. The save is refused only for a real defect,
    // and the cues at fault are named beside their rows.
    const issues = Array.isArray(cause?.data?.issues) ? cause.data.issues : []
    if (issues.length) {
      const side = cause?.config?.url?.includes('/labels') ? 'labels' : 'sound'
      validation.value = { ...validation.value, [side]: issues }
    }
    saveError.value = cause?.data?.detail || 'Could not save.'
    if (announce) showError(saveError.value)
  } finally { saving.value = false }
}

async function acceptMoves(): Promise<void> {
  try {
    await post<any>(`/projects/${slug.value}/sound-and-labels/${episodeId.value}/accept-moves`, {})
    movedNotes.value = []
    success('Times updated. Every item now follows its scene.')
    void loadEpisode()
  } catch (cause: any) { showError(cause?.data?.detail || 'Could not keep those times.') }
}

async function propose(): Promise<void> {
  if (!episodeId.value || !config.value.on_screen_text || !form.value.model) return
  const project = slug.value
  const episode = episodeId.value
  const epoch = scopeEpoch
  proposing.value = true
  const payload = { ...form.value }
  const operationId = freshAction.begin(payload)
  try {
    await post(`/projects/${project}/contextual-cues/${episode}/propose`, { ...payload, operation_id: operationId })
    freshAction.complete(operationId)
    if (!isCurrentScope(project, episode, epoch)) return
    success('Proposal queued. Labels and sounds will appear here when the job finishes.')
    setTimeout(() => { if (isCurrentScope(project, episode, epoch)) void loadEpisode() }, 1200)
  } catch (cause: any) {
    if (!isCurrentScope(project, episode, epoch)) return
    if (cause?.data?.detail) showError(cause.data.detail)
    else showAction(UNCONFIRMED_SUBMISSION, 'Retry', () => propose(), 'error')
  } finally { proposing.value = false }
}

// ── Playback ─────────────────────────────────────────────────────────────

let audio: HTMLAudioElement | null = null
function togglePlay(row: Row): void {
  if (playing.value === row.key) { audio?.pause(); audio = null; playing.value = ''; return }
  audio?.pause()
  const cue = row.cue as SoundCue
  const url = cue.source === 'gateway'
    ? `/projects/${encodeURIComponent(slug.value)}/sound-and-labels/sounds/library-audio/${encodeURIComponent(cue.clip)}`
    : `/projects/${encodeURIComponent(slug.value)}/sound-and-labels/sounds/pool-audio/${encodeURIComponent(cue.pool_id || '')}/${encodeURIComponent(cue.clip)}`
  audio = new Audio(url)
  playing.value = row.key
  audio.onended = () => { playing.value = ''; audio = null }
  audio.onerror = () => { playing.value = ''; audio = null; showError('That sound could not be played.') }
  void audio.play().catch(() => { playing.value = ''; audio = null; showError('That sound could not be played.') })
}

// ── Presets, state notices ───────────────────────────────────────────────

const activePresets = usePresets<ProbeForm>({
  slug: slug.value,
  configKey: 'contextual_cues',
  presetType: 'contextual-cues',
  snapshot: () => ({ ...form.value }),
  apply: (data) => {
    if (typeof data?.model === 'string') form.value.model = data.model
    if (data?.density === 'restrained' || data?.density === 'standard' || data?.density === 'editorial') form.value.density = data.density
    if (isContextualCueCorner(data?.placement)) form.value.placement = data.placement
    const stored = storedPresetAutoApprove(data)
    autoApproveNotice.value = stored === null ? null : { on: stored, changed: form.value.auto_approve !== stored }
    if (stored !== null) form.value.auto_approve = stored
  },
})
const soundPresets = usePresets<Settings>({
  slug: slug.value,
  configKey: 'sound_design',
  presetType: 'sound-design',
  snapshot: () => ({ ...settings.value }),
  apply: (data) => { settings.value = { ...settings.value, ...data }; markDirty() },
})

/** A preset action's own result, said plainly. A built-in is not an error. */
async function finishPreset(run: Promise<unknown>, done: string): Promise<void> {
  try {
    if (await run) success(done)
    else info('Nothing was changed. Built-in presets can\'t be edited — use "Save as…" to keep your own copy.')
  } catch (cause: any) {
    showError(`Your preset was not saved. ${cause?.data?.detail || cause?.message || 'Please try again.'}`)
  }
}

const saveState = computed<'saving' | 'error' | 'unsaved' | 'saved'>(() => saving.value ? 'saving' : saveError.value ? 'error' : dirty.value ? 'unsaved' : 'saved')
const saveStateLabel = computed(() => {
  if (saving.value) return 'Saving…'
  if (saveError.value) return `Not saved — ${saveError.value}`
  if (dirty.value) return 'Unsaved — saving in a moment'
  return savedAt.value ? `Saved at ${savedAt.value}` : 'Saved'
})

watch(slug, () => { projectEpoch++; void loadConfig() }, { flush: 'sync' })
watch([slug, episodeId], () => { scopeEpoch++; autoApproveNotice.value = null; void loadEpisode(); void loadTransitions() }, { flush: 'sync' })
watch(() => config.value.on_screen_text, () => { void loadEpisode() })
watch(() => config.value.sound, () => { void loadEpisode() })
watch(jobActive, (active, was) => { if (was && !active) void loadEpisode() })
onBeforeUnmount(() => { void saveNow(false); audio?.pause() })
onMounted(async () => {
  await loadConfig()
  await loadTransitions()
  await Promise.all([activePresets.load(), soundPresets.load()])
  autoApproveNotice.value = null
})
</script>

<style scoped>
.sl-transitions { margin: 1rem 0; padding: 1.25rem 1.5rem; }
.sl-transitions h2 { font-size: 1.1rem; }
.sl-transitions p { color: var(--text-muted); }
.sl-transition-controls { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; }
.sl-transition-controls label { display: grid; gap: .35rem; }
.sl-transition-clip { display: flex; align-items: center; gap: .5rem; margin: .4rem 0; }
.sl-transition-clip span { flex: 1; overflow-wrap: anywhere; }
.sound-labels-workspace :deep(.workspace-command-surface .top-action-bar) { margin: 0; border: 0; background: transparent; box-shadow: none; }
.section-kicker { display: block; color: var(--accent-gold); text-transform: uppercase; letter-spacing: .09em; font-weight: 700; font-size: .72rem; }
.sl-switches { display: flex; align-items: center; justify-content: space-between; gap: 2rem; margin: 1rem 0; padding: 1.25rem 1.5rem; }
.sl-switch-copy h2, .sl-setup h2, .sl-list h2 { margin: .25rem 0; font-size: 1.1rem; }
.sl-switch-copy p, .sl-setup p { margin: 0; color: var(--text-muted); max-width: 46rem; }
.sl-switch-row { display: flex; gap: .75rem; }
.sl-switch { display: flex; gap: .5rem; align-items: center; padding: .55rem .75rem; border: 1px solid var(--border-color); border-radius: .45rem; background: var(--bg-secondary); white-space: nowrap; cursor: pointer; }
.sl-switch input { width: 1.15rem; height: 1.15rem; accent-color: var(--accent-gold); }
.sl-switch span { display: grid; font-weight: 700; font-size: .85rem; }
.sl-switch small { color: var(--text-muted); font-weight: 500; font-size: .72rem; }
.sl-setup { display: grid; grid-template-columns: minmax(16rem, .85fr) minmax(30rem, 1.6fr); gap: 1.5rem; align-items: start; margin-bottom: 1rem; padding: 1.25rem 1.5rem; }
.sl-setup-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; align-items: end; }
.sl-setup-controls > label { display: grid; gap: .4rem; color: var(--text-muted); font-size: .82rem; }
.sl-auto-approve { grid-column: 1/-1; display: flex !important; gap: .55rem; align-items: flex-start; padding: .55rem .65rem; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: .4rem; }
.sl-auto-approve input { margin-top: .14rem; accent-color: var(--accent-gold); }
.sl-auto-approve strong, .sl-auto-approve small { display: block; }
.sl-auto-approve small { margin-top: .15rem; color: var(--text-muted); line-height: 1.35; }
.sl-auto-approve-notice { grid-column: 1/-1; margin: 0; }
.sl-list { padding: 1.25rem; }
.sl-list-heading { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; margin-bottom: .75rem; }
.sl-list-actions { display: flex; gap: .4rem; align-items: center; flex-wrap: wrap; }
.sl-save-state { max-width: 28rem; color: var(--text-muted); font-size: var(--font-xs); }
.sl-save-state[data-state="unsaved"], .sl-save-state[data-state="saving"] { color: var(--accent-gold); }
.sl-save-state[data-state="error"] { color: var(--warning); font-weight: 600; }
.sl-job-lock { margin: 0 0 .75rem; padding: .5rem .7rem; background: var(--accent-dim); border-radius: .35rem; font-size: .82rem; }
.sl-timeline { list-style: none; margin: 0; padding: 0; }
.sl-row { display: grid; grid-template-columns: 6.5rem minmax(14rem, 1.4fr) 6rem 7rem auto; gap: .9rem; align-items: start; padding: .9rem 0; border-top: 1px solid var(--border-color); }
.sl-row.is-approved { border-left: 3px solid var(--success); padding-left: .7rem; }
.sl-row.is-disabled, .sl-row.is-excluded { opacity: .55; }
.sl-time { padding-top: .2rem; color: var(--accent-gold); font-variant-numeric: tabular-nums; font-weight: 700; }
.sl-what { display: grid; gap: .15rem; min-width: 0; }
.sl-what strong { font-size: .9rem; line-height: 1.25; overflow-wrap: anywhere; }
.sl-subtitle { color: var(--text-muted); font-size: .78rem; }
.sl-credit { color: var(--text-muted); font-size: .7rem; font-style: italic; }
.sl-badge { justify-self: start; padding: .05rem .4rem; border-radius: .25rem; font-size: .62rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
.sl-badge-label { background: color-mix(in srgb, var(--accent-gold) 22%, transparent); color: var(--accent-gold); }
.sl-badge-sound { background: color-mix(in srgb, #4b9cd3 24%, transparent); color: #7fc4ec; }
.sl-scene { color: var(--text-muted); font-size: .76rem; padding-top: .2rem; }
.sl-status { font-size: .75rem; font-weight: 600; padding-top: .2rem; }
.sl-status[data-tone="success"] { color: var(--success); }
.sl-status[data-tone="warning"] { color: var(--warning); }
.sl-status[data-tone="muted"] { color: var(--text-muted); }
.sl-row-actions { display: flex; gap: .35rem; flex-wrap: wrap; }
.sl-play.is-playing { outline: 1px solid var(--accent-gold); }
.sl-note { grid-column: 1 / -1; margin: 0; padding: .3rem .6rem; color: var(--text-muted); background: var(--bg-secondary); border-left: 2px solid color-mix(in srgb, var(--warning) 55%, var(--border)); border-radius: .25rem; font-size: var(--font-xs); }
.sl-editor { grid-column: 1 / -1; display: grid; gap: .5rem; }
.sl-editor-main { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.sl-editor-main > input:first-child { flex: 1 1 14rem; min-width: 10rem; }
.sl-editor-main > input:nth-child(2) { flex: 1 1 10rem; min-width: 8rem; }
.sl-inline-check { display: flex; gap: .35rem; align-items: center; color: var(--text-muted); font-size: .8rem; white-space: nowrap; }
.sl-inline-check input { accent-color: var(--accent-gold); }
.clip-picker { flex: 1 1 16rem; min-width: 10rem; }
.sl-advanced { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .55rem .8rem; padding: .65rem 0; }
.sl-advanced > label { display: grid; gap: .25rem; color: var(--text-muted); font-size: .78rem; }
.input-time { width: 5.5rem; }
.input-gain { width: 5rem; }
.sl-label-preview { display: grid; gap: .35rem; padding-top: .35rem; }
.sl-preview-caption { color: var(--text-muted); font-size: .74rem; }
.sl-frame { position: relative; aspect-ratio: 16/9; max-width: 32rem; background: #0b1220; border: 1px solid #364152; border-radius: .45rem; overflow: hidden; }
.sl-frame-image { width: 100%; height: 100%; object-fit: cover; display: block; }
.sl-frame-empty { display: grid; place-items: center; height: 100%; color: #7a8699; font-size: .8rem; }
.sl-frame-cue { position: absolute; display: grid; gap: .1rem; max-width: 62%; padding: .25rem .45rem; color: #fff; background: #111827; border: 1px solid #364152; border-radius: .25rem; font-size: .65rem; pointer-events: none; }
.sl-frame-cue strong { font-size: .68rem; line-height: 1.15; }
.sl-frame-cue span, .sl-frame-cue small { font-size: .55rem; letter-spacing: .07em; text-transform: uppercase; color: #b6c0d1; }
.preview-archival-caption { background: #2c211b; border-color: #66513f; font-family: Georgia, serif; }
.preview-chapter-plate { background: linear-gradient(135deg, #111827, #2b3445); text-align: center; }
.sl-mix-presets { margin-bottom: .25rem; }
.sl-mix { display: grid; grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr)); gap: .75rem; padding: .65rem 0; }
.sl-mix > label { display: grid; gap: .25rem; color: var(--text-muted); font-size: .78rem; }
.sl-mix small { color: var(--text-muted); font-size: .7rem; line-height: 1.35; }
.sl-issue { display: block; }
.sl-accept { margin-top: .5rem; }
.sl-hits { list-style: none; margin: .25rem 0; padding: 0; display: grid; gap: .3rem; }
.sl-hits li { display: flex; gap: .6rem; align-items: center; padding: .35rem .55rem; border: 1px solid var(--border-color); border-radius: .35rem; background: var(--bg-secondary); font-size: .8rem; }
.sl-hit-title { font-weight: 600; }
.sl-hit-meta { color: var(--text-muted); font-size: .74rem; }
.sl-hit-link { color: var(--accent-gold); font-size: .72rem; margin-left: auto; }
@media (max-width: 1100px) {
  .sl-switches, .sl-setup, .sl-row { grid-template-columns: 1fr; display: grid; }
  .sl-switch-row { flex-wrap: wrap; }
}
</style>
