/**
 * useRememberedForm (v1.0.259) — remember a generator page's settings across
 * reloads/navigation, PER-MAC (localStorage), keyed by project slug + page.
 *
 * Restores the saved values into the form on setup (synchronously, before child
 * model pickers run their first-usable auto-pick), then auto-saves (debounced)
 * on every change. Episode-specific fields are never persisted, so the
 * remembered "how" (model, aspect, mode, detail, style…) doesn't leak a stale
 * episode/topic across episodes.
 *
 * Safety: a restored value that's no longer valid (e.g. a removed model) is
 * healed by each picker's own fallback — ModelSelector re-picks the first
 * usable model when the current one isn't in the live list. So persistence
 * can't get "stuck" on a gone model.
 *
 * Coexists with usePresets: an active named preset still auto-applies on load
 * (async, after this restore), so a saved preset takes precedence; with no
 * preset, the last-used values stand.
 */
import { watch, isRef } from 'vue'
import type { Ref } from 'vue'
import { peekDefaultModels } from './useDefaultModels.js'

const ALWAYS_EXCLUDE = ['episode_id', 'episodeId', 'episode', 'title']

export interface RememberOpts {
  /** Persist ONLY these keys (allowlist). Use on forms that mix global
   *  settings with per-episode values (e.g. Scripts: length/chapters come from
   *  the idea and must NOT be remembered across episodes). When set, `exclude`
   *  is ignored. */
  include?: string[]
  /** Extra keys to never persist (used when `include` is not set). */
  exclude?: string[]
  /**
   * Keys whose value is an OPEN map — its keys are not declared by the page.
   *
   * The default one-level merge below only copies sub-keys that already exist
   * on the target, which is right for a nested sub-form with a declared shape
   * (a new default field survives an old saved blob). It is wrong for a map
   * keyed by catalogue-owned names, such as the Audio page's published TTS
   * controls: the page declares none of those names, so nothing would ever be
   * restored. Keys listed here are restored wholesale instead. Whatever comes
   * back must still be reconciled against the live catalogue by the page.
   */
  openMapKeys?: string[]
  /** Bump to invalidate previously-saved shapes for this page. */
  version?: number
  /** Debounce for the auto-save (ms). */
  debounceMs?: number
}

export function useRememberedForm(
  pageKey: string,
  slug: Ref<string> | string,
  /** A `ref({...})` or a `reactive({...})` holding the page's settings. */
  form: Ref<Record<string, any>> | Record<string, any>,
  opts: RememberOpts = {},
) {
  const include = opts.include ? new Set(opts.include) : null
  const exclude = new Set([...(opts.exclude ?? []), ...ALWAYS_EXCLUDE])
  const ver = opts.version ?? 1
  const debounceMs = opts.debounceMs ?? 250
  const slugVal = (): string => (typeof slug === 'string' ? slug : slug.value) || ''
  const storageKey = (): string => `ssk:form:${slugVal()}:${pageKey}:v${ver}`
  // Resolve the plain settings object whether `form` is a ref or a reactive.
  const obj = (): Record<string, any> => (isRef(form) ? (form as any).value : (form as any))
  // A key is persisted if it's on the allowlist (when set) and not excluded.
  const wanted = (k: string): boolean => (include ? include.has(k) : !exclude.has(k))
  const isPlain = (v: any): boolean =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
  // Merge a saved value into the live form. For nested sub-forms (e.g.
  // images' thumbnail/scene) merge key-by-key so a NEW default field that
  // wasn't in the saved blob survives, instead of being wiped by a wholesale
  // object replace. One level deep is enough for our forms.
  const openMapKeys = new Set(opts.openMapKeys ?? [])
  const merge = (target: Record<string, any>, k: string, v: any): void => {
    if (openMapKeys.has(k) && isPlain(v)) {
      target[k] = { ...v }
    } else if (isPlain(target[k]) && isPlain(v)) {
      for (const [ck, cv] of Object.entries(v)) {
        if (ck in target[k]) target[k][ck] = cv
      }
    } else {
      target[k] = v
    }
  }

  function restore(): void {
    if (typeof window === 'undefined' || !slugVal()) return
    try {
      const raw = window.localStorage.getItem(storageKey())
      if (!raw) return
      const saved = JSON.parse(raw)
      if (!saved || typeof saved !== 'object') return
      const target = obj()
      for (const [k, v] of Object.entries(saved)) {
        if (!wanted(k)) continue
        if (k in target) merge(target, k, v)
      }
    } catch { /* corrupt / unavailable — ignore */ }
  }

  function persist(): void {
    if (typeof window === 'undefined' || !slugVal()) return
    try {
      const out: Record<string, any> = {}
      for (const [k, v] of Object.entries(obj())) {
        if (!wanted(k)) continue
        out[k] = v
      }
      dropAppDefaults(out)
      window.localStorage.setItem(storageKey(), JSON.stringify(out))
    } catch { /* quota / serialization — ignore */ }
  }

  /**
   * A page's settings are remembered; the app-wide default model is NOT.
   *
   * Settings → Default models is the LAST link of the precedence chain
   * (`precedence: the preset's model → this page's remembered choice → the default`), so a page
   * that opened with the default filled in must not save that value as though the owner had chosen
   * it. If it did, the remembered choice would outrank the default from then on and changing the
   * default would never reach this page again — AGENTS §1, a value cached past the moment the
   * selection changes.
   *
   * Matched by VALUE at the top level and one level down (the thumbnail sub-form), because the
   * stored form does not know which family each key belongs to. Model ids are unique across
   * families, so comparing against all six is unambiguous.
   *
   * KNOWN LIMIT: this cannot tell "the default filled it" from "the owner picked exactly the
   * default by hand". Both are dropped, so after the default changes this page follows the new one.
   * That is the behaviour the setting promises, and the alternative — the page silently pinning a
   * default forever — is the defect this exists to prevent.
   */
  function dropAppDefaults(target: Record<string, any>): void {
    const defaults = new Set(
      Object.values(peekDefaultModels().value).filter((id): id is string => typeof id === 'string' && !!id),
    )
    if (!defaults.size) return
    const isDefault = (value: unknown): boolean => typeof value === 'string' && defaults.has(value)
    for (const [k, v] of Object.entries(target)) {
      if (isDefault(v)) { delete target[k]; continue }
      if (isPlain(v)) {
        for (const [ck, cv] of Object.entries(v as Record<string, any>)) {
          if (isDefault(cv)) delete (v as Record<string, any>)[ck]
        }
      }
    }
  }

  function clear(): void {
    if (typeof window === 'undefined') return
    try { window.localStorage.removeItem(storageKey()) } catch { /* ignore */ }
  }

  // Restore immediately on setup so the model picker's auto-pick sees the
  // remembered value (a non-empty model stops it falling to first-usable).
  restore()

  let timer: ReturnType<typeof setTimeout> | null = null
  watch(form, () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(persist, debounceMs)
  }, { deep: true })

  return { restore, persist, clear }
}
