<template>
  <div
    :class="['character-card', { selectable, selected }]"
    :role="selectable ? 'checkbox' : undefined"
    :aria-checked="selectable ? selected : undefined"
    :tabindex="selectable ? 0 : undefined"
    @click="selectable && emit('toggle')"
    @keydown.enter.prevent="selectable && emit('toggle')"
    @keydown.space.prevent="selectable && emit('toggle')"
  >
    <input
      v-if="selectable"
      type="checkbox"
      class="cc-check"
      :checked="selected"
      tabindex="-1"
      aria-hidden="true"
    />
    <img v-if="thumbnailUrl" :src="thumbnailUrl" :alt="character.name" class="cc-thumb" />

    <div class="cc-body">
      <div class="card-top">
        <div class="card-meta">
          <strong class="char-name">{{ character.name }}</strong>
          <span v-if="character.archetype" class="char-archetype">{{ character.archetype }}</span>
          <span :class="['scope-badge', `scope-${character.scope}`]">{{ scopeLabel }}</span>
          <span v-if="character.source === 'imported'" class="source-badge">imported</span>
        </div>
        <div class="card-actions" @click.stop>
          <slot name="actions" />
        </div>
      </div>

      <p v-if="character.description" class="char-desc">{{ character.description }}</p>

      <div v-if="character.scope === 'episode'" class="char-episodes">
        <span class="muted">Episodes:</span>
        <span v-for="ec in character.episode_codes" :key="ec" class="ep-chip">{{ ec }}</span>
      </div>

      <div v-if="character.speech?.tonation" class="char-speech">
        <span class="muted">Tonation:</span> {{ character.speech.tonation }}
      </div>

      <div v-if="character.speech?.voiceId" class="char-voice">
        <span class="muted">Voice:</span>
        <code>{{ character.speech.voiceId }}</code>
        <span v-if="character.speech.voiceProvider" class="muted">({{ character.speech.voiceProvider }})</span>
      </div>

      <div v-if="character.references?.images?.length" class="char-refs">
        <span class="muted">Reference images: {{ character.references.images.length }}</span>
        <span class="ref-hint">
          — used by image gen with
          <strong>Flux Kontext (Pro / Max)</strong>
          and
          <strong>Nano Banana (Pro)</strong>.
          Other image models ignore reference images and run prompt-only.
        </span>
      </div>
      <div v-else-if="selectable" class="char-refs char-refs-warn">
        <span>⚠ No reference image — picks the name but won't visually lock the look.</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { Character } from '../composables/useCharacters.js'

// v1.0.191 — shared character card, used by the Characters library list AND
// the continuity Character Sheet anchor picker. Optional `thumbnailUrl` shows
// the first reference image; `selectable` + `selected` turn it into a pickable
// tile that emits `toggle`. Without those it renders exactly as before.
const props = defineProps<{
  character: Character
  thumbnailUrl?: string
  selectable?: boolean
  selected?: boolean
}>()
const emit = defineEmits<{ toggle: [] }>()

const scopeLabel = computed(() => props.character.scope === 'project' ? 'project-wide' : 'episode-only')
</script>

<style scoped>
.character-card {
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 6px);
  background: var(--bg-secondary);
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 12px;
}
.character-card.selectable { cursor: pointer; transition: border-color 0.15s, background 0.15s; }
.character-card.selectable:hover { border-color: var(--accent); }
.character-card.selectable:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-dim); }
.character-card.selected { border-color: var(--accent); background: var(--accent-dim); }

.cc-check { margin-top: 3px; flex-shrink: 0; pointer-events: none; }
.cc-thumb {
  width: 56px;
  height: 56px;
  border-radius: 6px;
  object-fit: cover;
  background: var(--bg-tertiary);
  flex-shrink: 0;
}
.cc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.char-name { font-size: 14px; }

.char-archetype {
  font-size: 11px;
  color: var(--text-muted);
  font-style: italic;
}

.scope-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 3px;
}

.scope-badge.scope-project {
  background: rgba(108, 143, 255, 0.12);
  color: var(--accent, #6c8fff);
}

.scope-badge.scope-episode {
  background: rgba(255, 180, 0, 0.10);
  color: #d4a017;
}

.source-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.char-desc {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.5;
}

.char-episodes, .char-speech, .char-voice, .char-refs {
  font-size: 11px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.muted { color: var(--text-muted); }
.char-refs-warn { color: var(--warning, #ca8a04); }

.ep-chip {
  font-size: 10px;
  background: var(--bg-tertiary);
  padding: 1px 6px;
  border-radius: 3px;
  color: var(--text-primary);
}

code { font-family: 'Menlo', Monaco, monospace; font-size: 11px; }

.ref-hint {
  font-size: 10px;
  color: var(--text-muted);
  line-height: 1.4;
  flex-basis: 100%;
  margin-top: 2px;
}

.ref-hint strong {
  color: var(--text-secondary);
  font-weight: 500;
}
</style>
