/**
 * Co-writer chat history — localStorage-backed, per-project.
 *
 * The Co-writer page (v1.0.271) held `messages` as a component-local ref,
 * so navigating away (Audio / Scenes / any tab switch) unmounted the
 * component and lost the conversation. Users had to re-explain context
 * every time they came back, defeating the "develop an idea over time"
 * promise of the feature.
 *
 * Persistence shape:
 *   - `localStorage["cowriter:<slug>:messages"]`  — JSON-encoded message array
 *   - `localStorage["cowriter:<slug>:model"]`     — last picked model id
 *
 * Per-project keying means switching projects doesn't bleed conversations
 * across them, and the same Mac running multiple projects keeps them
 * separate. Per-machine (not iCloud-synced) — if you want cross-Mac
 * threads later, the upgrade path is a backend sidecar without changing
 * this composable's call sites.
 *
 * Module-scoped cache keyed by slug so multiple mounts of the same page
 * within a session don't double-read localStorage. The Map also lets a
 * single conversation survive cheap component re-mounts (HMR, route
 * params changing) without going through the JSON round-trip.
 */

import { ref, watch, type Ref } from 'vue'

export interface CowriterMessage {
  role: 'user' | 'assistant'
  content: string
}

interface CowriterThreadState {
  messages: Ref<CowriterMessage[]>
  model: Ref<string>
  clear: () => void
}

// One cached thread per slug. Survives component unmount/remount within
// the same app session — even before localStorage rehydrates on reload.
const threadsBySlug = new Map<string, CowriterThreadState>()

// localStorage size guard: a runaway conversation could in theory blow
// past the ~5 MB quota. We cap at 200 messages, dropping the OLDEST when
// over (chat-app convention — the recent context is what matters for the
// next reply). Each message averages ~200 chars, so 200 messages is
// ~40 KB — well under quota with headroom for thousands of conversations.
const MAX_MESSAGES = 200

function safeLoadMessages(slug: string): CowriterMessage[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(`cowriter:${slug}:messages`)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Defensive shape-check — bad localStorage data shouldn't crash the page.
    return parsed.filter(
      (m): m is CowriterMessage =>
        m && typeof m === 'object'
        && (m.role === 'user' || m.role === 'assistant')
        && typeof m.content === 'string',
    )
  } catch {
    return []
  }
}

function safeLoadModel(slug: string): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    return localStorage.getItem(`cowriter:${slug}:model`) || ''
  } catch {
    return ''
  }
}

function safeSaveMessages(slug: string, messages: CowriterMessage[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    // Trim from the front if needed — most-recent context matters most.
    const trimmed = messages.length > MAX_MESSAGES
      ? messages.slice(messages.length - MAX_MESSAGES)
      : messages
    localStorage.setItem(`cowriter:${slug}:messages`, JSON.stringify(trimmed))
  } catch {
    // Quota exceeded or storage disabled — silent fail. The conversation
    // still works in-memory; only persistence is lost. We could surface a
    // toast here but it'd be noisy on every send for a quota-stuck user.
  }
}

function safeSaveModel(slug: string, model: string): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (model) localStorage.setItem(`cowriter:${slug}:model`, model)
    else localStorage.removeItem(`cowriter:${slug}:model`)
  } catch {
    /* silent */
  }
}

/**
 * Get the persistent co-writer thread for a project slug. Reactive — wire
 * the returned `messages` ref straight into v-for and template logic.
 *
 * Mutate via `messages.value.push(...)` etc.; the watcher persists on
 * every change. Call `clear()` to wipe both the in-memory state and the
 * localStorage entries.
 */
export function useCowriterHistory(slug: string): CowriterThreadState {
  if (!slug) {
    // Defensive — never seen in practice, but if the page is mounted before
    // the route param resolves, return a non-persisted state rather than
    // crashing. The page's own watchEffect will re-call with the real slug.
    const messages = ref<CowriterMessage[]>([])
    const model = ref('')
    return { messages, model, clear: () => { messages.value = []; model.value = '' } }
  }

  const cached = threadsBySlug.get(slug)
  if (cached) return cached

  const messages = ref<CowriterMessage[]>(safeLoadMessages(slug))
  const model = ref<string>(safeLoadModel(slug))

  // Deep watch — every push / splice / individual-message edit lands.
  watch(messages, (next) => { safeSaveMessages(slug, next) }, { deep: true })
  watch(model, (next) => { safeSaveModel(slug, next) })

  const state: CowriterThreadState = {
    messages,
    model,
    clear: () => {
      messages.value = []
      // Don't clear the model — user almost always wants to keep their
      // model selection when starting a fresh chat.
      if (typeof localStorage !== 'undefined') {
        try { localStorage.removeItem(`cowriter:${slug}:messages`) } catch { /* silent */ }
      }
    },
  }

  threadsBySlug.set(slug, state)
  return state
}
