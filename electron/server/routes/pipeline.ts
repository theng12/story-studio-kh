/**
 * Pipeline batch runner.
 *
 * Lets the user kick off a chain (script → images → audio → audio_merge)
 * for many accepted ideas at once, using each generator's last-used preset
 * for that step's settings. Designed for overnight runs: one click, walk
 * away. The job-queue chain hook in services/job-queue.ts handles the
 * hand-off between steps on successful completion.
 */

import { Router } from 'express'
import { randomUUID } from 'crypto'
import * as pm from '../services/project-manager.js'
import * as im from '../services/idea-manager.js'
import * as jq from '../services/job-queue.js'
import type { Format, JobType } from '../models/types.js'
import { computeEpisodeStatus, type EpisodeStatus } from '../services/asset-status.js'
import { getEffectiveFormat } from '../services/format-loader.js'
import {
  estimateRunBatchBytes,
  getFreeBytes,
  formatBytes,
  type EpisodeEstimateInputs,
  type EstimateStep,
} from '../lib/disk.js'

export const router = Router()

// Step types the batch runner understands.
//
// `script-only` and `introduction-only` replaced the legacy coupled
// `script` step in M1 — there's now exactly one way to generate
// chapters + intro across the entire system, and the user opts in to
// each independently. `introduction-only` requires `script-only` (or
// pre-existing chapters on disk) for context; the pipeline UI gates
// the intro checkbox accordingly.
//
// `image_prompts` and `metadata` are wrapped LLM calls (see
// generators/image-prompts.ts and generators/metadata.ts) — batch mode
// auto-saves without review. `video` is expensive (~$0.50-$2/clip via
// Veo) so it's opt-in; same for `video_assembly` which requires
// images+merged audio to be done.
type BatchStep =
  | 'script-only'
  | 'introduction-only'
  | 'image_prompts'
  | 'images'
  | 'audio'
  | 'audio_merge'
  | 'metadata'
  | 'video'
  | 'video_assembly'
const VALID_STEPS: BatchStep[] = ['script-only', 'introduction-only', 'image_prompts', 'images', 'audio', 'audio_merge', 'metadata', 'video', 'video_assembly']

// Per-step preset-storage keys. Matches the configKey used by each
// generator page's usePresets() call. If the user hasn't applied a
// preset for a step, we fail the whole batch with a clear message —
// an unattended overnight run shouldn't silently use built-in
// defaults the user never saw.
//
// `activeKeys` is a priority-ordered list of config keys to look up the
// active preset id under. The first key with a non-empty string value
// wins. This supports the typed-preset system: pages that adopt
// `usePresets({ presetType: 'X' })` write to `<configKey>_last_preset_X`,
// and we list that typed key BEFORE the legacy `<configKey>_last_preset`
// so the typed selection takes precedence — but legacy untyped presets
// (saved before typing existed) still resolve via the fallback.
//
// Steps that don't use typed presets (every step except the future
// script-only / introduction-only) just have a single-element list.
const PRESET_KEYS: Record<BatchStep, { list: string; activeKeys: string[] }> = {
  // Both script-only and introduction-only share the 'script' configKey
  // (both live on scripts.vue). They use typed-preset keys per
  // usePresets({ presetType }), with a fallback to the legacy untyped
  // key for old presets saved before typing existed. Order matters:
  // typed first wins.
  'script-only':       { list: 'script_presets',           activeKeys: ['script_last_preset_script', 'script_last_preset'] },
  'introduction-only': { list: 'script_presets',           activeKeys: ['script_last_preset_introduction', 'script_last_preset'] },
  image_prompts:       { list: 'image_prompts_presets',    activeKeys: ['image_prompts_last_preset'] },
  images:              { list: 'image_generator_presets',  activeKeys: ['image_generator_last_preset'] },
  audio:               { list: 'audio_generator_presets',  activeKeys: ['audio_generator_last_preset'] },
  audio_merge:         { list: 'audio_merge_presets',      activeKeys: ['audio_merge_last_preset'] },
  metadata:            { list: 'metadata_presets',         activeKeys: ['metadata_last_preset'] },
  video:               { list: 'video_generator_presets',  activeKeys: ['video_generator_last_preset'] },
  video_assembly:      { list: 'video_bundle_presets',     activeKeys: ['video_bundle_last_preset'] },
}

interface StoredPreset { id: string; name: string; data?: any; type?: string; [k: string]: any }

/**
 * Per-step type tag used by usePresets({ presetType }) on the scripts page.
 * When the active-key lookup fails (either missing or pointing at an id no
 * longer in the list — a stale ghost from a deleted preset), we fall back
 * to the most recently saved preset in the list whose `type` matches this
 * map. Keeps pipeline.vue and this resolver in lock-step.
 */
const TYPE_FALLBACK: Partial<Record<BatchStep, string>> = {
  'script-only': 'script',
  'introduction-only': 'introduction',
}

/**
 * Is this step's output already on disk? Used by `run-batch` to skip
 * chain links that would otherwise regenerate existing assets — the
 * default "skip-when-done" behaviour keeps batches cheap.
 *
 * `video_assembly` has no stable "complete" marker (bundled asset; depends
 * on the user's export config), so it's never auto-skipped. `video` uses
 * the asset-reconciler's `status.video` (every clip present).
 */
export function isStepAlreadyDone(status: EpisodeStatus, step: BatchStep): boolean {
  switch (step) {
    case 'script-only':       return status.script
    case 'introduction-only': return status.introduction
    case 'image_prompts':     return status.scene_prompts && status.thumb_prompts
    case 'images':            return status.images && status.thumbnails
    case 'audio':             return status.audio
    case 'audio_merge':       return status.merged_audio
    case 'metadata':          return status.metadata
    case 'video':             return status.video
    case 'video_assembly':    return status.video_assembly
  }
}

export function findActivePreset(
  config: any, step: BatchStep,
): { preset: StoredPreset | null; missingReason: string | null } {
  const keys = PRESET_KEYS[step]
  const list: StoredPreset[] = Array.isArray(config?.[keys.list]) ? config[keys.list] : []
  // Walk activeKeys in order; first key with a non-empty string id wins.
  // Typed-preset key first → legacy untyped key fallback. Centralised here
  // so individual step entries don't have to duplicate the lookup chain.
  let activeId = ''
  for (const k of keys.activeKeys) {
    const v = typeof config?.[k] === 'string' ? config[k] : ''
    if (v) { activeId = v; break }
  }
  const pointedTo = activeId ? list.find(p => p.id === activeId) : null
  if (pointedTo) return { preset: pointedTo, missingReason: null }

  // Type-based fallback — heals stale/missing active pointers by using the
  // most recently saved preset of the matching type. usePresets appends on
  // save, so the last matching entry is newest.
  const wantedType = TYPE_FALLBACK[step]
  if (wantedType) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]?.type === wantedType) return { preset: list[i], missingReason: null }
    }
  }

  if (!activeId) return { preset: null, missingReason: `No active preset for ${step}. Open the ${step} page, apply a preset, then retry.` }
  return { preset: null, missingReason: `Active preset for ${step} (${activeId}) not found in saved presets.` }
}

/**
 * Translate a stored preset + episode context into the params shape the
 * generator's job executor expects. Each generator's request body differs,
 * so we branch per step.
 *
 * Crucially, we strip `pipeline_chain` / `pipeline_batch_id` from the
 * resulting params and let the job-queue chain hook re-add them at
 * enqueue time — keeps the caller's chain metadata authoritative.
 */
export function resolveStepParams(
  step: BatchStep,
  episodeId: string,
  title: string,
  preset: StoredPreset,
  format?: Format | null,
): Record<string, any> {
  const data = preset.data || preset
  if (step === 'script-only') {
    // Typed `script` preset (see scripts.vue useScripts presets):
    //   { form: { episode_id, title, length, model, style, chapters, ... },
    //     customStyleText: '…' }
    // Legacy untyped preset still includes `intro` at the root; ignore it
    // here — intro is its own step now.
    const form = data.form || {}
    // CRITICAL: the idea's title must win over whatever stale title was
    // saved into the preset at snapshot time. Without this, every batched
    // episode inherits the preset's original title and the script
    // generator creates "{code} - {stale-title}" folders that don't match
    // the real episode (the duplicate-folders bug from before the typed-
    // preset rollout).
    const { title: _stalePresetTitle, episode_id: _stale, ...restForm } = form
    return {
      ...restForm,
      episode_id: episodeId,
      title: title || form.title || '',
      customStyleText: data.customStyleText ?? form.customStyleText,
    }
  }
  if (step === 'introduction-only') {
    // Typed `introduction` preset (see scripts.vue introPresets):
    //   { intro: { host_name, word_target, custom_opening, enabled },
    //     introBeats: [{ id, label, enabled, custom? }, ...] }
    // The introduction-only endpoint expects a flat shape with the model
    // pulled from script-side context — we default to gpt-4o here as the
    // batch fallback (matches metadata's default for the same reason).
    const intro = data.intro || {}
    return {
      episode_id: episodeId,
      title: title || '',
      model: data.model || 'gpt-4o',
      host_name: intro.host_name,
      word_target: intro.word_target,
      custom_opening: intro.custom_opening,
      beats: Array.isArray(data.introBeats)
        ? data.introBeats.filter((b: any) => b.enabled).map((b: any) => b.label)
        : [],
    }
  }
  if (step === 'image_prompts') {
    // image_prompts preset shape: { form: {...} } from image-prompts.vue.
    // Batch mode always runs mode='all' — generate both scenes AND thumbs.
    const form = data.form || {}
    const { title: _t, episode_id: _e, ...rest } = form
    // Mirror the UI's submit normalization (image-prompts.vue:705-706):
    // when scenes_per_chapter > 0, drop any stale total_scenes so the
    // generator's fallback derives total from scenes_per_chapter. Without
    // this, a preset saved earlier as {scenes_per_chapter: 3, total_scenes: 30}
    // would keep using 30 even after the user saved it down to 1.
    const spc = Number((rest as any).scenes_per_chapter)
    if (Number.isFinite(spc) && spc > 0) {
      delete (rest as any).total_scenes
    }
    return {
      ...rest,
      episode_id: episodeId,
      title: title || '',
      mode: 'all',
    }
  }
  if (step === 'images') {
    const form = data.form || {}
    return {
      ...form,
      episode_id: episodeId,
      mode: form.mode || 'all',
    }
  }
  if (step === 'audio') {
    const form = data.form || {}
    return {
      ...form,
      episode_id: episodeId,
    }
  }
  // audio_merge stores config flat on the preset (no form wrapper):
  //   { id, name, intro, music, background_noise, gap_duration, normalize_volume }
  // The generator is patched to auto-resolve `chapters` from disk when
  // missing, so we deliberately OMIT chapters here — they'll be scanned
  // after the preceding audio step finishes.
  //
  // Volume normalisation: the audio-merge form stores volumes as
  // percentages (0–100, matching its sliders), and the standalone
  // page converts to 0–1 decimals before POSTing — see
  // `audio-merge.vue` (`volume: music.volume / 100`). The backend
  // generator passes those decimals straight to FFmpeg's `volume=`
  // filter, which treats values >1 as amplification. Without the
  // conversion below, a preset saying "music at 30%" reached FFmpeg
  // as `volume=30.00` (30× amplification → clipping → audio sounded
  // like 100%), and a preset at 100% reached as `volume=100.00`.
  // This block mirrors the conversion so batch runs respect presets
  // identically to single-episode runs.
  if (step === 'audio_merge') {
    const pct = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v / 100 : undefined

    const normIntro = data.intro ? {
      ...data.intro,
      ...(data.intro.volume !== undefined ? { volume: pct(data.intro.volume) ?? data.intro.volume } : {}),
    } : undefined
    const normMusic = data.music ? {
      ...data.music,
      ...(data.music.volume !== undefined ? { volume: pct(data.music.volume) ?? data.music.volume } : {}),
      ...(data.music.post_narration_volume !== undefined
        ? { post_narration_volume: pct(data.music.post_narration_volume) ?? data.music.post_narration_volume }
        : {}),
    } : undefined
    const normNoise = data.background_noise ? {
      ...data.background_noise,
      ...(data.background_noise.volume !== undefined
        ? { volume: pct(data.background_noise.volume) ?? data.background_noise.volume }
        : {}),
    } : undefined

    // Multi-track ambient (v1.0.55). The page UI stores volume on a
    // 0-100 scale and divides by 100 before POSTing — the bundle
    // snapshot saves the 0-100 form, so we apply the same conversion
    // here. Filter out empty / disabled rows so half-configured
    // layers don't waste an FFmpeg input slot.
    //
    // v1.0.71+: dropped a defensive `t.volume > 1 ? /100 : t.volume`
    // heuristic that was ambiguous at exactly 1.0 (couldn't tell
    // "100% on 0-1 scale" from "1% on 0-100 scale"). ambient_tracks
    // were always 0-100 in the bundle from v1.0.55 inception — no
    // legacy 0-1 saves to protect — so we now match the unconditional
    // divide-by-100 used by intro / music / background_noise above.
    // Closes the audit's #7 footgun.
    const liveAmbient = Array.isArray(data.ambient_tracks)
      ? (data.ambient_tracks as any[])
        .filter(t => t && t.enabled && t.source_path)
        .map(t => ({
          id: t.id,
          enabled: true,
          source_path: t.source_path,
          volume: typeof t.volume === 'number' && Number.isFinite(t.volume)
            ? Math.max(0, Math.min(1, t.volume / 100))
            : 1,
          fade_in: Math.max(0, Number(t.fade_in) || 0),
          fade_out: Math.max(0, Number(t.fade_out) || 0),
          loop: t.loop !== false,
        }))
      : []

    return {
      episode_id: episodeId,
      intro: normIntro,
      music: normMusic,
      background_noise: normNoise,
      ...(liveAmbient.length ? { ambient_tracks: liveAmbient } : {}),
      gap_duration: data.gap_duration,
      normalize_volume: data.normalize_volume,
    }
  }
  if (step === 'metadata') {
    // metadata preset shape: { sections: [...] } from metadata.vue. Everything
    // else (model, counts, max_chars) isn't persisted per-project today, so
    // we supply batch-mode defaults that map to the Metadata page's own
    // UI defaults.
    //
    // Format-aware defaults (v1.0.69+): pull description size, title count,
    // title length, and tag count from the project's effective Format
    // when available. Sleep-story projects keep their historical 5000 /
    // 5 / 100 / 15; listicle / educational get tighter values out of the
    // box (3500 / 5 / 70 / 12 etc.). Falls back to legacy hardcoded
    // numbers if format resolution fails or the format JSON predates
    // the new defaults block.
    const fmtMeta = format?.metadata
    return {
      episode_id: episodeId,
      title: title || '',
      model: 'gpt-4o',
      sections: Array.isArray(data.sections) ? data.sections : [],
      max_chars: fmtMeta?.defaultMaxChars ?? 5000,
      title_count: fmtMeta?.defaultTitleCount ?? 5,
      title_max_length: fmtMeta?.defaultTitleMaxLength ?? 100,
      title_platform_preset: 'Universal',
      tag_count: fmtMeta?.defaultTagCount ?? 15,
    }
  }
  if (step === 'video') {
    // Video (Veo) preset shape: { form, promptsForm } (see video.vue usePresets)
    const form = data.form || {}
    const { title: _t, episode_id: _e, ...rest } = form
    return {
      ...rest,
      episode_id: episodeId,
      title: title || '',
    }
  }
  if (step === 'video_assembly') {
    // Video-assembly presets are "bundles" referencing 5 slot presets
    // (intro/timeline/effects/subtitles/export) plus a fallback snapshot
    // containing the full config for each slot. The generator
    // (generators/video.ts) reads its request FLAT at the top level
    // (req.chroma_key, req.video_layout, req.background_plate, …), but
    // the bundle stores fields grouped under those 5 slot keys.
    //
    // Earlier code passed the slots through unchanged — so the generator
    // saw nested `params.effects.chroma_key` etc. at top level, which it
    // simply ignored. Result: every batch render dropped logos, color
    // grading, chroma-key, overlays, ambient music, animated chapter
    // titles, compilation-layout backgrounds, and per-scene chapter
    // alignment. Single-episode renders worked because the page POSTs
    // the flat shape directly.
    //
    // This branch now flattens each slot back to top level, mirroring
    // useVideoAssemblyIo.ts:buildPayload(). Fields are spread only when
    // they're meaningfully populated so the v2-feature paths stay
    // disabled for legacy presets that never set them.
    return flattenVideoAssemblyBundle(data, episodeId, title)
  }
  return { episode_id: episodeId }
}

/**
 * Flatten a video_assembly bundle's `fallback` slot snapshots up to the
 * top-level request shape that GenerateVideoRequest expects. Mirrors
 * frontend/composables/useVideoAssemblyIo.ts:buildPayload() — keeping
 * these in sync is essential for batch parity with single-episode
 * runs. Exported for test coverage.
 *
 * Why this exists: the bundle's serialised shape groups fields under
 * 5 slot keys (intro/timeline/effects/subtitles/export); the generator
 * reads them flat. Earlier batches passed the slots through verbatim
 * and the generator silently ignored the unknown nested keys.
 */
export function flattenVideoAssemblyBundle(
  bundleData: any,
  episodeId: string,
  title: string,
): Record<string, unknown> {
  const fb = bundleData?.fallback || {}

  // Legacy-preset passthrough (v1.0.69+). Pre-v1.0.64 video_assembly
  // presets stored fields flat at the top of `data` — there's no
  // `fallback` block at all. The bundle-shape branch below would
  // return only {episode_id, title} for those, silently dropping
  // every effect the user had configured. Detect that shape (no
  // `fallback`, but at least one known generator-shape field at
  // bundleData top level) and pass the flat fields straight through
  // so the batch render keeps the user's intent. We log a one-line
  // notice so the operator knows the preset is on borrowed time and
  // can re-save it via the Video Assembly page to migrate to the
  // bundle shape.
  const isLegacyFlat = !bundleData?.fallback && bundleData && typeof bundleData === 'object' && (
    'logo' in bundleData ||
    'color_grading' in bundleData ||
    'chroma_key' in bundleData ||
    'overlays' in bundleData ||
    'video_layout' in bundleData ||
    'background_plate' in bundleData ||
    'chapter_titles' in bundleData ||
    'transition' in bundleData ||
    'scene_animation' in bundleData ||
    'resolution' in bundleData ||
    'codec' in bundleData
  )
  if (isLegacyFlat) {
    console.warn(
      `[pipeline] video_assembly preset has legacy flat shape (no \`fallback\` block). `
      + `Passing fields through; re-save the preset from the Video Assembly page to migrate to the bundle shape.`,
    )
    const { episode_id: _e, title: _t, ...rest } = bundleData
    return {
      ...rest,
      episode_id: episodeId,
      title: title || '',
    }
  }

  const intro = fb.intro || {}
  const outro = fb.outro || {}
  const timeline = fb.timeline || {}
  const effects = fb.effects || {}
  const subtitles = fb.subtitles || {}
  const exportS = fb.export || {}

  const out: Record<string, unknown> = {
    episode_id: episodeId,
    title: title || '',
  }

  // ── Export settings (flat fields: resolution, quality, fps, codec, …)
  for (const k of ['resolution', 'quality', 'fps', 'encoding_effort', 'codec', 'format']) {
    if (exportS[k] !== undefined) out[k] = exportS[k]
  }

  // ── Timeline slot
  if (timeline.scene_recycling)  out.scene_recycling  = timeline.scene_recycling
  if (timeline.duration)         out.duration         = timeline.duration
  if (timeline.post_audio)       out.post_audio       = timeline.post_audio
  if (timeline.transition?.type !== undefined) {
    out.transition = timeline.transition.type
    out.transition_duration = timeline.transition.type === 'none' ? 0 : (timeline.transition.duration ?? 0)
    if (Array.isArray(timeline.transition.pool)) out.transition_pool = timeline.transition.pool
    if (timeline.transition.randomize_mode) out.transition_randomize = timeline.transition.randomize_mode
  }
  if (timeline.scene_animation) {
    out.scene_animation = timeline.scene_animation
    if (Array.isArray(timeline.scene_animation.pool)) out.animation_pool = timeline.scene_animation.pool
    if (timeline.scene_animation.randomize_mode) out.animation_randomize = timeline.scene_animation.randomize_mode
  }
  if (timeline.title_image?.enabled && timeline.title_image.image_path) {
    out.title_image = timeline.title_image
  }

  // ── Intro / outro slots
  if (intro.enabled && intro.video_path) {
    out.intro = { enabled: true, video_path: intro.video_path }
  }
  if (outro.enabled && outro.video_path) {
    out.outro = { enabled: true, video_path: outro.video_path }
  }

  // ── Effects slot — every field flattened to top level
  if (effects.logo?.enabled && effects.logo.image_path) {
    // Logo opacity/scale on the page are 0-100; the single-episode
    // payload divides by 100. We mirror that conversion here so
    // batch-mode logos render with the same intensity.
    const lg = effects.logo
    out.logo = {
      ...lg,
      opacity: typeof lg.opacity === 'number' && lg.opacity > 1 ? lg.opacity / 100 : lg.opacity,
      scale:   typeof lg.scale   === 'number' && lg.scale   > 1 ? lg.scale   / 100 : lg.scale,
    }
  }
  if (effects.color_grading?.enabled) out.color_grading = effects.color_grading
  if (effects.vignette?.enabled)      out.vignette      = effects.vignette
  if (effects.film_grain?.enabled)    out.film_grain    = effects.film_grain
  if (effects.letterbox?.enabled)     out.letterbox     = effects.letterbox
  if (effects.chroma_key?.enabled && effects.chroma_key.source_path) {
    out.chroma_key = effects.chroma_key
  }
  if (effects.overlays?.enabled && Array.isArray(effects.overlays.layers)) {
    const liveLayers = effects.overlays.layers.filter(
      (l: any) => l && l.enabled && l.source_path,
    )
    if (liveLayers.length) out.overlays = { enabled: true, layers: liveLayers }
  }
  if (effects.chapter_titles)         out.chapter_titles = effects.chapter_titles
  if (typeof effects.exclude_intro_from_effects === 'boolean') {
    out.exclude_intro_from_effects = effects.exclude_intro_from_effects
  }
  if (effects.align_visuals_to_chapters === true) {
    out.align_visuals_to_chapters = true
  }
  if (effects.title_card?.enabled) out.title_card = effects.title_card
  if (effects.outro_card?.enabled) out.outro_card = effects.outro_card

  // ── Compilation layout (v1.0.63). Saved to the effects slot under
  // `compilation_layout`. We flatten its sub-fields to the top-level
  // names the generator reads.
  const cl = effects.compilation_layout
  if (cl?.layout === 'compilation') {
    out.video_layout = 'compilation'
    if (cl.background_plate?.source_path) {
      const bp = cl.background_plate
      out.background_plate = {
        enabled: true,
        source_path: bp.source_path,
        loop: bp.loop !== false,
        opacity: typeof bp.opacity === 'number' ? bp.opacity : 1,
      }
    }
    if (cl.foreground_defaults) {
      out.foreground_defaults = {
        scale_pct: cl.foreground_defaults.scale_pct ?? 0.5,
        position: cl.foreground_defaults.position ?? 'center',
        chroma_key: cl.foreground_defaults.chroma_key ?? null,
      }
    }
  }

  // ── Subtitles slot. The bundle deliberately omits `srt_path`
  // (episode-specific); the generator regenerates it per episode
  // from the merged audio when subtitles.enabled is true.
  if (subtitles.enabled) {
    out.subtitles = {
      enabled: true,
      source: subtitles.source,
      style: subtitles.style,
    }
  }

  return out
}

/**
 * Build per-episode estimate inputs from the resolved presets so the
 * disk-space precheck can size the batch without scanning each episode's
 * narration / scene assets (those don't exist yet for ungenerated episodes).
 *
 * We pull resolution/quality from the video_assembly preset's `fallback.export`
 * slot (matches the shape used in resolveStepParams), the duration target
 * from the same slot when set to `custom`, and the clip count from the
 * video preset's promptsForm.scene_count. Falls back to defensive defaults
 * when a field is absent — the safety margin in estimateRunBatchBytes
 * absorbs the difference.
 */
/**
 * Pull a named slot ('export'|'timeline'|'effects'|…) out of a stored
 * video_assembly bundle preset. Bundle saves nest fields under
 * `data.fallback.<slot>`; very early presets (and a handful of test
 * fixtures) sometimes store the same shape one level shallower at
 * `data.fallback.<slot>` directly on the preset (no inner data). We
 * accept either, and return `{}` when both miss so callers can pull
 * fields with safe optional chaining.
 */
function extractPresetSlot(preset: StoredPreset | undefined, slot: string): any {
  if (!preset) return {}
  return (preset.data?.fallback?.[slot] ?? preset.fallback?.[slot] ?? {}) as any
}

function extractEstimateInputs(
  presetByStep: Record<BatchStep, StoredPreset>,
  episodeCount: number,
): EpisodeEstimateInputs[] {
  const vaPreset = presetByStep['video_assembly']
  const videoPreset = presetByStep['video']

  const exportSlot = extractPresetSlot(vaPreset, 'export')
  const resolution = typeof exportSlot.resolution === 'string' ? exportSlot.resolution : undefined
  const quality = typeof exportSlot.quality === 'string' ? exportSlot.quality : undefined

  // Duration: video_assembly preset doesn't carry it (depends on narration);
  // we default to 1 hour inside estimateBytesForStep. If the user pinned a
  // custom duration in the timeline slot, honour the upper bound.
  const timelineSlot = extractPresetSlot(vaPreset, 'timeline')
  let durationSec: number | undefined
  if (timelineSlot?.duration?.mode === 'custom') {
    const max = Number(timelineSlot.duration.max_duration)
    const min = Number(timelineSlot.duration.min_duration)
    if (Number.isFinite(max) && max > 0) durationSec = max
    else if (Number.isFinite(min) && min > 0) durationSec = min
  }

  const videoData = videoPreset?.data || videoPreset || {}
  const promptsForm = (videoData as any)?.promptsForm || {}
  const sceneCount = Number(promptsForm.scene_count)
  const clipCount = Number.isFinite(sceneCount) && sceneCount > 0 ? sceneCount : undefined

  // Audio: no narration char count available pre-generation. Use the default
  // inside estimateBytesForStep (15k chars) — over-estimating audio by a
  // few MB is harmless next to the GB-scale video numbers. The audio
  // preset isn't read here today; the slot lookup is intentionally absent
  // until per-preset narration char hints get plumbed in.

  const perEpisode: EpisodeEstimateInputs = {
    durationSec,
    resolution,
    quality,
    clipCount,
  }
  return Array.from({ length: episodeCount }, () => ({ ...perEpisode }))
}

router.post('/projects/:slug/pipeline/run-batch', async (req, res) => {
  const { slug } = req.params
  if (!await pm.getProject(slug)) return res.status(404).json({ detail: 'Project not found' })

  const episode_ids: string[] = Array.isArray(req.body?.episode_ids) ? req.body.episode_ids.filter((x: any) => typeof x === 'string' && x) : []
  const stepsRaw: any[] = Array.isArray(req.body?.steps) ? req.body.steps : []
  const steps: BatchStep[] = stepsRaw.filter((s): s is BatchStep => VALID_STEPS.includes(s))
  // `force: true` disables per-step idempotency skipping — every selected
  // step runs even if its output already exists. Default is to skip done
  // steps so the batch doesn't silently burn tokens on regeneration.
  const force: boolean = req.body?.force === true

  if (!episode_ids.length) return res.status(400).json({ detail: 'episode_ids must be a non-empty array' })
  if (!steps.length) return res.status(400).json({ detail: 'steps must include at least one of ' + VALID_STEPS.join(', ') })

  const config = await pm.getConfig(slug)
  if (!config) return res.status(400).json({ detail: 'Project config missing' })

  // Verify every selected step has an active preset before enqueueing
  // anything. Avoids the half-started-batch failure mode where episode A
  // is already running when we discover episode B has no audio preset.
  const missing: Array<{ step: BatchStep; reason: string }> = []
  const presetByStep = {} as Record<BatchStep, StoredPreset>
  for (const step of steps) {
    const r = findActivePreset(config, step)
    if (r.preset) {
      presetByStep[step] = r.preset
    } else {
      missing.push({ step, reason: r.missingReason || 'preset missing' })
    }
  }
  if (missing.length) {
    return res.status(400).json({
      detail: 'One or more selected steps have no active preset',
      missing,
    })
  }

  // Free-disk-space precheck. Burning hours of FFmpeg time only to fail
  // halfway through a 20-episode batch is the failure mode this guards
  // against (audit-reports/09-jobs.md M3). Sum the worst-case byte cost
  // across every (step × episode) pair, multiply by a safety margin
  // inside estimateRunBatchBytes, then compare against statfs on the
  // PROJECTS_ROOT volume. We soft-pass when statfs returns 0 (unknown
  // filesystem) so this never blocks legitimate work on exotic FSes.
  const estimateInputs = extractEstimateInputs(presetByStep, episode_ids.length)
  const estimatedBytes = estimateRunBatchBytes(steps as EstimateStep[], estimateInputs)
  // Check free space on the volume the project's assets actually live
  // on — for a linked project that's the iCloud / external folder, not
  // PROJECTS_ROOT. Falls back to PROJECTS_ROOT for projects without a
  // resolvable output folder yet.
  const outputRoot = await pm.getProjectOutputRoot(slug)
  const probePath = outputRoot || pm.PROJECTS_ROOT
  const freeBytes = await getFreeBytes(probePath)
  if (freeBytes > 0 && freeBytes < estimatedBytes) {
    return res.status(400).json({
      detail: `Not enough free disk space for this batch. Have: ${formatBytes(freeBytes)}, need: ${formatBytes(estimatedBytes)} (estimated for ${episode_ids.length} episode${episode_ids.length === 1 ? '' : 's'} × ${steps.length} step${steps.length === 1 ? '' : 's'}, includes 1.5× safety margin). Free up space and retry.`,
      free_bytes: freeBytes,
      required_bytes: estimatedBytes,
      episodes: episode_ids.length,
      steps: steps.length,
    })
  }

  // Match episode_ids against accepted ideas so we can pull the title.
  const ideas = await im.getIdeas(slug, 'accepted')
  const ideaByCode = new Map(ideas.filter(i => i.episode_code).map(i => [i.episode_code!, i]))

  // Resolve the project's effective Format once per batch so resolveStepParams
  // can populate format-aware defaults (metadata sizes, future format-tuned
  // params). Cheap (project.json read + JSON merge); null when the project
  // has no format_id and no built-in default exists.
  const effectiveFormat = await getEffectiveFormat(slug)

  const batch_id = randomUUID()
  const enqueued: Array<{ episode_id: string; job_id: string; type: JobType }> = []
  const skipped: Array<{ episode_id: string; reason: string }> = []
  // Per-episode per-step skips — steps that were in `steps` but whose
  // output already exists. Populated only when `force` is falsy.
  const steps_skipped_as_done: Array<{ episode_id: string; step: BatchStep }> = []
  // Running total of actually-enqueued step count across all episodes,
  // used for the response's `total_jobs_planned` so the number reflects
  // what'll really run (not `episodes × steps`).
  let totalEnqueuedStepCount = 0

  for (const episodeId of episode_ids) {
    const idea = ideaByCode.get(episodeId)
    if (!idea) {
      skipped.push({ episode_id: episodeId, reason: 'Not found among accepted ideas' })
      continue
    }

    // Idempotency: drop steps whose outputs are already on disk. Keeps
    // batches cheap on partially-generated episodes. The user can opt out
    // with `force: true` to regenerate everything.
    let effectiveSteps: BatchStep[] = steps
    if (!force) {
      const status = await computeEpisodeStatus(slug, episodeId)
      effectiveSteps = steps.filter(step => {
        if (isStepAlreadyDone(status, step)) {
          steps_skipped_as_done.push({ episode_id: episodeId, step })
          return false
        }
        return true
      })
    }

    if (effectiveSteps.length === 0) {
      skipped.push({ episode_id: episodeId, reason: 'All selected steps already complete' })
      continue
    }

    // Build the whole chain up front so each link has its own resolved params.
    const chain = effectiveSteps.map(step => ({
      type: step as JobType,
      title: `[batch] ${step} — ${episodeId}`,
      params: resolveStepParams(step, episodeId, idea.title || '', presetByStep[step], effectiveFormat),
    }))

    const [first, ...rest] = chain

    // Duplicate guard: skip this episode entirely if its first step is
    // already queued/running. The user can see the existing job in the
    // Jobs tab; silently piling another one on is worse UX than a skip.
    if (jq.isDuplicate(slug, episodeId, first.type)) {
      skipped.push({ episode_id: episodeId, reason: `${first.type} already queued/running` })
      continue
    }

    const job = jq.enqueue({
      project_slug: slug,
      type: first.type,
      episode_id: episodeId,
      title: first.title,
      params: {
        ...first.params,
        pipeline_chain: rest,
        pipeline_batch_id: batch_id,
      },
    })
    enqueued.push({ episode_id: episodeId, job_id: job.job_id, type: first.type })
    totalEnqueuedStepCount += effectiveSteps.length
  }

  res.status(201).json({
    batch_id,
    enqueued: enqueued.length,
    total_jobs_planned: totalEnqueuedStepCount,
    skipped,
    steps_skipped_as_done,
    jobs: enqueued,
    steps,
    force,
  })
})
