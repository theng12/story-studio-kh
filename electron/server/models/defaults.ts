/**
 * Default catalogs for per-project image/audio models + voices.
 * These are seeded into new projects and used as a fallback for existing
 * projects whose config has empty `image_models` / `audio_models`.
 */

import type { ImageModelConfig, AudioModelConfig, VoicePreset, VideoModelConfig } from './types.js'

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
  'z-image':         { label: 'Z-Image',                    credits_per_image: 0.8, endpoint: '/jobs/createTask',         poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'z-image',                      provider: 'kie' },
  'grok-imagine':    { label: 'Grok Imagine',               credits_per_image: 1,   endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'grok-imagine/text-to-image',   provider: 'kie' },
  'qwen-image':      { label: 'Qwen Image',                 credits_per_image: 2,   endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'qwen/text-to-image',           provider: 'kie' },
  'flux-kontext-pro':{ label: 'Flux Kontext Pro',           credits_per_image: 2,   endpoint: '/flux/kontext/generate',     poll: '/flux/kontext/record-info',  type: 'flux',      api_model: 'flux-kontext-pro',             provider: 'kie', supports_reference_images: true },
  '4o-image':        { label: '4o Image (OpenAI)',          credits_per_image: 3,   endpoint: '/gpt4o-image/generate',      poll: '/gpt4o-image/record-info',   type: '4o',        api_model: '4o-image',                     provider: 'kie' },
  'gpt-image-1.5':   { label: 'GPT Image 1.5',              credits_per_image: 3,   endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'gpt-image', api_model: 'gpt-image/1.5-text-to-image',  provider: 'kie' },
  'seedream':        { label: 'Seedream (ByteDance)',       credits_per_image: 3,   endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream',           provider: 'kie' },
  'imagen4':         { label: 'Imagen 4 (Google)',          credits_per_image: 4,   endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'google/imagen4',               provider: 'kie' },
  'flux-kontext-max':{ label: 'Flux Kontext Max',           credits_per_image: 4,   endpoint: '/flux/kontext/generate',     poll: '/flux/kontext/record-info',  type: 'flux',      api_model: 'flux-kontext-max',             provider: 'kie', supports_reference_images: true },
  'wan-2-7-image':   { label: 'WAN 2.7 Image',              credits_per_image: 4.8, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'wan/2-7-image',                provider: 'kie' },
  'seedream-5-lite': { label: 'Seedream 5 Lite',            credits_per_image: 5.5, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream-5-lite-text-to-image', provider: 'kie' },
  'qwen-image-2':    { label: 'Qwen Image 2',               credits_per_image: 5.6, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'qwen2/image-edit',             provider: 'kie', supports_reference_images: true },
  'seedream-4-5':    { label: 'Seedream 4.5',               credits_per_image: 6.5, endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'bytedance/seedream-4-5-text-to-image', provider: 'kie' },
  'nano-banana':     { label: 'Nano Banana',                credits_per_image: 12,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'google/nano-banana',           provider: 'kie', supports_reference_images: true },
  'wan-2-7-image-pro':{ label: 'WAN 2.7 Image Pro',         credits_per_image: 12,  endpoint: '/jobs/createTask',           poll: '/jobs/recordInfo',           type: 'jobs',      api_model: 'wan/2-7-image-pro',            provider: 'kie' },

  // ── Tiered models — resolution and speed-based pricing ────────────────
  'flux-2-pro': {
    label: 'Flux 2 Pro',
    credits_per_image: 5, default_tier: '1k',
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
    tiers: [
      { id: '1k', label: '1K', credits: 6 },
      { id: '2k', label: '2K', credits: 10 },
      { id: '4k', label: '4K', credits: 16 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'gpt-image',
    api_model: 'gpt-image-2-text-to-image', provider: 'kie',
    supports_reference_images: true,
  },
  'nano-banana-2': {
    label: 'Nano Banana 2',
    credits_per_image: 8, default_tier: '1k',
    tiers: [
      { id: '1k', label: '1K', credits: 8 },
      { id: '2k', label: '2K', credits: 12 },
      { id: '4k', label: '4K', credits: 18 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'google/nano-banana-2', provider: 'kie',
    supports_reference_images: true,
  },
  'nano-banana-pro': {
    label: 'Nano Banana Pro',
    credits_per_image: 18, default_tier: '1k-2k',
    tiers: [
      { id: '1k-2k', label: '1K / 2K', credits: 18 },
      { id: '4k',    label: '4K',      credits: 24 },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'nano-banana-pro', provider: 'kie',
    supports_reference_images: true,
  },
  'ideogram-v3': {
    label: 'Ideogram V3',
    credits_per_image: 7, default_tier: 'balanced',
    tiers: [
      { id: 'turbo',    label: 'Turbo',    credits: 3.5 },
      { id: 'balanced', label: 'Balanced', credits: 7   },
      { id: 'quality',  label: 'Quality',  credits: 10  },
    ],
    endpoint: '/jobs/createTask', poll: '/jobs/recordInfo', type: 'jobs',
    api_model: 'ideogram/v3-text-to-image', provider: 'kie',
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
  // (docs/refactors/fal-model-audit.md). Entries for `v2` and `flash-v2.5`
  // were dropped because those queue endpoints do not exist on fal.ai.
  'turbo-v2.5':       { label: 'ElevenLabs Turbo v2.5 [fal]',       cost_per_1k_chars: 0.05, provider: 'fal' },
  'multilingual-v2':  { label: 'ElevenLabs Multilingual v2 [fal]',  cost_per_1k_chars: 0.10, provider: 'fal' },
  'eleven-v3':        { label: 'ElevenLabs v3 [fal]',               cost_per_1k_chars: 0.10, provider: 'fal' },
  // GenAIPro models (same ElevenLabs voices, different gateway)
  'genaipro-multilingual-v2': { label: 'ElevenLabs Multilingual v2 [GenAIPro]', cost_per_1k_chars: 0.10, provider: 'genaipro' },
  'genaipro-turbo-v2.5':      { label: 'ElevenLabs Turbo v2.5 [GenAIPro]',      cost_per_1k_chars: 0.05, provider: 'genaipro' },
  'genaipro-flash-v2.5':      { label: 'ElevenLabs Flash v2.5 [GenAIPro]',      cost_per_1k_chars: 0.03, provider: 'genaipro' },
  'genaipro-v3':              { label: 'ElevenLabs v3 [GenAIPro]',              cost_per_1k_chars: 0.10, provider: 'genaipro' },
  // Chatterbox — self-hosted TTS over Tailscale. Cost is $0 (local compute).
  // Hidden from projects that haven't set chatterbox_enabled in their config.
  'chatterbox-default':       { label: 'Chatterbox – Default Voice [local]',    cost_per_1k_chars: 0,    provider: 'chatterbox' },
  'chatterbox-cloned':        { label: 'Chatterbox – Cloned Voice [local]',     cost_per_1k_chars: 0,    provider: 'chatterbox' },
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

