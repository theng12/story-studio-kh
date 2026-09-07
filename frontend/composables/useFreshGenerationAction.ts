import { computed, ref } from 'vue'

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
    const id = crypto.randomUUID()
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
