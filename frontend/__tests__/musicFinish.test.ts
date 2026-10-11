/**
 * Music channel format, phase 4 ("finish"): music-aware steps on the Board / selectors, the Pipeline
 * and Remote music chain, the Thumbnail Generator's scene panel, the Finalizer's music copy, the
 * Episode Builder's polish / pictures preset / stills window, and the upscale sharpening control.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { describe } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  STEP_STATUS_FIELD,
  isEpisodeDone,
  requiredStatusFields,
} from '../composables/useProjectFlow.js'
import { fullRunSteps, stepLabelFor, upToReviewSteps } from '../composables/useRemoteChain.js'
import { statusFieldForJob } from '../utils/episode-step-jobs.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('music-aware steps (Board, Dashboard, selectors)', () => {
  test('a music episode is done when its own four steps are, never by narration steps', () => {
    assert.equal(STEP_STATUS_FIELD['episode-builder'], 'music_episode')
    assert.deepEqual(requiredStatusFields('music'), ['music_episode', 'video_assembly', 'thumbnails', 'metadata'])
    const done = { music_episode: true, video_assembly: true, thumbnails: true, metadata: true, script: false, audio: false, subtitles: false }
    assert.equal(isEpisodeDone(done, 'music'), true)
    assert.equal(isEpisodeDone({ ...done, music_episode: false }, 'music'), false)
  })

  test('the episode selector shows the music steps for a music episode instead of "Steps 0/7" narration steps', () => {
    const selector = read('../components/EpisodeSelector.vue')
    assert.match(selector, /const MUSIC_STEP_CHIPS: StepChip\[\] = \[/)
    for (const label of ['Episode Builder', 'Final video', 'Thumbnail', 'YouTube Finalizer']) assert.ok(selector.includes(`label: '${label}'`), label)
    assert.match(selector, /music_episode !== undefined\s+\? MUSIC_STEP_CHIPS\s+: STEP_CHIPS/)
    assert.match(selector, /return chipSet\.value\.filter/)
  })

  test('Board, Dashboard and Pipeline read the music flag the same way the sidebar does', () => {
    for (const page of ['board.vue', 'index.vue', 'pipeline.vue']) {
      const source = read(`../pages/projects/[slug]/${page}`)
      assert.match(source, /visualSourceFromFormat\((f|format)\)/, page)
    }
    assert.equal(statusFieldForJob({ type: 'music_episode_build', status: 'error' }), 'music_episode', 'a failed stitch shows on the Episode Builder column')
  })
})

describe('Pipeline music chain', () => {
  const pipeline = read('../pages/projects/[slug]/pipeline.vue')

  test('Build Episode → Scene Pictures → Final Video → Thumbnail → Finalizer', () => {
    assert.match(pipeline, /const CHAIN_MUSIC: ChainSpec = \['music_build', 'scene_review', 'video_assembly', 'thumb_images', 'metadata'\]/)
    assert.match(pipeline, /if \(isMusic\.value\) return CHAIN_MUSIC/)
    assert.match(pipeline, /scene_review: \{ label: 'Scene Pictures', link: '\/episode-builder' \}/)
    assert.match(pipeline, /new Set<StepId>\(\['introduction-only', 'music_build'\]\)/, 'the build step needs no preset')
    assert.match(pipeline, /case 'music_build':\s+return s\.music_episode === true/)
    assert.match(pipeline, /if \(musicPresetOptional\(step\.id\)\) continue/, 'a Video Assembly preset is optional for music')
    assert.match(pipeline, /function musicPresetOptional\(id: StepId\): boolean \{ return isMusic\.value && id === 'video_assembly' \}/)
  })

  test('the Remote cockpit runs the same music chain', () => {
    assert.deepEqual(fullRunSteps('music'), ['music_build', 'scene_review', 'video_assembly', 'thumb_images', 'metadata'])
    assert.deepEqual(upToReviewSteps('music'), ['music_build', 'scene_review', 'thumb_images', 'metadata'])
    assert.equal(stepLabelFor('music', 'scene_review'), 'Scene pictures')
    assert.equal(stepLabelFor('narrated-scenes', 'scene_review'), 'Scene render')
    assert.match(read('../pages/remote.vue'), /f\?\.musicChannel === true \? 'music'/)
  })
})

describe('Thumbnail Generator: thumbnail from a scene', () => {
  const panel = read('../components/MusicThumbnailPanel.vue')
  test('a scene picture as it is, or a prompt from a scene for the image model, which draws the headline', () => {
    assert.match(read('../pages/projects/[slug]/images.vue'), /<MusicThumbnailPanel\s/)
    assert.match(panel, /thumbnail\/use-scene/)
    assert.match(panel, /thumbnail\/prompts`, \{ scene_ids: \[picked\.value\], overwrite: true \}/)
    assert.match(panel, /it draws the headline/)
    assert.match(panel, /template text settings only shape the gallery preview/i)
  })
  test('an episode change replaces the scenes and the pick', () => {
    assert.match(panel, /state\.value = null\s+picked\.value = ''/)
  })
})

describe('YouTube Finalizer for a music episode', () => {
  const metadata = read('../pages/projects/[slug]/metadata.vue')
  test('no script gate; chapters from the tracklist; the writing model is the owner\'s pick', () => {
    assert.match(metadata, /const isMusic = computed\(\(\) => !!finalizationStatus\.value\?\.music_episode\)/)
    assert.match(metadata, /\(!scriptReady && !isMusic\)/)
    assert.match(metadata, /Open Episode Builder →/)
    assert.match(metadata, /Pick the writing model below; Story Studio does not pick one for you\./)
  })
})

describe('Episode Builder additions', () => {
  const page = read('../pages/projects/[slug]/episode-builder.vue')
  test('Polish Scene Prompts picks the writing model in the dialog, at the click', () => {
    assert.match(page, /Polish Scene Prompts…/)
    assert.match(page, /Polish This Scene…/)
    assert.match(page, /<ModelSelector v-model="polishForm\.model" :project-slug="slug" label="Writing model" writing-step \/>/)
    assert.match(page, /:disabled="!polishForm\.model \|\| polishJobActive" @click="startPolish"/)
  })
  test('the pictures preset is the Scene Review preset Pipeline reads', () => {
    assert.match(page, /configKey: 'scene_review_genstudio',\s+presetType: 'scene-review'/)
    assert.match(page, /auto_approve_generated: true \}\)/)
  })
  test('the stills window is a per-episode setting and marks used stills; a repeat is a deliberate choice', () => {
    assert.match(page, /Don't repeat a pool still for/)
    assert.match(page, /music-episodes\/\$\{code\.value\}\/stills\?pool_id=/)
    assert.match(page, /allow_repeat: true/)
  })
  test('light sharpening is offered with 1080p', () => {
    assert.match(page, /v-if="settings\.resolution === '1080p'"[\s\S]{0,400}Light sharpening/)
  })
})

describe('Video Assembly: sharpen when upscaling', () => {
  const assembly = read('../pages/projects/[slug]/video-assembly.vue')
  test('selectable, off by default, and set from the music episode at 1080p only', () => {
    assert.match(assembly, /<select v-model="exportSettings\.upscale_sharpen" class="select">/)
    assert.match(assembly, /video_bitrate_kbps: 0,\s+upscale_sharpen: 'off',\s+loudness_lufs: -14,\s+true_peak_db: -1,\s+loudness_tolerance_pct: 20,\s+\}\)/)
    assert.match(assembly, /exportSettings\.upscale_sharpen = exportSettings\.resolution === '1080p' && music\.upscale_sharpen === 'light' \? 'light' : 'off'/)
    assert.match(read('../composables/useVideoAssemblyIo.ts'), /s\.exportSettings\.upscale_sharpen === 'light' \? \{ upscale_sharpen: 'light' \} : \{\}/)
  })
})

describe('Music Formula', () => {
  test('the two new episode starting values are editable on the formula page', () => {
    const formula = read('../pages/projects/[slug]/music-formula.vue')
    assert.match(formula, /e\.upscale_sharpen = 'light'/)
    assert.match(formula, /v-model\.number="e\.still_no_repeat_episodes"/)
  })
})
