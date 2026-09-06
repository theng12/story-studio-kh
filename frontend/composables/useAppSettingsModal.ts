/**
 * Singleton open/close state for the App Settings modal.
 *
 * Pairs with `components/AppSettingsModal.vue`, which is mounted once in
 * `app.vue`. Any component can `useAppSettingsModal().open()` to surface
 * the modal — no navigation, no layout entanglement, no duplicate state.
 *
 * Mirrors the `useConfirm` pattern (the proven singleton-modal wiring in
 * this codebase) but simpler: there's no promise / no return value, the
 * modal owns its own data lifecycle.
 */
import { ref } from 'vue'

const isOpen = ref(false)
export type AppSettingsSection = 'all' | 'connections' | 'performance' | 'appearance'
const section = ref<AppSettingsSection>('all')

export function useAppSettingsModal() {
  return {
    isOpen,
    section,
    open: (nextSection: AppSettingsSection = 'all') => {
      section.value = nextSection
      isOpen.value = true
    },
    close: () => { isOpen.value = false },
  }
}
