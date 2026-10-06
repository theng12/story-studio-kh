/**
 * Escape or ⌘[ asks a sidebar-less page to go back — unless the key belongs to
 * something else: a field being typed in (Escape only), an open dialog, or a
 * handler that already took it.
 */
export function wantsBack(event: KeyboardEvent, doc: Document = document): boolean {
  if (event.defaultPrevented) return false
  const escape = event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey
  const bracket = event.metaKey && event.key === '['
  if (!escape && !bracket) return false
  const target = event.target as HTMLElement | null
  if (escape && target?.closest?.('input, textarea, select, [contenteditable="true"]')) return false
  return !doc.querySelector('[role="dialog"], dialog[open]')
}
