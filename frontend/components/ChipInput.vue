<template>
  <div class="chip-input" ref="rootEl">
    <div class="chip-area" @click="focusInput">
      <span v-for="(tag, i) in modelValue" :key="tag + i" class="chip">
        {{ tag }}
        <button type="button" class="chip-remove" @click.stop="remove(i)" aria-label="Remove tag">&times;</button>
      </span>
      <input
        ref="inputEl"
        v-model="query"
        class="chip-field"
        :placeholder="modelValue.length === 0 ? (placeholder || 'Add…') : ''"
        @keydown.enter.prevent="commitTyped"
        @keydown.backspace="onBackspace"
        @keydown.comma.prevent="commitTyped"
        @focus="open = true"
      />
    </div>
    <div v-if="open && filteredSuggestions.length" class="chip-suggest" role="listbox">
      <button
        v-for="s in filteredSuggestions"
        :key="s"
        type="button"
        class="chip-suggest-item"
        @click="add(s)"
      >
        {{ s }}
      </button>
    </div>
    <div v-if="open && query.trim() && allowCustom && !suggestions.includes(query.trim()) && !modelValue.includes(query.trim())" class="chip-add-custom">
      Press <kbd>Enter</kbd> to add “{{ query.trim() }}”
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string[]
  suggestions: string[]
  placeholder?: string
  allowCustom?: boolean
  max?: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string[]): void
  (e: 'add-custom', v: string): void
}>()

const query = ref('')
const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

const filteredSuggestions = computed(() => {
  const q = query.value.trim().toLowerCase()
  const taken = new Set(props.modelValue)
  return props.suggestions
    .filter(s => !taken.has(s))
    .filter(s => !q || s.toLowerCase().includes(q))
    .slice(0, 10)
})

function focusInput() {
  inputEl.value?.focus()
  open.value = true
}

function add(tag: string) {
  const t = tag.trim()
  if (!t) return
  if (props.modelValue.includes(t)) return
  if (props.max && props.modelValue.length >= props.max) return
  emit('update:modelValue', [...props.modelValue, t])
  query.value = ''
  if (!props.suggestions.includes(t)) emit('add-custom', t)
}

function remove(i: number) {
  const next = props.modelValue.slice()
  next.splice(i, 1)
  emit('update:modelValue', next)
}

function commitTyped() {
  const v = query.value.trim()
  if (!v) return
  if (!props.allowCustom && !props.suggestions.includes(v)) return
  add(v)
}

function onBackspace() {
  if (query.value === '' && props.modelValue.length) {
    remove(props.modelValue.length - 1)
  }
}

function onClickOutside(e: MouseEvent) {
  if (!rootEl.value?.contains(e.target as Node)) open.value = false
}

onMounted(() => { document.addEventListener('click', onClickOutside) })
onBeforeUnmount(() => { document.removeEventListener('click', onClickOutside) })
</script>

<style scoped>
.chip-input { position: relative; width: 100%; }

.chip-area {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 6px 8px;
  min-height: 38px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: text;
}
.chip-area:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(240, 198, 116, 0.15);
}

.chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 3px 8px 3px 10px;
  background: rgba(240, 198, 116, 0.12);
  border: 1px solid rgba(240, 198, 116, 0.25);
  border-radius: 999px;
  color: var(--accent);
  font-size: 12px; font-weight: 500;
}

.chip-remove {
  background: transparent; border: none;
  color: var(--accent); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px;
  opacity: 0.7;
}
.chip-remove:hover { opacity: 1; }

.chip-field {
  flex: 1; min-width: 120px;
  background: transparent; border: none; outline: none;
  color: var(--text-primary);
  font-size: 13px;
}

.chip-suggest {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  z-index: 50;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-height: 240px; overflow-y: auto;
  padding: 4px 0;
}

.chip-suggest-item {
  display: block; width: 100%; text-align: left;
  padding: 6px 12px;
  background: transparent; border: none;
  color: var(--text-primary);
  font-size: 13px; cursor: pointer;
}
.chip-suggest-item:hover { background: var(--bg-hover); color: var(--accent); }

.chip-add-custom {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  z-index: 50;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-size: 12px;
}
.chip-add-custom kbd {
  display: inline-block;
  padding: 1px 6px; margin: 0 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: 3px;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 10px;
}
</style>
