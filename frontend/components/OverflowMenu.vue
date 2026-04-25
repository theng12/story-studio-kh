<!--
  Compact `⋯` button that opens a dropdown of menu items. Used by the
  toolbar strip to collapse preset actions (Apply / Save / Save as / Delete)
  into a single trigger so the bar stays one row tall.

  Items are passed as a prop so the consumer keeps full control of labels,
  disabled states, and click handlers. Closes on outside click, Escape, or
  after invoking an item.
-->
<template>
  <span class="overflow-menu" :class="{ open }">
    <button
      ref="btnEl"
      type="button"
      class="overflow-trigger"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="menu"
      @click="toggle"
    >
      <slot name="trigger">⋯</slot>
    </button>
    <div
      v-if="open"
      ref="menuEl"
      class="overflow-pane"
      role="menu"
      :style="paneStyle"
    >
      <button
        v-for="(item, i) in items"
        :key="i"
        type="button"
        role="menuitem"
        class="overflow-item"
        :class="{ danger: item.danger }"
        :disabled="item.disabled"
        :title="item.title"
        @click="invoke(item)"
      >
        {{ item.label }}
      </button>
    </div>
  </span>
</template>

<script setup lang="ts">
type OverflowItem = {
  label: string
  onClick: () => void | Promise<void>
  disabled?: boolean
  danger?: boolean
  title?: string
}

withDefaults(defineProps<{
  items: OverflowItem[]
  ariaLabel?: string
}>(), {
  ariaLabel: 'More actions',
})

const open = ref(false)
const btnEl = ref<HTMLButtonElement | null>(null)
const menuEl = ref<HTMLDivElement | null>(null)
const paneStyle = ref<Record<string, string>>({})

function toggle() {
  open.value = !open.value
  if (open.value) nextTick(position)
}
function close() { open.value = false }

function invoke(item: OverflowItem) {
  if (item.disabled) return
  close()
  // Defer so the menu is fully closed before the handler can open a modal etc.
  Promise.resolve().then(() => item.onClick())
}

function position() {
  if (!btnEl.value || !menuEl.value) return
  const r = btnEl.value.getBoundingClientRect()
  const p = menuEl.value.getBoundingClientRect()
  // Right-align under the button, clamp to viewport.
  let left = r.right - p.width
  left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8))
  const top = r.bottom + 4
  paneStyle.value = { left: `${left}px`, top: `${top}px`, position: 'fixed' }
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (btnEl.value?.contains(t) || menuEl.value?.contains(t)) return
  close()
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) close()
}

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
})
</script>

<style scoped>
.overflow-menu {
  display: inline-flex;
  position: relative;
}
.overflow-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 1px solid var(--border);
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.overflow-trigger:hover { background: var(--bg-hover); color: var(--text-primary); }
.overflow-menu.open .overflow-trigger { background: var(--bg-hover); color: var(--text-primary); border-color: var(--accent); }
.overflow-pane {
  z-index: 250;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.overflow-item {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  font-size: 12.5px;
  border-radius: 5px;
  cursor: pointer;
  transition: background 0.12s;
  font-family: inherit;
}
.overflow-item:hover:not(:disabled) { background: var(--bg-hover); }
.overflow-item:disabled { color: var(--text-muted); cursor: not-allowed; opacity: 0.6; }
.overflow-item.danger { color: var(--error, #ef4444); }
.overflow-item.danger:hover:not(:disabled) { background: rgba(239, 68, 68, 0.08); }
</style>
