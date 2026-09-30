<template>
  <Modal
    :visible="state.visible"
    size="sm"
    :z-index="2000"
    labelledby="generation-dialog-title"
    dialog-class="generation-dialog modal-flush"
    @close="cancel"
  >
    <div class="modal-header">
      <h3 id="generation-dialog-title">Confirm action</h3>
      <button class="modal-close" @click="cancel" aria-label="Close">&times;</button>
    </div>

    <div class="modal-body">
      <p class="action-copy">{{ state.action || `Start ${state.typeLabel}?` }}</p>

      <dl v-if="state.details.length" class="action-details">
        <div v-for="detail in state.details" :key="detail.label" class="action-detail">
          <dt>{{ detail.label }}</dt>
          <dd>{{ detail.value }}</dd>
        </div>
      </dl>

      <label v-if="!state.always" class="skip-checkbox">
        <input v-model="skipFuture" type="checkbox" />
        <span>Skip confirmation for {{ state.typeLabel }} in the future</span>
      </label>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" @click="cancel">Cancel</button>
      <button class="btn btn-primary" @click="onConfirm">
        Confirm
      </button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Action-only confirmation dialog for generation. It never fetches pricing
 * or sends a preflight request; GenStudio handles admission at submission.
 */
const { state, confirm, cancel } = useConfirmation()
const skipFuture = ref(false)

// Reset the skip checkbox each time the dialog is re-opened — a user who
// checked it for one generation type shouldn't carry that intent into the next.
watch(() => state.visible, (visible) => {
  if (visible) skipFuture.value = false
})

function onConfirm() {
  confirm(skipFuture.value)
}
</script>

<style scoped>
/* The dialog's own padding reset comes from Modal's `modal-flush` hook on the
   tag above. It cannot be done from in here: the dialog is teleported to
   <body>, so `:deep(.generation-dialog)` emits `[data-v-…] .generation-dialog`
   and matches nothing. The bands below paint their own padding instead. */
.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.modal-close { background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer; padding: 0 4px; }
.modal-close:hover { color: var(--text-primary); }

.modal-body { padding: 20px; }
.action-copy { margin: 0 0 16px; color: var(--text-secondary); font-size: 14px; }
.action-details {
  display: grid;
  gap: 6px;
  margin: -6px 0 16px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary);
}
.action-detail { display: grid; grid-template-columns: 70px minmax(0, 1fr); gap: 10px; }
.action-detail dt { color: var(--text-muted); font-size: var(--font-xs); }
.action-detail dd { margin: 0; color: var(--text-primary); font-size: var(--font-xs); overflow-wrap: anywhere; }

.skip-checkbox {
  display: flex; align-items: center; gap: 8px;
  font-size: 12px; color: var(--text-secondary);
  cursor: pointer;
}
.skip-checkbox input { accent-color: var(--accent); }

.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 12px 20px;
  border-top: 1px solid var(--border);
}
</style>
