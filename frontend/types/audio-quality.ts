export type AudioQualityMode = 'off' | 'flag_issues' | 'check_and_repair'

export type AudioQualityState =
  | 'not_checked'
  | 'checking'
  | 'no_issue_detected'
  | 'review_needed'
  | 'repairing'
  | 'fixed'
  | 'still_needs_review'

export interface AudioQualityEvidence {
  state: AudioQualityState
  reason?: string
  reason_code?: string
  inspected_at?: string
  transcript_fresh: boolean
  provenance: 'known' | 'legacy' | 'script_changed'
  source_fingerprint?: string
  review?: {
    start_sec?: number
    end_sec?: number
    excerpt?: string
    script_excerpt?: string
  }
  receipt?: {
    model_id?: string
    voice_id?: string
    provider_name?: string
  }
  active_check?: {
    action_id: string
    source_fingerprint: string
    state: 'quoted' | 'checking' | 'needs_approval' | 'no_issue_detected' | 'review_needed'
    sections: string[]
    model_id: string
    verification: {
      credit_ceiling?: number
      committed_credits?: number
      quotes: Record<string, {
        id: string
        quoted_credit_cost?: number
        price_version?: string
      }>
    }
  }
  repair?: {
    action_id: string
    source_fingerprint: string
    sections: string[]
    state: 'candidate_ready' | 'needs_approval' | 'still_needs_review' | 'fixed'
    refresh_needed?: string
    candidate?: {
      model_id: string
      voice_id: string
    }
    verification?: {
      quoted_credit_cost?: number
      price_version?: string
      committed_credits: number
      credit_ceiling: number
    }
  }
}

export interface AudioQualityActiveCheckQuote {
  action_id: string
  source_fingerprint: string
  model_id: string
  state: 'quoted'
  sections: Array<{
    slug: string
    window: { kind: 'whole_chapter'; fallback: true }
    quote: { id: string; quoted_credit_cost?: number; price_version?: string }
  }>
  total_quoted_credits?: number
}

export interface AudioQualityQuote {
  text?: string
  credits?: number
  detail?: string
}

export interface AudioQualityCandidateQuote {
  quotable: boolean
  total_credits: number | null
  part_count?: number
  model_name?: string
  provider_name?: string
  unavailable_detail?: string
}

export interface AudioQualityPlan {
  action_id: string
  sections: Array<{ slug: string; quality: AudioQualityEvidence }>
  repair?: {
    eligible: boolean
    source_fingerprint?: string
    diagnostic_issue_detected?: boolean
    provenance_unavailable?: boolean
    source_facts_changed?: boolean
    requires_source_confirmation?: boolean
    alternate_model_id?: string
    transcription?: { required: boolean; quote?: AudioQualityQuote }
    candidate_tts?: { required: boolean; advisory_quote?: AudioQualityCandidateQuote }
  }
}

export function audioQualityLabel(state: AudioQualityState): string {
  if (state === 'checking') return 'Checking'
  if (state === 'no_issue_detected') return 'No issue detected'
  if (state === 'review_needed') return 'Review needed'
  if (state === 'repairing') return 'Repairing'
  if (state === 'fixed') return 'Fixed'
  if (state === 'still_needs_review') return 'Still needs review'
  return 'Not yet verified'
}

export function audioQualityTone(state: AudioQualityState): 'muted' | 'info' | 'success' | 'warning' {
  if (state === 'checking' || state === 'repairing') return 'info'
  if (state === 'no_issue_detected' || state === 'fixed') return 'success'
  if (state === 'review_needed' || state === 'still_needs_review') return 'warning'
  return 'muted'
}
