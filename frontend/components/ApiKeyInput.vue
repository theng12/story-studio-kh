<template>
  <div class="api-key-input">
    <input
      :type="visible ? 'text' : 'password'"
      :value="modelValue"
      :placeholder="placeholder"
      :aria-label="ariaLabel"
      autocomplete="off"
      spellcheck="false"
      class="input key-field"
      @input="onInput"
      @blur="emit('blur')"
    />
    <button
      type="button"
      class="toggle-btn"
      :aria-label="visible ? 'Hide API key' : 'Show API key'"
      :title="visible ? 'Hide' : 'Show'"
      @click="visible = !visible"
    >
      <span aria-hidden="true">{{ visible ? '🙈' : '👁' }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: string
  placeholder?: string
  ariaLabel?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'blur': []
}>()

const visible = ref(false)

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<style scoped>
.api-key-input {
  display: flex;
  align-items: stretch;
  gap: 4px;
}
.key-field {
  flex: 1;
  font-family: 'SF Mono', Monaco, monospace;
  font-size: 12px;
  letter-spacing: 0.5px;
}
.toggle-btn {
  flex-shrink: 0;
  width: 36px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: background 0.15s;
}
.toggle-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.toggle-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
