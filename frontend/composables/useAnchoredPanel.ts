interface AnchoredPanelOptions {
  minWidth?: number
  maxWidth?: number
  maxHeight?: number
  gap?: number
}

/** Positions a teleported menu against its trigger without inheriting card overflow. */
export function useAnchoredPanel(
  open: Ref<boolean>,
  anchorEl: Ref<HTMLElement | null>,
  panelEl: Ref<HTMLElement | null>,
  options: AnchoredPanelOptions = {},
) {
  const panelStyle = ref<Record<string, string>>({})

  function positionPanel() {
    if (!open.value || !anchorEl.value || typeof window === 'undefined') return

    const gutter = 12
    const gap = options.gap ?? 8
    const anchor = anchorEl.value.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maxAvailableWidth = Math.max(240, viewportWidth - gutter * 2)
    const width = Math.min(
      maxAvailableWidth,
      Math.max(Math.min(options.minWidth ?? 400, maxAvailableWidth), Math.min(anchor.width, options.maxWidth ?? 640)),
    )
    const left = Math.max(gutter, Math.min(anchor.left, viewportWidth - width - gutter))
    const below = Math.max(0, viewportHeight - anchor.bottom - gap - gutter)
    const above = Math.max(0, anchor.top - gap - gutter)
    const openAbove = below < 280 && above > below
    const availableHeight = openAbove ? above : below
    const maxHeight = Math.max(140, Math.min(options.maxHeight ?? 620, availableHeight))

    panelStyle.value = {
      left: `${Math.round(left)}px`,
      width: `${Math.round(width)}px`,
      maxHeight: `${Math.round(maxHeight)}px`,
      ...(openAbove
        ? { bottom: `${Math.round(viewportHeight - anchor.top + gap)}px`, top: 'auto' }
        : { top: `${Math.round(anchor.bottom + gap)}px`, bottom: 'auto' }),
    }
  }

  watch(open, async (visible) => {
    if (!visible) return
    await nextTick()
    positionPanel()
    panelEl.value?.focus({ preventScroll: true })
  })

  onMounted(() => {
    window.addEventListener('resize', positionPanel)
    window.addEventListener('scroll', positionPanel, true)
  })
  onBeforeUnmount(() => {
    window.removeEventListener('resize', positionPanel)
    window.removeEventListener('scroll', positionPanel, true)
  })

  return { panelStyle, positionPanel }
}
