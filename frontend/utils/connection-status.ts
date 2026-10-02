import type { GatewayReachability } from '../composables/useNetworkStatus.js'

export interface ConnectionStatus {
  tone: 'online' | 'offline' | 'unknown'
  label: string
  /** A visible next step; empty when there is nothing to do. */
  hint: string
}

/**
 * The one wording for "can Story Studio do AI work right now", shared by the sidebar and the header
 * strip so the two never disagree. The local engine comes first (if it is down nothing works), then
 * the Gateway, which every generation goes through.
 */
export function connectionStatus(engineOnline: boolean, gateway: GatewayReachability, gatewayUrl = ''): ConnectionStatus {
  if (!engineOnline) {
    return {
      tone: 'offline',
      label: 'Story Studio engine not answering',
      hint: 'Quit and reopen Story Studio. Your projects stay on disk.',
    }
  }
  if (gateway === 'unreachable') {
    return {
      tone: 'offline',
      label: 'Gateway not reachable',
      hint: `Open the Gateway app${gatewayUrl ? ` (${gatewayUrl})` : ''}. AI work cannot start until it answers; this updates by itself.`,
    }
  }
  if (gateway === 'reachable') return { tone: 'online', label: 'Gateway connected', hint: '' }
  return { tone: 'unknown', label: 'Checking the Gateway…', hint: '' }
}
