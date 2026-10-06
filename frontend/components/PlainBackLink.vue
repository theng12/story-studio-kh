<template>
  <a :href="fallback" class="plain-back-link" @click.prevent="goBack">← {{ label }}</a>
</template>

<script setup lang="ts">
/**
 * The top-left "back" of a page with no sidebar (1.4.257). Goes back in the
 * app's own history when there is one, else to `fallback`. Escape and ⌘[ do
 * the same — except while typing in a field or with a dialog open, where
 * Escape belongs to them.
 */
import { onMounted, onUnmounted } from 'vue'
import { wantsBack } from '~/utils/plain-back'

const props = withDefaults(defineProps<{ label?: string; fallback?: string }>(), { label: 'Back', fallback: '/' })
const router = useRouter()

function goBack(): void {
  if (window.history.state?.back) router.back()
  else void router.push(props.fallback)
}

function onKeydown(event: KeyboardEvent): void {
  if (!wantsBack(event)) return
  event.preventDefault()
  goBack()
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))
</script>

<style scoped>
.plain-back-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: var(--font-sm);
  text-decoration: underline;
  text-underline-offset: 4px;
}
.plain-back-link:hover { color: var(--text-primary); }
</style>
