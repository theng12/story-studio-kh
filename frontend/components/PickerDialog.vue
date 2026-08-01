<template>
  <Modal
    :visible="visible"
    :size="size"
    :z-index="zIndex"
    :labelledby="titleId"
    dialog-class="picker-dialog"
    @close="emit('close')"
  >
    <div class="pd-shell">
      <header class="pd-head" :class="`tone-${tone}`">
        <div class="pd-head-copy">
          <p class="pd-title-row">
            <span v-if="kind" class="pd-kind" aria-hidden="true">{{ kind }}</span>
            <strong :id="titleId">{{ title }}</strong>
          </p>
          <p v-if="description" class="pd-description">{{ description }}</p>
        </div>
        <div class="pd-head-side">
          <span v-if="count" class="pd-count">{{ count }}</span>
          <slot name="actions" />
          <button type="button" class="pd-close" :aria-label="closeLabel" @click="emit('close')">×</button>
        </div>
      </header>

      <div class="pd-body">
        <slot />
      </div>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Centred dialog shell for the app's pickers (models, voices).
 *
 * These lists used to open as panels anchored to their trigger, which meant a
 * trigger near the bottom of the window got a few hundred pixels of list — two
 * or three rows out of a dozen. A picker is a *choice among many*, so it is
 * sized by the viewport instead: the dialog grows to a generous maximum and the
 * list scrolls inside it, no matter where the trigger sits.
 *
 * Everything cross-cutting (Teleport, backdrop, backdrop-click, Escape, focus
 * trap, focus restore) comes from `Modal`; this component only adds the picker
 * chrome — a header that names the list, an optional count, an actions slot and
 * a close control — plus the flex column that lets the body scroll on its own.
 *
 * Callers own the search field and the list, and put both in the default slot
 * so they can wire their own keyboard navigation across the two.
 */
let sequence = 0

const props = withDefaults(defineProps<{
  visible: boolean
  /** Names the dialog for assistive tech and reads as its heading. */
  title: string
  /** Optional second line under the title — where this list comes from. */
  description?: string
  /** Short uppercase tag (TTS, IMG…) shown before the title. */
  kind?: string
  /** Right-hand summary, e.g. "7 available". */
  count?: string
  /** 'lg' 720px, 'xl' 880px. Wider lists take 'xl'. */
  size?: 'lg' | 'xl'
  /** Tints the header rule so a cloud list reads differently from a local one. */
  tone?: 'accent' | 'success'
  closeLabel?: string
  /**
   * Above every other dialog (Modal 2000, ConfirmDialog 2100) and above the
   * toast stack, because a picker is frequently opened from inside one of them.
   */
  zIndex?: number
}>(), {
  description: '',
  kind: '',
  count: '',
  size: 'lg',
  tone: 'accent',
  closeLabel: 'Close',
  zIndex: 2600,
})

const emit = defineEmits<{ close: [] }>()

const titleId = `picker-dialog-title-${(sequence += 1)}`
</script>

<style scoped>
.pd-shell {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}
.pd-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 18px 13px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-raised);
}
.pd-head.tone-accent { border-bottom-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
.pd-head.tone-success { border-bottom-color: color-mix(in srgb, var(--success) 38%, var(--border)); }
.pd-head-copy { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
.pd-title-row { display: flex; min-width: 0; align-items: center; gap: 9px; margin: 0; }
.pd-title-row strong { font-size: 15px; line-height: 1.3; overflow-wrap: anywhere; }
.pd-kind {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--surface-accent);
  color: var(--accent);
  font-size: var(--font-xs);
  font-weight: 800;
  letter-spacing: .08em;
}
.pd-description { margin: 0; color: var(--text-muted); font-size: var(--font-xs); line-height: 1.45; }
.pd-head-side { display: flex; flex: 0 0 auto; align-items: center; gap: 9px; }
.pd-count { color: var(--text-muted); font-size: var(--font-xs); white-space: nowrap; }
.pd-close {
  display: grid;
  width: 30px;
  height: 30px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--bg-primary);
  color: var(--text-muted);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.pd-close:hover { border-color: var(--accent); color: var(--text-primary); }
.pd-body { display: flex; min-height: 0; flex: 1; flex-direction: column; }

@media (max-width: 680px) {
  .pd-head { padding: 13px 14px 11px; }
  .pd-count { display: none; }
}
</style>

<style>
/*
 * Unscoped because it lands on Modal's own dialog element, which is teleported
 * to <body> and so never carries this component's scope id. A plain class is
 * all it takes: Modal's cosmetic defaults are `:where(...)`-wrapped (0,0,0),
 * so these (0,1,0) declarations win outright.
 *
 * The dialog is sized by the viewport, not by its contents: it grows to a
 * generous cap (Modal's `size-lg` / `size-xl` max-width, and the height cap
 * below) and stops, and on a short window it simply takes what the window has.
 * `max-height` rather than `height` so a two-item list is not a mostly-empty
 * box, and `overflow: hidden` so the body's own scroller is the only one.
 */
.picker-dialog {
  display: flex;
  width: calc(100% - 40px);
  max-height: min(760px, calc(100dvh - 40px));
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}

@media (max-width: 680px) {
  .picker-dialog {
    width: calc(100% - 20px);
    max-height: calc(100dvh - 20px);
  }
}
</style>
