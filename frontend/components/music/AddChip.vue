<!-- "+ Add" that turns into a text box in place (window.prompt is blocked in the desktop app). -->
<template>
  <input
    v-if="open" ref="box" v-model="text" class="mp-inp" :placeholder="placeholder" :aria-label="placeholder"
    style="min-height: 28px; padding: 3px 10px; width: 200px"
    @keydown.enter.prevent="commit" @keydown.esc.prevent="open = false" @blur="commit"
  >
  <button v-else type="button" :class="buttonClass" @click="start">{{ label }}</button>
</template>

<script setup lang="ts">
import { nextTick, ref } from 'vue'
withDefaults(defineProps<{ label?: string; placeholder?: string; buttonClass?: string }>(), {
  label: '+ Add', placeholder: 'Type and press Return', buttonClass: 'mp-chip',
})
const emit = defineEmits<{ add: [value: string] }>()
const open = ref(false)
const text = ref('')
const box = ref<HTMLInputElement | null>(null)
async function start() { open.value = true; text.value = ''; await nextTick(); box.value?.focus() }
function commit() {
  if (!open.value) return
  open.value = false
  const v = text.value.trim()
  if (v) emit('add', v)
}
</script>
