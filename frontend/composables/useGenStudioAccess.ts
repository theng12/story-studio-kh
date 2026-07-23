import type { GenStudioAccessStatus } from '~/utils/genstudio-relaxed'
import { genStudioPlanNotice, genStudioUnlimitedBadge } from '~/utils/genstudio-relaxed'

const access = ref<GenStudioAccessStatus | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')

/** Shared account entitlement cache used by every GenStudio model picker. */
export function useGenStudioAccess() {
  const { get } = useApi()

  async function refresh(force = false): Promise<void> {
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    error.value = ''
    try {
      access.value = await get<GenStudioAccessStatus>(
        '/app-settings/genstudio/access',
        { cache: 'no-store' },
      )
    } catch (cause: any) {
      access.value = null
      error.value = cause?.data?.detail || cause?.message || 'GenStudio plan status is unavailable.'
    } finally {
      loaded.value = true
      loading.value = false
    }
  }

  const planNotice = computed(() => genStudioPlanNotice(access.value))

  return {
    access: readonly(access),
    loading: readonly(loading),
    loaded: readonly(loaded),
    error: readonly(error),
    planNotice,
    badgeFor: (supportsUnlimited: boolean) => genStudioUnlimitedBadge(supportsUnlimited, access.value),
    refresh,
  }
}
