/**
 * I/O composable for the video-assembly page.
 *
 * The full page is large (~2k LOC); this composable holds the async calls
 * against the backend so the page component can focus on UI wiring. We don't
 * own the state here — the page passes its reactive refs in and we mutate
 * them in place. That means the page renderer and this composable can evolve
 * independently without a big-bang refactor of the template.
 *
 * Audio-related controls (narration source, chapter gap, music, noise) used
 * to live here but were moved out when Audio Assembly became a separate
 * upstream step. The video assembler now consumes only the merged audio
 * file produced there, so those fields no longer appear on the wire.
 *
 * The old single-preset `loadPreset` / `savePreset` pair used to live here
 * too; they've been replaced by per-slot `usePresets()` calls directly on
 * the page (intro, timeline, effects, subtitles, export) plus a bundle
 * picker that ties the slots together.
 *
 * Extracted functions:
 *   - checkFfmpeg()      — probes `/video-editor/check-ffmpeg`
 *   - scanAssets()       — discovers scenes/thumbnails/audio for an episode
 *   - generateVideo()    — composes payload + queues the assembly job
 */

// Explicit composable imports so this module is usable from plain node:test
// (no Nuxt auto-import context). Nuxt's auto-imports remain additive inside
// .vue files.
import type { Ref } from 'vue'
import { useApi } from './useApi.js'
import { useToast } from './useToast.js'

// A loose bag of refs/reactive objects the page passes in. Using `any` for
// the inner types keeps this composable decoupled from the page's growing
// schema — it mutates fields by name and the page keeps its strong types.
export interface VideoAssemblyIoState {
  slug: Ref<string>
  episodeId: Ref<string>
  selectedEpisode: Ref<any>
  ffmpegStatus: Ref<{
    installed: boolean
    version?: string
    has_drawtext?: boolean
    has_libass?: boolean
    /** Apple Media Engine encoders. Backend probes via `ffmpeg -encoders`
     *  on every status check. Used by the Video Assembly export-preset cards
     *  to grey out hardware-accelerated presets when the underlying ffmpeg
     *  build doesn't expose them. Optional for back-compat — old cached
     *  status objects in the renderer will read as undefined and the UI
     *  treats that as "unknown, leave the cards enabled". */
    hw_encoders?: { h264: boolean; h265: boolean }
    check_error?: string
  } | null>
  scannedAssets: Ref<any>
  scanning: Ref<boolean>
  scenes: Ref<Array<{
    image_path: string
    filename: string
    number: number
    title: string
    enabled: boolean
  }>>
  excludeIntroFromEffects: Ref<boolean>

  // Reactive objects mutated in-place by Object.assign.
  logo: any
  intro: any
  outro: any
  /** User-supplied timeline clips (multi-position). Passed as a Ref of an
   *  array because the page owns the list (add / remove / reorder) — the
   *  composable only reads it to build the payload. Discriminated by `kind`
   *  ('video' = video_path, 'static' = image_path + duration_sec). Old
   *  presets without `kind` are treated as 'video' on the page side. */
  timelineClips: Ref<Array<{
    id: string
    anchor: 'before_intro' | 'after_intro' | 'after_scenes' | 'after_outro'
    enabled: boolean
    kind?: 'video' | 'static'
    video_path?: string
    image_path?: string
    duration_sec?: number
  }>>
  titleImage: any
  sceneRecycling: any
  transition: any
  sceneAnimation: any
  postAudio: any
  colorGrading: any
  vignette: any
  filmGrain: any
  letterbox: any
  chromaKey: any
  /** Multi-layer overlay system (v1.0.53+). Authoritative when present;
   *  the legacy `chromaKey` slot is upgraded into a single layer on
   *  the backend if `overlays` is empty. */
  overlays?: any
  /** Workstream B (v1.0.54+): per-scene audio-to-visual alignment.
   *  Boolean ref. When true, payload sets `align_visuals_to_chapters`
   *  and the backend reads chapter durations from
   *  `${episode}/audio_chapters.json` (emitted by Audio Merge). */
  alignVisualsToChapters?: any
  /** Per-scene clip swap (v1.0.57+). Map of scene_number → chapter_slug.
   *  Stamped onto each VideoScene in the payload below; backend uses
   *  explicit slugs to partition instead of even-split. Empty/missing
   *  → backend falls back to positional even-split. */
  sceneAssignmentSaved?: Ref<Record<number, string>>
  /** Compilation video layout (v1.0.63+ / Path C). Reactive bag holding
   *  layout mode + background plate path + foreground defaults. When
   *  `videoLayout.value === 'compilation'`, the payload includes the
   *  compilation-mode fields and the backend takes the inverted
   *  base-bg / overlay-foreground render path. */
  compilationLayout?: any
  titleCard: any
  chapterTitles: any
  outroCard: any
  exportSettings: any
  // Only needed for generateVideo() — kept here so the state bag stays the
  // single handle the page passes in.
  subtitles?: any
  generating?: Ref<boolean>
  jobOutput?: Ref<string[]>
  // Populated with the enqueued job's id after `generateVideo()` succeeds,
  // so the page can subscribe to useJobs() and mirror the in-flight
  // output_lines + status onto the wizard UI.
  activeJobId?: Ref<string | null>
}

export function useVideoAssemblyIo(s: VideoAssemblyIoState) {
  const { get } = useApi()
  const { success, error: showError } = useToast()

  async function checkFfmpeg() {
    try {
      s.ffmpegStatus.value = await get<{
        installed: boolean
        version?: string
        has_drawtext?: boolean
        has_libass?: boolean
        hw_encoders?: { h264: boolean; h265: boolean }
      }>(
        `/projects/${s.slug.value}/video-editor/check-ffmpeg`,
      )
    } catch (e: any) {
      // Don't collapse a check-failure into `installed: false` — that
      // mislabels permission errors and corrupt binaries as "FFmpeg not
      // installed", and the operator is sent down the wrong remediation
      // path (Settings → install) instead of being told the actual
      // failure (e.g. backend unreachable, binary not executable). Carry
      // the error message through so the UI can distinguish the two.
      s.ffmpegStatus.value = {
        installed: false,
        check_error: e?.data?.detail || e?.message || 'FFmpeg check failed',
      }
    }
  }

  async function scanAssets() {
    if (!s.episodeId.value) return
    s.scanning.value = true
    s.scannedAssets.value = null
    try {
      s.scannedAssets.value = await get(
        `/projects/${s.slug.value}/video-editor/scan/${s.episodeId.value}`,
      )
      if (s.scannedAssets.value?.scenes?.length) {
        s.scenes.value = s.scannedAssets.value.scenes.map((img: any, i: number) => ({
          image_path: img.path || '',
          filename: img.filename || `scene_${i + 1}.png`,
          number: img.number || i + 1,
          title: img.title || '',
          enabled: true,
        }))
      }
      if (s.selectedEpisode.value?.title) {
        s.titleCard.text = s.selectedEpisode.value.title
      }
      if (s.scannedAssets.value?.thumbnails?.length) {
        s.titleImage.image_path = s.scannedAssets.value.thumbnails[0].path
      }
    } catch (e: any) {
      showError(e.data?.detail || 'Failed to scan assets')
    } finally {
      s.scanning.value = false
    }
  }


  /**
   * Build the video-assembly generate payload from the page's reactive state,
   * run the cost-confirmation prompt, then POST to the queue. Returns true
   * if the job was enqueued, false if the user cancelled or a submit error
   * occurred. The page is free to read `s.generating` / `videoAssemblyGenerating`
   * for its own UI feedback.
   *
   * Callers supply:
   *   - `post` — the useApi().post helper (re-injected so the composable
   *     doesn't have to import it twice if the caller already has it).
   *   - `confirmGeneration` — the useConfirmation().confirmGeneration
   *     function, injected the same way.
   *   - `videoAssemblyGenerating` — the sidebar's cross-tab "video assembly
   *     is running" flag that useGenerating exposes. This is the Video
   *     *Assembly* pulse, distinct from the AI Video Generator's
   *     `videoGenerating` (v1.0.391 — they used to be conflated).
   */
  async function generateVideo(opts: {
    post: (path: string, body: any) => Promise<any>
    confirmGeneration: (slug: string, type: string, params: Record<string, any>) => Promise<boolean>
    videoAssemblyGenerating: Ref<boolean>
  }): Promise<boolean> {
    const enabledScenes = s.scenes.value.filter(
      sc => !s.sceneRecycling.excluded_scenes.includes(sc.number),
    )

    // Narration always comes from the merged-audio file produced upstream
    // by Audio Assembly. We fall back to a raw chapter only if someone runs
    // the video step before merging — the backend validates this and errors
    // clearly.
    const mergedPath = s.scannedAssets.value?.merged_audio?.[0]?.path
    const narrationPath = mergedPath
      || s.scannedAssets.value?.narration_full?.path
      || s.scannedAssets.value?.audio_sections?.[0]?.path
      || ''

    // v1.0.57+: stamp per-scene chapter_slug from the saved
    // assignments map so backend honours explicit overrides without
    // re-reading the sidecar. Falls back to undefined when no
    // assignment exists for the scene_number — backend then defaults
    // to positional even-split for that scene.
    const assignmentMap = s.sceneAssignmentSaved?.value || {}
    const payload: Record<string, any> = {
      episode_id: s.episodeId.value,
      scenes: enabledScenes.map(sc => ({
        image_path: sc.image_path,
        duration: s.sceneRecycling.seconds_per_scene,
        title: sc.title || `Scene ${sc.number}`,
        show_title: s.chapterTitles.enabled,
        scene_number: sc.number,
        chapter_slug: assignmentMap[sc.number] || undefined,
      })),
      narration_path: narrationPath,
      merged_audio_path: mergedPath,
      transition: s.transition.type,
      transition_duration: s.transition.type === 'none' ? 0 : s.transition.duration,
      transition_pool: s.transition.pool,
      transition_randomize: s.transition.randomize_mode,
      resolution: s.exportSettings.resolution,
      quality: s.exportSettings.quality,
      fps: s.exportSettings.fps,
      encoding_effort: s.exportSettings.encoding_effort,
      codec: s.exportSettings.codec,
      format: s.exportSettings.format,
      scene_animation: { ...s.sceneAnimation },
      animation_pool: s.sceneAnimation.pool,
      animation_randomize: s.sceneAnimation.randomize_mode,
      post_audio: { ...s.postAudio },
      scene_recycling: {
        seconds_per_scene: s.sceneRecycling.seconds_per_scene,
        shuffle: s.sceneRecycling.shuffle,
        excluded_scenes: s.sceneRecycling.excluded_scenes,
      },
      // v1.0.354 — Target Duration removed. Length follows the narration;
      // the post-audio tail (post_audio) is the only intentional extension.
      chapter_titles: { ...s.chapterTitles },
    }

    if (s.logo.enabled && s.logo.image_path) {
      payload.logo = {
        enabled: true,
        image_path: s.logo.image_path,
        position: s.logo.position,
        custom_x: s.logo.custom_x,
        custom_y: s.logo.custom_y,
        opacity: s.logo.opacity / 100,
        scale: s.logo.scale / 100,
        margin: s.logo.margin,
        hide_during_intro: s.logo.hide_during_intro,
      }
    }

    if (s.intro.enabled && s.intro.video_path) {
      payload.intro = { enabled: true, video_path: s.intro.video_path }
    }

    if (s.outro.enabled && s.outro.video_path) {
      payload.outro = { enabled: true, video_path: s.outro.video_path }
    }

    // User-supplied timeline clips. Send only the fields the backend reads,
    // and only rows that are enabled + have a usable source. The backend
    // accepts a discriminated union: 'video' clips need video_path, 'static'
    // clips need image_path + duration_sec. Old presets without `kind`
    // default to 'video' for back-compat.
    const clips = (s.timelineClips.value || [])
      .filter((c) => {
        if (!c.enabled) return false
        const kind = c.kind ?? 'video'
        if (kind === 'static') {
          return !!c.image_path && Number.isFinite(c.duration_sec) && (c.duration_sec || 0) > 0
        }
        return !!c.video_path
      })
      .map((c) => {
        const kind = c.kind ?? 'video'
        if (kind === 'static') {
          return {
            id: c.id,
            kind: 'static' as const,
            image_path: c.image_path,
            duration_sec: c.duration_sec,
            anchor: c.anchor,
            enabled: true,
          }
        }
        return {
          id: c.id,
          kind: 'video' as const,
          video_path: c.video_path,
          anchor: c.anchor,
          enabled: true,
        }
      })
    if (clips.length) payload.timeline_clips = clips

    if (s.titleImage.enabled && s.titleImage.image_path) {
      payload.title_image = {
        enabled: true,
        image_path: s.titleImage.image_path,
        duration: s.titleImage.duration,
        transition_type: s.titleImage.transition_type || s.transition.type,
        transition_duration: s.titleImage.transition_duration || s.transition.duration,
      }
    }

    if (s.colorGrading.enabled) payload.color_grading = { ...s.colorGrading }
    if (s.vignette.enabled)     payload.vignette      = { ...s.vignette }
    if (s.chromaKey.enabled && s.chromaKey.source_path) payload.chroma_key = { ...s.chromaKey }
    // New multi-overlay path. Send only enabled layers with a
    // populated source_path so the backend doesn't waste an `-i`
    // slot on half-configured rows.
    if (s.overlays?.enabled && Array.isArray(s.overlays.layers)) {
      const liveLayers = s.overlays.layers.filter((l: any) => l && l.enabled && l.source_path)
      if (liveLayers.length) {
        payload.overlays = { enabled: true, layers: liveLayers.map((l: any) => ({ ...l })) }
      }
    }
    if (s.filmGrain.enabled)    payload.film_grain    = { ...s.filmGrain }
    if (s.letterbox.enabled)    payload.letterbox     = { ...s.letterbox }

    payload.exclude_intro_from_effects = s.excludeIntroFromEffects.value
    if (s.alignVisualsToChapters?.value) payload.align_visuals_to_chapters = true

    // Compilation mode payload (v1.0.63+). Only emits the new fields
    // when the user explicitly opted into compilation layout — the
    // standard sleep-story path stays byte-identical.
    const cl = s.compilationLayout
    if (cl?.layout?.value === 'compilation') {
      payload.video_layout = 'compilation'
      if (cl.backgroundPlate?.source_path) {
        payload.background_plate = {
          enabled: true,
          source_path: cl.backgroundPlate.source_path,
          loop: cl.backgroundPlate.loop !== false,
          opacity: cl.backgroundPlate.opacity ?? 1,
        }
      }
      payload.foreground_defaults = {
        scale_pct: cl.foregroundDefaults?.scale_pct ?? 0.5,
        position: cl.foregroundDefaults?.position ?? 'center',
        chroma_key: cl.foregroundDefaults?.chroma_key
          ? { ...cl.foregroundDefaults.chroma_key }
          : null,
      }
    }

    if (s.subtitles?.enabled && s.subtitles?.srt_path) {
      payload.subtitles = {
        enabled: true,
        source: s.subtitles.source,
        srt_path: s.subtitles.srt_path,
        style: { ...s.subtitles.style },
      }
    }

    if (s.titleCard.enabled) payload.title_card = { ...s.titleCard }
    if (s.outroCard.enabled) payload.outro_card = { ...s.outroCard }

    const confirmed = await opts.confirmGeneration(s.slug.value, 'video', payload)
    if (!confirmed) return false

    if (s.generating) s.generating.value = true
    opts.videoAssemblyGenerating.value = true
    if (s.jobOutput) s.jobOutput.value = []

    try {
      // The POST returns as soon as the job is enqueued — that's within
      // ~100ms. The *render* runs async for many minutes. We return the
      // enqueued job so the caller can watch it and keep the "generating"
      // UI live via the jobs SSE stream (see useJobs).
      const job = await opts.post<{ job_id: string }>(`/projects/${s.slug.value}/generate/video-assembly`, payload)
      success('Video assembly queued!')
      if (s.activeJobId) s.activeJobId.value = job?.job_id || null
      return true
    } catch (e: any) {
      console.error('[video-assembly] POST failed:', e)
      showError(e.data?.detail || 'Failed to start video generation')
      if (s.generating) s.generating.value = false
      opts.videoAssemblyGenerating.value = false
      return false
    }
    // Intentionally no `finally { generating = false }`. The caller now
    // owns the generating lifecycle — they watch the job via useJobs and
    // flip the flag off when the job reaches a terminal state (done /
    // error / cancelled). Clearing generating here would hide the live
    // output panel within milliseconds of clicking Generate.
  }

  return { checkFfmpeg, scanAssets, generateVideo }
}
