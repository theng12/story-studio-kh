import { createHash } from 'node:crypto'
import type { Job } from '../models/types.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function readOperationId(body: unknown, required: boolean): string | null {
  if (!required) return null
  return readOptionalOperationId(body, true)
}

export function readOptionalOperationId(body: unknown, required = false): string | null {
  const value = body && typeof body === 'object' && typeof (body as any).operation_id === 'string'
    ? (body as any).operation_id.trim()
    : ''
  if (!value) {
    if (required) throw new Error('This fresh generation action requires a valid operation_id UUID.')
    return null
  }
  if (!UUID_V4.test(value)) throw new Error('operation_id must be a valid UUID.')
  return value
}

export function freshActionFingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function stampFreshGenerationAction<T extends Record<string, any>>(
  params: T,
  operationId: string,
): T & { generation_action: { id: string; kind: 'fresh' }; generation_action_fingerprint: string } {
  const clean = { ...params }
  delete clean.operation_id
  delete clean.generation_action
  delete clean.generation_action_fingerprint
  return {
    ...clean,
    generation_action: { id: operationId, kind: 'fresh' },
    generation_action_fingerprint: freshActionFingerprint(clean),
  }
}

export function findFreshActionJob(jobs: Job[], operationId: string): Job | undefined {
  return jobs.find(job => job.params?.generation_action?.id === operationId)
}

export function freshGenerationRequestIdentity(job: Job, purpose: string): string | undefined {
  const action = job.params?.generation_action
  return action?.kind === 'fresh' && typeof action.id === 'string'
    ? `${job.project_slug}:${job.episode_id || 'project'}:fresh:${action.id}:${purpose}`
    : undefined
}
