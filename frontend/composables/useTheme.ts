/**
 * Theme composable — singleton store for the user's chosen appearance
 * mode (light / dark / system) plus the resolved theme that's actually
 * applied to <html data-theme>.
 *
 * v1.0.147+ — companion to `plugins/theme.client.ts` which does the
 * initial sync DOM stamp before first paint (so the user never sees the
 * wrong theme flash). This composable owns the runtime mutations:
 * setMode() persists to localStorage and re-applies, and the watcher
 * on `prefers-color-scheme` reacts live whenever `mode === 'system'`.
 *
 * Mode vs resolved:
 *   - `mode`     = what the user picked ('light' | 'dark' | 'system')
 *   - `resolved` = what's actually applied to the DOM ('light' | 'dark')
 *
 * 'system' resolves via `matchMedia('(prefers-color-scheme: light)')` —
 * when the OS flips at sunset (macOS Auto appearance), the live MQ
 * listener re-stamps without needing a reload.
 *
 * Storage key + matchMedia query are duplicated in `plugins/theme.client.ts`
 * (intentionally — that plugin runs as an inline-ish boot blob and must be
 * standalone). Keep them in sync. Constants are exported from this module
 * so a future refactor can de-dup if Nuxt grows a synchronous-pre-render
 * plugin hook we can share with.
 */
import { ref, readonly, computed } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'story-studio:theme'
const SYSTEM_LIGHT_MQ = '(prefers-color-scheme: light)'

// Module-scope singletons so every component sees the same reactive state.
const mode = ref<ThemeMode>('system')
const resolved = ref<ResolvedTheme>('dark')
let mqListenerAttached = false
let mq: MediaQueryList | null = null

function readSystemPreference(): ResolvedTheme {
  if (typeof window === 'undefined') return 'dark'
  try {
    return window.matchMedia(SYSTEM_LIGHT_MQ).matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function resolveMode(m: ThemeMode): ResolvedTheme {
  if (m === 'light' || m === 'dark') return m
  return readSystemPreference()
}

function applyToDOM(r: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', r)
  // color-scheme tells the engine which built-in form-control / scrollbar
  // palette to use. Without this, light mode would still show dark
  // native <select> chevrons + dark scrollbar thumbs on macOS.
  document.documentElement.style.colorScheme = r
}

function ensureMqListener(): void {
  if (mqListenerAttached || typeof window === 'undefined') return
  try {
    mq = window.matchMedia(SYSTEM_LIGHT_MQ)
    const handler = (): void => {
      // Only react when the user wants to follow system. Explicit
      // light/dark picks shouldn't flip with the OS.
      if (mode.value === 'system') {
        const next = readSystemPreference()
        resolved.value = next
        applyToDOM(next)
      }
    }
    // Modern API + Safari/older WebKit fallback.
    if (typeof mq.addEventListener === 'function') mq.addEventListener('change', handler)
    else if (typeof (mq as any).addListener === 'function') (mq as any).addListener(handler)
    mqListenerAttached = true
  } catch {
    /* matchMedia unavailable — fail-quiet, system mode falls back to last resolved */
  }
}

/**
 * Initialize the composable from whatever the boot plugin already
 * stamped onto the DOM. Idempotent — calling repeatedly is a no-op
 * after the first run. The plugin invokes this on app mount.
 */
export function _initTheme(): void {
  if (typeof window === 'undefined') return
  let savedRaw: string | null = null
  try { savedRaw = localStorage.getItem(THEME_STORAGE_KEY) } catch { /* ignore */ }
  const savedMode: ThemeMode =
    savedRaw === 'light' || savedRaw === 'dark' || savedRaw === 'system'
      ? savedRaw
      : 'system'
  mode.value = savedMode
  const r = resolveMode(savedMode)
  resolved.value = r
  applyToDOM(r)
  ensureMqListener()
}

export function useTheme() {
  function setMode(next: ThemeMode): void {
    mode.value = next
    try { localStorage.setItem(THEME_STORAGE_KEY, next) } catch { /* ignore */ }
    const r = resolveMode(next)
    resolved.value = r
    applyToDOM(r)
    ensureMqListener()
  }

  return {
    mode: readonly(mode),
    resolved: readonly(resolved),
    /** True when the user is letting the OS pick. */
    isSystem: computed(() => mode.value === 'system'),
    setMode,
  }
}
