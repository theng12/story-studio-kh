/**
 * Default catalogs for per-project image/audio models + voices.
 * These are seeded into new projects and used as a fallback for existing
 * projects whose config has empty `image_models` / `audio_models`.
 */

import type { ImageModelConfig, AudioModelConfig, VoicePreset, VideoModelConfig } from './types.js'
import { voicestudioAudioDefaults } from '../lib/voicestudio-client.js'

// Every built-in image model today is served by kie.ai; tagging them here
// makes the provider explicit for the unified catalog view and avoids the
// implicit fallback in `toUnified`.
//
// Pricing notes (2026-04-28 refresh):
//   - All kie.ai credits convert at 1 credit = $0.005 USD.
//   - Models with multiple price points carry `tiers` + `default_tier`.
//     `credits_per_image` mirrors the default tier's credits so callers
//     that don't pass a tier still get a sensible cost.
//   - High-tier-topup discounts (~10%) are NOT modelled here — they apply
//     globally on the kie.ai account, not per-call.
export const DEFAULT_IMAGE_MODELS: Record<string, ImageModelConfig> = {
  // Phase 8: `supports_reference_images: true` marks the kie.ai models that
  // ingest character reference images (Flux Kontext via inputImages, Nano
  // Banana via image_urls). Other entries silently ignore reference paths
  // when passed — text-to-image only. The character picker reads this flag
  // to surface a "compatible models" hint per character.

  // ── Flat-priced models (single credit cost, no tiers) ─────────────────
  // `prompt_char_cap` figures are approximate — sourced from each
  // provider's documented limit at last audit (2026-05-13). The frontend
  // uses them only for warning users before they spend credits; the
  // provider's own validator stays the source of truth at request time.
  'z-image':         { label: 'Z-Image',                    credits_per_image: 0.8, prompt_char_cap: 1000, endpoint: '/jobs/createTask',         poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'z-image',                      provider: 'kie' },
  'grok-imagine':    { label: 'Grok Imagine',               credits_per_image: 1,   prompt_char_cap: 1000, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'grok-imagine/text-to-image',   provider: 'kie' },
  'qwen-image':      { label: 'Qwen Image',                 credits_per_image: 2,   prompt_char_cap: 800,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'qwen/text-to-image',           provider: 'kie' },
  'flux-kontext-pro':{ label: 'Flux Kontext Pro',           credits_per_image: 2,   prompt_char_cap: 1000, endpoint: '/flux/kontext/generate',     poll: '/flux/kontext/record-info',  type: 'flux',      api_model: 'flux-kontext-pro',             provider: 'kie', supports_reference_images: true },
  '4o-image':        { label: '4o Image (OpenAI)',          credits_per_image: 3,   prompt_char_cap: 4000, endpoint: '/gpt4o-image/generate',      poll: '/gpt4o-image/record-info',   type: '4o',        api_model: '4o-image',                     provider: 'kie' },
  'gpt-image-1.5':   { label: 'GPT Image 1.5',              credits_per_image: 3,   prompt_char_cap: 4000, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'gpt-image', api_model: 'gpt-image/1.5-text-to-image',  provider: 'kie' },
  'seedream':        { label: 'Seedream (ByteDance)',       credits_per_image: 3,   prompt_char_cap: 500,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream',           provider: 'kie' },
  'imagen4':         { label: 'Imagen 4 (Google)',          credits_per_image: 4,   prompt_char_cap: 2000, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'google/imagen4',               provider: 'kie' },
  'flux-kontext-max':{ label: 'Flux Kontext Max',           credits_per_image: 4,   prompt_char_cap: 1000, endpoint: '/flux/kontext/generate',     poll: '/flux/kontext/record-info',  type: 'flux',      api_model: 'flux-kontext-max',             provider: 'kie', supports_reference_images: true },
  'wan-2-7-image':   { label: 'WAN 2.7 Image',              credits_per_image: 4.8, prompt_char_cap: 800,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'wan/2-7-image',                provider: 'kie' },
  'seedream-5-lite': { label: 'Seedream 5 Lite',            credits_per_image: 5.5, prompt_char_cap: 500,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream-5-lite-text-to-image', provider: 'kie' },
  'qwen-image-2':    { label: 'Qwen Image 2',               credits_per_image: 5.6, prompt_char_cap: 800,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'qwen2/image-edit',             provider: 'kie', supports_reference_images: true },
  'seedream-4-5':    { label: 'Seedream 4.5',               credits_per_image: 6.5, prompt_char_cap: 500,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream-4-5-text-to-image', provider: 'kie' },
  'nano-banana':     { label: 'Nano Banana',                credits_per_image: 12,  prompt_char_cap: 5000, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'google/nano-banana',           api_model_i2i: 'google/nano-banana-edit', refs_field: 'image_urls', aspect_field: 'image_size', provider: 'kie', supports_reference_images: true },
  'wan-2-7-image-pro':{ label: 'WAN 2.7 Image Pro',         credits_per_image: 12,  prompt_char_cap: 800,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'wan/2-7-image-pro',            provider: 'kie' },

  // ── Tiered models — resolution and speed-based pricing ────────────────
  'flux-2-pro': {
    label: 'Flux 2 Pro',
    credits_per_image: 5, default_tier: '1k',
    prompt_char_cap: 1000,
    tiers: [
      { id: '1k', label: '1K', credits: 5 },
      { id: '2k', label: '2K', credits: 7 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'flux-2/pro-text-to-image', provider: 'kie',
    supports_reference_images: true,
  },
  'gpt-image-2': {
    label: 'GPT Image 2',
    credits_per_image: 6, default_tier: '1k',
    prompt_char_cap: 4000,
    tiers: [
      { id: '1k', label: '1K', credits: 6 },
      { id: '2k', label: '2K', credits: 10 },
      { id: '4k', label: '4K', credits: 16 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'gpt-image',
    // kie.ai splits GPT Image 2 into two slugs: text-to-image (default) and
    // image-to-image (when references are attached). The i2i variant takes
    // `input_urls` (note plural underscore form, NOT `input_images`), while
    // t2i takes neither. Verified against docs.kie.ai/market/gpt/
    // gpt-image-2-{text,image}-to-image, 2026-05-14.
    api_model: 'gpt-image-2-text-to-image',
    api_model_i2i: 'gpt-image-2-image-to-image',
    refs_field: 'input_urls',
    provider: 'kie',
    supports_reference_images: true,
  },
  // v1.0.234+ — OFFICIAL OpenAI Images API (your own OpenAI key, billed on
  // your OpenAI platform account — separate from kie.ai credits). Same
  // gpt-image-2 model, hit directly: txt2img → /v1/images/generations,
  // img2img → /v1/images/edits (references sent as image[] files). cost is
  // token-based on OpenAI, so credits_per_image is 0 here (watch spend on the
  // OpenAI dashboard). Needs API Organization Verification on platform.openai.com.
  'gpt-image-2-openai': {
    label: 'GPT Image 2 (direct)',
    credits_per_image: 0,
    prompt_char_cap: 4000,
    endpoint: '', poll: '', type: 'openai',
    api_model: 'gpt-image-2',
    provider: 'openai-image',
    supports_reference_images: true,
  },
  // v1.0.236+ — Google Gemini "Nano Banana" image models via OpenRouter (your
  // own OpenRouter credit, token-billed — watch spend on openrouter.ai). Both
  // do text-to-image AND image-to-image/edits (references sent as image_url
  // blocks). credits_per_image 0 since OpenRouter prices by tokens.
  'gemini-2-5-flash-image-openrouter': {
    label: 'Gemini 2.5 Flash Image (Nano Banana)',
    credits_per_image: 0,
    prompt_char_cap: 4000,
    endpoint: '', poll: '', type: 'openrouter',
    api_model: 'google/gemini-2.5-flash-image',
    provider: 'openrouter-image',
    supports_reference_images: true,
  },
  'gemini-3-1-flash-image-openrouter': {
    label: 'Gemini 3.1 Flash Image',
    credits_per_image: 0,
    prompt_char_cap: 4000,
    endpoint: '', poll: '', type: 'openrouter',
    api_model: 'google/gemini-3.1-flash-image-preview',
    provider: 'openrouter-image',
    supports_reference_images: true,
  },
  'nano-banana-2': {
    label: 'Nano Banana 2',
    credits_per_image: 8, default_tier: '1k',
    prompt_char_cap: 5000,
    tiers: [
      { id: '1k', label: '1K', credits: 8 },
      { id: '2k', label: '2K', credits: 12 },
      { id: '4k', label: '4K', credits: 18 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    // kie.ai accepts a single slug for NB2 — same endpoint handles both
    // text-to-image and image-to-image based on whether `image_input` is
    // present. The `google/` prefix the original NB1 uses is NOT part of
    // NB2's slug (verified against docs.kie.ai/market/google/nanobanana2,
    // 2026-05-14).
    api_model: 'nano-banana-2', refs_field: 'image_input', provider: 'kie',
    supports_reference_images: true,
  },
  'nano-banana-pro': {
    label: 'Nano Banana Pro',
    credits_per_image: 18, default_tier: '1k-2k',
    prompt_char_cap: 5000,
    tiers: [
      { id: '1k-2k', label: '1K / 2K', credits: 18 },
      { id: '4k',    label: '4K',      credits: 24 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'nano-banana-pro', refs_field: 'image_input', provider: 'kie',
    supports_reference_images: true,
  },
  'ideogram-v3': {
    label: 'Ideogram V3',
    credits_per_image: 7, default_tier: 'balanced',
    prompt_char_cap: 1000,
    tiers: [
      { id: 'turbo',    label: 'Turbo',    credits: 3.5 },
      { id: 'balanced', label: 'Balanced', credits: 7   },
      { id: 'quality',  label: 'Quality',  credits: 10  },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'ideogram/v3-text-to-image', provider: 'kie',
  },

  // ── v1.0.151+ Image Studio KH (Pinokio FastAPI wrapper, local MLX) ───
  // Sibling of Voice Studio. The model id surfaced here is the only
  // catalog entry that fits an 8 GB M1 (per /api/catalog probing during
  // the v1.0.151 integration). Adding more families (FLUX.2 dev,
  // Qwen-Image, FIBO, Z-Image) is a 2-line change once you're on a Mac
  // with more unified memory: append the id here + the matching repo
  // entry in providers/image/imagestudio.ts → MODEL_TO_REPO.
  //
  // Cost is $0 — Apple Silicon compute. The kie-shape required fields
  // (endpoint / poll / type / api_model) are empty strings: they only
  // route through the kie provider; the imagestudio dispatch bypasses
  // them via the `provider: 'imagestudio'` field.
  'imagestudio-flux2-klein-mlx-4bit': {
    label: 'FLUX.2 klein 4B (MLX 4-bit) [Image Studio · local]',
    credits_per_image: 0,
    prompt_char_cap: 1000,
    endpoint: '', poll: '', type: 'local',
    api_model: 'AITRADER/FLUX2-klein-4B-mlx-4bit',
    provider: 'imagestudio',
  },
}

export const DEFAULT_AUDIO_MODELS: Record<string, AudioModelConfig> = {
  // Direct ElevenLabs (official API; prefix `eleven_` signals that backend).
  // Pricing is indicative — ElevenLabs charges per character against your plan
  // quota, so this is an approximate USD/1K-char figure for budgeting.
  'eleven_multilingual_v2': { label: 'ElevenLabs Multilingual v2 [direct]', cost_per_1k_chars: 0.30, provider: 'elevenlabs' },
  'eleven_turbo_v2_5':      { label: 'ElevenLabs Turbo v2.5 [direct]',      cost_per_1k_chars: 0.15, provider: 'elevenlabs' },
  'eleven_flash_v2_5':      { label: 'ElevenLabs Flash v2.5 [direct]',      cost_per_1k_chars: 0.10, provider: 'elevenlabs' },
  // fal.ai models — verified against live fal.ai docs in Delivery 5
  // (docs/history/fal-model-audit-2026-04.md). Entries for `v2` and `flash-v2.5`
  // were dropped because those queue endpoints do not exist on fal.ai.
  'turbo-v2.5':       { label: 'ElevenLabs Turbo v2.5 [fal]',       cost_per_1k_chars: 0.05, provider: 'fal' },
  'multilingual-v2':  { label: 'ElevenLabs Multilingual v2 [fal]',  cost_per_1k_chars: 0.10, provider: 'fal' },
  'eleven-v3':        { label: 'ElevenLabs v3 [fal]',               cost_per_1k_chars: 0.10, provider: 'fal' },
  // GenAIPro models (same ElevenLabs voices, different gateway)
  'genaipro-multilingual-v2': { label: 'ElevenLabs Multilingual v2 [GenAIPro]', cost_per_1k_chars: 0.10, provider: 'genaipro' },
  'genaipro-turbo-v2.5':      { label: 'ElevenLabs Turbo v2.5 [GenAIPro]',      cost_per_1k_chars: 0.05, provider: 'genaipro' },
  'genaipro-flash-v2.5':      { label: 'ElevenLabs Flash v2.5 [GenAIPro]',      cost_per_1k_chars: 0.03, provider: 'genaipro' },
  'genaipro-v3':              { label: 'ElevenLabs v3 [GenAIPro]',              cost_per_1k_chars: 0.10, provider: 'genaipro' },
  // v1.0.149+ — Voice Studio KH local modal (Pinokio FastAPI wrapper).
  // v1.0.150+ — replaced the standalone 'chatterbox-default' /
  // 'chatterbox-cloned' entries entirely. Chatterbox is reachable
  // through Voice Studio's chatterbox-mlx family if the user wants
  // it back. Existing projects with chatterbox-* selected as the
  // active audio model will need to switch to a different model the
  // first time they open the Audio Generator after upgrading — the
  // mergeCatalog flow drops orphan ids that no longer exist in defaults.
  // Multi-family TTS host reached over Tailscale; today we surface one
  // engine (VoxCPM2 4-bit MLX). Cost $0 — local Apple Silicon compute.
  // Hidden from projects that haven't set the modal URL in App Settings
  // → Local Models. Adding more families (kokoro-mlx, qwen3-tts, etc.)
  // is one line here + a matching entry in providers/audio/voicestudio.ts.
  // v1.0.160+ — soft cap 1500 chars (down from 3000 in v1.0.156).
  //
  // History of this number, FULL:
  //   v1.0.155: 500. Set from the modal catalog's
  //     `text_guidance.soft_max_chars: 600` plus a user-reported
  //     hallucination zone at 500-600 chars. Both signals seemed to
  //     confirm each other.
  //   v1.0.156: 3000. User pushed the Voice Studio author to verify
  //     upstream — the catalog's 600 was an eyeballed guess, not from
  //     openbmb / mlx-audio sources. Architecture max: 4096 audio
  //     tokens × ~6.25 Hz ≈ ~11 minutes of audio ≈ ~8-10k characters.
  //     User landed on 3000 as a practical sweet spot (~1/3 of arch
  //     max). Story Studio matched exactly so the modal never had to
  //     internally re-split.
  //   v1.0.160: 1500. Crash report from the modal author. A 2755-char
  //     submit (under the 3000 cap) requested a 13.13 GB Metal buffer
  //     allocation vs the M4's 9.53 GB per-buffer Metal limit → Abort
  //     trap 6 → entire voicestudio server killed. Author derived 1500
  //     as ~50% safety margin under 9.53 GB single-request budget.
  //   v1.0.161: 1000. 1500 crashed AGAIN — the user reported only the
  //     first chunk's WAV came back before the server died. That maps
  //     to cross-request memory pressure: each individual 1500-char
  //     request fits inside 9.5 GB but two consecutive submits don't
  //     give Metal time to release buffers between them, so request #2
  //     piles on top of #1's not-yet-freed allocations. Two coordinated
  //     fixes in v1.0.161:
  //       (a) drop the per-request cap to 1000 chars (halves the
  //           single-request alloc — request fits with margin even when
  //           voice cloning is enabled and the cloning reference is
  //           still resident from the previous call).
  //       (b) audio.ts inserts an inter-chunk cooldown sleep
  //           (`VOICESTUDIO_INTER_CHUNK_DELAY_MS` ≈ 3000) between
  //           consecutive submits to a voicestudio-* model. Gives
  //           the Metal driver an explicit window to deallocate
  //           buffers from the previous forward pass before the next
  //           one allocates.
  //     The "right" server-side fix is still the runtime memory gate
  //     the modal author flagged as P1 — until that lands, our cap +
  //     cooldown is the only thing keeping the modal alive on batches.
  //
  // Big-picture lesson banked here: engine spec ≠ hardware ceiling.
  // Architecture token limits describe what the model can REPRESENT,
  // not what the user's specific GPU/Metal stack can ALLOCATE during
  // a single forward pass. For diffusion-based audio models, the
  // hardware ceiling moves with output duration and is the binding
  // constraint on consumer Apple Silicon — always derive from the
  // crash data when you have it, not the model card.
  //
  // If the modal lands its planned runtime memory gate (estimates
  // alloc from input × engine factor, fails the single request
  // cleanly before allocation, leaves the server alive), this client-
  // side cap stops being load-bearing. Until then it's the only thing
  // standing between an over-long submit and a dead server.
  // v1.0.203+ — every Voice Studio engine is generated from the catalog
  // (VOICESTUDIO_ENGINES in voicestudio-client.ts): VoxCPM (cloning),
  // Kokoro / Qwen3-TTS / Bark (built-in voicepacks), Chatterbox (cloning),
  // … Registering them all here keeps generation/preview/chunk-cap native;
  // the audio page only *shows* the ones the live modal reports available
  // (GET /voicestudio/models). Adding an engine = one catalog row, no edit
  // here. The shared voicestudio inter-chunk cooldown (audio.ts) applies to
  // every voicestudio-* model. (Kokoro/Bark aren't diffusion-based so they
  // don't hit VoxCPM's Metal single-buffer ceiling — caps reflect that.)
  ...voicestudioAudioDefaults(),
  // v1.0.329 — macOS built-in `say` voices. Local, free ($0), offline; the
  // chosen voice is the variable (Evan / Tom / Jamie / …), surfaced by the
  // VoicePicker from `say -v '?'`. One model entry is enough — the voice
  // carries the identity. soft cap generous: `say` handles long text fine
  // (renders from a temp file), so chunking here is only for the pipeline's
  // per-chunk file + merge granularity. Intended for free PREVIEW renders;
  // swap to a premium provider for the final episode.
  'macos-say': { label: 'macOS say (built-in · free)', cost_per_1k_chars: 0, provider: 'macos', tts_soft_max_chars: 3000 },
}

export const DEFAULT_VOICE_PRESETS: VoicePreset[] = [
  { name: 'Vincent', voice_id: 'Qe9WSybioZxssVEwlBSo' },
]

// Per-model extra fields live in provider_params on the stored config (not the typed interface)
// so we cast via `as any` on each object. Keeps VideoModelConfig lean.
export const DEFAULT_VIDEO_MODELS: Record<string, VideoModelConfig> = {
  // ── fal.ai video models (base64 data-URI i2v) ────────────────────────────
  'fal-veo-3.1': {
    label: 'Veo 3.1 [fal.ai] — premium',
    credits_per_video: 30,
    provider: 'fal-video',
    modes: ['text', 'frames'],
    max_duration: 8,
    ...({ provider_params: { slug: 'fal-ai/veo3.1', default_duration: 8, default_resolution: '720p' } } as any),
  } as any,
  'fal-veo-3.1-i2v': {
    label: 'Veo 3.1 Image-to-Video [fal.ai]',
    credits_per_video: 30,
    provider: 'fal-video',
    modes: ['frames'],
    max_duration: 8,
    ...({ provider_params: { slug: 'fal-ai/veo3.1/image-to-video', default_duration: 8 } } as any),
  } as any,
  'fal-sora-2-t2v': {
    label: 'Sora 2 Text-to-Video [fal.ai]',
    credits_per_video: 20,
    provider: 'fal-video',
    modes: ['text'],
    max_duration: 20,
    ...({ provider_params: { slug: 'fal-ai/sora-2/text-to-video', default_duration: 8 } } as any),
  } as any,
  'fal-sora-2-i2v': {
    label: 'Sora 2 Image-to-Video [fal.ai]',
    credits_per_video: 20,
    provider: 'fal-video',
    modes: ['frames'],
    max_duration: 20,
    ...({ provider_params: { slug: 'fal-ai/sora-2/image-to-video', default_duration: 8 } } as any),
  } as any,
  'fal-hailuo-02-t2v': {
    label: 'Hailuo-02 Text-to-Video [fal.ai] — cheap',
    credits_per_video: 3,
    provider: 'fal-video',
    modes: ['text'],
    max_duration: 10,
    ...({ provider_params: { slug: 'fal-ai/minimax/hailuo-02/standard/text-to-video', default_duration: 6 } } as any),
  } as any,
  'fal-hailuo-02-i2v': {
    label: 'Hailuo-02 Image-to-Video [fal.ai]',
    credits_per_video: 3,
    provider: 'fal-video',
    modes: ['frames'],
    max_duration: 10,
    ...({ provider_params: { slug: 'fal-ai/minimax/hailuo-02/standard/image-to-video', default_duration: 6 } } as any),
  } as any,
  'fal-wan-i2v': {
    label: 'Wan 2.2 Image-to-Video [fal.ai] — cheapest',
    credits_per_video: 2,
    provider: 'fal-video',
    modes: ['frames'],
    max_duration: 5,
    ...({ provider_params: { slug: 'fal-ai/wan/v2.2-a14b/image-to-video' } } as any),
  } as any,

  // ── kie.ai video models (jobs endpoint, base64 data-URI for i2v) ─────────
  'kie-sora-2-t2v': {
    label: 'Sora 2 Text-to-Video [kie.ai]',
    credits_per_video: 20,
    provider: 'kie-video',
    modes: ['text'],
    max_duration: 20,
    ...({ provider_params: { api_model: 'sora-2-text-to-video' } } as any),
  } as any,
  'kie-sora-2-i2v': {
    label: 'Sora 2 Image-to-Video [kie.ai]',
    credits_per_video: 20,
    provider: 'kie-video',
    modes: ['frames'],
    max_duration: 20,
    ...({ provider_params: { api_model: 'sora-2-image-to-video' } } as any),
  } as any,
  'kie-kling-3': {
    label: 'Kling 3.0 [kie.ai] — text + image, up to 15s',
    credits_per_video: 10,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 15,
    ...({ provider_params: { type: 'jobs', api_model: 'kling-3.0/video', default_duration: 5, extra_input: { mode: 'std' } } } as any),
  } as any,
  // ── kie.ai dedicated endpoints (Veo / Runway) ────────────────────────────
  'kie-veo3-fast': {
    label: 'Veo 3 Fast [kie.ai] — cheap, 8s',
    credits_per_video: 10,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 8,
    ...({ provider_params: { type: 'veo', api_model: 'veo3_fast' } } as any),
  } as any,
  'kie-veo3': {
    label: 'Veo 3 [kie.ai] — premium, 8s, 1080p',
    credits_per_video: 30,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 8,
    ...({ provider_params: { type: 'veo', api_model: 'veo3' } } as any),
  } as any,
  'kie-veo3-lite': {
    label: 'Veo 3 Lite [kie.ai]',
    credits_per_video: 5,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 8,
    ...({ provider_params: { type: 'veo', api_model: 'veo3_lite' } } as any),
  } as any,
  'kie-runway-720p': {
    label: 'Runway Gen-3 [kie.ai] — 720p, 5 or 10s',
    credits_per_video: 8,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 10,
    ...({ provider_params: { type: 'runway', default_duration: 5, default_quality: '720p' } } as any),
  } as any,
  'kie-runway-1080p': {
    label: 'Runway Gen-3 [kie.ai] — 1080p, 5s only',
    credits_per_video: 15,
    provider: 'kie-video',
    modes: ['text', 'frames'],
    max_duration: 5,
    ...({ provider_params: { type: 'runway', default_duration: 5, default_quality: '1080p' } } as any),
  } as any,
}

