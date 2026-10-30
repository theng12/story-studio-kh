<template>
  <div class="character-picker">
    <label class="picker-label">
      <span>Cast <span class="optional-tag">(optional)</span></span>
      <span class="hint">
        Select characters to include in this episode. The script generator uses these names + descriptions
        instead of inventing characters every time. Leave empty to keep today's behaviour (LLM invents the cast).
        Every option comes from the shared Channel Characters roster for this channel.
      </span>
    </label>

    <div v-if="loading" class="muted">Loading characters…</div>
    <div v-else-if="!available.length" class="empty-cast">
      No Channel Characters are assigned yet.
      <button class="btn btn-secondary btn-sm" @click="showQuickCreate = true">+ Quick Channel Character</button>
      <NuxtLink :to="{ path: '/character-library', query: { channel: projectSlug, project: projectSlug } }" class="link-sm">Open Channel Characters →</NuxtLink>
    </div>

    <div v-else class="picker-list">
      <label v-for="c in available" :key="c.id" class="cast-row">
        <input
          type="checkbox"
          :value="c.id"
          :checked="selectedSet.has(c.id)"
          @change="toggle(c.id)"
        />
        <!-- The character already has a portrait on this Mac; showing the name
             alone made a roster of faces read as a list of words. -->
        <span class="cast-portrait" aria-hidden="true">
          <img
            v-if="portrait(c) && !portraitFailed.has(c.id)" :src="portrait(c)!" :alt="''"
            loading="lazy" @error="portraitFailed.add(c.id)"
          />
          <span v-else class="cast-portrait-fallback">{{ c.name.slice(0, 1) }}</span>
        </span>
        <div class="cast-info">
          <strong>{{ c.name }}</strong>
          <span class="scope-tag scope-project">channel</span>
          <span class="cast-desc">{{ shortDesc(c.description) }}</span>
        </div>
      </label>
      <div class="picker-actions">
        <button class="btn btn-ghost btn-sm" @click="showQuickCreate = true">+ Quick Channel Character</button>
        <NuxtLink :to="{ path: '/character-library', query: { channel: projectSlug, project: projectSlug } }" class="link-sm">Manage Channel Characters →</NuxtLink>
      </div>
    </div>

    <!-- Quick create writes directly to the shared roster and labels it for
         this channel. It never creates an episode-only duplicate. -->
    <div v-if="showQuickCreate" class="quick-create">
      <div class="form-group">
        <label>Name</label>
        <input v-model="quick.name" class="input" placeholder="e.g. Aria the Knight" autofocus />
      </div>
      <div class="form-group">
        <label>Description</label>
        <span class="hint">Physical + personality. Used in script + visual prompts.</span>
        <textarea v-model="quick.description" class="input" rows="3" placeholder="Tall, plate armour, silver braid. Calm under pressure, dry sense of humour." />
      </div>
      <div class="quick-actions">
        <button class="btn btn-ghost btn-sm" @click="cancelQuickCreate">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="quickSaving || !quick.name.trim() || !quick.description.trim()" @click="saveQuickCreate">
          {{ quickSaving ? 'Creating…' : 'Create Character' }}
        </button>
      </div>
      <div v-if="quickError" class="quick-error">{{ quickError }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { Character } from '../composables/useCharacters.js'

const props = defineProps<{
  projectSlug: string
  episodeCode: string
  modelValue: string[]    // selected character ids
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string[]]
}>()

const cm = useCharacters(() => props.projectSlug)
const { error: showError } = useToast()

const available = ref<Character[]>([])
const loading = ref(false)
const showQuickCreate = ref(false)
const quick = ref({ name: '', description: '' })
const quickSaving = ref(false)
const quickError = ref('')

const selectedSet = computed(() => new Set(props.modelValue))

/** The first reference image is the character's portrait, the same one the roster uses. */
const portraitFailed = ref(new Set<string>())
function portrait(character: Character): string | null {
  const filename = character.references?.images?.[0]
  return filename ? `/api/character-library/${encodeURIComponent(character.id)}/reference-image/${encodeURIComponent(filename)}` : null
}

async function load() {
  if (!props.projectSlug || !props.episodeCode) {
    available.value = []
    return
  }
  loading.value = true
  try {
    available.value = await cm.listForEpisode(props.episodeCode)
  } catch (e: any) {
    showError(`Failed to load characters: ${e?.data?.detail || e?.message || e}`)
  } finally {
    loading.value = false
  }
}

watch([() => props.projectSlug, () => props.episodeCode], load, { immediate: true })

function toggle(id: string) {
  const next = new Set(props.modelValue)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  emit('update:modelValue', [...next])
}

function shortDesc(d: string): string {
  return d.length > 100 ? d.slice(0, 100).trim() + '…' : d
}

function cancelQuickCreate() {
  showQuickCreate.value = false
  quick.value = { name: '', description: '' }
  quickError.value = ''
}

async function saveQuickCreate() {
  quickSaving.value = true
  quickError.value = ''
  try {
    const created = await cm.create({
      name: quick.value.name.trim(),
      description: quick.value.description.trim(),
      scope: 'project',
    })
    available.value = [...available.value, created].sort((a, b) => a.name.localeCompare(b.name))
    // Auto-select the new character.
    emit('update:modelValue', [...props.modelValue, created.id])
    cancelQuickCreate()
  } catch (e: any) {
    quickError.value = e?.data?.detail || e?.message || 'Failed to create'
  } finally {
    quickSaving.value = false
  }
}
</script>

<style scoped>
.character-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.picker-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
  color: var(--text-primary);
}

.picker-label .hint {
  font-size: var(--font-xs);
  color: var(--text-muted);
  font-weight: normal;
  line-height: 1.4;
}

.optional-tag {
  font-size: var(--font-xs);
  text-transform: uppercase;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  margin-left: 6px;
}

.empty-cast {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
  color: var(--text-muted);
}

.picker-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  max-height: 280px;
  overflow-y: auto;
}

.cast-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
}

.cast-row:hover {
  background: var(--bg-tertiary);
}

.cast-portrait {
  flex: 0 0 auto;
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-accent);
}

.cast-portrait img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.cast-portrait-fallback {
  color: var(--accent);
  font-size: 18px;
  font-weight: 700;
}

.cast-info {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12px;
  color: var(--text-primary);
  flex: 1;
}

.cast-desc {
  color: var(--text-muted);
  font-weight: normal;
  font-size: var(--font-xs);
  line-height: 1.4;
  flex-basis: 100%;
  margin-top: 2px;
}

.scope-tag {
  font-size: var(--font-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 4px;
  border-radius: 2px;
}

.scope-tag.scope-project {
  background: rgba(108, 143, 255, 0.12);
  color: var(--accent, #6c8fff);
}

.scope-tag.scope-episode {
  background: rgba(255, 180, 0, 0.10);
  color: #d4a017;
}

.picker-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  margin-top: 4px;
}

.link-sm {
  font-size: var(--font-xs);
  color: var(--accent, #6c8fff);
  text-decoration: none;
}
.link-sm:hover { text-decoration: underline; }

.quick-create {
  margin-top: 6px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quick-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.quick-error {
  padding: 6px 10px;
  background: rgba(226, 92, 92, 0.10);
  color: var(--error, #e25c5c);
  border-radius: 4px;
  font-size: var(--font-xs);
}

.muted { color: var(--text-muted); font-size: 12px; }
</style>
