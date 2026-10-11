/**
 * 1.4.286 — "if it's on. it show be showing. if enabled and not showing. it's either failed
 * or a bug" (owner, 2026-10-11).
 *
 * - The Presentation Frame reaches a Pipeline batch: from the Video Assembly preset's own copy,
 *   or from the Effects preset it names (refinanced and terranash-sleep-stories had it on there
 *   while the copy never kept it). Measured on real pixels through the final composition.
 * - The outro saved inside the intro slot, the episode's own title on a title card, and the
 *   "hide captions during the intro" choice reach the batch request.
 * - Anything switched on that a batch cannot draw is named in preflight (`not_drawn`).
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'
import { describeEffectStack } from '../contracts/effects-look.js'
import { getWorkTempDir } from '../lib/work-tempdir.js'
import type { Job } from '../models/types.js'

const tmp = await useTempDataDir()
after(() => tmp.cleanup())
process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

const { flattenVideoAssemblyBundle, resolveStepParams, settingsNotDrawn, videoEffectsAnswer, withNamedEffectsFrame } = await import('../routes/pipeline.js')
const { createVideoAssemblyExecutionRequest, _runFinalCompositionForTesting: runFinalComposition } = await import('../generators/video.js')

/** refinanced on the mini: the bundle's copy has no `frame`; its named Effects preset has it on. */
const REFINANCED_FRAME = { enabled: true, inset_pct: 5.5, border_width: 69, corner_radius: 58, border_color: '#FFFFFF', background_color: '#101820', background_path: '', fit: 'cover' }
const refinancedConfig = {
  effects_presets: [{ id: 'fx', name: 'Effects', data: { frame: REFINANCED_FRAME, logo: { enabled: false } } }],
}
const refinancedBundle = {
  id: 'va', name: 'Video Assembly',
  data: { effects_preset_id: 'fx', fallback: { effects: { logo: { enabled: false } }, timeline: { title_image: { enabled: true, duration: 5 } } } },
}

describe('the Presentation Frame reaches a batch', () => {
  test('the named Effects preset\'s frame is used when the saved copy has none, and every answer lists it', () => {
    const merged = withNamedEffectsFrame(refinancedConfig, refinancedBundle as any)
    assert.equal(refinancedBundle.data.fallback.effects.hasOwnProperty('frame'), false, 'the stored preset is not changed')
    const params = resolveStepParams('video_assembly', 'EP0001', 'One', merged, null)
    assert.deepEqual(params.frame, REFINANCED_FRAME)
    assert.ok(describeEffectStack(params).includes('Presentation frame'), 'the job\'s effect_stack lists it')
    const answer = videoEffectsAnswer(refinancedConfig, merged)!
    assert.ok(answer.effects.includes('Presentation frame'), 'preflight / run-batch video_effects lists it')
    assert.ok(answer.notes.some(n => /taken from the Effects preset "Effects"/.test(n)), answer.notes.join('\n'))
  })

  test('the copy\'s own frame wins when it is on; nothing on anywhere means no frame', () => {
    const own = { ...REFINANCED_FRAME, inset_pct: 2 }
    const bundle = { id: 'va', name: 'VA', data: { effects_preset_id: 'fx', fallback: { effects: { frame: own } } } }
    assert.equal(withNamedEffectsFrame(refinancedConfig, bundle as any), bundle)
    assert.deepEqual(flattenVideoAssemblyBundle(bundle.data, 'E', 'T').frame, own)
    const off = { effects_presets: [{ id: 'fx', name: 'Effects', data: { frame: { ...REFINANCED_FRAME, enabled: false } } }] }
    const plain = withNamedEffectsFrame(off, refinancedBundle as any)
    assert.equal(flattenVideoAssemblyBundle(plain.data, 'E', 'T').frame, undefined)
    assert.equal(withNamedEffectsFrame({}, refinancedBundle as any), refinancedBundle, 'a deleted Effects preset changes nothing')
  })

  test('a batch render with the frame on draws it (real pixels through the final composition)', async () => {
    const dir = await getWorkTempDir('frame-batch', 'EP1')
    const p = (name: string) => path.join(dir, name)
    const W = 320, H = 180
    const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' })
    ff(['-f', 'lavfi', '-i', `color=c=red:s=${W}x${H}:r=24:d=2`, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', p('intermediate_video.mp4')])
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '2', p('premixed_audio.wav')])
    const render = async (bundle: any, name: string) => {
      const params = resolveStepParams('video_assembly', 'EP1', 'One', bundle, null)
      const req = createVideoAssemblyExecutionRequest(params as any) as any
      const job = { job_id: name, project_slug: 'frame-batch', episode_id: 'EP1', type: 'video_assembly', status: 'running',
        title: name, created_at: '', started_at: '', finished_at: null, error: null, output_lines: [], params } as unknown as Job
      const outputFile = p(`${name}.mp4`)
      // The fields generateVideo hands the final composition, straight from the batch request.
      await runFinalComposition({
        videoInputPath: p('intermediate_video.mp4'), premixedAudioPath: p('premixed_audio.wav'),
        targetDuration: 2, w: W, h: H, quality: { crf: 18, preset: 'ultrafast', fps: 24 }, format: 'mp4', outputFile,
        logo: req.logo, colorGrading: req.color_grading, vignette: req.vignette, letterbox: req.letterbox,
        frame: req.frame, sceneEffects: req.scene_effects, job,
      } as any)
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', '1', '-i', outputFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      return { at: (x: number, y: number) => { const i = (y * W + x) * 3; return [raw[i]!, raw[i + 1]!, raw[i + 2]!] }, lines: job.output_lines.join('\n') }
    }
    const isRed = ([r, g, b]: number[]) => r! > 180 && g! < 70 && b! < 70
    const isWhite = ([r, g, b]: number[]) => r! > 200 && g! > 200 && b! > 200
    const isBoard = ([r, g, b]: number[]) => r! < 40 && g! < 50 && b! < 60 // #101820

    const framed = await render(withNamedEffectsFrame(refinancedConfig, refinancedBundle as any), 'framed')
    // 5.5% inset of 180 = 10px board; border 69px at 1080p = 12px at 180p.
    assert.ok(isBoard(framed.at(3, 3)), `the board fills the outer inset: ${framed.at(3, 3)}`)
    assert.ok(isBoard(framed.at(160, 4)), `board above the border: ${framed.at(160, 4)}`)
    assert.ok(isWhite(framed.at(160, 15)), `white border band: ${framed.at(160, 15)}`)
    assert.ok(isWhite(framed.at(15, 90)), `white border band, left: ${framed.at(15, 90)}`)
    assert.ok(isRed(framed.at(160, 90)), `the scene inside the frame: ${framed.at(160, 90)}`)
    assert.match(framed.lines, /Frame: 5.5% inset · 69px border · 58px corners/)

    const bare = await render(refinancedBundle, 'bare')
    assert.ok(isRed(bare.at(3, 3)) && isRed(bare.at(160, 15)), 'without the frame the scene runs edge to edge (the bug the owner saw)')
  })
})

describe('other switched-on settings reach the batch request', () => {
  test('the outro saved inside the intro slot renders (the page never wrote a top-level outro)', () => {
    const out = flattenVideoAssemblyBundle({ fallback: { intro: { enabled: false, outro: { enabled: true, video_path: '/a/outro.mp4' } } } }, 'E', 'T')
    assert.deepEqual(out.outro, { enabled: true, video_path: '/a/outro.mp4' })
  })

  test('a title card shows THIS episode\'s title, not the one open when the preset was saved', () => {
    const out = flattenVideoAssemblyBundle({ fallback: { effects: { title_card: { enabled: true, text: 'The Economics of Running a Suburban Dental Practice', duration: 5 } } } }, 'EP2', 'Why Rents Rise')
    assert.equal((out.title_card as any).text, 'Why Rents Rise')
  })

  test('hide-captions-during-the-intro: a saved choice wins; an unsaved one is left to the render (hidden behind a branded opening)', () => {
    const subs = (extra: object) => (flattenVideoAssemblyBundle({ fallback: { subtitles: { enabled: true, source: 'chapters', ...extra } } }, 'E', 'T').subtitles as any)
    assert.equal(subs({}).hide_during_intro, undefined, 'absent: the generator decides from the Scene Plan opening, as the page does')
    assert.equal(subs({ hide_during_intro: false }).hide_during_intro, false)
    assert.equal(subs({ hide_during_intro: true }).hide_during_intro, true)
  })
})

describe('switched on but not drawn is said out loud', () => {
  test('title image, empty logo, an empty timeline clip and an outro with no file are each named', () => {
    const lines = settingsNotDrawn({ fallback: {
      intro: { enabled: true, video_path: '/a/intro.mp4', outro: { enabled: true, video_path: '' },
        timeline_clips: [{ anchor: 'after_outro', kind: 'static', enabled: true, image_path: '', duration_sec: 6000 }, { anchor: 'after_scenes', kind: 'static', enabled: false, image_path: '' }] },
      timeline: { title_image: { enabled: true, duration: 15 } },
      effects: { logo: { enabled: true, image_path: '' }, overlays: { enabled: true, layers: [{ enabled: true, source_path: '' }] } },
    } })
    assert.equal(lines.length, 5, lines.join('\n'))
    assert.match(lines[0]!, /Title Image is switched on, but its picture is chosen per episode/)
    assert.match(lines[1]!, /outro video is switched on but no file/)
    assert.match(lines[2]!, /timeline clip \(after outro\) is switched on but has no picture/)
    assert.match(lines[3]!, /logo is switched on but no logo picture/)
    assert.match(lines[4]!, /1 overlay file layer/)
  })

  test('a music channel is told which narration-only settings its videos leave out by design', () => {
    const bundle = { id: 'va', name: 'VA', data: { fallback: {
      intro: { enabled: true, video_path: '/a/intro.mp4' },
      subtitles: { enabled: true, source: 'chapters' },
      effects: { chapter_titles: { enabled: false }, logo: { enabled: true, image_path: '/a/logo.png' } },
    } } }
    const answer = videoEffectsAnswer({}, bundle as any, true)!
    assert.deepEqual(answer.not_drawn, ['Music episodes have no narration, so these Video Assembly settings are left out of their videos by design: intro, subtitles.'])
  })

  test('everything that is drawn says nothing', () => {
    assert.deepEqual(settingsNotDrawn({ fallback: {
      intro: { enabled: true, video_path: '/a/intro.mp4', timeline_clips: [{ anchor: 'after_outro', kind: 'static', enabled: true, image_path: '/a/still.png', duration_sec: 7200 }] },
      timeline: { title_image: { enabled: false } },
      effects: { logo: { enabled: true, image_path: '/a/logo.png' }, frame: REFINANCED_FRAME },
    } }), [])
  })

  test('POST /pipeline/preflight lists the frame and names the title image and the missing captions', async () => {
    const { app } = await import('../app.js')
    const pm = await import('../services/project-manager.js')
    const im = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const project = await pm.createProject({ name: 'Frame answer' })
    const bundle = structuredClone(refinancedBundle) as any
    bundle.data.fallback.subtitles = { enabled: true, source: 'chapters' }
    await pm.updateConfig(project.slug, { ...refinancedConfig, video_bundle_presets: [bundle], video_bundle_last_preset: 'va' } as any)
    const [idea] = await im.addIdeas(project.slug, [{ title: 'One', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test-model')
    await im.acceptIdea(project.slug, idea!.id)
    const episodeId = (await im.getIdeas(project.slug, 'accepted'))[0]!.episode_code!
    await fs.mkdir((await resolveEpisodePathsByCode(project.slug, episodeId)).episode_dir, { recursive: true })
    await im.setEpisodeStatusOverrides(project.slug, episodeId, { script: true, merged_audio: true, subtitles: false, scene_plan: true, scene_review: true, video_assembly: true })
    const res = await request(app).post(`/api/projects/${project.slug}/pipeline/preflight`).send({ episode_ids: [episodeId], steps: ['video_assembly'] })
    const fx = res.body.video_effects
    assert.ok(fx, JSON.stringify(res.body))
    assert.ok(fx.effects.includes('Presentation frame'), fx.effects.join(', '))
    assert.ok(fx.not_drawn.some((l: string) => /Title Image is switched on/.test(l)), fx.not_drawn.join('\n'))
    assert.ok(fx.not_drawn.some((l: string) => new RegExp(`${episodeId}: captions are switched on, but this episode has no subtitles`).test(l)), fx.not_drawn.join('\n'))
  })
})
