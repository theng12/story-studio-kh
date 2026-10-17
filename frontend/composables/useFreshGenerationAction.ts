import { computed, ref } from 'vue'

/** What the owner reads when a paid/queued request was sent but no answer came back. */
export const UNCONFIRMED_SUBMISSION = 'Story Studio sent this request but did not hear back. Click Retry: it resends the same request, so nothing is made or charged twice. Changing the selection starts a new request instead.'

/**
 * One request identity for a paid/queued action, secure in every connection.
 *
 * `crypto.randomUUID` is restricted to secure contexts, so on a plain-HTTP
 * connection (the shop mini, a LAN address) it is simply absent while
 * `crypto.getRandomValues` — the CSPRNG, and not context-restricted — is there.
 * Branching on `randomUUID` alone therefore refuses actions over HTTP that the
 * browser can create safely; every caller of this helper gets the same rule:
 * randomUUID when present, otherwise a CSPRNG UUIDv4, never a Math.random or
 * clock-based identity. Only a browser with neither is refused, and that refusal
 * says what happened rather than guessing at a fix.
 */
export function secureOperationId(): string {
  const browserCrypto = globalThis.crypto
  if (typeof browserCrypto?.randomUUID === 'function') return browserCrypto.randomUUID()
  if (typeof browserCrypto?.getRandomValues !== 'function') {
    const detail = 'This browser cannot create a secure request identity, so nothing was sent.'
    const error = new Error(detail) as Error & { data: { detail: string } }
    error.data = { detail }
    throw error
  }
  const bytes = browserCrypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Keep one deliberate paid-action identity across an unresolved HTTP submit. */
export function useFreshGenerationAction() {
  const pending = ref(new Map<string, { id: string; scope: string }>())
  const hasPending = computed(() => pending.value.size > 0)

  function scopeKey(scope: unknown): string {
    return JSON.stringify(scope)
  }

  function begin(scope: unknown, target = 'default'): string {
    const key = scopeKey(scope)
    const current = pending.value.get(target)
    if (current?.scope === key) return current.id
    const id = secureOperationId()
    pending.value = new Map(pending.value).set(target, { id, scope: key })
    return id
  }

  function complete(id: string): void {
    const next = new Map(pending.value)
    for (const [target, action] of next) if (action.id === id) next.delete(target)
    pending.value = next
  }

  function isRetry(scope: unknown, target = 'default'): boolean {
    return pending.value.get(target)?.scope === scopeKey(scope)
  }

  function cancel(target?: string): void {
    if (!target) pending.value = new Map()
    else {
      const next = new Map(pending.value)
      next.delete(target)
      pending.value = next
    }
  }

  return { pending, hasPending, begin, complete, isRetry, cancel }
}
