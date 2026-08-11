/**
 * Provider interfaces — contracts for image, audio, and text AI providers.
 * Each provider implements one or more of these interfaces and self-registers
 * with the registry at import time.
 *
 * To add a new provider:
 *   1. Create a file in providers/image/, providers/audio/, or providers/text/
 *   2. Implement the relevant interface
 *   3. Call registry.registerXxx() at the bottom of the file
 *   4. Import the file in app.ts
 */

// ── Provider Metadata ────────────────────────────────────────────────────

export interface ProviderMeta {
  /** Unique provider ID used in config (e.g. 'kie', 'replicate', 'openai-images') */
  id: string
  /** Display name for UI (e.g. 'kie.ai', 'Replicate', 'OpenAI Images') */
  name: string
  /**
   * Legacy: config key name for the API key (e.g. 'kie_api_key'). Still consumed
   * by `resolveApiKeyForProvider` as a fallback when `providerId` is absent.
   */
  apiKeyField: string
  /**
   * Canonical provider id in `secrets.json` — defaults to the slice of
   * `apiKeyField` before `_api_key`. Declare explicitly when the provider's
   * registry id differs from its secrets bucket (e.g. `kie-video` and
   * `fal-video` share secrets with their audio/image counterparts).
   */
  providerId?: string
  /** Local Studio wrappers own their credentials and do not need an app key. */
  requiresApiKey?: boolean
}

// ── Image Provider ───────────────────────────────────────────────────────

export interface ImageGenerationRequest {
  prompt: string
  apiKey: string
  aspectRatio: string
  modelId: string
  /** Provider-specific params from config.image_models[model].provider_params */
  providerParams: Record<string, any>
  /**
   * Phase 8 — character reference images. Absolute paths to local image
   * files that the provider should use as visual references (img2img /
   * IP-Adapter / Flux Kontext input image). Providers that don't support
   * reference-image generation, OR models within a supporting provider
   * that don't enable it, MUST silently ignore this field. The caller
   * decides what to attempt based on the model's capability flag in
   * providerParams (e.g. `supports_reference_images: true`).
   */
  referenceImagePaths?: string[]
  /**
   * v1.0.261 — explicit output pixel dimensions. When BOTH are set, a provider
   * that renders at a chosen resolution (local Image Studio) uses these instead
   * of deriving size from `aspectRatio`. Cloud providers that only accept an
   * aspect string (kie, OpenAI, OpenRouter) MUST ignore these. Used by the
   * Scene Review "render size" tier to cut VAE/GPU memory on local MLX models.
   */
  width?: number
  height?: number
  /**
   * Resolution LABEL from the selected model's published `output_options[]`
   * (e.g. "1K"). Never a locally invented ladder, and never paired against a
   * separate ratio list — the published row is the valid combination. Absent
   * means the customer chose none, so the model's published default applies.
   */
  resolution?: string
  /** Optional deterministic seed. Omit to let the provider randomize. */
  seed?: number
  idempotencyIdentity?: string
  /**
   * Durable providers call this as soon as upstream accepts the task, before
   * polling or downloading. The caller can then recover the same paid/free
   * task after a restart instead of submitting it again.
   */
  onJobAccepted?: (taskId: string, idempotencyKey: string) => void | Promise<void>
  /** Called when Story Studio safely reconnects to an already accepted task. */
  onReconnect?: (taskId: string, reason: string) => void | Promise<void>
  /** Probe for user cancel — provider should honour it in poll loops so an
   *  aborted batch stops burning provider calls per in-flight request. */
  isCancelled?: () => boolean
}

export interface ImageGenerationResult {
  urls: string[]
  taskId?: string
}

export interface ImageProvider {
  meta: ProviderMeta

  /** Check if this provider handles the given model config */
  supportsModel(modelId: string, providerParams: Record<string, any>): boolean

  /** Generate image(s). The provider handles its own submit/poll internally. */
  generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult>
}

// ── Audio Provider ───────────────────────────────────────────────────────

export interface AudioGenerationRequest {
  text: string
  apiKey: string
  modelId: string
  voiceId?: string
  speed?: number
  /**
   * Values for the selected model's published `controls[]`, keyed by the name
   * GenStudio published. Never enumerated here: the catalogue owns the names,
   * the types and the ranges (lib/tts-controls.ts).
   */
  controls?: Record<string, number | boolean | string>
  /** Probe for user cancel — honoured in poll loops. */
  isCancelled?: () => boolean
}

export interface AudioGenerationResult {
  audioUrl: string
  contentType?: string
}

export interface AudioProvider {
  meta: ProviderMeta

  /** Generate TTS audio from text */
  generateAudio(request: AudioGenerationRequest): Promise<AudioGenerationResult>
}

// ── Video Provider ────────────────────────────────────────────────────────

export type VideoMode = 'frames'

export interface VideoGenerationRequest {
  mode: VideoMode
  prompt: string
  apiKey: string
  aspectRatio: 'landscape' | 'portrait'
  numberOfVideos: number
  modelId: string
  /** For frames mode: path to the start image on disk */
  startImagePath?: string
  /** For frames mode: path to an optional end image on disk */
  endImagePath?: string
  /** Provider-specific params */
  providerParams?: Record<string, any>
  /** Stable Story asset identity used for GenStudio idempotency. */
  idempotencyIdentity?: string
  /** Probe for user cancel — honoured in poll loops. */
  isCancelled?: () => boolean
}

export interface VideoGenerationResult {
  /** Final mp4 URLs, ready to download */
  videoUrls: string[]
  /** The Veo/provider task IDs, if any — useful for debugging */
  taskIds?: string[]
  /** Private GenStudio artifacts require the same scoped key on download. */
  downloadHeaders?: Record<string, string>
}

export interface VideoProvider {
  meta: ProviderMeta

  /** Check if this provider handles the given model */
  supportsModel(modelId: string, providerParams?: Record<string, any>): boolean

  /** Generate video(s) — provider handles submit/poll/download-URL resolution internally */
  generateVideo(request: VideoGenerationRequest): Promise<VideoGenerationResult>
}

// ── Text Provider ────────────────────────────────────────────────────────

import type { TextOutputContract } from '../lib/json-output-contract.js'
import type { OutputBudget } from '../services/output-token-budget.js'

export interface TextGenerationRequest {
  model: string
  system: string
  userMessage: string
  apiKey: string
  stream?: boolean
  maxTokens?: number
  /** The SHAPE of this workflow's output, sized from the selected product's
   *  published output limit. See services/output-token-budget.ts. */
  outputBudget?: OutputBudget
  /** Prefer provider-native JSON mode for strict machine-readable workflows. */
  jsonMode?: boolean
  /**
   * Exact workflow output contract. `jsonMode` remains a compatibility alias
   * for `{ mode: 'json_object' }` while older callers are migrated.
   */
  outputContract?: TextOutputContract
  /** Disable paid reasoning tokens when the task is deterministic formatting. */
  disableReasoning?: boolean
  /** Optional sampling temperature for callers that need stable structured output. */
  temperature?: number
  /** Stable Story-side identity used by durable boundaries for idempotent submission. */
  requestIdentity?: string
  /** Reconcile a saved durable request instead of creating a replacement. */
  recoverByIdempotencyKey?: boolean
  /** Server-owned durable key used only by read-only chat recovery. */
  idempotencyKey?: string
  allowedRecoveryKeys?: string[]
  /** Provider response details used to explain truncation and token consumption. */
  onDiagnostics?: (diagnostics: TextGenerationDiagnostics) => void
  /** Abort signal passed through to the SDK — streaming providers tear down
   *  the fetch on abort, so a user-cancelled job stops paying for a long
   *  completion that would otherwise run to max_tokens. */
  signal?: AbortSignal
  /**
   * v1.0.283 — optional image attachments for multimodal (vision-capable)
   * requests. Each entry is a base64 data URL (e.g. `data:image/png;base64,
   * iVBORw0K…`). Providers that support vision (currently OpenAI's gpt-4o
   * family + LM Studio when a vision-capable local model is loaded) repackage
   * `userMessage` + these images into the SDK's multimodal content-array
   * format. Providers that don't support vision IGNORE this field and behave
   * as text-only — callers gate the UI to vision-capable models so we never
   * silently drop images. Empty array == undefined == "no images".
   */
  images?: string[]
}

export interface TextGenerationDiagnostics {
  requestId?: string
  model?: string
  provider?: string
  finishReason?: string
  nativeFinishReason?: string
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export interface TextProvider {
  meta: ProviderMeta

  /** Check if this provider handles the given model */
  supportsModel(modelId: string): boolean

  /** Generate text completion */
  callText(request: TextGenerationRequest): Promise<string>
}
