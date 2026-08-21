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
  agedArchiveFilm: any
  letterbox: any
  /** v1.2.0 — the effect-library selection. Absent means "no overlays". */
  sceneEffects?: { enabled: boolean; overlays: Array<{ id: string; enabled: boolean; params?: Record<string, unknown> }> }
  frame?: any
  chromaKey: any
  /** Multi-layer overlay system (v1.0.53+). Authoritative when present;
   *  the legacy `chromaKey` slot is upgraded into a single layer on
   *  the backend if `overlays` is empty. */
  overlays?: any
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
  normalizePath?: (input: string) => Promise<string>
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
      applyScenePoolMode()
      // v1.3.4 — both of the next two used to be `if (source) assign` with no
      // else, so a new episode that supplied no replacement silently kept the
      // PREVIOUS episode's value — and both reach the finished video. Same
      // shape as the `srt_path` defect this release fixes: episode-specific
      // state surviving an episode change because the refresh only ever filled
      // a gap instead of replacing the field. An episode with no title, or with
      // no thumbnails yet, is now blank rather than borrowing its neighbour's.
      s.titleCard.text = s.selectedEpisode.value?.title || ''
      const thumbnail = s.scannedAssets.value?.thumbnails?.[0]?.path
      s.titleImage.image_path = thumbnail
        ? (s.normalizePath ? await s.normalizePath(thumbnail) : thumbnail)
        : ''
    } catch (e: any) {
      // The scan failed, so nothing below is known for THIS episode. Leaving
      // the previous episode's scene list in place made the page report its
      // count, its cycle estimate and its low-asset warning against an episode
      // they do not describe.
      s.scenes.value = []
      showError(e.data?.detail || 'Failed to scan assets')
    } finally {
      s.scanning.value = false
    }
  }

  function applyScenePoolMode() {
    const all = Array.isArray(s.scannedAssets.value?.scenes)
      ? s.scannedAssets.value.scenes
      : []
    const planned = all.filter((img: any) => img.source === 'scene_plan')
    s.scenes.value = planned.map((img: any, i: number) => ({
      image_path: img.path || '',
      filename: img.filename || `scene_${i + 1}.png`,
      number: img.number || i + 1,
      title: img.title || '',
      enabled: true,
      // v1.0.521 — keep the pool source + plan scene id on each entry so the
      // generate payload can tell the backend this is a plan-sourced list.
      // Plan renders are always named `<scene_id>.<ext>`, so the basename
      // stem IS the id.
      source: img.source || undefined,
      plan_scene_id: img.source === 'scene_plan'
        ? (img.plan_scene_id || String(img.filename || img.path || '').split('/').pop()!.replace(/\.[^.]+$/, ''))
        : undefined,
    }))
  }


  /**
   * Build the video-assembly generate payload from the page's reactive state,
   * then POST to the queue. Returns true if the job was enqueued, false on a
   * submit error. The page is free to read `s.generating` /
   * `videoAssemblyGenerating` for its own UI feedback.
   *
   * Video assembly is a local ffmpeg render, so it queues without a generation
   * confirmation.
   *
   * Callers supply:
   *   - `post` — the useApi().post helper (re-injected so the composable
   *     doesn't have to import it twice if the caller already has it).
   *   - `videoAssemblyGenerating` — the sidebar's cross-tab "video assembly
   *     is running" flag that useGenerating exposes. This is the Video
   *     *Assembly* pulse, distinct from the AI Video Generator's
   *     `videoGenerating` (v1.0.391 — they used to be conflated).
   */
  /**
   * The render request this page would submit.
   *
   * v1.4.0 — split out of `generateVideo` so the caption preflight can ask for
   * frames from the EXACT payload the render will use. Building a second,
   * similar payload for the preview would let the frames describe a render that
   * never happens: a different resolution scales the caption differently, and a
   * different `hide_during_intro` changes which cues exist at all.
   *
   * Scene media, order, exact durations, and merged audio are intentionally
   * absent. The backend re-scans the authoritative Scene Plan immediately before
   * enqueue and again before execution, so a stale tab or preset can never
   * submit an alternate timeline.
   */
  function buildPayload(): Record<string, any> {
    const payload: Record<string, any> = {
      episode_id: s.episodeId.value,
      scene_pool_mode: 'scene_plan',
      transition: s.transition.type,
      transition_duration: s.transition.type === 'none' ? 0 : s.transition.duration,
      transition_pool: s.transition.pool,
      transition_randomize: s.transition.randomize_mode,
      resolution: s.exportSettings.resolution,
      // v1.4.15 — the frame's shape. Rides in the same payload as the
      // resolution, which means the caption preflight (built from this exact
      // function) draws its frames at the render's real shape without any
      // separate wiring.
      aspect_ratio: s.exportSettings.aspect_ratio,
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
        shuffle: false,
        excluded_scenes: [],
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
    if (s.agedArchiveFilm.enabled) payload.aged_archive_film = { ...s.agedArchiveFilm }
    if (s.letterbox.enabled)    payload.letterbox     = { ...s.letterbox }
    // Only emitted when something is actually selected. An empty list is not
    // sent at all, so a config written before v1.2.0 produces a byte-identical
    // request and renders exactly as it always did.
    const chosenEffects = (s.sceneEffects?.overlays || []).filter(o => o.enabled)
    if (s.sceneEffects?.enabled && chosenEffects.length) {
      payload.scene_effects = {
        enabled: true,
        overlays: chosenEffects.map(o => ({ id: o.id, enabled: true, params: { ...(o.params || {}) } })),
      }
    }
    if (s.frame?.enabled)       payload.frame         = { ...s.frame }

    payload.exclude_intro_from_effects = s.excludeIntroFromEffects.value

    // Compilation mode payload. Only emits these fields when the user
    // explicitly opts into that layout; standard assembly payloads remain
    // unchanged.
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

    // v1.4.0 — NO `srt_path`. Video Assembly no longer chooses a transcript;
    // `resolveEpisodeSubtitleFile` does, for this page and for Pipeline batches
    // alike, so both arrive at the renderer the same way and get the same
    // answer. The gate used to be `enabled && srt_path`, which meant a render
    // was silently captionless whenever the browser's path was empty.
    if (s.subtitles?.enabled) {
      payload.subtitles = {
        enabled: true,
        source: s.subtitles.source,
        // Trim intro captions from the burn when the assembly setting enables it.
        hide_during_intro: !!s.subtitles.hide_during_intro,
        style: { ...s.subtitles.style },
      }
    }

    if (s.titleCard.enabled) payload.title_card = { ...s.titleCard }
    if (s.outroCard.enabled) payload.outro_card = { ...s.outroCard }
    return payload
  }

  async function generateVideo(opts: {
    post: (path: string, body: any) => Promise<any>
    videoAssemblyGenerating: Ref<boolean>
  }): Promise<boolean> {
    const payload = buildPayload()
    // v1.0.514 — straight to enqueue; no cost/duration confirmation dialog
    // (free local render — see the function doc).
    if (s.generating) s.generating.value = true
    if (opts.videoAssemblyGenerating) opts.videoAssemblyGenerating.value = true
    if (s.jobOutput) s.jobOutput.value = []

    try {
      // The POST returns as soon as the job is enqueued — that's within
      // ~100ms. The *render* runs async for many minutes. We return the
      // enqueued job so the caller can watch it and keep the "generating"
      // UI live via the jobs SSE stream (see useJobs).
      const job = await opts.post(`/projects/${s.slug.value}/generate/video-assembly`, payload) as { job_id: string }
      success('Video assembly queued!')
      if (s.activeJobId) s.activeJobId.value = job?.job_id || null
      return true
    } catch (e: any) {
      console.error('[video-assembly] POST failed:', e)
      showError(e.data?.detail || 'Failed to start video generation')
      if (s.generating) s.generating.value = false
      if (opts.videoAssemblyGenerating) opts.videoAssemblyGenerating.value = false
      return false
    }
    // Intentionally no `finally { generating = false }`. The caller now
    // owns the generating lifecycle — they watch the job via useJobs and
    // flip the flag off when the job reaches a terminal state (done /
    // error / cancelled). Clearing generating here would hide the live
    // output panel within milliseconds of clicking Generate.
  }

  return { checkFfmpeg, scanAssets, generateVideo, buildPayload }
}
