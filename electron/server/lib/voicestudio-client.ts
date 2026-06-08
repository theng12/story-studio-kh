/**
 * Voice Studio KH client — local TTS modal launcher reached over Tailscale.
 *
 * v1.0.149+ — distinct from `chatterbox-client.ts` (a single-engine server).
 * Voice Studio KH is a Pinokio-launched FastAPI wrapper that fronts twelve
 * TTS engine families (voxcpm, voxcpm-mlx, kokoro, kokoro-mlx, qwen3-tts,
 * chatterbox-mlx, spark-tts-mlx, orpheus, kittentts, vibevoice, bark,
 * omnivoice). The user loads one family at a time in the wrapper UI, then
 * Story Studio talks to it via this client.
 *
 * No auth — Tailscale handles network security at the transport layer.
 * Default base URL is the user's tailnet IP discovered during the v1.0.149
 * integration probe (http://100.120.246.10:47870); editable in
 * App Settings → Local Models so the value isn't tied to a specific
 * machine.
 *
 * Async pipeline (mirrors the Chatterbox flow but with VS-KH's path shape):
 *   1. POST /api/generate/txt2speech     → { job_id, status, queue_position, ... }
 *   2. GET  /api/generate/jobs/{job_id}  → poll until status === 'done' | 'failed'
 *   3. GET  /api/generate/jobs/{id}/audio → binary download (wav/mp3/flac)
 *
 * Liveness:
 *   - GET /api/health                       — process + version
 *   - GET /api/generate/availability        — which engines are loaded
 *   - GET /api/voices                       — user's saved voice library
 *
 * Cancellation: VS-KH exposes DELETE /api/generate/jobs/{job_id}; we call
 * it on best-effort cancellation in addition to stopping our polling loop.
 */

import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable, Transform } from 'stream'
import { sleepCancellable } from './http-retry.js'
import { parseEndpoints, parseEnabledEndpoints } from './endpoint-pool.js'

/**
 * Voice Studio modal base URL default.
 *
 * v1.0.207 — **empty by default**. There is no universal host: each user
 * runs the modal on their own Mac and reaches it however they like —
 * Bonjour (`http://<mac-name>.local:47870`), a direct LAN IP
 * (`http://192.168.x.x:47870`), or a Tailscale tailnet IP for remote
 * access. Story Studio no longer guesses; the user enters their URL in
 * App Settings → Local Models (the port stays `47870`, the host varies).
 * When empty, the local audio model fails fast with a "set your URL"
 * message instead of probing a stranger's hostname.
 *
 * (Earlier builds hardcoded the original author's Mac — `…-m1.local`,
 * then `…-m4.local`. That leaked a machine-specific default to everyone.)
 */
export const DEFAULT_VOICESTUDIO_BASE_URL = ''

/**
 * First endpoint of a (possibly comma/space-separated) stored URL list —
 * mirrors `lmstudioFirst` in lmstudio-client.ts. Callers that don't use the
 * full multi-endpoint dispatcher (e.g. the subtitle transcriber, the
 * availability probe routes) MUST run the stored value through this before
 * using it as a base URL — otherwise a 2+ endpoint user's stored value
 * `http://mac1:47870, http://mac2:47870` gets treated as one giant URL and
 * fetch fails with "Failed to parse URL …" (v1.0.289 bug fix).
 *
 * Returns '' when nothing is stored — the caller is expected to fall back
 * to DEFAULT_VOICESTUDIO_BASE_URL or surface a "no URL configured" error.
 */
export function voicestudioFirst(stored: string | null | undefined): string {
  return parseEndpoints(stored)[0] || ''
}

/**
 * The twelve engine families the Voice Studio KH wrapper exposes (from
 * /api/generate/availability's `wired_families` array). Story Studio
 * dispatches per-family by setting `repo` on the submit body.
 *
 * `voxcpm-mlx` is the only one Story Studio surfaces as a first-class
 * model id today (v1.0.149) — the others can be added trivially once the
 * user starts using them; the client / availability probe / job pipeline
 * already cover them.
 */
export type VoiceStudioFamily =
  | 'voxcpm-mlx' | 'voxcpm'
  | 'kokoro-mlx' | 'kokoro'
  | 'qwen3-tts'
  | 'chatterbox-mlx'
  | 'spark-tts-mlx'
  | 'orpheus' | 'kittentts' | 'vibevoice' | 'bark' | 'omnivoice'

/**
 * Default HuggingFace `repo` values for each engine family. Used when the
 * user picks one of our model ids and we have to fill the `repo` field on
 * the submit body. The wrapper supports overriding this from the UI but
 * 95%+ of users want the default — the 4-bit MLX build is what the user
 * is running per their v1.0.149 request.
 */
export const VOICESTUDIO_DEFAULT_REPOS: Partial<Record<VoiceStudioFamily, string>> = {
  'voxcpm-mlx': 'mlx-community/VoxCPM2-4bit',
  'voxcpm': 'openbmb/VoxCPM2',
  'kokoro-mlx': 'mlx-community/Kokoro-82M-4bit',
  'kokoro': 'hexgrad/Kokoro-82M',
  'qwen3-tts': 'Qwen/Qwen3-TTS',
  'chatterbox-mlx': 'mlx-community/Chatterbox',
  'spark-tts-mlx': 'mlx-community/Spark-TTS',
  'orpheus': 'canopylabs/Orpheus-3b',
  'kittentts': 'kittentts/kittentts',
  'vibevoice': 'microsoft/VibeVoice-1.5B',
  'bark': 'suno/bark',
  'omnivoice': 'openbmb/MiniCPM-o',
}

/**
 * Which submit-body field carries the chosen voice for an engine. Confirmed
 * against the Voice Studio KH wrapper by its author (v1.0.211):
 *   - `voice`            → Kokoro's named speaker (e.g. `am_liam`). The
 *                          wrapper's `_generate_kokoro` reads `voice`, NOT
 *                          `preset_speaker` — that mismatch is why a picked
 *                          Kokoro voice was silently dropped before.
 *   - `preset_speaker`   → Qwen3 CustomVoice preset speakers only
 *   - `voice_library_id` → zero-shot cloning from the user's uploaded clip
 *                          (VoxCPM / Chatterbox)
 *   - `bark_voice_preset`→ Bark's `vN/lang_speaker_K` preset id
 */
export type VoiceStudioVoiceField = 'voice' | 'voice_library_id' | 'preset_speaker' | 'bark_voice_preset'

/**
 * v1.0.203+ — THE engine catalog. One row per Voice Studio TTS engine
 * Story Studio knows how to drive. This is the single source of truth that
 * makes the integration dynamic: the audio-model defaults, the live
 * availability gate, the provider's submit body, and the voice picker all
 * derive from it. **Adding a new engine (e.g. another the modal ships) is a
 * one-line append here — nothing else needs touching.**
 *
 * Fields:
 *   - `family`          the wrapper's engine family id
 *   - `modelId`         Story Studio audio-model id (`voicestudio-<x>`)
 *   - `label`           display name (the `[Voice Studio · local]` suffix
 *                       is added where it's surfaced)
 *   - `repo`            default HuggingFace repo sent as the submit `repo`
 *   - `softMaxChars`    per-submit chunk cap (tts_soft_max_chars)
 *   - `voiceField`      where the picked voice id goes on the submit body
 *   - `availabilityKey` the `<key>_available` flag in /availability that
 *                       gates whether this engine is offered in the dropdown
 */
export interface VoiceStudioEngine {
  family: VoiceStudioFamily
  modelId: string
  label: string
  repo: string
  softMaxChars: number
  voiceField: VoiceStudioVoiceField
  availabilityKey: string
}

export const VOICESTUDIO_ENGINES: VoiceStudioEngine[] = [
  // VoxCPM2 default chunk cap dropped from 1000 → 500 (~30s of audio).
  // VoxCPM2 is autoregressive-clone TTS; the cloned voice drifts toward the
  // model's generic distribution after the reference signal fades from
  // attention (~10-30s window depending on model + reference quality).
  // Each chunk is a separate API call with fresh reference injection, so
  // smaller chunks keep clone fidelity tight. User-tunable per-job via the
  // Audio page's "Max chunk size" field — that override takes precedence
  // over this default.
  { family: 'voxcpm-mlx',     modelId: 'voicestudio-voxcpm-mlx',     label: 'VoxCPM2 4-bit MLX', repo: 'mlx-community/VoxCPM2-4bit', softMaxChars: 500,  voiceField: 'voice_library_id',  availabilityKey: 'voxcpm' },
  // v1.0.323 — all three Kokoro variants surfaced as separate model entries.
  // Up to v1.0.322 Story Studio only exposed one Kokoro option whose repo got
  // swapped each release (hexgrad → bf16 → 4-bit) as we learned which
  // variant actually worked. The user asked to have all three available in
  // the dropdown so they can pick whichever they want on each project, and
  // they're going to download all three on every Mac.
  //
  //   • voicestudio-kokoro       → MLX 4-bit (recommended — proven working in
  //                                end-to-end synthesis on the user's Mac on
  //                                2026-06-09; smallest + fastest on Apple Si).
  //   • voicestudio-kokoro-bf16  → MLX full-precision. Larger weights (~327 MB),
  //                                same audio quality as PyTorch in theory.
  //                                Has had download / runtime issues in
  //                                practice — leave at this label until end-
  //                                to-end synthesis is confirmed by the user.
  //   • voicestudio-kokoro-pt    → Original PyTorch (`hexgrad/Kokoro-82M`).
  //                                Cross-platform baseline; safest "the model
  //                                weights are exactly what the authors
  //                                published" option, but slower on Apple
  //                                Silicon than either MLX build.
  //
  // All three share `availabilityKey: 'kokoro'` (Voice Studio reports one
  // `kokoro_available` flag covering all variants) and `voiceField: 'voice'`
  // (the af_*/am_*/bf_*/bm_* voicepack ids work across all three repos). The
  // family field differs (kokoro vs kokoro-mlx) so it matches the Voice Studio
  // catalog precisely.
  //
  // Keep `voicestudio-kokoro` as the recommended-default modelId — anyone with
  // saved presets / project configs referencing it gets the working variant.
  { family: 'kokoro-mlx',     modelId: 'voicestudio-kokoro',         label: 'Kokoro v1.0 82M (MLX 4-bit, recommended)', repo: 'mlx-community/Kokoro-82M-4bit', softMaxChars: 2000, voiceField: 'voice',            availabilityKey: 'kokoro' },
  { family: 'kokoro-mlx',     modelId: 'voicestudio-kokoro-bf16',    label: 'Kokoro v1.0 82M (MLX bf16, full precision)', repo: 'mlx-community/Kokoro-82M-bf16', softMaxChars: 2000, voiceField: 'voice',            availabilityKey: 'kokoro' },
  { family: 'kokoro',         modelId: 'voicestudio-kokoro-pt',      label: 'Kokoro v1.0 82M (PyTorch baseline)',         repo: 'hexgrad/Kokoro-82M',            softMaxChars: 2000, voiceField: 'voice',            availabilityKey: 'kokoro' },
  // qwen3-tts: must pin to a CONCRETE catalog variant — bare 'Qwen/Qwen3-TTS'
  // is not in the modal's catalog and would hard-error (ValueError: repo not
  // in catalog). The wrapper dispatches mode by repo-name pattern: *Base* →
  // clone (voice_library_id), *CustomVoice* → custom (preset_speaker),
  // *VoiceDesign* → design (voice_design_prompt). We pin to the 0.6B
  // CustomVoice variant since it matches our preset_speaker mapping.
  { family: 'qwen3-tts',      modelId: 'voicestudio-qwen3-tts',      label: 'Qwen3-TTS 0.6B CustomVoice (MLX)', repo: 'mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit', softMaxChars: 2000, voiceField: 'preset_speaker',    availabilityKey: 'qwen3' },
  { family: 'bark',           modelId: 'voicestudio-bark',           label: 'Bark',              repo: 'suno/bark',                 softMaxChars: 1000, voiceField: 'bark_voice_preset', availabilityKey: 'bark' },
  // chatterbox-mlx: voiceField correct ('voice_library_id'); repo pinned to a
  // real catalog variant — bare 'mlx-community/Chatterbox' is not in the
  // catalog. chatterbox-4bit is the newer v1.2.1 build (smaller/faster than
  // the older chatterbox-mlx-4bit).
  { family: 'chatterbox-mlx', modelId: 'voicestudio-chatterbox-mlx', label: 'Chatterbox MLX',    repo: 'mlx-community/chatterbox-4bit', softMaxChars: 1000, voiceField: 'voice_library_id',  availabilityKey: 'chatterbox' },
]

/** Catalog lookups — by Story Studio model id or by engine family. */
export function engineForModelId(modelId: string): VoiceStudioEngine | undefined {
  return VOICESTUDIO_ENGINES.find(e => e.modelId === modelId)
}
export function engineForFamily(family: VoiceStudioFamily): VoiceStudioEngine | undefined {
  return VOICESTUDIO_ENGINES.find(e => e.family === family)
}

/** True when `family` selects voices from a fixed voicepack (not cloning). */
export function familyShipsVoicepack(family: VoiceStudioFamily): boolean {
  const e = engineForFamily(family)
  return !!e && e.voiceField !== 'voice_library_id'
}

/**
 * The audio-model-catalog rows for every known engine. `DEFAULT_AUDIO_MODELS`
 * (models/defaults.ts) spreads this in, so all engines are first-class
 * (generation chunk-cap, preview, provider) — the live availability probe
 * only gates which are *shown* in the dropdown.
 */
export function voicestudioAudioDefaults(): Record<string, { label: string; cost_per_1k_chars: number; provider: 'voicestudio'; tts_soft_max_chars: number }> {
  const out: Record<string, { label: string; cost_per_1k_chars: number; provider: 'voicestudio'; tts_soft_max_chars: number }> = {}
  for (const e of VOICESTUDIO_ENGINES) {
    out[e.modelId] = {
      label: `${e.label} [Voice Studio · local]`,
      cost_per_1k_chars: 0,
      provider: 'voicestudio',
      tts_soft_max_chars: e.softMaxChars,
    }
  }
  return out
}

/**
 * A preset speaker surfaced to the voice picker. Shares the shape of a
 * library voice (id/name/language/gender) so the frontend's existing
 * "Voice Studio library" section renders presets unchanged.
 */
export interface VoiceStudioPresetVoice {
  id: string
  name: string
  language?: string
  gender?: string
}

/**
 * Kokoro voice ids encode accent + gender in a two-char prefix
 * (`am_liam` = American Male "Liam"; `bf_alice` = British Female "Alice").
 * This maps the leading char to a human accent/language so the picker can
 * group + label them. Kokoro v1.0 is multilingual; unknown prefixes fall
 * back to the raw id so a server adding new packs never breaks the picker.
 */
const KOKORO_ACCENT_BY_PREFIX: Record<string, { accent: string; lang: string }> = {
  a: { accent: 'American', lang: 'en-US' },
  b: { accent: 'British', lang: 'en-GB' },
  e: { accent: 'Spanish', lang: 'es' },
  f: { accent: 'French', lang: 'fr-fr' },
  h: { accent: 'Hindi', lang: 'hi' },
  i: { accent: 'Italian', lang: 'it' },
  j: { accent: 'Japanese', lang: 'ja' },
  p: { accent: 'Portuguese', lang: 'pt-br' },
  z: { accent: 'Mandarin', lang: 'zh' },
}

/** Format one Kokoro speaker id (e.g. `am_liam`) into a labelled preset voice. */
export function formatKokoroVoice(id: string): VoiceStudioPresetVoice {
  const m = /^([a-z])([mf])_(.+)$/.exec(id)
  if (!m) return { id, name: id, gender: 'unknown', language: 'en' }
  const [, langCh, g, rest] = m
  const meta = KOKORO_ACCENT_BY_PREFIX[langCh] || { accent: '', lang: 'en' }
  const first = rest.charAt(0).toUpperCase() + rest.slice(1)
  const gender = g === 'm' ? 'male' : 'female'
  const tag = meta.accent ? ` (${meta.accent} ${gender === 'male' ? 'M' : 'F'})` : ''
  return { id, name: `${first}${tag}`, gender, language: meta.lang }
}

/**
 * Fallback Kokoro voicepack — the stock v1.0 (82M) English speakers. Used
 * only when the live availability probe doesn't return `presets.kokoro`
 * (older wrapper build or modal offline at fetch time). The user's target
 * voice, `am_liam` ("Liam"), is here.
 */
export const DEFAULT_KOKORO_VOICE_IDS: string[] = [
  // American Female
  'af_heart', 'af_bella', 'af_aoede', 'af_kore', 'af_nicole', 'af_nova',
  'af_sarah', 'af_sky', 'af_alloy', 'af_jessica', 'af_river',
  // American Male
  'am_michael', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_onyx', 'am_puck', 'am_santa',
  // British Female
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  // British Male
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
]

/**
 * Story-Studio-model-id → engine-family, derived from the catalog. Returns
 * undefined for a model id no known engine claims (so callers can 400
 * cleanly instead of guessing).
 */
export function familyForModelId(modelId: string): VoiceStudioFamily | undefined {
  return engineForModelId(modelId)?.family
}

export interface VoiceStudioTxt2SpeechParams {
  /** Required by the server — HF repo id selecting which model variant to run. */
  repo: string
  /** The narration text. Server soft-caps at ~600 chars for voxcpm; auto-splits longer. */
  text: string
  /** ISO language code; omit to let the engine auto-detect. */
  language?: string
  /** Voice library entry id (from GET /api/voices). For zero-shot cloning. */
  voice_library_id?: string
  /** Preset speaker id for engines that ship voicepacks (kokoro, qwen3-tts, bark). */
  preset_speaker?: string
  /** Free-text instruction for engines with natural-language emotion control. */
  instruct?: string
  /** Voice-design natural-language prompt (qwen3-tts). */
  voice_design_prompt?: string
  /** Reference transcript for cloning engines that benefit from a transcript hint. */
  ref_transcript?: string
  /** Bark-only: vN/lang_speaker_K preset id. */
  bark_voice_preset?: string
  /** 0.5–2.0; default 1.0 (pitch-preserving). */
  speed?: number
  /** 0.1–2.0; default 0.7. */
  temperature?: number
  /** Integer seed; omit for random. */
  seed?: number
  /** voxcpm classifier-free guidance weight; default 2.0. */
  cfg_value?: number
  /** voxcpm inference steps; default 10. */
  inference_timesteps?: number
  /** When true, server normalises text (numbers, abbreviations) before TTS. */
  normalize_text?: boolean
  /** Legacy `voice` field — some engines accept a plain string voice id. */
  voice?: string
}

export interface VoiceStudioSubmitResponse {
  job_id: string
  status?: VoiceStudioJobStatus
  queue_position?: number
  estimated_seconds?: number
}

export type VoiceStudioJobStatus =
  | 'pending' | 'queued' | 'running' | 'stitching' | 'done' | 'failed' | 'cancelled'

export interface VoiceStudioJob {
  id?: string
  job_id?: string
  status: VoiceStudioJobStatus
  progress?: number
  message?: string
  error?: string | null
  elapsed_seconds?: number
  eta_seconds?: number
  audio_seconds?: number
  /** Engine-reported output format ('wav' | 'mp3' | 'flac'). */
  final_format?: string
}

/**
 * v1.0.153+ — Pinokio wrapper response envelope. The Image Studio sibling
 * was confirmed to wrap submit + poll responses in `{ job: {...} }` with
 * the field name `state` (not `status`). Voice Studio almost certainly
 * does the same — same author, same wrapper architecture — but we
 * hadn't end-to-end tested a TTS generation in v1.0.149/150 so the bug
 * sat latent. Same fix as imagestudio-client: unwrap + normalize.
 */
function unwrapJob(raw: any): VoiceStudioJob {
  const j = raw && typeof raw === 'object' && raw.job ? raw.job : (raw || {})
  const rawState = j.state ?? j.status
  let status: VoiceStudioJobStatus
  switch (rawState) {
    case 'queued': case 'pending': case 'running':
    case 'stitching': case 'done': case 'failed': case 'cancelled':
      status = rawState; break
    case 'completed': case 'succeeded': case 'success': case 'finished':
      status = 'done'; break
    case 'error':
      status = 'failed'; break
    default:
      status = (typeof rawState === 'string' ? rawState : 'running') as VoiceStudioJobStatus
  }
  return {
    id: j.id || j.job_id,
    job_id: j.job_id || j.id,
    status,
    progress: typeof j.progress === 'number' ? j.progress : undefined,
    message: typeof j.message === 'string' ? j.message : undefined,
    error: j.error ?? null,
    elapsed_seconds: typeof j.elapsed_seconds === 'number' ? j.elapsed_seconds : undefined,
    eta_seconds: typeof j.eta_seconds === 'number' ? j.eta_seconds : undefined,
    audio_seconds: typeof j.audio_seconds === 'number' ? j.audio_seconds : undefined,
    final_format: typeof j.final_format === 'string' ? j.final_format : undefined,
  }
}

export interface VoiceStudioHealth {
  ok: boolean
  appVersion?: string
  apiVersion?: string
  hfHome?: string
  error?: string
}

export interface VoiceStudioAvailabilityVoice {
  id: string
  label: string
  lang?: string
  gender?: string
  description?: string
}

export interface VoiceStudioAvailability {
  ok: boolean
  /** Process device — 'mps' | 'cpu' | 'cuda'. */
  device?: string
  /** Per-engine flags. */
  engines: Partial<Record<VoiceStudioFamily, boolean>>
  /** wired_families — every family the wrapper has integration code for. */
  wiredFamilies: VoiceStudioFamily[]
  /** Voice presets per engine (kokoro voicepacks, qwen3 preset speakers, bark presets). */
  presets: {
    kokoro?: VoiceStudioAvailabilityVoice[]
    qwen3?: VoiceStudioAvailabilityVoice[]
    bark?: VoiceStudioAvailabilityVoice[]
  }
  error?: string
}

export interface VoiceStudioLibraryVoice {
  id: string
  name: string
  language?: string
  gender?: string
  notes?: string
  license?: string
  duration_seconds?: number
  sample_rate?: number
  channels?: number
  /** Relative URL — caller joins with base URL when fetching the audio. */
  audio_url?: string
  has_transcript?: boolean
  created_at?: number
}

interface PollOpts {
  isCancelled?: () => boolean
  /** Total wait cap, ms. Default 24 h (see below). */
  timeoutMs?: number
  /** Optional progress hook fired on every successful status response. */
  onProgress?: (job: VoiceStudioJob) => void
}

/**
 * v1.0.154+ — same reasoning as imagestudio-client. Voice Studio TTS
 * on Apple Silicon is faster than FLUX (a sentence in a few seconds)
 * but long-form narration generation across many sections can still
 * occupy the queue for hours, especially when batched with other
 * jobs. 24 h matches the audio batch ceiling so we don't time-out a
 * legitimately-waiting job whose modal queue position is deep.
 */
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60_000

function trimBaseUrl(baseUrl: string): string {
  const t = (baseUrl || '').trim()
  if (!t) throw new Error('Voice Studio base URL is empty. Set it in App Settings → Local Models.')
  return t.replace(/\/+$/, '')
}

function joinUrl(baseUrl: string, p: string): string {
  return `${trimBaseUrl(baseUrl)}${p.startsWith('/') ? p : `/${p}`}`
}

/**
 * Surface user-readable connection errors. The Tailscale-specific hints
 * mirror the Chatterbox client because the failure modes are identical
 * (machine asleep, port shifted, Tailscale disconnected).
 */
function friendlyConnectError(baseUrl: string, e: any): Error {
  const code: string = e?.cause?.code || e?.code || ''
  const msg: string = e?.message || String(e)
  if (code === 'ENOTFOUND' || code === 'ENETUNREACH' || code === 'EAI_AGAIN' || /getaddrinfo|fetch failed/i.test(msg)) {
    return new Error(
      `Cannot reach Voice Studio modal at ${baseUrl}. ` +
      `Check that Tailscale is connected and Pinokio is running.`,
    )
  }
  if (code === 'ECONNREFUSED' || /connect.*refused/i.test(msg)) {
    return new Error(
      `Voice Studio modal at ${baseUrl} refused the connection. ` +
      `Confirm Pinokio still has the wrapper running on that port — ` +
      `Pinokio sometimes shifts ports between launches.`,
    )
  }
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || /timeout/i.test(msg)) {
    return new Error(
      `Voice Studio modal at ${baseUrl} timed out. ` +
      `Tailscale may be reconnecting — try again in a moment.`,
    )
  }
  return e instanceof Error ? e : new Error(msg)
}

/** Liveness probe. Never throws — returns `{ ok: false, error }` on failure. */
export async function health(baseUrl: string): Promise<VoiceStudioHealth> {
  try {
    const resp = await fetch(joinUrl(baseUrl, '/api/health'), {
      signal: AbortSignal.timeout(5_000),
    })
    if (!resp.ok) {
      return { ok: false, error: `Health check failed (${resp.status})` }
    }
    const data = await resp.json() as { ok?: boolean; version?: string; app_version?: string; hf_home?: string }
    return {
      ok: data.ok === true,
      apiVersion: data.version,
      appVersion: data.app_version,
      hfHome: data.hf_home,
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) }
  }
}

/**
 * Which engine families are currently loaded + their preset voicepacks.
 * Surfaced in the Local Models settings panel and gates which model ids
 * the audio picker offers.
 */
export async function availability(baseUrl: string): Promise<VoiceStudioAvailability> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/generate/availability'), {
      signal: AbortSignal.timeout(8_000),
    })
  } catch (e) {
    const err = friendlyConnectError(baseUrl, e)
    return { ok: false, engines: {}, wiredFamilies: [], presets: {}, error: err.message }
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    return {
      ok: false, engines: {}, wiredFamilies: [], presets: {},
      error: `Availability fetch failed (${resp.status}): ${text.slice(0, 200)}`,
    }
  }
  const data = await resp.json() as any
  // Catalog-driven: every engine's `<availabilityKey>_available` flag maps
  // to engines[family]. New catalog rows light up automatically — no edit
  // here when an engine is added. MLX variants mirror their base family's
  // flag (the wrapper auto-picks the MLX path for *-MLX repos).
  const engines: Partial<Record<VoiceStudioFamily, boolean>> = {}
  for (const e of VOICESTUDIO_ENGINES) {
    const flag = data[`${e.availabilityKey}_available`]
    if (flag !== undefined) engines[e.family] = !!flag
  }
  if (data.voxcpm_available !== undefined) engines.voxcpm = !!data.voxcpm_available
  if (data.kokoro_available !== undefined) {
    engines.kokoro = !!data.kokoro_available
    engines['kokoro-mlx'] = !!data.kokoro_available
  }
  if (data.omnivoice_available !== undefined) engines.omnivoice = !!data.omnivoice_available
  const wired: VoiceStudioFamily[] = Array.isArray(data.wired_families)
    ? data.wired_families.filter((s: any) => typeof s === 'string')
    : []
  return {
    ok: data.available !== false,
    device: typeof data.device === 'string' ? data.device : undefined,
    engines,
    wiredFamilies: wired,
    presets: {
      kokoro: Array.isArray(data.kokoro_voices) ? data.kokoro_voices : undefined,
      qwen3: Array.isArray(data.qwen3_preset_speakers) ? data.qwen3_preset_speakers : undefined,
      bark: Array.isArray(data.bark_voice_presets) ? data.bark_voice_presets : undefined,
    },
    error: data.error || undefined,
  }
}

/** One engine, as offered to the audio-model dropdown. */
export interface VoiceStudioModelInfo {
  id: string
  label: string
  family: VoiceStudioFamily
  tts_soft_max_chars: number
  voicepack: boolean
}

/**
 * v1.0.203+ — the engines the live modal can currently run, derived by
 * intersecting the catalog with the availability probe. This is what makes
 * the dropdown dynamic: the frontend shows exactly these, so enabling a new
 * engine on the modal (or our adding a catalog row) surfaces it with no
 * further work. `configured` reflects whether a modal URL is even set;
 * `ok` whether the probe succeeded. When the probe can't speak to the
 * modal, `models` is empty and the caller falls back to the full catalog.
 */
export async function listAvailableEngines(
  baseUrl: string,
): Promise<{ configured: boolean; ok: boolean; models: VoiceStudioModelInfo[]; error?: string }> {
  const configured = !!(baseUrl || '').trim()
  const avail = await availability(baseUrl)
  const models: VoiceStudioModelInfo[] = VOICESTUDIO_ENGINES
    .filter(e => avail.engines[e.family])
    .map(e => ({
      id: e.modelId,
      label: e.label,
      family: e.family,
      tts_soft_max_chars: e.softMaxChars,
      voicepack: e.voiceField !== 'voice_library_id',
    }))
  return { configured, ok: avail.ok, models, error: avail.error }
}

/** List the user's saved voice library (uploaded reference clips). */
export async function listVoices(baseUrl: string): Promise<VoiceStudioLibraryVoice[]> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/voices'), {
      signal: AbortSignal.timeout(8_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Voice list fetch failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const data = await resp.json() as { voices?: VoiceStudioLibraryVoice[] }
  return Array.isArray(data.voices) ? data.voices : []
}

/**
 * v1.0.202+ — list a voicepack family's preset speakers for the picker.
 * Pulls the live speaker ids from the availability probe (`presets.kokoro`
 * etc.) and labels them; falls back to the bundled default pack when the
 * server doesn't advertise any (older wrapper or transient miss). Returns
 * the same id/name/language/gender shape as the cloning library so the
 * frontend renders them through its existing Voice Studio section.
 */
export async function listPresetVoices(
  baseUrl: string,
  family: VoiceStudioFamily,
): Promise<VoiceStudioPresetVoice[]> {
  const isKokoro = family === 'kokoro' || family === 'kokoro-mlx'
  // Availability presets may arrive as structured {id,label,lang,gender}
  // objects OR as bare id strings, depending on wrapper build. Normalise
  // both to a {id, server-label?} shape we can re-label uniformly.
  let raw: Array<{ id: string; label?: string; lang?: string; gender?: string; description?: string }> = []
  try {
    const avail = await availability(baseUrl)
    const src = isKokoro
      ? avail.presets?.kokoro
      : family === 'qwen3-tts' ? avail.presets?.qwen3
      : family === 'bark' ? avail.presets?.bark
      : undefined
    if (Array.isArray(src)) {
      raw = src
        .map((v: any) => typeof v === 'string'
          ? { id: v }
          : (v && typeof v.id === 'string' ? { id: v.id, label: v.label, lang: v.lang, gender: v.gender, description: v.description } : null))
        .filter((v): v is { id: string; label?: string; lang?: string; gender?: string; description?: string } => !!v)
    }
  } catch {
    // Non-fatal — fall through to the bundled default pack below.
  }
  if (!raw.length && isKokoro) {
    raw = DEFAULT_KOKORO_VOICE_IDS.map(id => ({ id }))
  }
  if (isKokoro) {
    // Decode accent + gender from the id for consistent grouping/labels.
    return raw.map(v => formatKokoroVoice(v.id))
  }
  // Other voicepacks (qwen3-tts, bark): prefer the server's label, then the
  // descriptive blurb, else the raw id (qwen3 ids ARE names, e.g. "Ryan").
  return raw.map(v => ({
    id: v.id,
    name: v.label || (v.description ? `${v.id} — ${v.description}` : v.id),
    language: v.lang,
    gender: v.gender,
  }))
}

/** Submit a txt2speech job. Returns the new job_id and queue metadata. */
export async function submitTxt2Speech(
  baseUrl: string,
  params: VoiceStudioTxt2SpeechParams,
): Promise<VoiceStudioSubmitResponse> {
  const body: Record<string, unknown> = { repo: params.repo, text: params.text }
  if (params.language) body.language = params.language
  if (params.voice_library_id) body.voice_library_id = params.voice_library_id
  if (params.preset_speaker) body.preset_speaker = params.preset_speaker
  if (params.instruct) body.instruct = params.instruct
  if (params.voice_design_prompt) body.voice_design_prompt = params.voice_design_prompt
  if (params.ref_transcript) body.ref_transcript = params.ref_transcript
  if (params.bark_voice_preset) body.bark_voice_preset = params.bark_voice_preset
  if (typeof params.speed === 'number') body.speed = params.speed
  if (typeof params.temperature === 'number') body.temperature = params.temperature
  if (typeof params.seed === 'number') body.seed = params.seed
  if (typeof params.cfg_value === 'number') body.cfg_value = params.cfg_value
  if (typeof params.inference_timesteps === 'number') body.inference_timesteps = params.inference_timesteps
  if (typeof params.normalize_text === 'boolean') body.normalize_text = params.normalize_text
  if (params.voice) body.voice = params.voice

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/generate/txt2speech'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Voice Studio submit failed (${resp.status}): ${text.slice(0, 300)}`)
  }
  const data = await resp.json() as any
  // v1.0.153+ — handle the `{ job: {...} }` envelope + state-vs-status
  // field name. See unwrapJob() above for the rationale (mirrors the
  // imagestudio-client fix surfaced by the user's thumbnail run).
  const job = unwrapJob(data)
  if (!job.id) {
    throw new Error(`Voice Studio submit returned no job id: ${JSON.stringify(data).slice(0, 200)}`)
  }
  return {
    job_id: job.id,
    status: job.status,
    queue_position: typeof data?.queue_position === 'number' ? data.queue_position : undefined,
    estimated_seconds: typeof data?.estimated_seconds === 'number' ? data.estimated_seconds : undefined,
  }
}

/**
 * Poll a job until it reaches 'done' or 'failed'. Adaptive cadence mirrors
 * the Chatterbox client: 2s burst → 5s → 10s. Honours `eta_seconds` if the
 * server reports it.
 */
export async function pollJob(
  baseUrl: string,
  jobId: string,
  opts: PollOpts = {},
): Promise<VoiceStudioJob> {
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  let polls = 0
  while (Date.now() < deadline) {
    if (opts.isCancelled?.()) {
      // Best-effort server-side cancel before throwing.
      await cancelJob(baseUrl, jobId).catch(() => {})
      throw new Error('Cancelled by user')
    }

    let resp: Response
    try {
      resp = await fetch(joinUrl(baseUrl, `/api/generate/jobs/${jobId}`), {
        signal: AbortSignal.timeout(15_000),
      })
    } catch (e) {
      throw friendlyConnectError(baseUrl, e)
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`Voice Studio poll failed (${resp.status}): ${text.slice(0, 300)}`)
    }
    // v1.0.153+ — same envelope unwrap as submit. Without this the
    // polling loop would never see 'done' because `job.status` from a
    // raw `{ job: { state: 'done' } }` payload is undefined.
    const raw = await resp.json()
    const job = unwrapJob(raw)
    try { opts.onProgress?.(job) } catch { /* never let UI plumbing kill polling */ }

    if (job.status === 'done') return job
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`Voice Studio job ${job.status}: ${job.error || job.message || 'unknown error'}`)
    }

    const baseSleepMs =
      polls < 6 ? 2_000 :
      polls < 18 ? 5_000 :
      10_000
    const eta = typeof job.eta_seconds === 'number' ? job.eta_seconds : 0
    const etaSleep = eta > 8 ? Math.min(eta * 1000 * 0.5, 10_000) : 0
    const sleepMs = Math.max(baseSleepMs, etaSleep)

    await sleepCancellable(sleepMs, opts.isCancelled)
    polls += 1
  }
  throw new Error(`Voice Studio job ${jobId} did not complete within ${Math.round((opts.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)} min`)
}

/** Best-effort server-side cancel. Never throws. */
export async function cancelJob(baseUrl: string, jobId: string): Promise<void> {
  try {
    await fetch(joinUrl(baseUrl, `/api/generate/jobs/${jobId}`), {
      method: 'DELETE',
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    /* fail-quiet — local polling already stopped, server-side cancel is bonus */
  }
}

/** Download the finished audio to `outPath`. Mirrors chatterbox-client's helper. */
export async function downloadAudio(
  baseUrl: string,
  jobId: string,
  outPath: string,
  opts: { signal?: AbortSignal; onProgress?: (bytesReceived: number, totalBytes?: number) => void } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, `/api/generate/jobs/${jobId}/audio`), {
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Voice Studio audio download failed (${resp.status}): ${text.slice(0, 200)}`)
  }
  const cl = resp.headers.get('content-length')
  const total = cl ? Number(cl) || undefined : undefined
  let received = 0
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      received += chunk.length
      try { opts.onProgress?.(received, total) } catch { /* never let UI plumbing kill a download */ }
      cb(null, chunk)
    },
  })
  const out = createWriteStream(outPath)
  try {
    await pipeline(Readable.fromWeb(resp.body as any), counter, out)
  } catch (e) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw e
  }
  const stat = await fs.stat(outPath)
  if (stat.size === 0) {
    await fs.rm(outPath, { force: true }).catch(() => {})
    throw new Error('Voice Studio download wrote 0 bytes')
  }
}

// ── Transcription (Whisper STT) — Voice Studio v1.4.0+ ──────────────────────
//
// Voice Studio KH gained an OpenAI-free Whisper STT subsystem (it reuses the
// mlx-audio dependency already present for TTS, the same GPU lock, and the
// same model-download manager). Story Studio transcribes subtitles against it
// instead of (or alongside) the paid OpenAI Whisper API. See the modal repo's
// docs/SUBTITLES.md for the full contract. Key rules honoured here:
//   - Gate on /api/transcribe/availability + the chosen model's `cached` flag.
//   - HTTP 409 means "model not downloaded" — surface a download-then-retry
//     message; the modal never silently pulls 1.6 GB mid-request.
//   - STT and TTS serialise on one server-side GPU lock, so callers must NOT
//     fire transcription in parallel with generation (our per-chapter loop is
//     sequential, which is correct).

export interface VoiceStudioTranscribeModel {
  repo: string
  label?: string
  size_gb?: number
  recommended?: boolean
  cached?: boolean
  note?: string
}

export interface VoiceStudioTranscribeAvailability {
  available: boolean
  mlx_audio?: boolean
  device?: string
  default_model?: string
  models?: VoiceStudioTranscribeModel[]
}

export interface VoiceStudioTranscribeResult {
  text: string
  language: string
  duration: number
  model: string
  elapsed_seconds?: number
  segments?: Array<{ id: number; start: number; end: number; text: string }>
  srt: string
  vtt: string
}

/** Which Whisper models the modal has cached + ready. Call before transcribing. */
export async function transcribeAvailability(baseUrl: string): Promise<VoiceStudioTranscribeAvailability> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/transcribe/availability'), {
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`Voice Studio transcribe availability failed (${resp.status})${t ? `: ${t.slice(0, 200)}` : ''}`)
  }
  return resp.json() as Promise<VoiceStudioTranscribeAvailability>
}

/**
 * v1.0.290 — walk a stored comma/space-separated URL list and return the
 * FIRST endpoint that responds to the transcribe-availability probe AND
 * reports `available: true`. Returns null if none are reachable + ready.
 *
 * Used by the subtitle generator because the STT path is intentionally
 * single-endpoint (parallel STT not worth the refactor — see v1.0.288
 * changelog) BUT should gracefully fail over when the primary endpoint is
 * offline. v1.0.289's `voicestudioFirst()` fixed the URL-parse crash but
 * still failed if endpoint #1 was unreachable; this lifts that limitation
 * by trying each endpoint in order.
 *
 * Probe timeout is per-endpoint (~15s via transcribeAvailability), so a
 * full 3-endpoint walk worst-case takes ~45s before giving up. In practice
 * unreachable endpoints fail much faster (TCP refused or DNS lookup error).
 */
export async function pickFirstAvailableTranscribeEndpoint(
  stored: string | null | undefined,
): Promise<{ baseUrl: string; avail: VoiceStudioTranscribeAvailability } | null> {
  const endpoints = parseEnabledEndpoints(stored)
  if (endpoints.length === 0) return null
  let lastError: Error | null = null
  for (const baseUrl of endpoints) {
    try {
      const avail = await transcribeAvailability(baseUrl)
      if (avail.available) return { baseUrl, avail }
      // Reachable but STT not loaded — keep walking. The modal may be on
      // but its mlx-audio engine is missing/broken on this Mac.
      lastError = new Error(`${baseUrl}: reachable but transcription unavailable (mlx-audio not importable)`)
    } catch (e: any) {
      // Unreachable — try the next one. Keep the most recent error so we
      // can surface something useful if ALL endpoints fail.
      lastError = e instanceof Error ? e : new Error(String(e))
    }
  }
  // Attach lastError as a cause so the caller's "no endpoints available"
  // message can point at WHICH thing went wrong last (network vs missing engine).
  if (lastError) {
    const e = new Error(`No Voice Studio endpoint available for transcription. Last error: ${lastError.message}`)
    ;(e as any).cause = lastError
    throw e
  }
  return null
}

/** Kick off a one-time Whisper model download on the modal (same generic
 *  /api/downloads endpoint the TTS models use). Returns the modal's response. */
export async function downloadTranscribeModel(baseUrl: string, repo: string): Promise<any> {
  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/downloads'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const t = await resp.text().catch(() => '')
    throw new Error(`Voice Studio model download failed (${resp.status})${t ? `: ${t.slice(0, 200)}` : ''}`)
  }
  return resp.json().catch(() => ({}))
}

/**
 * Transcribe an audio file via the modal (multipart `file` upload — the
 * universal, decoupled path; we don't rely on a still-live TTS job_id since
 * subtitles are a separate step). Returns the modal's ready-to-write `srt`.
 * 300 s timeout (long clips on the full large model are slow); honours a
 * caller cancel signal too.
 */
export async function transcribeFile(
  baseUrl: string,
  audioPath: string,
  opts: { model?: string; language?: string; wordTimestamps?: boolean; signal?: AbortSignal } = {},
): Promise<VoiceStudioTranscribeResult> {
  const buf = await fs.readFile(audioPath)
  const fd = new FormData()
  // Wrap the Node Buffer in a fresh Uint8Array before constructing the Blob.
  // Passing a Buffer directly as a BlobPart works on current Node, but has
  // historically produced an empty/garbled multipart body on some Electron
  // bundled-Node/undici versions — the explicit Uint8Array is the safe form.
  fd.append('file', new Blob([new Uint8Array(buf)]), path.basename(audioPath))
  if (opts.model) fd.append('model', opts.model)
  if (opts.language) fd.append('language', opts.language)
  if (opts.wordTimestamps) fd.append('word_timestamps', 'true')

  const timeout = AbortSignal.timeout(300_000)
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

  let resp: Response
  try {
    resp = await fetch(joinUrl(baseUrl, '/api/transcribe'), { method: 'POST', body: fd, signal })
  } catch (e) {
    throw friendlyConnectError(baseUrl, e)
  }
  if (!resp.ok) {
    const err: any = await resp.json().catch(() => ({}))
    const detail: string = err?.detail || ''
    if (resp.status === 409) {
      throw new Error(
        `Whisper model not downloaded on Voice Studio yet${detail ? ` (${detail})` : ''}. ` +
        `Download it (Subtitles tab → Download model) and retry.`,
      )
    }
    // Pass the modal's own (now clear) error through — e.g. Voice Studio v1.4.3+
    // attaches the Whisper processor from the base OpenAI repo on first use,
    // and returns an actionable message if that one-time ~2 MB fetch can't run
    // (offline). No client-side second-guessing of the cause.
    throw new Error(detail || `Voice Studio transcribe failed (${resp.status})`)
  }
  return resp.json() as Promise<VoiceStudioTranscribeResult>
}
