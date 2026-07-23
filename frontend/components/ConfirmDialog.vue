<template>
  <Modal
    :visible="state.visible"
    size="sm"
    :z-index="2100"
    labelledby="confirm-title"
    @close="cancel"
  >
    <h3 id="confirm-title" class="confirm-title">{{ state.options.title }}</h3>
    <p v-if="state.options.message" class="confirm-message">{{ state.options.message }}</p>
    <label v-if="state.options.remember" class="confirm-remember">
      <input
        type="checkbox"
        :checked="state.rememberChecked"
        @change="toggleRemember"
      />
      <span>{{ state.options.remember.label || "Don't ask again" }}</span>
    </label>
    <div class="confirm-actions">
      <button class="btn btn-ghost" @click="cancel">
        {{ state.options.cancelLabel }}
      </button>
      <button
        class="btn"
        :class="state.options.danger ? 'btn-danger' : 'btn-primary'"
        @click="confirm"
      >
        {{ state.options.confirmLabel }}
      </button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Global confirm dialog. Mounted once in app.vue and driven by useConfirm.
 * Replaces window.confirm() — themed, focus-trapped (via the shared Modal
 * primitive), Escape closes, Enter confirms.
 *
 * z-index is 2100 so destructive confirmations always stay on top.
 */
const { state, confirm, cancel, toggleRemember } = useConfirm()

// Enter confirms (except when focus is on the Cancel button — then the
// browser's default button-activation wins).
function onKeydown(ev: KeyboardEvent) {
  if (!state.visible) return
  if (ev.key !== 'Enter') return
  const target = document.activeElement as HTMLElement | null
  if (target?.textContent?.trim() === state.options.cancelLabel) return
  ev.preventDefault()
  confirm()
}

if (import.meta.client) {
  onMounted(() => window.addEventListener('keydown', onKeydown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
}
</script>

<style scoped>
.confirm-title {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary);
}

.confirm-message {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
  white-space: pre-line;
}

.confirm-remember {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: -8px 0 16px;
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
  user-select: none;
}
.confirm-remember input {
  accent-color: var(--accent);
  cursor: pointer;
}

.confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
}
.btn-ghost {
  background: transparent;
  border-color: var(--border);
  color: var(--text-secondary);
}
.btn-ghost:hover { background: var(--bg-hover); color: var(--text-primary); }
.btn-primary {
  background: var(--accent);
  color: #0f1117;
}
.btn-primary:hover { filter: brightness(1.08); }
.btn-danger {
  background: #ef4444;
  color: #fff;
}
.btn-danger:hover { background: #dc2626; }
</style>
