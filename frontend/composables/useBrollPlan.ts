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
  aigen?: number
  pool_id?: string
  resolve_skipped_reason?: string
}

export interface AiImageControls {
  ai_fallback?: boolean
  image_model?: string
  image_aspect_ratio?: string
  image_steps?: number
  image_seed?: number
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
    generate: (slug: string, code: string, body: { model: string; broll_style?: string; style_hint?: string; target_beat_sec?: number; resolve?: boolean } & AiImageControls) =>
      post<GenerateResult>(`${base(slug, code)}/broll-plan/generate`, body),
    resolve: (slug: string, code: string, plan?: BrollPlan, opts?: AiImageControls) =>
      post<GenerateResult>(`${base(slug, code)}/broll-plan/resolve`, { ...(plan ?? {}), ...(opts ?? {}) }),
    assemble: (slug: string, code: string) =>
      post<{ ok: boolean; job: any; beats: number }>(`${base(slug, code)}/broll-plan/assemble`, {}),
    requeryBeat: (slug: string, code: string, body: { beat_index: number; model: string; style_hint?: string }) =>
      post<{ ok: boolean; plan: BrollPlan; queries: string[] }>(`${base(slug, code)}/broll-plan/requery-beat`, body),
    search: (slug: string, code: string, queries: string[]) =>
      post<{ candidates: BrollCandidate[] }>(`${base(slug, code)}/broll-plan/search`, { queries }),
    swapBeat: (slug: string, code: string, body: { beat_index: number; provider: string; result: any }) =>
      post<{ ok: boolean; plan: BrollPlan; filename: string }>(`${base(slug, code)}/broll-plan/swap-beat`, body),

    // Raw media URLs for the preview player's <video>/<audio> elements.
    videoUrl: (poolId: string, filename: string) =>
      `/api/broll-pools/${encodeURIComponent(poolId)}/clips/${encodeURIComponent(filename)}/video`,
    narrationUrl: (slug: string, code: string) =>
      `/api/projects/${encodeURIComponent(slug)}/episodes/${encodeURIComponent(code)}/narration-audio`,
  }
}

export interface BrollCandidate {
  provider: string
  source_id: string
  source_url: string
  thumbnail_url: string
  duration: number
  result: any
}
