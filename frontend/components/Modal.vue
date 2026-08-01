<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="modal-overlay"
      :style="{ zIndex }"
      @click.self="handleBackdropClick"
    >
      <div
        ref="dialogRef"
        class="modal-dialog"
        :class="[`size-${size}`, dialogClass]"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="labelledby"
      >
        <slot />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
/**
 * Shared modal primitive.
 *
 * Every in-app dialog goes through this — it's the single source of truth
 * for cross-cutting modal behaviour: Teleport to <body>, backdrop overlay,
 * click-outside-to-cancel, Escape-to-cancel, focus trap (via useFocusTrap),
 * fade-in / pop-in animations, z-index layering.
 *
 * Children own their content, their title, and their action buttons. The
 * primitive never renders chrome it doesn't need — a simple save-as prompt
 * can slot raw inputs directly; a cost confirmation can stack a rich grid.
 *
 * Opinionated defaults:
 *   - `closeOnBackdrop` / `closeOnEscape` default to true — override only
 *     when the flow genuinely can't be abandoned (e.g., migration prompt).
 *   - `size` is 'sm' / 'md' / 'lg' / 'xl' / 'xxl' mapped to max-widths; all dialogs honour
 *     the same 24px internal padding so they feel like the same family.
 *
 * Styling contract (read this before fighting the cascade):
 *   - Every *cosmetic* default (background, border, radius, shadow, padding,
 *     width, max-width, max-height, overflow) lives in the unscoped block
 *     below wrapped in `:where(...)`, which contributes ZERO specificity. A
 *     consumer that writes a plain `.my-dialog { padding: 0 }` in an unscoped
 *     style block and passes `dialog-class="my-dialog"` simply wins. No
 *     `.modal-overlay > .modal-dialog.my-dialog` gymnastics needed.
 *   - Structural / behavioural rules (overlay positioning + backdrop, flex
 *     centring, the flex-shrink guard, the open animation) stay in the scoped
 *     block at full specificity so a consumer cannot silently break the modal
 *     contract with a one-class rule.
 *   - `modal-flush` is the supported shorthand for the most common override:
 *     pass it through `dialog-class` to drop the dialog's internal padding
 *     when the consumer renders its own header / body / footer bands.
 *
 * NOTE for consumers: because the dialog is teleported to <body>, it never
 * carries the consumer's scope id — `:deep(.my-dialog)` compiles to
 * `[data-v-consumer] .my-dialog` and matches nothing. Style the dialog from
 * an unscoped `<style>` block instead.
 */
const props = withDefaults(defineProps<{
  /** Drives render + focus trap. Parent owns the state. */
  visible: boolean
  /** 'sm' 440px (default), 'md' 560px, 'lg' 720px, 'xl' 880px, 'xxl' 1120px. */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl'
  /** Override z-index if a modal must stack above another. Default 2000. */
  zIndex?: number
  /** Cancel the dialog when the user clicks outside it. Default true. */
  closeOnBackdrop?: boolean
  /** Cancel the dialog on Escape. Default true. */
  closeOnEscape?: boolean
  /** id of the content's heading, for assistive tech. */
  labelledby?: string
  /**
   * Optional extra class(es) on the inner dialog container. Space-separated,
   * so `dialog-class="my-dialog modal-flush"` both names the dialog for the
   * consumer's own rules and opts out of the default 24px padding.
   */
  dialogClass?: string
}>(), {
  size: 'sm',
  zIndex: 2000,
  closeOnBackdrop: true,
  closeOnEscape: true,
})

const emit = defineEmits<{ (e: 'close'): void }>()

const dialogRef = ref<HTMLElement | null>(null)
const visibleRef = computed(() => props.visible)

// Focus trap: first focusable inside becomes the initial target, Tab wraps,
// Escape fires the provided callback. We re-emit `close` instead of mutating
// state ourselves so the parent stays in charge of the lifecycle.
useFocusTrap(dialogRef, visibleRef, () => {
  if (props.closeOnEscape) emit('close')
})

function handleBackdropClick() {
  if (props.closeOnBackdrop) emit('close')
}
</script>

<!--
  Structural + behavioural rules. Scoped, so they emit as
  `.modal-overlay[data-v-…]` (0,2,0) and a consumer's single class cannot
  silently take them over: the backdrop's fixed positioning and centring,
  the flex-shrink guard that stops long content blowing the dialog out of
  the viewport, and the open animation (its @keyframes name is hashed by the
  scoped transform, so the `animation` shorthand has to live in here too).
-->
<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn 0.15s;
}

.modal-dialog {
  min-width: 0;
  animation: popIn 0.18s ease-out;
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes popIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>

<!--
  Cosmetic defaults. Deliberately unscoped and wrapped in `:where(...)` so
  every declaration here has ZERO specificity: a consumer's plain
  `.my-dialog { … }` (0,1,0) beats it without any selector gymnastics, and
  a consumer that writes nothing keeps the house style. `.modal-dialog` is
  rendered nowhere else in the app, so going unscoped leaks nothing.

  Order matters inside this block — everything is (0,0,0), so later rules
  win: sizes, then the small-screen overrides, then the `modal-flush`
  opt-out last so it survives the media query.
-->
<style>
:where(.modal-dialog) {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  padding: 24px;
  width: calc(100% - 48px);
  max-height: calc(100dvh - 48px);
  overflow-x: hidden;
  overflow-y: auto;
}

:where(.modal-dialog.size-sm) { max-width: 440px; }
:where(.modal-dialog.size-md) { max-width: 560px; }
:where(.modal-dialog.size-lg) { max-width: 720px; }
:where(.modal-dialog.size-xl) { max-width: 880px; }
:where(.modal-dialog.size-xxl) { max-width: 1120px; }

@media (max-width: 680px) {
  :where(.modal-dialog) {
    width: calc(100% - 24px);
    max-height: calc(100dvh - 24px);
    padding: 18px;
  }
}

/* Explicit API for the commonest override: a dialog that paints its own
   header / body / footer bands edge-to-edge. Pass `modal-flush` through
   `dialog-class`. */
:where(.modal-dialog.modal-flush) { padding: 0; }
</style>
