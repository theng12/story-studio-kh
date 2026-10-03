/**
 * Gateway model pools (owner, 2026-10-03). A pool is ONE writing-model choice
 * that the Gateway runs by trying its member models in order until one answers.
 * The Gateway publishes every pool under the `pool::` namespace — the id Story
 * Studio sends back to use one — so that namespace is what marks a pool here.
 */
export const POOL_GROUP_LABEL = 'Pools'
export const POOL_HINT = 'Pool — tries several models'
/** A chargeable pool: free members first, a paid member only when every free one is out. */
export const POOL_PAID_LAST_RESORT_LABEL = 'Free · paid only as last resort'

export function isGatewayPoolId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('pool::')
}

/** Pools first, everything else after, each keeping the catalogue's own order. */
export function poolsFirst<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows.filter(row => isGatewayPoolId(row.id)), ...rows.filter(row => !isGatewayPoolId(row.id))]
}
