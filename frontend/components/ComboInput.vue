<template>
  <div class="combo-input" ref="rootEl">
    <div class="combo-trigger" :class="{ open }" @click="toggleOpen">
      <span v-if="modelValue" class="combo-value">{{ modelValue }}</span>
      <span v-else class="combo-placeholder">{{ placeholder || 'Select…' }}</span>
      <span class="combo-chev" aria-hidden="true">▾</span>
    </div>
    <div v-if="open" class="combo-popover" role="listbox">
      <input
        v-if="searchable"
        ref="searchEl"
        v-model="query"
        class="combo-search"
        :placeholder="searchPlaceholder || 'Search or type to add…'"
        @keydown.enter.prevent="onEnter"
        @keydown.escape.prevent="open = false"
      />
      <div class="combo-options">
        <button
          v-for="opt in filteredOptions"
          :key="opt"
          type="button"
          class="combo-option"
          :class="{ active: opt === modelValue }"
          @click="pick(opt)"
        >
          {{ opt }}
        </button>
        <div v-if="filteredOptions.length === 0" class="combo-empty">
          No matches. Press Enter or click below to add.
        </div>
      </div>
      <button
        v-if="allowCustom && query.trim() && !options.includes(query.trim())"
        type="button"
        class="combo-add-custom"
        @click="addCustom"
      >
        + Add “{{ query.trim() }}”
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  options: string[]
  placeholder?: string
  searchPlaceholder?: string
  searchable?: boolean
  allowCustom?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'add-custom', v: string): void
}>()

const open = ref(false)
const query = ref('')
const rootEl = ref<HTMLElement | null>(null)
const searchEl = ref<HTMLInputElement | null>(null)

const filteredOptions = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return props.options
  return props.options.filter(o => o.toLowerCase().includes(q))
})

function toggleOpen() {
  open.value = !open.value
  if (open.value) {
    query.value = ''
    nextTick(() => searchEl.value?.focus())
  }
}

function pick(v: string) {
  emit('update:modelValue', v)
  open.value = false
}

function addCustom() {
  const v = query.value.trim()
  if (!v) return
  emit('update:modelValue', v)
  emit('add-custom', v)
  open.value = false
}

function onEnter() {
  if (filteredOptions.value.length === 1) {
    pick(filteredOptions.value[0]!)
  } else if (props.allowCustom && query.value.trim()) {
    addCustom()
  }
}

function onClickOutside(e: MouseEvent) {
  if (!rootEl.value?.contains(e.target as Node)) open.value = false
}

onMounted(() => { document.addEventListener('click', onClickOutside) })
onBeforeUnmount(() => { document.removeEventListener('click', onClickOutside) })
</script>

<style scoped>
.combo-input { position: relative; width: 100%; }

.combo-trigger {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 14px;
  transition: border-color 0.15s;
}
.combo-trigger:hover { border-color: var(--accent); }
.combo-trigger.open { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(240, 198, 116, 0.15); }
.combo-value { flex: 1; color: var(--text-primary); }
.combo-placeholder { flex: 1; color: var(--text-muted); }
.combo-chev { color: var(--text-muted); font-size: var(--font-xs); }

.combo-popover {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  z-index: 50;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  max-height: 320px;
  display: flex; flex-direction: column;
  overflow: hidden;
}

.combo-search {
  border: none; border-bottom: 1px solid var(--border);
  padding: 10px 12px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
}

.combo-options {
  overflow-y: auto;
  flex: 1;
  padding: 4px 0;
}

.combo-option {
  display: block; width: 100%; text-align: left;
  padding: 8px 12px;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.1s;
}
.combo-option:hover { background: var(--bg-hover); }
.combo-option.active { background: rgba(240, 198, 116, 0.12); color: var(--accent); font-weight: 500; }

.combo-empty {
  padding: 10px 12px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

.combo-add-custom {
  border: none;
  border-top: 1px solid var(--border);
  padding: 10px 12px;
  background: rgba(240, 198, 116, 0.08);
  color: var(--accent);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.combo-add-custom:hover { background: rgba(240, 198, 116, 0.15); }
</style>
