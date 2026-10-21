/**
 * Where the reserved opening comes from (v1.3.1).
 *
 * The defect: the Scene Plan preset said `opening_mode: "from-start"` with a
 * stale 15s, the project config said `branded-opening` with 10s, and the file
 * on disk was 10.0s. The preset won, the plan reserved nothing, and every scene
 * visual landed ~10s after the narration it was planned against.
 *
 * The fix reads the project's own Video Assembly opening — the same slot
 * presets the page loads and the renderer plays — and measures it. These tests
 * pin that resolution, including the parts that must NOT count.
 */

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { measureOpeningSec } from '../lib/opening-duration.js'

let cleanup: () => Promise<void>
let pm: typeof import('../services/project-manager.js')
let resolveProjectOpening: typeof import('../services/opening-assets.js')['resolveProjectOpening']
let resolveEpisodeRenderShape: typeof import('../services/opening-assets.js')['resolveEpisodeRenderShape']
let assetsDir: string

/** Stub probe: every real fixture file is 10s except where stated. */
const probe = async (p: string) => (path.basename(p).startsWith('short') ? 2 : 10)

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ;({ resolveProjectOpening, resolveEpisodeRenderShape } = await import('../services/opening-assets.js'))
  assetsDir = path.join(temp.dir, 'assets')
  await fs.mkdir(assetsDir, { recursive: true })
  for (const name of ['intro.mp4', 'short-pre.mp4', 'short-post.mp4', 'tail.mp4', 'title.png']) {
    await fs.writeFile(path.join(assetsDir, name), 'not really media, but materialised on disk')
  }
})
after(async () => { await cleanup() })

async function projectWith(config: Record<string, unknown>): Promise<string> {
  const meta = await pm.createProject({ name: `Opening ${Math.random().toString(36).slice(2, 8)}` } as any)
  await pm.updateConfig(meta.slug, config as any)
  return meta.slug
}

const asset = (name: string) => path.join(assetsDir, name)

describe('the opening Scene Plan reserves', () => {
  test('an enabled intro is measured; a disabled one reserves nothing', async () => {
    const enabled = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
    })
    const on = await resolveProjectOpening(enabled)
    assert.equal(await measureOpeningSec(on.head, probe), 10)
    assert.deepEqual(on.unresolved, [])

    const off = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: false, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(off)).head, probe), 0)
  })

  test('a project with no Video Assembly settings at all reserves nothing', async () => {
    const bare = await projectWith({})
    const resolved = await resolveProjectOpening(bare)
    assert.equal(await measureOpeningSec(resolved.head, probe), 0)
  })

  test('a stale Scene Plan preset cannot change the answer', async () => {
    // The owner's live preset, verbatim. It has no vote any more.
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'BL - Intro', data: { enabled: true, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
      scene_plan_presets: [{
        id: 'sp1',
        name: 'BL - Scene Plan',
        data: { opening_mode: 'from-start', opening_reserved_sec: 15 },
      }],
      'scene_plan_last_preset_scene-plan': 'sp1',
      visual_opening_mode: 'branded-opening',
      branded_opening_duration_sec: 10,
    })
    const resolved = await resolveProjectOpening(slug)
    assert.equal(await measureOpeningSec(resolved.head, probe), 10, 'the file wins over both remembered numbers')
  })

  test('head timeline clips count; tail clips never do', async () => {
    const slug = await projectWith({
      intro_presets: [{
        id: 'i1',
        name: 'Intro',
        data: {
          enabled: true,
          video_path: asset('intro.mp4'),
          timeline_clips: [
            { id: 'a', anchor: 'before_intro', enabled: true, kind: 'video', video_path: asset('short-pre.mp4') },
            { id: 'b', anchor: 'after_intro', enabled: true, kind: 'video', video_path: asset('short-post.mp4') },
            { id: 'c', anchor: 'after_scenes', enabled: true, kind: 'video', video_path: asset('tail.mp4') },
            { id: 'd', anchor: 'after_outro', enabled: true, kind: 'video', video_path: asset('tail.mp4') },
            { id: 'e', anchor: 'before_intro', enabled: false, kind: 'video', video_path: asset('tail.mp4') },
          ],
        },
      }],
      intro_last_preset: 'i1',
    })
    const { head } = await resolveProjectOpening(slug)
    assert.equal(head.before_intro.length, 1)
    assert.equal(head.after_intro.length, 1)
    assert.equal(await measureOpeningSec(head, probe), 14, '2 + 10 + 2, with both tail clips excluded')
  })

  test('a static head clip carries its own hold, not a probe', async () => {
    const slug = await projectWith({
      intro_presets: [{
        id: 'i1',
        name: 'Intro',
        data: {
          enabled: false,
          video_path: '',
          timeline_clips: [
            { id: 'a', anchor: 'before_intro', enabled: true, kind: 'static', image_path: asset('title.png'), duration_sec: 3 },
          ],
        },
      }],
      intro_last_preset: 'i1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(slug)).head, probe), 3)
  })

  test('a title image with no file behind it reserves nothing', async () => {
    // The owner's live `BL - Timeline` preset is exactly this: enabled, with
    // no `image_path`. The renderer skips it, so the plan must not reserve for
    // it — that is precisely the drift this release removes.
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
      timeline_presets: [{ id: 't1', name: 'BL - Timeline', data: { title_image: { enabled: true, image_path: '', duration: 5 } } }],
      timeline_last_preset: 't1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(slug)).head, probe), 10)
  })

  test('a real title image is part of the opening', async () => {
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
      timeline_presets: [{ id: 't1', name: 'TL', data: { title_image: { enabled: true, image_path: asset('title.png'), duration: 4 } } }],
      timeline_last_preset: 't1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(slug)).head, probe), 14)
  })

  test('the active bundle answers when no slot preset is selected', async () => {
    const slug = await projectWith({
      video_bundle_presets: [{
        id: 'b1',
        name: 'BL - Video Assembly',
        data: { fallback: { intro: { enabled: true, video_path: asset('intro.mp4') } } },
      }],
      video_bundle_last_preset: 'b1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(slug)).head, probe), 10)
  })

  test('a text title card is reserved from the Effects slot, where the page saves it (1.4.286)', async () => {
    const slug = await projectWith({
      video_bundle_presets: [{
        id: 'b1',
        name: 'VA',
        data: { fallback: { intro: { enabled: true, video_path: asset('intro.mp4') }, effects: { title_card: { enabled: true, text: '', duration: 6 } } } },
      }],
      video_bundle_last_preset: 'b1',
    })
    assert.equal(await measureOpeningSec((await resolveProjectOpening(slug)).head, probe), 16)
  })

  test('a missing file is reported, never quietly reserved', async () => {
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: asset('deleted-last-week.mp4') } }],
      intro_last_preset: 'i1',
    })
    const resolved = await resolveProjectOpening(slug)
    assert.equal(await measureOpeningSec(resolved.head, probe), 0)
    assert.equal(resolved.unresolved.length, 1)
    assert.match(resolved.unresolved[0]!, /intro video \(file not found\)/)
  })

  test('a portable token this Mac cannot expand is reported, never guessed', async () => {
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: '${NOT_DEFINED_HERE}/intro.mp4' } }],
      intro_last_preset: 'i1',
    })
    const resolved = await resolveProjectOpening(slug)
    assert.equal(await measureOpeningSec(resolved.head, probe), 0)
    assert.match(resolved.unresolved[0]!, /named root not defined/)
  })
})

/**
 * What the episode's own settings put around its narration — the tail the final check has to know
 * about for a file that recorded no plan of its own, and where its branded intro sits.
 *
 * Story Sprout SS0063, 2026-10-20: the channel's Video Assembly bundle
 * (`preset-1781671791580`) carries a static still anchored `after_scenes` for 6000 s and a
 * `fade-to-black` post-roll of 15 s, which is where the final's 100 minutes of silence came from.
 */
describe('what the episode\'s own settings put around the narration', () => {
  /** The channel's own bundle, verbatim: a 6000 s after-scenes still and a 15 s fade post-roll. */
  const sproutBundle = () => ({
    video_bundle_presets: [{
      id: 'b1',
      name: 'Story Sprout - Video Assembly',
      data: {
        fallback: {
          intro: {
            enabled: true,
            video_path: asset('intro.mp4'),
            outro: { enabled: false, video_path: '' },
            timeline_clips: [{
              id: 'clip-1776875775168-cl5s', kind: 'static', anchor: 'after_scenes', enabled: true,
              image_path: asset('title.png'), duration_sec: 6000,
            }],
          },
          timeline: { post_audio: { behavior: 'fade-to-black', fade_duration: 15, tail_seconds: 4 } },
        },
      },
    }],
    video_bundle_last_preset: 'b1',
  })

  test('the after-scenes still and the post-roll are the tail, and the intro is where it plays', async () => {
    const slug = await projectWith(sproutBundle())
    const shape = await resolveEpisodeRenderShape(slug, probe)
    assert.equal(shape.after_narration_sec, 6015, '6000 s of still + a 15 s fade post-roll')
    assert.deepEqual(shape.intro, {
      asset: asset('intro.mp4'),
      window: { start_sec: 0, end_sec: 10 },
    })
  })

  test('a before-intro clip puts the intro where it actually plays', async () => {
    const slug = await projectWith({
      intro_presets: [{
        id: 'i1',
        name: 'Intro',
        data: {
          enabled: true,
          video_path: asset('intro.mp4'),
          timeline_clips: [
            { id: 'a', anchor: 'before_intro', enabled: true, kind: 'video', video_path: asset('short-pre.mp4') },
          ],
        },
      }],
      intro_last_preset: 'i1',
    })
    const shape = await resolveEpisodeRenderShape(slug, probe)
    assert.deepEqual(shape.intro?.window, { start_sec: 2, end_sec: 12 })
    assert.equal(shape.after_narration_sec, 0, 'a head clip is not tail content')
  })

  test('head clips never count as tail, and the outro and after-outro clips do', async () => {
    const slug = await projectWith({
      intro_presets: [{
        id: 'i1',
        name: 'Intro',
        data: {
          enabled: true,
          video_path: asset('intro.mp4'),
          outro: { enabled: true, video_path: asset('tail.mp4') },
          timeline_clips: [
            { id: 'a', anchor: 'before_intro', enabled: true, kind: 'video', video_path: asset('short-pre.mp4') },
            { id: 'b', anchor: 'after_intro', enabled: true, kind: 'video', video_path: asset('short-post.mp4') },
            { id: 'c', anchor: 'after_scenes', enabled: true, kind: 'static', image_path: asset('title.png'), duration_sec: 30 },
            { id: 'd', anchor: 'after_outro', enabled: true, kind: 'video', video_path: asset('tail.mp4') },
            { id: 'e', anchor: 'after_scenes', enabled: false, kind: 'static', image_path: asset('title.png'), duration_sec: 999 },
          ],
        },
      }],
      intro_last_preset: 'i1',
    })
    // 30 s still + 10 s outro + 10 s after-outro clip; the disabled one and both head clips count for
    // nothing, and neither does a `hard-cut` tail.
    assert.equal((await resolveEpisodeRenderShape(slug, probe)).after_narration_sec, 50)
  })

  test('a project with no Video Assembly settings puts nothing around the narration', async () => {
    const bare = await projectWith({})
    assert.deepEqual(await resolveEpisodeRenderShape(bare, probe), { after_narration_sec: 0, tail: { sec: 0, from_end_sec: 0 }, intro: null })
  })

  test("the reserved opening the plan asked for is inside the intro's window", async () => {
    // The renderer trims or pads the intro clip to the opening Scene Plan reserved when the plan did
    // not measure it from the clips, so the clip IN THE FILE is that long — a window built from the
    // asset's own 10 s would be too short to cover the clip's own black (release343 review, 2026-10-20).
    const slug = await projectWith({
      intro_presets: [{ id: 'i1', name: 'Intro', data: { enabled: true, video_path: asset('intro.mp4') } }],
      intro_last_preset: 'i1',
    })
    assert.deepEqual(
      (await resolveEpisodeRenderShape(slug, probe)).intro?.window,
      { start_sec: 0, end_sec: 10 },
      'the asset\'s own length when the plan reserved nothing',
    )
    assert.deepEqual(
      (await resolveEpisodeRenderShape(slug, probe, { opening_reserved_sec: 25 })).intro?.window,
      { start_sec: 0, end_sec: 25 },
      'the reserved opening when it is longer',
    )
    assert.deepEqual(
      (await resolveEpisodeRenderShape(slug, probe, { opening_reserved_sec: 4 })).intro?.window,
      { start_sec: 0, end_sec: 10 },
      'a shorter reserve does not shorten the clip below its own length',
    )
  })

  test('a setting this machine cannot measure contributes nothing, never a guess', async () => {
    const slug = await projectWith({
      intro_presets: [{
        id: 'i1',
        name: 'Intro',
        data: {
          enabled: true,
          video_path: asset('deleted-last-week.mp4'),
          timeline_clips: [{
            id: 'c', anchor: 'after_scenes', enabled: true, kind: 'video', video_path: asset('gone-too.mp4'),
          }],
        },
      }],
      intro_last_preset: 'i1',
    })
    const shape = await resolveEpisodeRenderShape(slug, probe)
    assert.equal(shape.after_narration_sec, 0)
    assert.equal(shape.intro, null, 'an intro that cannot be measured is no window at all')
  })
})
