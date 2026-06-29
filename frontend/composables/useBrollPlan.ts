/**
 * Wrapper around the scripted-broll shot-plan routes (routes/broll-shots.ts).
 */
import { useApi } from './useApi.js'

export type BrollSource = '' | 'pexels' | 'pixabay' | 'nasa' | 'ai-gen' | 'substitute'
export type BrollBeatStatus = 'proposed' | 'matched' | 'empty' | 'user-swapped'

export interface BrollBeat {
  start_sec: number
  end_sec: number
  line: string
  queries: string[]
  source: BrollSource
  pool_id?: string
  clip: string
  in_point_sec: number
  status: BrollBeatStatus
}
export interface BrollPlan {
  schema_version: 1
  enabled: boolean
  broll_style: string
  beats: BrollBeat[]
}
export interface GenerateResult {
  ok: boolean
  plan: BrollPlan
  beat_count: number
  downloaded?: number
  matched?: number
  pool_id?: string
  resolve_skipped_reason?: string
}

export function useBrollPlan() {
  const { get, post, put, del } = useApi()
  const base = (slug: string, code: string) =>
    `/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}`

  return {
    getPlan: (slug: string, code: string) => get<BrollPlan>(`${base(slug, code)}/broll-plan`),
    savePlan: (slug: string, code: string, plan: BrollPlan) =>
      put<{ ok: boolean; plan: BrollPlan }>(`${base(slug, code)}/broll-plan`, plan),
    deletePlan: (slug: string, code: string) => del(`${base(slug, code)}/broll-plan`),
    generate: (slug: string, code: string, body: { model: string; broll_style?: string; style_hint?: string; target_beat_sec?: number; resolve?: boolean }) =>
      post<GenerateResult>(`${base(slug, code)}/broll-plan/generate`, body),
    resolve: (slug: string, code: string, plan?: BrollPlan) =>
      post<GenerateResult>(`${base(slug, code)}/broll-plan/resolve`, plan ?? {}),
    assemble: (slug: string, code: string) =>
      post<{ ok: boolean; job: any; beats: number }>(`${base(slug, code)}/broll-plan/assemble`, {}),
  }
}
