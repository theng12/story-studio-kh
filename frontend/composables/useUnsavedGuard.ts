import type { Ref } from 'vue'

/**
 * Keeps hand-edited, manually-saved work from being thrown away by a click.
 *
 * While `dirty` is true: leaving the page, switching project, and closing or reloading the
 * window all ask first (the same "Discard unsaved changes?" pattern as upload/plans.vue).
 * `episodeSwitch` also guards a same-page episode change — pass it only where a change
 * would drop the edits (a page that autosaves on switch does not need it).
 */
export function useUnsavedGuard(dirty: Ref<boolean>, what: string, opts: { episodeSwitch?: boolean } = {}) {
  const { ask } = useConfirm()
  const discard = async (why: string): Promise<boolean> =>
    !dirty.value || !!await ask({
      title: `Discard unsaved ${what}?`,
      message: `Your ${what} have not been saved. ${why}`,
      confirmLabel: 'Discard changes',
      danger: true,
    })
  onBeforeRouteLeave(() => discard('Leave this page?'))
  onBeforeRouteUpdate((to, from) => {
    const episode = (r: typeof to) => String(r.query.episode_id || r.query.episode || '')
    if (to.params.slug !== from.params.slug) return discard('Switch projects anyway?')
    if (opts.episodeSwitch && episode(to) !== episode(from)) return discard('Switch episode anyway?')
    return true
  })
  // Reload / close. Electron's main process turns this into a Stay / Discard prompt.
  const warn = (event: BeforeUnloadEvent) => { if (dirty.value) event.preventDefault() }
  onMounted(() => window.addEventListener('beforeunload', warn))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', warn))
}
