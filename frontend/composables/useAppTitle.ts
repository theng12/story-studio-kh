import type { MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'

/**
 * Centralised page-title composable. Replaces 19 hardcoded
 * `useHead({ title: 'X — Story Studio KH' })` calls across pages.
 *
 * The product name is read from `runtimeConfig.public.appName` (set in
 * nuxt.config.ts), so a future rebrand / whitelabel touches one place.
 *
 * Pass a string, ref, or getter:
 *   useAppTitle('Audio Generator')                  // → "Audio Generator — Story Studio KH"
 *   useAppTitle()                                   // → "Story Studio KH"
 *   useAppTitle(computed(() => brand.value?.name))  // reactive — refreshes as the ref changes
 *
 * Empty / nullish page titles fall back to just the app name (no trailing dash).
 */
export function useAppTitle(pageTitle?: MaybeRefOrGetter<string | null | undefined>) {
  const { public: pub } = useRuntimeConfig()
  const appName = (pub.appName as string | undefined) || 'Story Studio KH'
  useHead(() => {
    const t = toValue(pageTitle)
    return { title: t ? `${t} — ${appName}` : appName }
  })
}
