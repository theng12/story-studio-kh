import { ref } from 'vue'

/**
 * The names of voices this browser has seen, kept across launches.
 *
 * The model pickers have had `useGenStudioModelDisplay` for a while; the voice
 * picker had nothing, so when its catalogue read failed the trigger fell all the
 * way through to the saved value — a raw GenStudio voice id — and presented it
 * to the customer as though it were the name of their voice. This is the same
 * machinery for the same failure, scoped to voices because voices and models are
 * separate catalogues with separate ids and must not share a namespace.
 *
 * Cumulative and never pruned back to nothing on a failed read: a voice that
 * retires from the live catalogue keeps its name here, which is precisely the
 * case where the name matters most.
 */
const STORAGE_KEY = 'genstudio_voice_display_names_v1'
const MAX_REMEMBERED = 2_000

const names = ref<Record<string, string>>({})

/**
 * The store, or null where there isn't one.
 *
 * A capability check rather than a build constant: what this needs to know is
 * whether a storage exists. Private windows and browsers set to block site data
 * land here too, and get the same answer — no remembered names, which is the
 * behaviour this picker had before any of this existed.
 */
function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function readRemembered(): Record<string, string> {
  const storage = store()
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const clean: Record<string, string> = {}
    for (const [id, name] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof name === 'string' && name.trim()) clean[id] = name.trim()
    }
    return clean
  } catch {
    return {}
  }
}

function persist(next: Record<string, string>): void {
  const storage = store()
  if (!storage) return
  try {
    // A hard ceiling so a long-lived install cannot grow this without bound.
    // Insertion order is preserved by JS objects for string keys, so trimming
    // from the front drops the oldest entries first.
    const entries = Object.entries(next)
    const capped = entries.length > MAX_REMEMBERED
      ? Object.fromEntries(entries.slice(entries.length - MAX_REMEMBERED))
      : next
    storage.setItem(STORAGE_KEY, JSON.stringify(capped))
  } catch { /* best effort — a full or blocked store must never break a picker */ }
}

export function useRememberedVoiceNames() {
  /** Load the persisted map into memory. No network, idempotent, cheap. */
  function hydrate(): void {
    const remembered = readRemembered()
    if (!Object.keys(remembered).length) return
    names.value = { ...remembered, ...names.value }
  }

  /** Record names off any successful voice-catalogue read. */
  function remember(entries: Array<{ id?: unknown; name?: unknown }>): void {
    const next: Record<string, string> = {}
    for (const entry of entries || []) {
      const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
      const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
      if (id && name) next[id] = name
    }
    if (!Object.keys(next).length) return
    names.value = { ...readRemembered(), ...names.value, ...next }
    persist(names.value)
  }

  /** The remembered name, or '' — never the raw id. */
  function knownName(voiceId: unknown): string {
    const id = typeof voiceId === 'string' ? voiceId.trim() : ''
    if (!id) return ''
    return names.value[id] || readRemembered()[id] || ''
  }

  return { hydrate, remember, knownName }
}
