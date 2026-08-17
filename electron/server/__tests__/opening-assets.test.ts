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
let assetsDir: string

/** Stub probe: every real fixture file is 10s except where stated. */
const probe = async (p: string) => (path.basename(p).startsWith('short') ? 2 : 10)

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  pm = await import('../services/project-manager.js')
  ;({ resolveProjectOpening } = await import('../services/opening-assets.js'))
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
