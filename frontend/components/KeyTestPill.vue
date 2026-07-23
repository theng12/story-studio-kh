<template>
  <span
    v-if="status !== 'untested'"
    class="key-test-pill"
    :class="`key-test-pill--${status}`"
    :title="message || defaultLabel"
    :aria-label="`API key test status: ${defaultLabel}`"
  >
    {{ defaultLabel }}
  </span>
</template>

<script setup lang="ts">
/**
 * Shared status pill for API-key tests. Used by the first-run wizard
 * (Step 3: API Keys) and by Settings → API Keys. The `unreachable` state is
 * deliberately distinct from `invalid`: a timeout or DNS failure gets a
 * yellow warning instead of a red rejection, so the user doesn't re-paste
 * a correct key while their LAN is broken.
 */
export type KeyTestStatus = 'untested' | 'testing' | 'valid' | 'invalid' | 'unreachable'

const props = defineProps<{ status: KeyTestStatus; message?: string }>()

const defaultLabel = computed(() => {
  switch (props.status) {
    case 'testing': return '⏳ Testing…'
    case 'valid': return '✓ Valid'
    case 'invalid': return '✗ Invalid'
    case 'unreachable': return '⚠ Unreachable'
    default: return ''
  }
})
</script>

<style scoped>
.key-test-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: var(--font-xs);
  font-weight: 500;
  vertical-align: middle;
  white-space: nowrap;
}
.key-test-pill--testing {
  background: var(--bg-tertiary);
  color: var(--text-secondary);
}
.key-test-pill--valid {
  background: var(--success-bg, rgba(46, 160, 67, 0.15));
  color: var(--success, #3fb950);
}
.key-test-pill--invalid {
  background: var(--danger-bg, rgba(248, 81, 73, 0.15));
  color: var(--danger, #f85149);
}
.key-test-pill--unreachable {
  background: rgba(251, 191, 36, 0.15);
  color: var(--warning, #fbbf24);
}
</style>
