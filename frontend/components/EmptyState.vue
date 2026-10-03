<template>
  <!-- Empty, loading and error blocks share one shape: a quiet icon, a
       one-line title, a short detail, and the one action that helps.

         <EmptyState icon="🕘" title="No history yet" message="Past prompt generations appear here." />
         <EmptyState tone="loading" title="Loading jobs…" />
         <EmptyState tone="error" title="Could not load jobs" :message="error">
           <template #action><button class="btn btn-secondary btn-sm" @click="reload">Try Again</button></template>
         </EmptyState>

       `tone` is 'empty' (default) | 'loading' | 'error'. `compact` drops the
       big padding for use inside a card or list. An error's `message` should
       be the server's own sentence, shown verbatim. -->
  <div
    class="empty-state"
    :class="{ 'is-compact': compact }"
    :data-tone="tone"
    :role="tone === 'error' ? 'alert' : 'status'"
    :aria-busy="tone === 'loading' || undefined"
  >
    <LoadingSpinner v-if="tone === 'loading'" size="lg" class="empty-icon" />
    <div v-else-if="icon || tone === 'error'" class="empty-icon" aria-hidden="true">{{ icon || '⚠︎' }}</div>
    <h3 v-if="title" class="empty-title">{{ title }}</h3>
    <p v-if="message" class="empty-message">{{ message }}</p>
    <slot name="action">
      <NuxtLink v-if="actionTo" :to="actionTo" class="btn btn-primary btn-sm">
        {{ actionLabel || 'Get Started' }}
      </NuxtLink>
    </slot>
    <slot />
  </div>
</template>

<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  title?: string
  message?: string
  actionTo?: string
  actionLabel?: string
  tone?: 'empty' | 'loading' | 'error'
  compact?: boolean
}>(), {
  icon: '',
  title: '',
  message: '',
  actionTo: '',
  actionLabel: '',
  tone: 'empty',
  compact: false,
})
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 40px 24px;
  text-align: center;
  background: var(--bg-secondary);
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  color: var(--text-muted);
}
.empty-state.is-compact { padding: 20px 16px; border-radius: var(--radius-md); }
.empty-state[data-tone='loading'] { border-style: solid; }
.empty-state[data-tone='error'] {
  border-style: solid;
  border-color: color-mix(in srgb, var(--error) 40%, var(--border));
  background: color-mix(in srgb, var(--error) 7%, var(--bg-secondary));
}
.empty-icon {
  margin-bottom: 2px;
  color: var(--text-muted);
  font-size: 28px;
  line-height: 1;
  opacity: 0.75;
}
.empty-state[data-tone='error'] .empty-icon { color: var(--error); opacity: 1; }
.empty-title {
  margin: 0;
  color: var(--text-primary);
  font-size: var(--font-lg);
  font-weight: 600;
}
.empty-message {
  max-width: 440px;
  margin: 0;
  font-size: var(--font-sm);
  line-height: 1.5;
}
.empty-state[data-tone='error'] .empty-message { color: var(--text-secondary); }
.empty-state :deep(.btn) { margin-top: var(--space-1); }
</style>
