import fs from 'fs/promises'
import path from 'path'
import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import { hashSubtitleAudioSources } from './subtitle-completion.js'

export type AudioQualityEvidenceState = 'not_checked' | 'no_issue_detected' | 'review_needed'
export type AudioQualityProvenanceState = 'known' | 'legacy' | 'script_changed'

/** Facts retained at active-audio publication. Narration text is never copied here. */
export interface AudioQualityChapterProvenance {
  normalized_script_hash: string
  normalization: string
  source_audio_hash: string
  source_files: string[]
  recorded_at: string
  tts?: {
    model_id?: string
    /** Catalogue display name at the time (owner, 2026-10-26). */
    model_display_name?: string
    model_revision_id?: string
    voice_id?: string
    /** Catalogue display name of the voice at the time. */
    voice_display_name?: string
    voice_revision?: string
    /** The model row's serving provider, as published. */
    provider?: string
    voice_provider?: string
    engine_id?: string
    engine_name?: string
    model_family?: string
    /** Durable GenStudio facts for the part files, never request text. */
    task_ids?: Record<string, string>
    idempotency_keys?: Record<string, string>
  }
}

/** A compact inspection record for later route/UI projection. */
export interface AudioQualityChapterReport {
  state: AudioQualityEvidenceState
  provenance: AudioQualityProvenanceState
  transcript_fresh: boolean
  reason_code: string
  inspected_at: string
}

/**
 * A deliberate quality action is persisted before its paid candidate can be
 * submitted. It holds hashes and filenames only: the current narration and
 * private audio bytes remain in their existing authoritative locations.
 */
export interface AudioQualityRepairAction {
  action_id: string
  scope_fingerprint: string
  source_fingerprint: string
  /** Script-only fence used after candidate audio legitimately replaces old bytes. */
  script_fingerprint?: string
  sections: string[]
  /** Exact active source filenames at check time; bytes alone do not prove map ownership. */
  source_files: Record<string, string[]>
  mode: 'flag_issues' | 'check_and_repair'
  /** User-approved total for later candidate ASR quote confirmations. */
  verification_credit_ceiling?: number
  verification_committed_credits?: number
  verification_quote?: { id: string; quoted_credit_cost?: number; price_version?: string }
  /** Frozen alternate ASR model for this explicit repair action. */
  verification_model_id?: string
  state: 'checked' | 'confirmed' | 'candidate_ready' | 'needs_approval' | 'fixed' | 'still_needs_review' | 'cancelled'
  created_at: string
  confirmed_at?: string
  candidate?: {
    model_id: string
    voice_id: string
    speed?: number
    controls?: Record<string, number | boolean | string>
    /**
     * How the replacement was DIRECTED, when one was given (owner, 2026-10-29).
     * Kept with the candidate so a resumed repair makes the same take, and so a
     * repaired chapter is not quietly read differently from the rest.
     */
    delivery_instruction?: string
    staging_dir: string
    source_audio_hashes: Record<string, string>
    /** Candidate files and their post-ASR content fingerprints. */
    candidate_files?: Record<string, string[]>
    candidate_audio_hashes?: Record<string, string>
    /** Planned server-side active filenames, retained across a crash before promotion. */
    promoted_files?: Record<string, string[]>
    /** Candidate-only raw ASR evidence, stored by basename under staging_dir. */
    transcript_files?: Record<string, string>
    transcript_hashes?: Record<string, string>
  }
  /** Paid, user-confirmed alternate-ASR evidence over the unchanged active bytes. */
  active_check?: {
    model_id: string
    staging_dir: string
    credit_ceiling?: number
    committed_credits?: number
    state: 'quoted' | 'checking' | 'needs_approval' | 'no_issue_detected' | 'review_needed'
    quotes: Record<string, { id: string; audio_hash: string; quoted_credit_cost?: number; price_version?: string }>
  }
  /** Local follow-up required when no prior durable Audio Assembly settings exist. */
  refresh_needed?: string
}

export interface AudioQualityProvenance {
  version: 1
  chapters: Record<string, AudioQualityChapterProvenance>
  reports?: Record<string, AudioQualityChapterReport>
  actions?: Record<string, AudioQualityRepairAction>
}

const FILE = 'audio_quality.json'

function filePath(episodeDir: string): string {
  return path.join(episodeDir, FILE)
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function chapter(value: unknown): AudioQualityChapterProvenance | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const normalized_script_hash = text(row.normalized_script_hash)
  const normalization = text(row.normalization)
  const source_audio_hash = text(row.source_audio_hash)
  const recorded_at = text(row.recorded_at)
  const source_files = Array.isArray(row.source_files)
    ? row.source_files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file && !!file.trim())
    : []
  if (!normalized_script_hash || !normalization || !source_audio_hash || !recorded_at || !source_files.length) return null
  const rawTts = row.tts && typeof row.tts === 'object' ? row.tts as Record<string, unknown> : null
  const tts = rawTts ? Object.fromEntries(Object.entries({
    model_id: text(rawTts.model_id),
    model_display_name: text(rawTts.model_display_name),
    model_revision_id: text(rawTts.model_revision_id),
    voice_id: text(rawTts.voice_id),
    voice_display_name: text(rawTts.voice_display_name),
    voice_revision: text(rawTts.voice_revision),
    provider: text(rawTts.provider),
    voice_provider: text(rawTts.voice_provider),
    engine_id: text(rawTts.engine_id),
    engine_name: text(rawTts.engine_name),
    model_family: text(rawTts.model_family),
    task_ids: rawTts.task_ids && typeof rawTts.task_ids === 'object'
      ? Object.fromEntries(Object.entries(rawTts.task_ids as Record<string, unknown>)
        .filter(([file, id]) => path.basename(file) === file && !!text(id))
        .map(([file, id]) => [file, text(id)!]))
      : undefined,
    idempotency_keys: rawTts.idempotency_keys && typeof rawTts.idempotency_keys === 'object'
      ? Object.fromEntries(Object.entries(rawTts.idempotency_keys as Record<string, unknown>)
        .filter(([file, key]) => path.basename(file) === file && !!text(key))
        .map(([file, key]) => [file, text(key)!]))
      : undefined,
  }).filter(([, value]) => value)) : undefined
  return { normalized_script_hash, normalization, source_audio_hash, source_files,
    recorded_at, ...(tts && Object.keys(tts).length ? { tts } : {}) }
}

function report(value: unknown): AudioQualityChapterReport | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const state = row.state
  const provenance = row.provenance
  const transcript_fresh = row.transcript_fresh
  const reason_code = text(row.reason_code)
  const inspected_at = text(row.inspected_at)
  if (!['not_checked', 'no_issue_detected', 'review_needed'].includes(String(state))
    || !['known', 'legacy', 'script_changed'].includes(String(provenance))
    || typeof transcript_fresh !== 'boolean' || !reason_code || !inspected_at) return null
  return { state: state as AudioQualityEvidenceState, provenance: provenance as AudioQualityProvenanceState,
    transcript_fresh, reason_code, inspected_at }
}

function repairAction(value: unknown): AudioQualityRepairAction | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const action_id = text(row.action_id)
  const scope_fingerprint = text(row.scope_fingerprint)
  const source_fingerprint = text(row.source_fingerprint)
  const created_at = text(row.created_at)
  const mode = row.mode
  const state = row.state
  const sections = Array.isArray(row.sections)
    ? [...new Set(row.sections.map(text).filter((section): section is string => !!section))]
    : []
  const source_files = row.source_files && typeof row.source_files === 'object'
    ? Object.fromEntries(Object.entries(row.source_files as Record<string, unknown>)
      .flatMap(([slug, files]) => { const safeSlug = text(slug); return safeSlug ? [[safeSlug, safeFiles(files)] as [string, string[]]] : [] })
      .filter((pair): pair is [string, string[]] => pair[1].length > 0))
    : {}
  const verification_credit_ceiling = typeof row.verification_credit_ceiling === 'number'
    ? row.verification_credit_ceiling : undefined
  const verification_committed_credits = typeof row.verification_committed_credits === 'number'
    ? row.verification_committed_credits : undefined
  const rawQuote = row.verification_quote && typeof row.verification_quote === 'object'
    ? row.verification_quote as Record<string, unknown> : null
  const verification_quote = rawQuote && text(rawQuote.id) ? {
    id: text(rawQuote.id)!,
    ...(typeof rawQuote.quoted_credit_cost === 'number' && Number.isFinite(rawQuote.quoted_credit_cost)
      ? { quoted_credit_cost: rawQuote.quoted_credit_cost } : {}),
    ...(text(rawQuote.price_version) ? { price_version: text(rawQuote.price_version)! } : {}),
  } : undefined
  const verification_model_id = text(row.verification_model_id)
  if (!action_id || !scope_fingerprint || !source_fingerprint || !created_at || !sections.length
    || sections.some(section => !source_files[section]?.length)
    || !['flag_issues', 'check_and_repair'].includes(String(mode))
    || (verification_credit_ceiling !== undefined && (!Number.isSafeInteger(verification_credit_ceiling) || verification_credit_ceiling < 1))
    || (verification_committed_credits !== undefined && (!Number.isSafeInteger(verification_committed_credits) || verification_committed_credits < 0))
    || !['checked', 'confirmed', 'candidate_ready', 'needs_approval', 'fixed', 'still_needs_review', 'cancelled'].includes(String(state))
    || (state !== 'checked' && verification_credit_ceiling === undefined)) return null
  const rawCandidate = row.candidate && typeof row.candidate === 'object' ? row.candidate as Record<string, unknown> : null
  const candidate = rawCandidate ? (() => {
    const model_id = text(rawCandidate.model_id)
    const voice_id = text(rawCandidate.voice_id)
    const staging_dir = text(rawCandidate.staging_dir)
    const speed = typeof rawCandidate.speed === 'number' && Number.isFinite(rawCandidate.speed)
      ? rawCandidate.speed : undefined
    const controls = rawCandidate.controls && typeof rawCandidate.controls === 'object' && !Array.isArray(rawCandidate.controls)
      ? Object.fromEntries(Object.entries(rawCandidate.controls as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string')) as Record<string, number | boolean | string>
      : undefined
    const source_audio_hashes = rawCandidate.source_audio_hashes && typeof rawCandidate.source_audio_hashes === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.source_audio_hashes as Record<string, unknown>)
        .map(([slug, hash]) => [text(slug), text(hash)])
        .filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]))
      : {}
    const promoted_files = rawCandidate.promoted_files && typeof rawCandidate.promoted_files === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.promoted_files as Record<string, unknown>)
        .flatMap(([slug, files]) => { const safeSlug = text(slug); const safe = Array.isArray(files)
          ? files.filter((file): file is string => typeof file === 'string' && path.basename(file) === file && !!file.trim()) : []
          return safeSlug ? [[safeSlug, safe] as [string, string[]]] : [] })
        .filter((pair): pair is [string, string[]] => pair[1].length > 0))
      : {}
    const transcript_files = rawCandidate.transcript_files && typeof rawCandidate.transcript_files === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.transcript_files as Record<string, unknown>)
        .flatMap(([slug, file]) => { const safeSlug = text(slug); const safeFile = text(file); return safeSlug && safeFile ? [[safeSlug, safeFile] as [string, string]] : [] })
        .filter((pair): pair is [string, string] => path.basename(pair[1]) === pair[1]))
      : {}
    const transcript_hashes = rawCandidate.transcript_hashes && typeof rawCandidate.transcript_hashes === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.transcript_hashes as Record<string, unknown>)
        .map(([slug, hash]) => [text(slug), text(hash)])
        .filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]))
      : {}
    const candidate_files = rawCandidate.candidate_files && typeof rawCandidate.candidate_files === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.candidate_files as Record<string, unknown>)
        .flatMap(([slug, files]) => { const safeSlug = text(slug); return safeSlug ? [[safeSlug, safeFiles(files)] as [string, string[]]] : [] })
        .filter((pair): pair is [string, string[]] => pair[1].length > 0))
      : {}
    const candidate_audio_hashes = rawCandidate.candidate_audio_hashes && typeof rawCandidate.candidate_audio_hashes === 'object'
      ? Object.fromEntries(Object.entries(rawCandidate.candidate_audio_hashes as Record<string, unknown>)
        .map(([slug, hash]) => [text(slug), text(hash)])
        .filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]))
      : {}
    return model_id && voice_id && staging_dir && Object.keys(source_audio_hashes).length
      ? { model_id, voice_id, staging_dir, source_audio_hashes,
        ...(speed !== undefined ? { speed } : {}),
        ...(controls && Object.keys(controls).length ? { controls } : {}),
        ...(Object.keys(promoted_files).length ? { promoted_files } : {}),
        ...(Object.keys(transcript_files).length ? { transcript_files } : {}),
        ...(Object.keys(transcript_hashes).length ? { transcript_hashes } : {}),
        ...(Object.keys(candidate_files).length ? { candidate_files } : {}),
        ...(Object.keys(candidate_audio_hashes).length ? { candidate_audio_hashes } : {}),
      }
      : null
  })() : null
  const rawActiveCheck = row.active_check && typeof row.active_check === 'object' ? row.active_check as Record<string, unknown> : null
  const active_check = rawActiveCheck ? (() => {
    const model_id = text(rawActiveCheck.model_id)
    const staging_dir = text(rawActiveCheck.staging_dir)
    const credit_ceiling = typeof rawActiveCheck.credit_ceiling === 'number' ? rawActiveCheck.credit_ceiling : undefined
    const committed_credits = typeof rawActiveCheck.committed_credits === 'number' ? rawActiveCheck.committed_credits : undefined
    const state = rawActiveCheck.state
    const quotes = rawActiveCheck.quotes && typeof rawActiveCheck.quotes === 'object'
      ? Object.fromEntries(Object.entries(rawActiveCheck.quotes as Record<string, unknown>).flatMap(([slug, value]) => {
        const item = value && typeof value === 'object' ? value as Record<string, unknown> : null
        const id = item && text(item.id); const audio_hash = item && text(item.audio_hash)
        return id && audio_hash ? [[slug, { id, audio_hash,
          ...(typeof item!.quoted_credit_cost === 'number' ? { quoted_credit_cost: item!.quoted_credit_cost } : {}),
          ...(text(item!.price_version) ? { price_version: text(item!.price_version)! } : {}),
        }]] : []
      })) : {}
    const validCeiling = credit_ceiling === undefined || (Number.isSafeInteger(credit_ceiling) && credit_ceiling >= 1)
    const validCommitted = committed_credits === undefined || (Number.isSafeInteger(committed_credits) && committed_credits >= 0)
    return model_id && staging_dir && validCeiling && validCommitted
      && ['quoted', 'checking', 'needs_approval', 'no_issue_detected', 'review_needed'].includes(String(state))
      && Object.keys(quotes).length
      ? { model_id, staging_dir, ...(credit_ceiling !== undefined ? { credit_ceiling } : {}),
        ...(committed_credits !== undefined ? { committed_credits } : {}),
        state: state as NonNullable<AudioQualityRepairAction['active_check']>['state'], quotes }
      : null
  })() : null
  return {
    action_id, scope_fingerprint, source_fingerprint, sections, source_files,
    state: state as AudioQualityRepairAction['state'], mode: mode as AudioQualityRepairAction['mode'], created_at,
    ...(text(row.confirmed_at) ? { confirmed_at: text(row.confirmed_at)! } : {}),
    ...(text(row.script_fingerprint) ? { script_fingerprint: text(row.script_fingerprint)! } : {}),
    ...(verification_credit_ceiling !== undefined ? { verification_credit_ceiling } : {}),
    ...(verification_committed_credits !== undefined ? { verification_committed_credits } : {}),
    ...(verification_quote ? { verification_quote } : {}),
    ...(verification_model_id ? { verification_model_id } : {}),
    ...(candidate ? { candidate } : {}),
    ...(active_check ? { active_check } : {}),
    ...(text(row.refresh_needed) ? { refresh_needed: text(row.refresh_needed)! } : {}),
  }
}

function normalize(value: unknown): AudioQualityProvenance {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const chapters: Record<string, AudioQualityChapterProvenance> = {}
  if (raw.version === 1 && raw.chapters && typeof raw.chapters === 'object') {
    for (const [slug, value] of Object.entries(raw.chapters as Record<string, unknown>)) {
      const safeSlug = text(slug)
      const parsed = chapter(value)
      if (safeSlug && parsed) chapters[safeSlug] = parsed
    }
  }
  const reports: Record<string, AudioQualityChapterReport> = {}
  if (raw.reports && typeof raw.reports === 'object') {
    for (const [slug, value] of Object.entries(raw.reports as Record<string, unknown>)) {
      const safeSlug = text(slug)
      const parsed = report(value)
      if (safeSlug && parsed) reports[safeSlug] = parsed
    }
  }
  const actions: Record<string, AudioQualityRepairAction> = {}
  if (raw.actions && typeof raw.actions === 'object') {
    for (const [actionId, value] of Object.entries(raw.actions as Record<string, unknown>)) {
      const parsed = repairAction(value)
      if (parsed && parsed.action_id === actionId) actions[actionId] = parsed
    }
  }
  return {
    version: 1, chapters,
    ...(Object.keys(reports).length ? { reports } : {}),
    ...(Object.keys(actions).length ? { actions } : {}),
  }
}

export async function readAudioQualityProvenance(episodeDir: string): Promise<AudioQualityProvenance> {
  try {
    return normalize(JSON.parse(await fs.readFile(filePath(episodeDir), 'utf8')))
  } catch {
    return { version: 1, chapters: {} }
  }
}

export async function writeAudioQualityProvenance(episodeDir: string, value: AudioQualityProvenance): Promise<void> {
  const target = filePath(episodeDir)
  await withLock(target, () => writeJsonAtomic(target, normalize(value)))
}

/** Serialize read-modify-write action updates with active-audio provenance. */
export async function updateAudioQualityProvenance<T>(
  episodeDir: string,
  update: (current: AudioQualityProvenance) => T | Promise<T>,
): Promise<T> {
  const target = filePath(episodeDir)
  return withLock(target, async () => {
    let current: AudioQualityProvenance
    try {
      current = normalize(JSON.parse(await fs.readFile(target, 'utf8')))
    } catch {
      current = { version: 1, chapters: {} }
    }
    const result = await update(current)
    await writeJsonAtomic(target, normalize(current))
    return result
  })
}

interface PromotionSection {
  slug?: unknown
  source_file?: unknown
  source_files?: unknown
  duration_s?: unknown
}

function safeFiles(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((file): file is string => typeof file === 'string' && path.basename(file) === file && !!file.trim())
    : []
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function nextVersionedName(audioDir: string, file: string): Promise<string> {
  const ext = path.extname(file)
  const stem = file.slice(0, -ext.length)
  let version = 2
  while (true) {
    const candidate = `${stem}_v${version}${ext}`
    try { await fs.access(path.join(audioDir, candidate)); version++ }
    catch { return candidate }
  }
}

/**
 * Copy a fully verified staged candidate into retained versioned active files,
 * then atomically select those exact files in audio_chapters.json. The old
 * active bytes are never overwritten. A planned target list is saved before
 * copying so a restart resumes the same candidate instead of minting another
 * version or silently selecting a directory scan result.
 */
export async function promoteAudioQualityCandidate(input: {
  episodeDir: string
  audioDir: string
  candidateAudioDir: string
  actionId: string
  episodeCode: string
  sections: string[]
  expectedSourceHashes: Record<string, string>
  expectedSourceFiles: Record<string, string[]>
  expectedCandidateFiles: Record<string, string[]>
  expectedCandidateHashes: Record<string, string>
}): Promise<Record<string, string[]>> {
  const sidecarPath = path.join(input.episodeDir, 'audio_chapters.json')
  return withLock(sidecarPath, async () => {
    const candidateRoot = path.resolve(input.candidateAudioDir)
    const names = await fs.readdir(candidateRoot).catch(() => [] as string[])
    const candidateBySlug: Record<string, string[]> = {}
    for (const slug of input.sections) {
      const matcher = new RegExp(`^${escapeRegExp(input.episodeCode)}_${escapeRegExp(slug)}(?:_part\\d+)?\\.(?:mp3|wav|m4a)$`, 'i')
      const selected = names.filter(name => matcher.test(name)).sort()
      if (!selected.length) throw new Error(`Verified candidate audio is missing ${slug}; the active audio was left unchanged.`)
      const checks = await Promise.all(selected.map(async name => {
        const stat = await fs.stat(path.join(candidateRoot, name)).catch(() => null)
        return !!stat?.isFile() && stat.size > 0
      }))
      if (checks.some(ok => !ok)) throw new Error(`Verified candidate audio for ${slug} is empty; the active audio was left unchanged.`)
      candidateBySlug[slug] = selected
      const candidateHash = await hashSubtitleAudioSources(selected.map(name => path.join(candidateRoot, name)))
      if (!candidateHash || candidateHash !== input.expectedCandidateHashes[slug]
        || JSON.stringify(selected) !== JSON.stringify(input.expectedCandidateFiles[slug])) {
        throw new Error(`Verified candidate audio for ${slug} changed after ASR; active audio was left unchanged.`)
      }
    }

    const planned = await updateAudioQualityProvenance(input.episodeDir, async current => {
      const action = current.actions?.[input.actionId]
      if (!action?.candidate) throw new Error('No confirmed candidate action exists for this promotion.')
      action.candidate.promoted_files ||= {}
      for (const slug of input.sections) {
        if (!action.candidate.promoted_files[slug]?.length) {
          action.candidate.promoted_files[slug] = await Promise.all(candidateBySlug[slug]!.map(file => nextVersionedName(input.audioDir, file)))
        }
      }
      return Object.fromEntries(input.sections.map(slug => [slug, action.candidate!.promoted_files![slug]!]))
    })

    // Copy before selecting. A crash here leaves only retained inactive files;
    // the action checkpoint lets the next attempt verify and reuse them.
    for (const slug of input.sections) {
      for (let index = 0; index < candidateBySlug[slug]!.length; index++) {
        const source = path.join(candidateRoot, candidateBySlug[slug]![index]!)
        const target = path.join(input.audioDir, planned[slug]![index]!)
        const sourceHash = await hashSubtitleAudioSources([source])
        const targetHash = await hashSubtitleAudioSources([target])
        if (targetHash && targetHash !== sourceHash) throw new Error(`A retained candidate filename for ${slug} belongs to different bytes; active audio was left unchanged.`)
        if (!targetHash) await fs.copyFile(source, target)
      }
    }

    const sidecar = JSON.parse(await fs.readFile(sidecarPath, 'utf8')) as { sections?: PromotionSection[]; [key: string]: unknown }
    if (!Array.isArray(sidecar.sections)) throw new Error('Audio Assembly timing data is missing; active audio was left unchanged.')
    for (const slug of input.sections) {
      const section = sidecar.sections.find(row => typeof row.slug === 'string' && row.slug.toLowerCase() === slug.toLowerCase())
      if (!section) throw new Error(`Audio Assembly timing data has no ${slug} section; active audio was left unchanged.`)
      const priorFiles = safeFiles(section.source_files).length ? safeFiles(section.source_files)
        : typeof section.source_file === 'string' && path.basename(section.source_file) === section.source_file ? [section.source_file] : []
      const currentHash = await hashSubtitleAudioSources(priorFiles.map(file => path.join(input.audioDir, file)))
      if (!currentHash || currentHash !== input.expectedSourceHashes[slug]
        || JSON.stringify(priorFiles) !== JSON.stringify(input.expectedSourceFiles[slug])) {
        throw new Error(`Active ${slug} changed while the candidate was being verified; it was not promoted.`)
      }
      section.source_files = planned[slug]!
      section.source_file = planned[slug]![0]!
    }
    await writeJsonAtomic(sidecarPath, sidecar)
    await updateAudioQualityProvenance(input.episodeDir, current => {
      const action = current.actions?.[input.actionId]
    if (action) action.state = 'candidate_ready'
    })
    return planned
  })
}
