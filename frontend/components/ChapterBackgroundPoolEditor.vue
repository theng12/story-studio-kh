<template>
  <div class="cbpe">
    <div class="cbpe-header">
      <div>
        <h4 class="cbpe-title">Chapter background pool</h4>
        <p class="cbpe-subtitle text-muted text-sm">
          Reusable backgrounds for this channel, taken one after another in order.
          The rotation steps through this episode's chapters and on into the next
          episode, wrapping. Empty pool = today's behaviour, unchanged.
        </p>
      </div>
      <button
        type="button"
        class="btn btn-sm btn-secondary"
        :disabled="disabled || items.length === 0"
        @click="resetRotation"
      >Reset rotation</button>
    </div>

    <p v-if="nextUp" class="cbpe-next text-muted text-sm" role="status">
      Next: <strong>{{ nextUp.name }}</strong> — position {{ nextUp.index + 1 }} of {{ enabledCount }}
    </p>

    <div v-if="!items.length" class="cbpe-empty">
      <p class="text-muted">
        The pool is empty. Chapter backgrounds are used exactly as today: no rotation.
        Add the channel's own background files or app backgrounds below to start one.
      </p>
    </div>

    <ol v-else class="cbpe-items" aria-label="Pool items in rotation order">
      <li
        v-for="(item, index) in items"
        :key="item.id"
        class="cbpe-item"
        :class="{ 'is-disabled': !item.enabled }"
      >
        <span class="cbpe-index" aria-hidden="true">{{ index + 1 }}</span>
        <span class="cbpe-item-name" :title="item.reference">{{ item.name }}</span>
        <span v-if="item.kind" class="cbpe-kind text-muted text-sm">{{ item.kind }}</span>
        <button
          type="button"
          class="cbpe-toggle"
          :disabled="disabled"
          :title="item.enabled ? 'Take out of rotation' : 'Put back into rotation'"
          :aria-label="item.enabled ? `Disable ${item.name}` : `Enable ${item.name}`"
          @click="toggleEnabled(item.id)"
        >{{ item.enabled ? 'On' : 'Off' }}</button>
        <button
          type="button"
          class="cbpe-remove"
          :disabled="disabled"
          :aria-label="`Remove ${item.name} from the pool`"
          @click="removeItem(item.id)"
        >Remove</button>
      </li>
    </ol>

    <details class="cbpe-add" :open="!items.length">
      <summary>Add backgrounds</summary>
      <div class="cbpe-add-body">
        <div v-if="catalogChoices.length" class="cbpe-add-section">
          <h5 class="text-sm">App backgrounds</h5>
          <ul class="cbpe-choices">
            <li v-for="entry in catalogChoices" :key="entry.id">
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                :disabled="disabled || hasId(entry.id)"
                @click="addCatalog(entry)"
              >+ {{ entry.name }}</button>
            </li>
          </ul>
        </div>
        <div v-if="channelChoices.length" class="cbpe-add-section">
          <h5 class="text-sm">This channel's background files</h5>
          <ul class="cbpe-choices">
            <li v-for="file in channelChoices" :key="file">
              <button
                type="button"
                class="btn btn-sm btn-secondary"
                :disabled="disabled || hasId(file)"
                @click="addChannelFile(file)"
              >+ {{ file }}</button>
            </li>
          </ul>
        </div>
        <p v-if="!catalogChoices.length && !channelChoices.length" class="text-muted text-sm">
          No backgrounds available to add yet. Drop image or video files into the channel's
          <code>backgrounds</code> folder.
        </p>
      </div>
    </details>
  </div>
</template>

<script setup lang="ts">
/**
 * The chapter background pool field — reusable backgrounds for a channel with
 * SERIAL rotation (item 14, release 1.4.386; HANDOFF "four-background serial
 * chapter rotation"). Serial only: no other rotation mode was asked for.
 *
 * Selection and ordering only: the host page owns the save path, exactly like
 * ChapterTitleFontEditor. The rotation itself is decided by the shared
 * contract (`contracts/chapter-background-pool.ts`), so the "Next" line the UI
 * shows and the pick the render records are one answer (AGENTS §1). An empty
 * pool means today's behaviour — nothing here touches an episode or a preset.
 */
import { computed } from 'vue'
import {
  decideChapterBackground,
  emptyChapterBackgroundPool,
  normaliseChapterBackgroundPool,
  normaliseCursor,
  poolBackgroundIds,
  type ChapterBackgroundCursor,
  type ChapterBackgroundItem,
  type ChapterBackgroundPool,
} from '../../electron/server/contracts/chapter-background-pool.js'

const props = withDefaults(defineProps<{
  /** The saved pool. Absent = the channel has none and the editor starts empty. */
  modelValue?: ChapterBackgroundPool | null
  /** The channel's standing rotation cursor. Display only. */
  cursor?: ChapterBackgroundCursor | null
  /** Catalog backgrounds available to add (approved entries only). */
  catalog?: Array<{ id: string; name: string; reference: string }> | null
  /** Filenames in the channel's own backgrounds folder (its inventory). */
  channelFiles?: string[] | null
  disabled?: boolean
}>(), {
  modelValue: null,
  cursor: null,
  catalog: null,
  channelFiles: null,
  disabled: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: ChapterBackgroundPool]
  'reset-cursor': []
}>()

const poolValue = computed(() =>
  props.modelValue ? normaliseChapterBackgroundPool(props.modelValue) : emptyChapterBackgroundPool(),
)
const items = computed(() => poolValue.value.items)
const enabledCount = computed(() => poolBackgroundIds(poolValue.value).length)

const catalogChoices = computed(() =>
  (props.catalog ?? []).filter(entry => entry && entry.id && !hasId(entry.id)),
)
const channelChoices = computed(() =>
  (props.channelFiles ?? []).filter(file => file && !hasId(file)),
)

/** What the serial rotation takes next, as the render would decide it. */
const nextUp = computed(() => {
  const decision = decideChapterBackground(poolValue.value, normaliseCursor(props.cursor))
  if (!decision) return null
  return { name: decision.item.name, index: decision.index }
})

function patch(partial: Partial<ChapterBackgroundPool>): void {
  emit('update:modelValue', normaliseChapterBackgroundPool({ ...poolValue.value, ...partial }))
}

function hasId(id: string): boolean {
  return items.value.some(item => item.id === id)
}

function addItem(item: { id: string; name: string; reference: string; kind?: string }): void {
  if (hasId(item.id)) return
  const next: ChapterBackgroundItem = {
    id: item.id,
    name: item.name,
    reference: item.reference,
    kind: item.kind,
    enabled: true,
  }
  patch({ items: [...items.value, next] })
}

function addCatalog(entry: { id: string; name: string; reference: string }): void {
  addItem({ id: entry.id, name: entry.name, reference: entry.reference, kind: 'catalog' })
}

function addChannelFile(file: string): void {
  addItem({ id: file, name: file, reference: `\${CHANNEL}/backgrounds/${file}` })
}

function removeItem(id: string): void {
  patch({ items: items.value.filter(item => item.id !== id) })
}

function toggleEnabled(id: string): void {
  patch({
    items: items.value.map(item => item.id === id ? { ...item, enabled: !item.enabled } : item),
  })
}

function resetRotation(): void {
  emit('reset-cursor')
}
</script>

<style scoped>
.cbpe {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-secondary);
}

.cbpe-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.cbpe-title {
  margin: 0 0 4px;
  font-size: 14px;
  font-weight: 600;
}

.cbpe-subtitle {
  margin: 0;
  max-width: 62ch;
}

.cbpe-next {
  margin: 0;
}

.cbpe-empty {
  padding: 10px 12px;
  border: 1px dashed var(--border-light);
  border-radius: 6px;
}

.cbpe-empty p {
  margin: 0;
}

.cbpe-items {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.cbpe-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.cbpe-item.is-disabled {
  opacity: 0.55;
}

.cbpe-index {
  min-width: 1.6em;
  font-size: 12px;
  color: var(--text-muted);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.cbpe-item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.cbpe-kind {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.cbpe-toggle,
.cbpe-remove {
  border: 1px solid var(--border-light);
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  padding: 3px 8px;
  cursor: pointer;
}

.cbpe-toggle:hover:not(:disabled),
.cbpe-remove:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.cbpe-remove:hover:not(:disabled) {
  border-color: var(--error);
  color: var(--error);
}

.cbpe-add summary {
  cursor: pointer;
  font-size: 13px;
  color: var(--text-secondary);
}

.cbpe-add-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 8px;
}

.cbpe-choices {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 0;
  padding: 0;
  list-style: none;
}
</style>
