<template>
  <!-- v1.0.185 (S2) — thin wrapper. The body moved into <ThisMacSettings>
       (shared with the project Settings page's "This Mac" zone). This modal
       remains as the slug-less entry point used from the all-projects index +
       characters page, where no project Settings page is available yet. The
       inner component owns its own data lifecycle (loads on mount), so this
       wrapper only manages visibility. -->
  <Modal
    :visible="modal.isOpen.value"
    size="xxl"
    dialog-class="app-settings-dialog modal-flush"
    labelledby="app-settings-title"
    @close="modal.close()"
  >
    <header class="modal-header">
      <h2 id="app-settings-title">Settings — This Mac</h2>
      <button
        type="button"
        class="modal-close"
        aria-label="Close"
        title="Close"
        @click="modal.close()"
      >×</button>
    </header>

    <!-- Re-mounted each open (:key) so the inner component re-fetches keys —
         reflects edits made elsewhere since last open. -->
    <div class="modal-body">
      <ThisMacSettings v-if="modal.isOpen.value" :key="openCount" />
    </div>

    <footer class="modal-footer">
      <button type="button" class="btn btn-secondary" @click="modal.close()">Close</button>
    </footer>
  </Modal>
</template>

<script setup lang="ts">
/**
 * Singleton App-Settings modal, mounted once in app.vue and opened from any
 * component via `useAppSettingsModal().open()`. v1.0.185 — the actual settings
 * UI now lives in <ThisMacSettings> (reused by the project Settings page); this
 * wrapper is just the modal shell + a re-mount key so each open re-fetches.
 */
import { ref, watch } from 'vue'

const modal = useAppSettingsModal()

// Bump on each open so the inner component remounts and reloads its data.
const openCount = ref(0)
watch(modal.isOpen, (now) => { if (now) openCount.value++ })
</script>

<style scoped>
.modal-header {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 24px 12px;
  border-bottom: 1px solid var(--border);
}
.modal-header h2 { margin: 0; font-size: 18px; font-weight: 600; }
.modal-close {
  background: transparent;
  border: 0;
  padding: 4px 8px;
  font-size: 22px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
  border-radius: 6px;
  transition: background 0.15s, color 0.15s;
}
.modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }
.modal-body {
  min-width: 0;
  min-height: 0;
  padding: 16px 24px;
  overflow-x: hidden;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.modal-footer {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 12px 24px 20px;
  border-top: 1px solid var(--border);
}

@media (max-width: 680px) {
  .modal-header { padding: 16px 16px 10px; }
  .modal-body { padding: 12px 16px; }
  .modal-footer { padding: 10px 16px 16px; }
}
</style>

<!--
  Unscoped because it lands on Modal's own dialog element, which is teleported
  to <body> and so never carries this component's scope id. A plain class is
  enough: Modal's cosmetic defaults are `:where(...)`-wrapped (0,0,0), so
  these (0,1,0) declarations win outright. The padding reset comes from
  Modal's `modal-flush` hook on the tag above — the header / body / footer
  bands paint their own padding edge-to-edge.
-->
<style>
.app-settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(1120px, calc(100vw - 32px));
  max-height: calc(100dvh - 32px);
  overflow: hidden;
}
</style>
