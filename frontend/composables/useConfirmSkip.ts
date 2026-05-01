/**
 * Confirm dialog with a persistent "don't ask again" checkbox.
 *
 * Thin wrapper over `useConfirm` that pre-checks the project's
 * `confirmation_preferences` map before showing the dialog (skipping it
 * when the user has opted out) and writes the pref back when they tick
 * the checkbox. The same map is what the Settings → Confirmations tab
 * toggles, so re-enabling a dismissed dialog is a one-click trip through
 * settings — no hidden localStorage, no per-key flag sprawl.
 *
 * Usage:
 *   const { askSkippable } = useConfirmSkip()
 *   if (!await askSkippable({
 *     skipKey: 'reveal_folder',
 *     title: 'Open in Finder?',
 *     message: 'This will open the job output folder in Finder.',
 *   })) return
 *
 * Kept separate from `useConfirm` because this one needs project context
 * (slug, config, api) and must not be imported from node:test — the core
 * composable stays test-friendly.
 */

import type { ConfirmOptions } from './useConfirm'

export interface SkippableConfirmOptions {
  /** Key into `config.confirmation_preferences`. Set to `false` there to
   *  skip the dialog. Same namespace as generator cost dialogs. */
  skipKey: string
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
  rememberLabel?: string
}

export function useConfirmSkip() {
  const { ask, consumeRemember } = useConfirm()
  const { config, refreshConfig } = useProject()
  const { put } = useApi()
  const route = useRoute()

  async function askSkippable(opts: SkippableConfirmOptions): Promise<boolean> {
    const slug = route.params.slug as string
    const prefs = config.value?.confirmation_preferences || {}
    // `false` means the user ticked "don't ask again" previously. Default
    // (undefined or true) means confirm as usual.
    if (prefs[opts.skipKey] === false) return true

    // Build the options object piecemeal — passing an explicit `undefined`
    // for confirmLabel/cancelLabel would clobber useConfirm's defaults via
    // the spread inside `ask()`, leaving the buttons with empty text.
    const askOpts: ConfirmOptions = {
      title: opts.title,
      remember: { label: opts.rememberLabel || "Don't ask again" },
    }
    if (opts.message !== undefined) askOpts.message = opts.message
    if (opts.confirmLabel !== undefined) askOpts.confirmLabel = opts.confirmLabel
    if (opts.cancelLabel !== undefined) askOpts.cancelLabel = opts.cancelLabel
    if (opts.danger !== undefined) askOpts.danger = opts.danger
    const confirmed = await ask(askOpts)

    // Only persist the skip when the user confirmed AND checked the box.
    // Cancel-with-box-checked must NOT set the pref — otherwise a mis-click
    // silently disables the guardrail for future clicks too.
    if (confirmed && consumeRemember() && slug) {
      const next = { ...prefs, [opts.skipKey]: false }
      try {
        await put(`/projects/${slug}/settings/config`, { confirmation_preferences: next })
        await refreshConfig(slug)
      } catch { /* best-effort — dialog already accepted */ }
    }

    return confirmed
  }

  return { askSkippable }
}
