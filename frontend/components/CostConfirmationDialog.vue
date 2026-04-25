<template>
  <Modal
    :visible="state.visible"
    size="sm"
    :z-index="2000"
    labelledby="cost-dialog-title"
    dialog-class="cost-dialog"
    @close="cancel"
  >
    <div class="modal-header">
      <h3 id="cost-dialog-title">Confirm Generation</h3>
      <button class="modal-close" @click="cancel" aria-label="Close">&times;</button>
    </div>

    <div v-if="state.loading" class="modal-body loading">
      <div class="spinner" />
      <span class="text-muted">Estimating cost...</span>
    </div>

    <div v-else-if="state.estimate" class="modal-body">
      <div class="estimate-type">{{ state.typeLabel }}</div>

      <div class="estimate-grid">
        <div class="estimate-item">
          <div class="estimate-label">Estimated Cost</div>
          <div class="estimate-value cost">
            <template v-if="state.estimate.cost_unit === 'USD'">${{ state.estimate.estimated_cost }}</template>
            <template v-else>{{ state.estimate.estimated_cost }} {{ state.estimate.cost_unit }}</template>
          </div>
        </div>
        <div class="estimate-item">
          <div class="estimate-label">Duration</div>
          <div class="estimate-value">{{ state.estimate.estimated_duration }}</div>
        </div>
        <div v-if="state.estimate.current_balance != null" class="estimate-item">
          <div class="estimate-label">Current Balance</div>
          <div class="estimate-value balance">
            <template v-if="state.estimate.cost_unit === 'USD'">${{ state.estimate.current_balance }}</template>
            <template v-else>{{ state.estimate.current_balance }} {{ state.estimate.cost_unit }}</template>
          </div>
        </div>
      </div>

      <div class="estimate-details">{{ state.estimate.details }}</div>

      <label class="skip-checkbox">
        <input v-model="skipFuture" type="checkbox" />
        <span>Skip confirmation for {{ state.typeLabel }} in the future</span>
      </label>
    </div>

    <div class="modal-footer">
      <button class="btn btn-ghost" @click="cancel">Cancel</button>
      <button class="btn btn-primary" :disabled="state.loading" @click="onConfirm">
        Generate
      </button>
    </div>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Cost estimation + confirmation dialog for generators. Uses the shared
 * Modal primitive for overlay/backdrop/focus-trap/Escape; this component
 * only owns the estimate layout and the "skip future confirmations" toggle.
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
/* The Modal primitive owns the 24px padding; reset it for this dialog because
   we want the classic header / body / footer rhythm with their own inner padding. */
:deep(.cost-dialog) { padding: 0; }

.modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border);
}
.modal-header h3 { margin: 0; font-size: 15px; font-weight: 600; }
.modal-close { background: none; border: none; color: var(--text-muted); font-size: 20px; cursor: pointer; padding: 0 4px; }
.modal-close:hover { color: var(--text-primary); }

.modal-body { padding: 20px; }
.modal-body.loading { display: flex; align-items: center; gap: 12px; padding: 32px 20px; }

.spinner {
  width: 20px; height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.estimate-type {
  font-size: 13px; font-weight: 600; color: var(--accent);
  margin-bottom: 16px;
  text-transform: uppercase; letter-spacing: 0.5px;
}

.estimate-grid {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 12px; margin-bottom: 14px;
}
.estimate-item { background: var(--bg-primary); border-radius: var(--radius-sm); padding: 12px; }
.estimate-label { font-size: 11px; color: var(--text-muted); margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
.estimate-value { font-size: 18px; font-weight: 600; color: var(--text-primary); }
.estimate-value.cost { color: var(--accent); }
.estimate-value.balance { color: var(--text-secondary); font-size: 16px; }

.estimate-details { font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }

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
