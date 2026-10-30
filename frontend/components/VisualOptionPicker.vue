<template>
  <div class="vop">
    <button
      type="button" class="select vop-trigger" :id="triggerId" :disabled="disabled"
      aria-haspopup="dialog" :aria-expanded="open" @click="open = true"
    >
      <span class="vop-trigger-label">{{ currentLabel }}</span>
      <span class="vop-caret" aria-hidden="true">▾</span>
    </button>

    <PickerDialog
      :visible="open" :title="title" :description="description" :kind="kind"
      :count="`${options.length} options`" :size="size" @close="open = false"
    >
      <div class="vop-grid">
        <button
          v-for="o in options" :key="o.value" type="button" class="vop-card"
          :aria-pressed="o.value === modelValue" @click="pick(o.value)"
        >
          <span class="vop-sample" aria-hidden="true"><slot name="sample" :option="o" /></span>
          <strong class="vop-label">{{ o.label }}</strong>
        </button>
      </div>
    </PickerDialog>
  </div>
</template>

<script setup lang="ts">
/**
 * The card-popup form of a small option list: a trigger that reads like the
 * select it replaced, and a `PickerDialog` of cards, each carrying a drawn
 * sample of what the option does.
 *
 * Callers keep owning their option list (it comes from wherever it came from
 * before) and their sample art through the `sample` slot; picking emits the
 * value and the parent keeps writing it, so saved values never move.
 *
 * Open state lives here: nothing else in the app needs to open or close one of
 * these, and keeping it inside means a page adds one element per list.
 */
const props = withDefaults(defineProps<{
  options: Array<{ value: string; label: string }>
  modelValue: string
  title: string
  description?: string
  kind?: string
  size?: 'lg' | 'xl'
  disabled?: boolean
  /** Labelled by a `<label for>` in the page; the id belongs on the button. */
  triggerId?: string
}>(), {
  description: '',
  kind: '',
  size: 'lg',
  disabled: false,
  triggerId: '',
})

const emit = defineEmits<{ 'update:modelValue': [value: string]; pick: [value: string] }>()

defineSlots<{ sample(props: { option: { value: string; label: string } }): any }>()

const open = ref(false)

/** The saved value's own label; a value the list does not carry shows raw. */
const currentLabel = computed(() => {
  const hit = props.options.find(o => o.value === props.modelValue)
  return hit ? hit.label : (props.modelValue || '')
})

function pick(value: string) {
  emit('update:modelValue', value)
  // Second emit for pages that must react to the choice itself (saving);
  // v-model alone carries the value.
  emit('pick', value)
  open.value = false
}
</script>

<style scoped>
.vop { display: block; min-width: 0; }
.vop-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  text-align: left;
  cursor: pointer;
}
.vop-trigger-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vop-caret { flex: 0 0 auto; color: var(--text-muted); font-size: 11px; }
.vop-grid {
  display: grid;
  min-height: 0;
  flex: 1;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 12px;
  padding: 16px;
  overflow-y: auto;
}
.vop-card {
  display: grid;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-primary);
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}
.vop-card:hover { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
.vop-card[aria-pressed='true'] { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.vop-sample {
  display: grid;
  aspect-ratio: 16 / 9;
  place-items: center;
  overflow: hidden;
  border-radius: 6px;
  background: #12151c;
}
.vop-label { font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
</style>
