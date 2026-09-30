<template>
  <div class="toast-container" role="status" aria-live="polite">
    <div
      v-for="toast in toasts"
      :key="toast.id"
      :title="toast.raw"
      :class="['toast', `toast-${toast.type}`, { 'has-undo': !!toast.onUndo, 'has-action': !!toast.action }]"
    >
      <span class="toast-message">{{ toast.message }}</span>
      <button
        v-if="toast.onUndo"
        type="button"
        class="toast-undo"
        @click="toast.onUndo"
      >
        Undo
      </button>
      <button
        v-else-if="toast.action"
        type="button"
        class="toast-undo"
        @click="toast.action.onClick"
      >
        {{ toast.action.label }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * Floating toast stack. Renders whatever `useToast` pushes into its state.
 *
 * Undoable toasts (those with an `onUndo` handler) render an inline button;
 * clicking it triggers the caller-provided rollback and closes the toast.
 * The button is focusable so keyboard users can Tab to it from the main
 * content area while the toast is visible.
 *
 * Also registers a global Cmd+Z (macOS) / Ctrl+Z (others) shortcut that
 * invokes the most recent undoable toast's `onUndo`. Deferred text-edit
 * undo (in inputs, textareas, contenteditable) takes priority — we only
 * fire when focus is on non-editable surface so the shortcut never steals
 * from a user typing in a form.
 */
const { toasts } = useToast()

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  return false
}

function onKeydown(ev: KeyboardEvent) {
  // Cmd+Z on macOS, Ctrl+Z elsewhere. Shift+Cmd+Z is redo — leave it alone.
  if (ev.key !== 'z' && ev.key !== 'Z') return
  if (ev.shiftKey) return
  const mod = ev.metaKey || ev.ctrlKey
  if (!mod) return
  // Don't hijack text-edit undo in forms.
  if (isEditableTarget(ev.target)) return

  // Find the most recent undoable toast. `toasts.value` is ordered by
  // insertion, so the last undoable entry wins.
  const list = toasts.value
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i]
    if (t && typeof t.onUndo === 'function') {
      ev.preventDefault()
      t.onUndo()
      return
    }
  }
  // No undoable toast — let the browser/OS handle the keypress normally.
}

if (import.meta.client) {
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
</script>

<style scoped>
.toast-container {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  z-index: 2500;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.4;
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  min-width: 280px;
  max-width: 420px;
  animation: slideIn 0.22s ease-out;
}
.toast-message { flex: 1; color: var(--text-primary); }

.toast-success { border-left: 3px solid #22c55e; }
.toast-error   { border-left: 3px solid #ef4444; }
.toast-info    { border-left: 3px solid var(--accent); }

/* Undo button — pill-styled, accent-colored so the eye catches it within
   the 5-second window. Focus state is prominent for keyboard users. */
.toast-undo {
  flex-shrink: 0;
  padding: 4px 12px;
  background: transparent;
  border: 1px solid var(--accent);
  border-radius: 999px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.toast-undo:hover {
  background: var(--accent);
  color: #0f1117;
}
.toast-undo:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

@keyframes slideIn {
  from { transform: translateX(20px); opacity: 0; }
  to   { transform: translateX(0);    opacity: 1; }
}
</style>
