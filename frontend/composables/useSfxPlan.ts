/**
 * Thin wrapper around the SFX sound-layer routes (electron/server/routes/sfx.ts)
 * so the Video Assembly Sound section stays focused on UI.
 */
import { useApi } from './useApi.js'

export type SfxSource = '' | 'pool' | 'freesound' | 'elevenlabs'
export type SfxStatus = 'proposed' | 'matched' | 'empty' | 'user-swapped' | 'muted'

export interface SfxBed {
  label: string
  start_sec: number
  end_sec: number
  source: SfxSource
  pool_id?: string
  clip: string
  gain_db: number
  status: SfxStatus
}
export interface SfxSpot {
  label: string
  at_sec: number
  source: SfxSource
  pool_id?: string
  clip: string
  gain_db: number
  status: SfxStatus
}
export interface SfxPlan {
  schema_version: 1
  enabled: boolean
  beds: SfxBed[]
  spots: SfxSpot[]
}
export interface SfxCandidate {
  pool_id: string
  filename: string
  tags: string[]
}
export interface SfxResolveResult {
  ok: boolean
  plan: SfxPlan
  candidate_count: number
  fetched?: string[]
  fetch_skipped_reason?: string
}

export function useSfxPlan() {
  const { get, post, put, del } = useApi()
  const base = (slug: string, code: string) =>
    `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}`

  return {
    getPlan: (slug: string, code: string) => get<SfxPlan>(`${base(slug, code)}/sfx-plan`),
    savePlan: (slug: string, code: string, plan: SfxPlan) =>
      put<{ ok: boolean; plan: SfxPlan }>(`${base(slug, code)}/sfx-plan`, plan),
    deletePlan: (slug: string, code: string) => del(`${base(slug, code)}/sfx-plan`),
    generate: (slug: string, code: string, body: { model: string; intensity?: string; auto_fetch?: boolean }) =>
      post<SfxResolveResult>(`${base(slug, code)}/sfx-plan/generate`, body),
    resolvePlan: (slug: string, code: string, plan?: SfxPlan, opts?: { auto_fetch?: boolean }) =>
      post<SfxResolveResult>(`${base(slug, code)}/sfx-plan/resolve`, { ...(plan ?? {}), ...(opts ?? {}) }),
    candidates: (slug: string, code: string) =>
      get<{ candidates: SfxCandidate[] }>(`${base(slug, code)}/sfx-candidates`),
  }
}
