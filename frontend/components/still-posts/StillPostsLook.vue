<!--
  Step 1 — Channel look. The cast, the handle and logo, the preset, the format and layout, the lettering
  fonts and the placement. A group that is already set collapses to one line that says what is chosen,
  so the page reads as a summary until someone opens a group to change it.
-->
<template>
  <div class="sp-step">
    <StillPostsStepHead tab="look" />

    <details class="card sp-section sp-fold" :open="!castCount">
      <summary class="sp-fold-summary">
        <span class="sp-h3">Characters</span>
        <span class="sp-fold-line">{{ castLine }}</span>
      </summary>
      <div class="sp-fold-body">
        <div class="sp-section-head">
          <p class="sp-help sp-fold-intro">
            The cast belongs to this channel, not to a post. Choose up to 10 characters; every post may use
            any of them, and no post may use one from another channel.
          </p>
          <button type="button" class="btn btn-sm btn-secondary" :disabled="savingConfig" @click="saveConfig">
            {{ savingConfig ? 'Saving…' : 'Save channel' }}
          </button>
        </div>
        <p v-if="configNote" class="sp-note" :class="{ 'sp-note-error': configError }" role="status">{{ configNote }}</p>

        <h4 class="sp-h4">Characters <span class="sp-count">{{ castDraft.length }}/10</span></h4>
        <p v-if="!workspace?.characters.length" class="sp-help">
          This channel has no characters yet. Create one on the
          <NuxtLink :to="{ path: '/character-library', query: { channel: slug, project: slug } }" class="sp-link">Channel Characters</NuxtLink>
          page with at least one reference image, then come back.
        </p>
        <div v-else class="sp-cast">
          <label
            v-for="character in workspace?.characters"
            :key="character.id"
            class="sp-cast-item"
            :class="{ 'is-on': castDraft.includes(character.id), 'is-off': !character.has_reference }"
          >
            <input
              type="checkbox"
              :checked="castDraft.includes(character.id)"
              :disabled="!character.has_reference || (!castDraft.includes(character.id) && castDraft.length >= 10)"
              @change="toggleCast(character.id)"
            >
            <img v-if="character.portrait_url" :src="character.portrait_url" :alt="character.name" class="sp-cast-portrait">
            <span v-else class="sp-cast-placeholder" aria-hidden="true">?</span>
            <span class="sp-cast-text">
              <strong>{{ character.name }}</strong>
              <span class="sp-help">{{ character.has_reference ? (character.description || 'No description') : 'No reference image yet — add one on Channel Characters.' }}</span>
            </span>
          </label>
        </div>
      </div>
    </details>

    <details class="card sp-section sp-fold" :open="!presetChosen">
      <summary class="sp-fold-summary">
        <span class="sp-h3">Preset</span>
        <span class="sp-fold-line">{{ presetLine }}</span>
      </summary>
      <div class="sp-fold-body">
        <p class="sp-help sp-fold-intro">
          Presets hold the reusable look only: formats, layout, language, export frames, the handle and logo
          placement, the lettering fonts and the models you chose. Never a character, never a quote.
        </p>
        <div class="sp-row">
          <select v-model="presetId" class="select" aria-label="Preset" @change="applyPreset(presetId)">
            <option v-for="preset in workspace?.presets" :key="preset.id" :value="preset.id">
              {{ preset.name }}{{ preset.builtin ? ' (built in)' : '' }}
            </option>
          </select>
          <input v-model="presetName" class="input input-sm" maxlength="60" aria-label="New preset name" placeholder="Preset name">
          <button type="button" class="btn btn-sm btn-secondary" :disabled="savingPreset" @click="savePreset">
            {{ savingPreset ? 'Saving…' : 'Save as new preset' }}
          </button>
        </div>
        <p v-if="presetNote" class="sp-note" :class="{ 'sp-note-error': presetError }" role="status">{{ presetNote }}</p>
      </div>
    </details>

    <details class="card sp-section sp-fold" open>
      <summary class="sp-fold-summary">
        <span class="sp-h3">Format and layout</span>
        <span class="sp-fold-line">{{ formatLine }}</span>
      </summary>
      <div class="sp-fold-body">
        <div class="sp-grid">
          <label class="sp-field">
            <span class="sp-label">Format (the look)</span>
            <select v-model="preset.format_id" class="select">
              <option v-for="format in workspace?.formats" :key="format.id" :value="format.id">{{ format.name }}</option>
            </select>
            <span class="sp-help">{{ draftFormat?.description }}</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Option (the layout)</span>
            <select v-model="preset.option_id" class="select">
              <option v-for="option in workspace?.options" :key="option.id" :value="option.id">{{ option.name }}</option>
            </select>
            <span class="sp-help">{{ draftOption?.description }}</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Language</span>
            <select v-model="preset.language" class="select">
              <option v-for="entry in languages" :key="entry.id" :value="entry.id">{{ entry.label }}</option>
            </select>
            <span class="sp-help">{{ letteringFontLabel }}</span>
          </label>
          <div class="sp-field">
            <span class="sp-label">Export frames</span>
            <div class="sp-checks">
              <label v-for="aspect in aspects" :key="aspect" class="sp-check">
                <input v-model="preset.aspects" type="checkbox" :value="aspect"> {{ aspect }}
              </label>
            </div>
            <label class="sp-draw-mode">
              <span class="sp-label">Drawings</span>
              <select v-model="preset.fresh_drawing_per_size" class="select" aria-label="Drawings per post">
                <option :value="false">One drawing, fitted to each size (default)</option>
                <option :value="true">A fresh drawing for each size (up to 3× the drawings)</option>
              </select>
            </label>
            <span class="sp-help">Every chosen frame is rendered for every post before a batch is complete.</span>
          </div>
          <label class="sp-field">
            <span class="sp-label">Text size <span class="sp-count">{{ preset.text_scale.toFixed(2) }}×</span></span>
            <input v-model.number="preset.text_scale" class="sp-range" type="range" min="0.6" max="1.6" step="0.05">
          </label>
        </div>
      </div>
    </details>

    <details class="card sp-section sp-fold">
      <summary class="sp-fold-summary">
        <span class="sp-h3">Lettering fonts</span>
        <span class="sp-fold-line">{{ fontsLine }}</span>
      </summary>
      <div class="sp-fold-body">
        <p class="sp-help sp-fold-intro">
          Choose the faces your posts are lettered in, one pool per writing system. One font means every post
          uses it; several rotate — one after another by default, or by percentage. With no pool, posts use the
          format's own face. A font that cannot draw the language is not offered.
        </p>
        <div v-for="row in poolRows" :key="row.script" class="sp-pool" :data-script="row.script">
          <div class="sp-pool-head">
            <strong>{{ row.label }}</strong>
            <span class="sp-help sp-pool-summary">{{ poolSummary(row) }}</span>
          </div>

          <div class="sp-row">
            <label v-for="mode in usageModes" :key="mode" class="sp-check">
              <input
                type="radio"
                :value="mode"
                :name="`pool-mode-${row.script}`"
                v-model="row.pool.usage_mode"
              >
              {{ usageModeLabels[mode] }}
            </label>
            <label v-if="row.pool.usage_mode === 'weighted'" class="sp-check">
              <input v-model="row.pool.allow_repeat" type="checkbox">
              Allow the same font twice in a row (true random)
            </label>
          </div>

          <p v-if="!row.faces.length" class="sp-help">No bundled font covers {{ row.label }}, so no pool can be set here.</p>

          <div v-for="(choice, index) in row.pool.fonts" :key="`${row.script}-${index}`" class="sp-pool-row">
            <span class="sp-pool-order">{{ row.pool.usage_mode === 'serial' ? `#${index + 1}` : `${percentagesFor(row.pool)[index] ?? 0}%` }}</span>
            <select v-model="choice.font_id" class="select sp-pool-face" :aria-label="`${row.label} font ${index + 1}`">
              <option v-for="face in facesForChoice(row, index)" :key="face.id" :value="face.id">{{ face.label }}</option>
            </select>
            <label v-if="row.pool.usage_mode === 'weighted'" class="sp-pool-weight">
              <span class="sp-label">Weight</span>
              <input v-model.number="choice.weight" class="input input-sm" type="number" min="1" max="100" step="1">
            </label>
            <span v-if="row.pool.usage_mode === 'weighted'" class="sp-pool-pct">{{ percentagesFor(row.pool)[index] ?? 0 }}% of posts</span>
            <button type="button" class="btn btn-sm btn-ghost" @click="removePoolFont(row.script, index)">Remove</button>
          </div>

          <div class="sp-row">
            <select
              class="select"
              :aria-label="`Add a ${row.label} font to the pool`"
              :value="''"
              :disabled="!row.faces.length"
              @change="onAddPoolFont(row.script, $event)"
            >
              <option value="">Add a font…</option>
              <option v-for="face in freeFaces(row)" :key="face.id" :value="face.id">{{ face.label }}</option>
            </select>
            <span class="sp-help">Percentages are of the pool, and are what the rotation uses.</span>
          </div>
        </div>
      </div>
    </details>

    <details class="card sp-section sp-fold">
      <summary class="sp-fold-summary">
        <span class="sp-h3">Handle and logo</span>
        <span class="sp-fold-line">{{ brandingLine }}</span>
      </summary>
      <div class="sp-fold-body">
        <div class="sp-two">
          <label class="sp-field">
            <span class="sp-label">Handle</span>
            <input v-model="handleDraft" class="input" maxlength="60" :placeholder="workspace?.config.handle ? `@${workspace.config.handle}` : 'no handle set on this channel'">
            <span class="sp-help">Blank uses the channel's own handle. Drawn by our renderer, in the post's own language font.</span>
          </label>
          <label class="sp-field">
            <span class="sp-label">Logo file</span>
            <input v-model="logoDraft" class="input" placeholder="Leave empty until you have a logo PNG">
            <span class="sp-help">
              The logo layer is built and simply draws nothing until a file is set.
              <template v-if="workspace?.config.logo_ready">A logo is set and found.</template>
              <template v-else>No logo file is in place yet.</template>
            </span>
          </label>
        </div>
        <div class="sp-row">
          <button type="button" class="btn btn-sm btn-secondary" :disabled="savingConfig" @click="saveConfig">
            {{ savingConfig ? 'Saving…' : 'Save channel' }}
          </button>
        </div>
        <h4 class="sp-h4">Handle and logo placement</h4>
        <div class="sp-grid">
          <label class="sp-check">
            <input v-model="preset.branding.handle_enabled" type="checkbox"> Burn the handle in
          </label>
          <label class="sp-field">
            <span class="sp-label">Handle for this preset</span>
            <input v-model="preset.branding.handle_text" class="input" placeholder="Use the channel's handle">
          </label>
          <label class="sp-check">
            <input v-model="preset.branding.logo_enabled" type="checkbox"> Burn the logo in
          </label>
          <label class="sp-field">
            <span class="sp-label">Position</span>
            <select v-model="preset.branding.position" class="select">
              <option v-for="anchor in anchors" :key="anchor" :value="anchor">{{ anchor }}</option>
            </select>
          </label>
          <label class="sp-field">
            <span class="sp-label">Handle size <span class="sp-count">{{ preset.branding.handle_size_px }}px</span></span>
            <input v-model.number="preset.branding.handle_size_px" class="sp-range" type="range" min="12" max="80" step="1">
          </label>
          <label class="sp-field">
            <span class="sp-label">Logo width <span class="sp-count">{{ preset.branding.logo_width_pct }}%</span></span>
            <input v-model.number="preset.branding.logo_width_pct" class="sp-range" type="range" min="3" max="40" step="1">
          </label>
          <label class="sp-field">
            <span class="sp-label">Margin <span class="sp-count">{{ preset.branding.margin_pct }}%</span></span>
            <input v-model.number="preset.branding.margin_pct" class="sp-range" type="range" min="0" max="12" step="0.5">
          </label>
          <label class="sp-field">
            <span class="sp-label">Opacity <span class="sp-count">{{ Math.round(preset.branding.opacity * 100) }}%</span></span>
            <input v-model.number="preset.branding.opacity" class="sp-range" type="range" min="0.2" max="1" step="0.05">
          </label>
        </div>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useStillPosts } from '../../composables/useStillPostsWorkspace'

const ws = useStillPosts()
const {
  slug, workspace, configNote, configError, savingConfig, saveConfig, castDraft, handleDraft, logoDraft, toggleCast,
  presetId, presetName, presetNote, presetError, savingPreset, applyPreset, savePreset, preset,
  draftFormat, draftOption, letteringFontLabel, languages, aspects, anchors,
  poolRows, usageModes, usageModeLabels, poolSummary, freeFaces, facesForChoice, removePoolFont, onAddPoolFont, percentagesFor,
} = ws

const castCount = computed(() => workspace.value?.config.character_ids.length ?? 0)
const castLine = computed(() => {
  const names = (workspace.value?.characters || [])
    .filter(character => castDraft.value.includes(character.id))
    .map(character => character.name)
  return names.length ? names.join(', ') : 'No characters chosen yet'
})
const presetChosen = computed(() => !!presetId.value)
const presetLine = computed(() => {
  const found = workspace.value?.presets.find(entry => entry.id === presetId.value)
  return found ? found.name : 'No preset loaded'
})
const formatLine = computed(() => {
  const format = draftFormat.value?.name || 'No format'
  const option = draftOption.value?.name || 'No layout'
  const frames = preset.aspects.length ? preset.aspects.join(', ') : 'no frames'
  return `${format} · ${option} · ${frames}`
})
const fontsLine = computed(() => {
  const set = poolRows.value.filter(row => row.pool.fonts.length)
  return set.length ? set.map(row => `${row.label}: ${row.pool.fonts.length} font${row.pool.fonts.length === 1 ? '' : 's'}`).join(' · ') : 'Format default'
})
const brandingLine = computed(() => {
  const handle = handleDraft.value.trim() || workspace.value?.config.handle || ''
  const logo = workspace.value?.config.logo_ready ? 'logo set' : 'no logo'
  return `${handle ? `@${handle.replace(/^@/, '')}` : 'no handle'} · ${logo} · ${preset.branding.position}`
})
</script>
