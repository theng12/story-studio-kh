<template>
  <div v-if="modelValue" class="iedit-overlay" @click.self="close">
    <div class="iedit-modal" role="dialog" aria-modal="true" aria-labelledby="image-edit-unavailable-title">
      <div class="iedit-header">
        <h3 id="image-edit-unavailable-title">Image editing unavailable</h3>
        <button type="button" class="btn-icon" aria-label="Close" @click="close">✕</button>
      </div>
      <div class="iedit-body">
        <p>
          Image editing will return after GenStudio exposes and qualifies a secure image-edit API.
        </p>
        <p class="text-muted">
          Story Studio will not send this image or your credentials directly to a cloud provider.
        </p>
      </div>
      <div class="iedit-footer">
        <button type="button" class="btn btn-sm btn-primary" @click="close">Close</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  modelValue: boolean
  projectSlug: string
  imagePath: string
}>()

const emit = defineEmits<{
  'update:modelValue': [open: boolean]
  accepted: [newPath: string]
}>()

function close() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
.iedit-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: grid;
  place-items: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.62);
}

.iedit-modal {
  width: min(520px, 100%);
  border: 1px solid var(--border-color, #d8d8d8);
  border-radius: 14px;
  background: var(--surface, #fff);
  color: var(--text-primary, #171717);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.24);
}

.iedit-header,
.iedit-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
}

.iedit-header {
  border-bottom: 1px solid var(--border-color, #e5e5e5);
}

.iedit-header h3,
.iedit-body p {
  margin: 0;
}

.iedit-body {
  display: grid;
  gap: 10px;
  padding: 18px;
}

.iedit-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--border-color, #e5e5e5);
}
</style>
