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
  /** Optional extra class on the inner dialog container. */
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
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.4);
  padding: 24px;
  width: calc(100% - 48px);
  animation: popIn 0.18s ease-out;
  max-height: calc(100dvh - 48px);
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.size-sm { max-width: 440px; }
.size-md { max-width: 560px; }
.size-lg { max-width: 720px; }
.size-xl { max-width: 880px; }
.size-xxl { max-width: 1120px; }

@media (max-width: 680px) {
  .modal-dialog {
    width: calc(100% - 24px);
    max-height: calc(100dvh - 24px);
    padding: 18px;
  }
}

@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes popIn {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
</style>
