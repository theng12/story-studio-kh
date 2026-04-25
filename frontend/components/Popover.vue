<!--
  Hover/focus-triggered popover. Used by the toolbar strip to surface
  per-control explanations (preset values, episode status, generate
  action description) without cluttering the bar itself.

  Trigger goes in the default slot, popover body in the `content` slot.
  Stays open while hovering EITHER the trigger or the popover so the
  user can read longer explanations without it dismissing mid-glance.
-->
<template>
  <span
    ref="rootEl"
    class="popover-root"
    @mouseenter="open"
    @mouseleave="scheduleClose"
    @focusin="open"
    @focusout="onFocusOut"
  >
    <slot />
    <Teleport to="body">
      <div
        v-if="visible"
        ref="popoverEl"
        class="popover-pane"
        :style="paneStyle"
        role="tooltip"
        @mouseenter="cancelClose"
        @mouseleave="scheduleClose"
      >
        <slot name="content" />
      </div>
    </Teleport>
  </span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  placement?: 'bottom' | 'top'
}>(), { placement: 'bottom' })

const visible = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const popoverEl = ref<HTMLElement | null>(null)
const paneStyle = ref<Record<string, string>>({})

let closeTimer: ReturnType<typeof setTimeout> | null = null

function open() {
  cancelClose()
  visible.value = true
  nextTick(position)
}
function scheduleClose() {
  cancelClose()
  closeTimer = setTimeout(() => { visible.value = false }, 120)
}
function cancelClose() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
}
function onFocusOut(e: FocusEvent) {
  // Close only when focus leaves both the trigger and popover.
  const next = e.relatedTarget as Node | null
  if (next && (rootEl.value?.contains(next) || popoverEl.value?.contains(next))) return
  scheduleClose()
}

function position() {
  if (!rootEl.value || !popoverEl.value) return
  const r = rootEl.value.getBoundingClientRect()
  const p = popoverEl.value.getBoundingClientRect()
  // Center horizontally on the trigger, clamped to viewport with 8px gutter.
  let left = r.left + r.width / 2 - p.width / 2
  left = Math.max(8, Math.min(left, window.innerWidth - p.width - 8))
  const top = r.bottom + 8
  paneStyle.value = { left: `${left}px`, top: `${top}px` }
}

onUnmounted(cancelClose)
</script>

<style scoped>
.popover-root {
  display: inline-flex;
  align-items: center;
}
</style>

<style>
/* Unscoped — pane is teleported to body, so scoped attrs wouldn't apply. */
.popover-pane {
  position: fixed;
  z-index: 300;
  max-width: 320px;
  padding: 10px 12px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32);
  font-size: 12px;
  line-height: 1.45;
  color: var(--text-secondary);
  pointer-events: auto;
}
.popover-pane strong { color: var(--text-primary); }
.popover-pane .popover-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.popover-pane .popover-row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 1px 0;
}
.popover-pane .popover-row .label { color: var(--text-muted); }
.popover-pane .popover-status {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.popover-pane .popover-status .item { white-space: nowrap; }
.popover-pane .popover-status .ok { color: var(--accent); }
.popover-pane .popover-status .pending { color: var(--text-muted); }
</style>
