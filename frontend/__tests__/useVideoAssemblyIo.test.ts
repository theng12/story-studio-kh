/**
 * Tests for `useVideoAssemblyIo.generateVideo()`.
 *
 * The extracted function owns the contract between the Video Assembly
 * wizard and the backend's `/api/projects/:slug/generate/video-assembly`
 * endpoint. That contract covers a lot:
 *
 *   - Scene media, timing, and narration are never trusted from the browser;
 *     the backend hydrates them from Scene Plan + merged audio.
 *   - Optional sections (logo, intro, outro, title image, color grading, vignette,
 *     chroma key, film grain, letterbox, subtitles, title/outro card) only
 *     appear in the payload when their `.enabled` flag is true.
 *   - Flag lifecycle: `generating` / `videoGenerating` must flip correctly
 *     on success AND on error (else the sidebar pulse stays stuck).
 *   - Return value: true on submit, false on submit-error.
 *
 * A full-fidelity state bag would be tedious to build inline per test, so
 * `makeState()` produces a sensible baseline that individual tests tweak.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { ref, reactive } from 'vue'

// useVideoAssemblyIo pulls in useApi + useToast. Those use $fetch — stub
// it before importing so the module captures our stub at setup time.
;(globalThis as any).$fetch = async () => ({})

const { useVideoAssemblyIo } = await import('../composables/useVideoAssemblyIo.js')

function makeState() {
  return {
    slug: ref('proj-x'),
    episodeId: ref('EP0001'),
    selectedEpisode: ref<any>(null),
    ffmpegStatus: ref<any>(null),
    scannedAssets: ref<any>({
      merged_audio: [{ path: '/m/merged.mp3' }],
      narration_full: { path: '/m/full.mp3' },
      audio_sections: [{ path: '/m/section-1.mp3' }],
      scenes: [],
      thumbnails: [],
    }),
    scanning: ref(false),
    scenes: ref([
      { image_path: '/i/1.png', filename: '1.png', number: 1, title: 'First', enabled: true },
      { image_path: '/i/2.png', filename: '2.png', number: 2, title: 'Second', enabled: true },
      { image_path: '/i/3.png', filename: '3.png', number: 3, title: '', enabled: true },
    ]),
    excludeIntroFromEffects: ref(true),

    // Reactives — makeState ships them disabled so the base payload is
    // minimal; individual tests flip flags to assert optional sections.
    logo:          reactive({ enabled: false, image_path: '', position: 'top-right', custom_x: 0, custom_y: 0, opacity: 70, scale: 10, margin: 20, hide_during_intro: false }),
    intro:         reactive({ enabled: false, video_path: '' }),
    // Symmetric to `intro`: a tail clip stitched onto the back of the
    // assembly. The composable's `generateVideo()` reads `s.outro.enabled`
    // and `s.outro.video_path` on every run; a missing fixture entry was
    // throwing "Cannot read properties of undefined (reading 'enabled')"
    // on every test in this describe block.
    outro:         reactive({ enabled: false, video_path: '' }),
    // User-supplied timeline clips (multi-anchor). Empty list = payload
    // omits the `timeline_clips` key, matching pre-feature behaviour.
    timelineClips: ref<Array<{ id: string; video_path: string; anchor: 'before_intro' | 'after_intro' | 'after_scenes' | 'after_outro'; enabled: boolean }>>([]),
    titleImage:    reactive({ enabled: false, image_path: '', duration: 5, transition_type: '', transition_duration: 0 }),
    sceneRecycling: reactive({ seconds_per_scene: 10, shuffle: false, excluded_scenes: [] as number[] }),
    transition:    reactive({ type: 'fade', duration: 0.5, pool: [], randomize_mode: 'off' }),
    sceneAnimation: reactive({ type: 'ken-burns', zoom_start: 100, zoom_end: 108, pool: [], randomize_mode: 'off' }),
    postAudio:     reactive({ behavior: 'fade-to-black', fade_duration: 5 }),
    colorGrading:  reactive({ enabled: false, preset: 'none', brightness: 0, contrast: 1, saturation: 1, warmth: 0, tint: 0 }),
    vignette:      reactive({ enabled: false, strength: 0.4 }),
    filmGrain:     reactive({ enabled: false, strength: 15 }),
    agedArchiveFilm: reactive({ enabled: false, strength: 45 }),
    letterbox:     reactive({ enabled: false, ratio: '2.35:1', color: 'black' }),
    frame:         reactive({ enabled: false, inset_pct: 4, border_width: 12, corner_radius: 28, border_color: '#fff', background_color: '#111', fit: 'cover' }),
    chromaKey:     reactive({ enabled: false, source_path: '', color: '#00FF00', similarity: 0.15, blend: 0.1 }),
    titleCard:     reactive({ enabled: false, text: 'T', duration: 3, style: 'gold', background: '#000' }),
    chapterTitles: reactive({ enabled: false, style: 'gold', position: 'center', duration: 2.5, font_size: 'medium' }),
    outroCard:     reactive({ enabled: false, text: '', duration: 3, style: 'gold' }),
    exportSettings: reactive({ resolution: '1080p', aspect_ratio: '9:16', quality: 'high', format: 'mp4' }),
    subtitles:     reactive({ enabled: false, source: 'chapters', srt_path: '', style: {} }),
    generating:    ref(false),
    jobOutput:     ref<string[]>([]),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useVideoAssemblyIo.generateVideo()', () => {
  let state: ReturnType<typeof makeState>
  let videoGenerating: any

  beforeEach(() => {
    state = makeState()
    videoGenerating = ref(false)
  })

  // v1.0.514 — video assembly no longer shows a cost/duration confirmation
  // (free local render), so there's no cancel gate to test; a click enqueues
  // straight away. The submit-error path (below) still returns false.

  test('happy path — POSTs correct payload shape, returns true, flips flags', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    let capturedUrl = ''
    let capturedBody: any = null
    const ok = await generateVideo({
      post: async (url, body) => { capturedUrl = url; capturedBody = body },
      videoAssemblyGenerating: videoGenerating,
    })

    assert.equal(ok, true)
    assert.equal(capturedUrl, '/projects/proj-x/generate/video-assembly',
      'POST must hit the video-assembly generate endpoint')

    assert.equal(capturedBody.scenes, undefined)
    assert.equal(capturedBody.narration_path, undefined)
    assert.equal(capturedBody.merged_audio_path, undefined)
    assert.equal(capturedBody.scene_pool_mode, 'scene_plan')

    // v1.4.15 — the frame's shape has to reach the backend, and it has to
    // reach it through THIS builder: the caption preflight posts the same
    // payload, so a preflight drawn at the wrong shape would prove nothing.
    assert.equal(capturedBody.resolution, '1080p')
    assert.equal(capturedBody.aspect_ratio, '9:16')

    // v1.0.354+: target-duration padding was removed. Video length follows
    // narration, with post-audio as the only intentional tail extension.
    assert.equal(capturedBody.duration, undefined)
    assert.deepEqual(capturedBody.post_audio, {
      behavior: 'fade-to-black',
      fade_duration: 5,
    })

    // Transition "none" maps to 0s duration
    // (our baseline uses "fade"; confirm the echo)
    assert.equal(capturedBody.transition, 'fade')
    assert.equal(capturedBody.transition_duration, 0.5)

    // No optional sections flipped on → not present in payload
    assert.equal(capturedBody.logo, undefined)
    assert.equal(capturedBody.intro, undefined)
    assert.equal(capturedBody.title_image, undefined)
    assert.equal(capturedBody.color_grading, undefined)
    assert.equal(capturedBody.vignette, undefined)
    assert.equal(capturedBody.chroma_key, undefined)
    assert.equal(capturedBody.film_grain, undefined)
    assert.equal(capturedBody.aged_archive_film, undefined)
    assert.equal(capturedBody.letterbox, undefined)
    assert.equal(capturedBody.subtitles, undefined)
    assert.equal(capturedBody.title_card, undefined)
    assert.equal(capturedBody.outro_card, undefined)

    // exclude_intro_from_effects passes through even when no effects enabled.
    assert.equal(capturedBody.exclude_intro_from_effects, true)

    // Flag lifecycle on SUCCESS: both `generating` and `videoGenerating`
    // stay TRUE after submit. The caller owns the terminal transition —
    // it watches the enqueued job via useJobs' SSE stream and flips the
    // flags off when the job reaches done/error/cancelled. Clearing them
    // here would hide the live output panel within ms of clicking Generate.
    assert.equal(state.generating.value, true,
      'generating stays true on submit — useJobs clears it when the job finishes')
    assert.equal(videoGenerating.value, true,
      'videoGenerating stays true on submit — the queue poller clears it later')
    assert.deepEqual(state.jobOutput.value, [], 'jobOutput cleared on run start')
  })

  test('legacy recycling controls cannot alter the authoritative plan', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    state.sceneRecycling.excluded_scenes = [2] // drop the middle one
    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.equal(body.scenes, undefined)
    assert.deepEqual(body.scene_recycling.excluded_scenes, [])
    assert.equal(body.scene_recycling.shuffle, false)
  })

  test('enabled optional sections appear in the payload with rescaled values', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    state.logo.enabled = true
    state.logo.image_path = '/logo.png'
    // Logo opacity/scale are stored 0-100 in UI but 0-1 on the wire.
    state.logo.opacity = 80
    state.logo.scale = 15

    state.intro.enabled = true
    state.intro.video_path = '/intro.mp4'

    state.titleImage.enabled = true
    state.titleImage.image_path = '/title.png'
    state.titleImage.duration = 7

    state.colorGrading.enabled = true
    state.vignette.enabled = true
    state.filmGrain.enabled = true
    state.agedArchiveFilm.enabled = true
    state.letterbox.enabled = true
    state.frame.enabled = true
    state.chromaKey.enabled = true
    state.chromaKey.source_path = '/green.mp4'
    state.titleCard.enabled = true
    state.outroCard.enabled = true
    state.subtitles.enabled = true
    state.subtitles.style = {
      position_x_pct: 37.5,
      position_y_pct: 84,
      safe_margin_pct: 10,
    }

    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })

    assert.ok(body.logo, 'logo section present when enabled')
    assert.equal(body.logo.opacity, 0.8, 'UI 80 → wire 0.8')
    assert.equal(body.logo.scale, 0.15, 'UI 15 → wire 0.15')
    assert.equal(body.intro.video_path, '/intro.mp4')
    assert.equal(body.title_image.duration, 7)
    assert.ok(body.color_grading, 'color_grading present when enabled')
    assert.ok(body.vignette, 'vignette present when enabled')
    assert.ok(body.film_grain, 'film_grain present when enabled')
    assert.deepEqual(body.aged_archive_film, { enabled: true, strength: 45 }, 'archive effect sends only its own settings')
    assert.ok(body.letterbox, 'letterbox present when enabled')
    assert.equal(body.frame.corner_radius, 28, 'presentation frame present when enabled')
    assert.ok(body.chroma_key, 'chroma_key present when enabled AND source_path set')
    assert.equal(body.title_card.text, 'T')
    assert.ok(body.outro_card, 'outro_card present when enabled')
    // v1.4.0 — the payload carries NO transcript path. Video Assembly stopped
    // choosing one: `resolveEpisodeSubtitleFile` resolves it per episode for this
    // page and for Pipeline batches alike, so both reach the renderer the same
    // way. A browser-supplied path is what the backend's ownership guard exists
    // to refuse, and sending one was how EP0048's captions reached EP0047.
    assert.ok(body.subtitles, 'the subtitles block is sent on `enabled` alone')
    assert.equal(body.subtitles.srt_path, undefined, 'no subtitle path may be sent from the browser')
    assert.deepEqual(body.subtitles.style, {
      position_x_pct: 37.5,
      position_y_pct: 84,
      safe_margin_pct: 10,
    }, 'precise safe-area placement survives the final assembly payload')
  })

  test('timeline_clips filters disabled/empty rows and omits the key when none remain', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    state.timelineClips.value = [
      { id: 'a', video_path: '/black.mp4', anchor: 'after_outro', enabled: true },
      { id: 'b', video_path: '', anchor: 'before_intro', enabled: true },   // empty path → drop
      { id: 'c', video_path: '/sting.mp4', anchor: 'after_scenes', enabled: false }, // disabled → drop
      { id: 'd', video_path: '/opener.mp4', anchor: 'before_intro', enabled: true },
    ]
    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.ok(Array.isArray(body.timeline_clips), 'timeline_clips included when at least one valid row exists')
    assert.equal(body.timeline_clips.length, 2, 'empty-path and disabled rows are filtered out')
    assert.deepEqual(
      body.timeline_clips.map((c: any) => c.id),
      ['a', 'd'],
      'order is preserved from the source list (filter, not reorder)',
    )
    assert.equal(body.timeline_clips[0].anchor, 'after_outro')
    assert.equal(body.timeline_clips[1].anchor, 'before_intro')
  })

  test('timeline_clips key is omitted from payload when list is empty (back-compat)', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    // Default makeState leaves timelineClips empty. Omitting the key keeps
    // the payload byte-identical to pre-feature requests, so presets saved
    // before timeline clips still decode and the backend's `?.length`
    // guard short-circuits without allocation.
    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.equal(body.timeline_clips, undefined, 'empty list → key absent, not an empty array')
  })

  test('chroma_key is NOT included if enabled but source_path is empty', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    state.chromaKey.enabled = true
    state.chromaKey.source_path = '' // user enabled but didn't pick a file
    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.equal(body.chroma_key, undefined,
      'chroma_key requires a source_path — the enabled flag alone is not enough')
  })

  test('submit error resets videoGenerating + generating, returns false', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    const ok = await generateVideo({
      post: async () => { throw new Error('backend down') },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.equal(ok, false)
    assert.equal(state.generating.value, false,
      'generating must be rolled back on submit failure — no SSE job exists to clear it later')
    assert.equal(videoGenerating.value, false,
      'videoGenerating must roll back to false on submit failure — otherwise the sidebar pulse sticks')
  })

  test('chapter-title styling travels without a browser-authored scene list', async () => {
    const { generateVideo } = useVideoAssemblyIo(state as any)
    state.chapterTitles.enabled = true
    let body: any
    await generateVideo({
      post: async (_u, b) => { body = b },
      videoAssemblyGenerating: videoGenerating,
    })
    assert.equal(body.scenes, undefined)
    assert.equal(body.chapter_titles.enabled, true)
  })
})
