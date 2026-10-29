/**
 * Still Posts — the channel's lettering font pool.
 *
 * Owner, 2026-10-29: *"using different font for different post. say i add 1 font only. so all the
 * post use that font, then i add 5 fonts to it so it's randomize by that 5 fonts or serial or one
 * after another, these are usage options."*
 *
 * What is pinned here, in the owner's own order:
 *   - no pool = today's behaviour, byte for byte;
 *   - one font = every post uses it;
 *   - several = serial (default, one after another, wrapping) or weighted (by percentage);
 *   - only weighted avoids a repeat, and only until the customer opts in to true random;
 *   - a pool edit mid-run (add, remove, reorder) and a restart neither repeat nor skip;
 *   - a face that cannot draw the script is refused by name, never substituted;
 *   - a post keeps the face it was given on a retry, and a post with no recorded face keeps the
 *     format's own.
 *
 * The RNG is injected everywhere it matters, so "no repeat" is a pinned answer rather than luck.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import * as fonts from '../contracts/still-post-fonts.js'

/** A serial pool from plain font ids, as the picker would send it. */
function pool(ids: string[], overrides: Record<string, any> = {}): any {
  return {
    usage_mode: 'serial',
    allow_repeat: false,
    fonts: ids.map(id => ({ font_id: id, weight: 100 })),
    ...overrides,
  }
}

/** A weighted pool from `[id, weight]` pairs. */
function weighted(pairs: Array<[string, number]>, overrides: Record<string, any> = {}): any {
  return {
    usage_mode: 'weighted',
    allow_repeat: false,
    fonts: pairs.map(([font_id, weight]) => ({ font_id, weight })),
    ...overrides,
  }
}

/** Run `count` assignments through a pool, carrying the cursor forward like the writer does. */
function rotate(poolValue: any, count: number, rng: () => number = () => 0): string[] {
  const picked: string[] = []
  let cursor: fonts.StillPostFontCursor | null = null
  for (let index = 0; index < count; index++) {
    const chosen = fonts.decideFont(poolValue, cursor, rng)
    if (!chosen) break
    picked.push(chosen.font_id)
    cursor = fonts.cursorAfter(chosen.font_id, chosen.index)
  }
  return picked
}

describe('still posts — the font pool resolver', () => {
  test('an empty pool leaves the format face exactly as it was', () => {
    assert.equal(fonts.decideFont(undefined, null), null)
    assert.equal(fonts.decideFont(null, null), null)
    assert.equal(fonts.decideFont(pool([]), null), null)
    // An empty pool is not stored at all, so nothing invents a shape for a channel that has none.
    assert.deepEqual(fonts.normaliseFontPools({ latn: pool([]), khmr: pool(['kantumruy-pro']) }), {
      khmr: pool(['kantumruy-pro']),
    })
    assert.deepEqual(fonts.normaliseFontPools(null), {})
  })

  test('one font means every post uses that font', () => {
    assert.deepEqual(rotate(pool(['anton']), 4), ['anton', 'anton', 'anton', 'anton'])
    // And a weighted pool of one behaves the same way, repetition and all.
    assert.deepEqual(rotate(weighted([['anton', 100]]), 3), ['anton', 'anton', 'anton'])
  })

  test('serial walks the pool in order and wraps, with no configuration', () => {
    const three = pool(['inter', 'anton', 'patrick-hand'])
    assert.deepEqual(rotate(three, 7), [
      'inter', 'anton', 'patrick-hand', 'inter', 'anton', 'patrick-hand', 'inter',
    ])
    // An unknown or absent usage mode is serial, never a guess at something else.
    assert.equal(fonts.normaliseUsageMode('randomish'), 'serial')
    assert.equal(fonts.normaliseUsageMode(undefined), 'serial')
    assert.equal(fonts.normaliseFontPool({ usage_mode: 'weighted' }).usage_mode, 'weighted')
    assert.deepEqual(rotate(pool(['inter', 'anton'], { usage_mode: 'randomish' }), 3), ['inter', 'anton', 'inter'])
  })

  test('a pool edit mid-run never repeats and never skips', () => {
    const after = (ids: string[], lastFontId: string, lastIndex: number): string => {
      const index = fonts.nextSerialIndex(ids, { last_font_id: lastFontId, last_index: lastIndex })
      return ids[index]!
    }
    // Last post was lettered in Anton, at index 1 of a two-face pool.

    // 1. A font is ADDED. Patrick Hand arrives at the front, so a position-based answer would pick
    //    Anton again (index 2 → wrap); the id-based answer moves on to the face after Anton.
    assert.equal(after(['patrick-hand', 'inter', 'anton'], 'anton', 1), 'patrick-hand')

    // 2. The last used font is REMOVED. The face that slid into its place is next — never a skip to
    //    the one after it, and never the removed face.
    assert.equal(after(['inter', 'patrick-hand'], 'anton', 1), 'patrick-hand')
    // Removing the last used face at the END wraps to the first face.
    assert.equal(after(['inter', 'anton'], 'patrick-hand', 2), 'inter')

    // 3. The pool is REORDERED. The next entry after the last used id in the CURRENT order.
    assert.equal(after(['anton', 'inter'], 'anton', 1), 'inter')

    // 4. No answer is ever the face the last post was given.
    for (const [ids, last] of [
      [['inter', 'anton'], 'inter'],
      [['inter', 'anton'], 'anton'],
      [['anton', 'inter'], 'inter'],
    ] as Array<[string[], string]>) {
      assert.notEqual(after(ids, last, 0), last, `${ids.join('/')} repeated ${last}`)
    }
  })

  test('serial continues from disk across a restart', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { createPostsFromDrafts } = await import('../generators/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts serial restart' })
      const slug = project.slug
      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('quote-top')!
      const fontPools = { latn: pool(['inter', 'anton', 'patrick-hand']) }
      const draft = (text: string) => ({ panels: [{ text, scene_prompt: 'a frog' }], caption: '' })

      const first = await createPostsFromDrafts(slug, {
        batch_id: 'batch-restart-1', format, option, language: 'en', aspects: ['1:1'], font_pools: fontPools, character_ids: [],
      }, [draft('one'), draft('two')])
      assert.equal(first.length, 2)

      // The pointer is channel state on disk, not preset content: it survives with no process memory.
      assert.ok(existsSync(store.fontPoolCursorPath(slug)))
      assert.deepEqual(await store.readFontPoolCursor(slug, 'latn'), { last_font_id: 'anton', last_index: 1 })

      // A SECOND run (a restart, a new batch) continues where the first stopped — no repeat, no skip.
      await createPostsFromDrafts(slug, {
        batch_id: 'batch-restart-2', format, option, language: 'en', aspects: ['1:1'], font_pools: fontPools, character_ids: [],
      }, [draft('three'), draft('four')])
      const posts = (await store.listPosts(slug)).sort((a, b) => (a.id < b.id ? -1 : 1))
      assert.deepEqual(posts.map(post => post.font_id), ['inter', 'anton', 'patrick-hand', 'inter'])

      // And a third run wraps to the start of the pool.
      await createPostsFromDrafts(slug, {
        batch_id: 'batch-restart-3', format, option, language: 'en', aspects: ['1:1'], font_pools: fontPools, character_ids: [],
      }, [draft('five')])
      const all = (await store.listPosts(slug)).sort((a, b) => (a.id < b.id ? -1 : 1))
      assert.deepEqual(all.map(post => post.font_id), ['inter', 'anton', 'patrick-hand', 'inter', 'anton'])
    } finally {
      await isolated.cleanup()
    }
  })

  test('weighted follows the percentages and never repeats unless the customer opts in', () => {
    // The percentages shown in the picker are the ones the draw uses, and they add up to 100.
    assert.deepEqual(fonts.percentagesFor(weighted([['inter', 70], ['anton', 20], ['patrick-hand', 10]])), [70, 20, 10])
    assert.deepEqual(fonts.percentagesFor(weighted([['inter', 1], ['anton', 1], ['patrick-hand', 1]])), [34, 33, 33])
    assert.deepEqual(fonts.percentagesFor(weighted([['inter', 0], ['anton', 0]])), [50, 50])
    assert.deepEqual(fonts.percentagesFor(pool([])), [])

    const three = weighted([['inter', 70], ['anton', 20], ['patrick-hand', 10]])
    // A roll of 0.5 of the weight range lands inside "inter" (its 70).
    assert.equal(fonts.decideFont(three, null, () => 0.5)?.font_id, 'inter')
    // A roll of 0.75 falls past those 70, into "anton".
    assert.equal(fonts.decideFont(three, null, () => 0.75)?.font_id, 'anton')

    // No repeat by default: the last used face is not a candidate while another face exists.
    const lastInter = { last_font_id: 'inter', last_index: 0 }
    assert.equal(fonts.decideFont(three, lastInter, () => 0)?.font_id, 'anton')
    const lastAnton = { last_font_id: 'anton', last_index: 1 }
    assert.equal(fonts.decideFont(three, lastAnton, () => 0)?.font_id, 'inter')

    // True random is an explicit opt-in, and then the same face may come twice in a row.
    const trueRandom = weighted([['inter', 70], ['anton', 20], ['patrick-hand', 10]], { allow_repeat: true })
    assert.equal(fonts.decideFont(trueRandom, lastInter, () => 0.1)?.font_id, 'inter')
    // With only one face there is nothing to avoid, so it repeats with or without the opt-in.
    assert.equal(fonts.decideFont(weighted([['anton', 100]]), lastAnton, () => 0)?.font_id, 'anton')
    // A cursor naming a face that has since left the pool cannot block the draw.
    assert.ok(fonts.decideFont(three, { last_font_id: 'gone', last_index: 9 }, () => 0.5))
  })

  test('a face that cannot draw the script is refused by name, never substituted', async () => {
    const store = await import('../services/still-posts.js')    // Anton is a Latin-only display face: it must not letter Khmer.
    await assert.rejects(
      store.assertFontPoolCoversScript(pool(['anton']), 'khmr', 'Khmer (khmr)'),
      (error: any) => /Anton/.test(error.message) && /does not cover/.test(error.message) && /substituted face/.test(error.message),
    )
    // A face this build does not ship is refused with the real list, not silently dropped.
    await assert.rejects(
      store.assertFontPoolCoversScript(pool(['papyrus']), 'latn', 'English (latn)'),
      /not one of this build's bundled fonts/,
    )
    // A face whose manifest DOES list the script is accepted…
    await store.assertFontPoolCoversScript(pool(['kantumruy-pro']), 'khmr', 'Khmer (khmr)')
    // …and so is no pool at all (the format's own face applies).
    await store.assertFontPoolCoversScript(undefined, 'khmr', 'Khmer (khmr)')
  })
})

describe('still posts — a post keeps the face it was given', () => {
  test('the recorded face wins on a re-render, and a post without one keeps the format face', async () => {
    const store = await import('../services/still-posts.js')
    const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
    const format = stillPostFormat('night-painterly')!
    const option = stillPostOption('quote-top')!
    const branding = store.brandingFor(
      { handle_enabled: false, handle_text: null, logo_enabled: false, position: 'bottom', handle_size_px: 30, logo_width_pct: 12, margin_pct: 4, opacity: 0.9 },
      { handle: null, logoPath: null, language: 'en', format },
    )
    // This format letters Latin in Patrick Hand, so the two paths are visibly different.
    assert.equal(format.lettering.fonts.latn, 'patrick-hand')

    const noRecord = store.lookForPost({ format_id: format.id, option_id: option.id, language: 'en' }, branding, 1)
    assert.equal(store.textStyleFor(noRecord, 0, '1:1').font_id, 'patrick-hand')

    const recorded = store.lookForPost({ format_id: format.id, option_id: option.id, language: 'en', font_id: 'anton' }, branding, 1)
    assert.equal(store.textStyleFor(recorded, 0, '1:1').font_id, 'anton')
    // The face is part of what a final is made from, so a changed face is provably stale.
    assert.notEqual(
      store.styleHashFor(noRecord, 0, '1:1', 'words'),
      store.styleHashFor(recorded, 0, '1:1', 'words'),
    )
  })

  test('a batch with no pool records no face at all, so earlier channels are untouched', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { createPostsFromDrafts } = await import('../generators/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts no pool' })
      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('quote-top')!
      await createPostsFromDrafts(project.slug, {
        batch_id: 'batch-none', format, option, language: 'en', aspects: ['1:1'], character_ids: [],
      }, [{ panels: [{ text: 'words', scene_prompt: 'a frog' }], caption: '' }])
      const [post] = await store.listPosts(project.slug)
      assert.equal(post!.font_id, undefined)
      const onDisk = JSON.parse(await fs.readFile(path.join(store.postDir(project.slug, post!.id), 'post.json'), 'utf-8'))
      assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'font_id'), false)
      // No pool means no cursor file either: nothing new appears on an existing channel's disk.
      assert.equal(existsSync(store.fontPoolCursorPath(project.slug)), false)
    } finally {
      await isolated.cleanup()
    }
  })

  test('a failed write never advances the pointer', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { createPostsFromDrafts } = await import('../generators/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts failed write' })
      const slug = project.slug
      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('quote-top')!
      const fontPools = { latn: pool(['inter', 'anton', 'patrick-hand']) }
      const draft = (text: string) => ({ panels: [{ text, scene_prompt: 'a frog' }], caption: '' })

      await createPostsFromDrafts(slug, {
        batch_id: 'batch-fail', format, option, language: 'en', aspects: ['1:1'], font_pools: fontPools, character_ids: [],
      }, [draft('one')])
      assert.equal((await store.readFontPoolCursor(slug, 'latn'))!.last_font_id, 'inter')

      // A creation that throws before the record exists must not consume a face.
      await assert.rejects(
        store.createPostWithPoolFont(slug, 'latn', fontPools.latn, () => { throw new Error('the record could not be built') }),
        /could not be built/,
      )
      assert.equal((await store.readFontPoolCursor(slug, 'latn'))!.last_font_id, 'inter')

      // The next real post takes the face after the last one that actually exists.
      await createPostsFromDrafts(slug, {
        batch_id: 'batch-fail-2', format, option, language: 'en', aspects: ['1:1'], font_pools: fontPools, character_ids: [],
      }, [draft('two')])
      const posts = (await store.listPosts(slug)).sort((a, b) => (a.id < b.id ? -1 : 1))
      assert.deepEqual(posts.map(post => post.font_id), ['inter', 'anton'])
    } finally {
      await isolated.cleanup()
    }
  })

  test('changing a post to another script blanks the recorded face and says so', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { createPostsFromDrafts } = await import('../generators/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts script change' })
      const slug = project.slug
      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('quote-top')!
      const created = await createPostsFromDrafts(slug, {
        batch_id: 'batch-script', format, option, language: 'en', aspects: ['1:1'],
        font_pools: { latn: pool(['anton']) }, character_ids: [],
      }, [{ panels: [{ text: 'words', scene_prompt: 'a frog' }], caption: '' }])
      assert.equal((await store.readPost(slug, created[0]!))!.font_id, 'anton')

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)
      const response = await request(app).put(`/api/projects/${slug}/still-posts/posts/${created[0]}`)
        .send({ language: 'km', panels: [{ text: 'ពាក្យ', scene_prompt: 'a frog' }] })
      assert.equal(response.status, 200, response.text)
      assert.match(String(response.body.font_note), /cleared/)
      assert.match(String(response.body.font_note), /Khmer/)
      const stored = JSON.parse(await fs.readFile(path.join(store.postDir(slug, created[0]!), 'post.json'), 'utf-8'))
      assert.equal(Object.prototype.hasOwnProperty.call(stored, 'font_id'), false, 'the Latin face must not follow Khmer')

      // And the same rule holds on the next script move: a face is never carried across writing
      // systems, in either direction.
      await store.writePost(slug, { ...(await store.readPost(slug, created[0]!))!, font_id: 'anton' })
      const zh = await request(app).put(`/api/projects/${slug}/still-posts/posts/${created[0]}`)
        .send({ language: 'zh', panels: [{ text: '文字', scene_prompt: 'a frog' }] })
      assert.equal(zh.status, 200, zh.text)
      assert.match(String(zh.body.font_note), /cleared/)
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — pool routes', () => {
  test('the preset carries the pool and a face that cannot draw a script is refused', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const project = await pm.createProject({ name: 'Still posts pool routes' })
      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)

      const saved = await request(app).put(`/api/projects/${project.slug}/still-posts/presets`).send({
        presets: [{
          id: 'mine',
          name: 'Mine',
          data: {
            format_id: 'sticker-flat',
            font_pools: {
              latn: weighted([['inter', 60], ['anton', 40]]),
              // A repeated face is kept once, so the percentages cannot be double-counted.
              khmr: pool(['kantumruy-pro', 'kantumruy-pro']),
            },
          },
        }],
        last_preset_id: 'mine',
      })
      assert.equal(saved.status, 200, saved.text)
      const stored = saved.body.presets.find((entry: any) => entry.id === 'mine')
      assert.equal(stored.data.font_pools.latn.usage_mode, 'weighted')
      assert.equal(stored.data.font_pools.latn.fonts.length, 2)
      assert.equal(stored.data.font_pools.khmr.fonts.length, 1)

      // Anton cannot draw Khmer: the preset is refused by name and nothing is stored.
      const refused = await request(app).put(`/api/projects/${project.slug}/still-posts/presets`).send({
        presets: [{ id: 'bad', name: 'Bad', data: { format_id: 'sticker-flat', font_pools: { khmr: pool(['anton']) } } }],
      })
      assert.equal(refused.status, 400)
      assert.match(refused.body.detail, /Anton/)
      assert.match(refused.body.detail, /Bad/)

      // The picker's own catalogue is the manifest, live: every face says which scripts it draws.
      const workspace = await request(app).get(`/api/projects/${project.slug}/still-posts`)
      assert.equal(workspace.status, 200)
      assert.ok(workspace.body.fonts.length >= 5)
      const kantumruy = workspace.body.fonts.find((font: any) => font.id === 'kantumruy-pro')
      assert.ok(kantumruy.scripts.includes('khmr'))
      assert.ok(!workspace.body.fonts.find((font: any) => font.id === 'anton').scripts.includes('khmr'))

      // A batch whose pool cannot draw its language is refused before a job is queued.
      const batch = await request(app).post(`/api/projects/${project.slug}/still-posts/batches`).send({
        brief: 'a quiet late-night thought',
        count: 1,
        format_id: 'sticker-flat',
        option_id: 'quote-top',
        language: 'km',
        aspects: ['1:1'],
        character_ids: [],
        font_pools: { khmr: pool(['anton']) },
      })
      assert.equal(batch.status, 400)
      assert.match(batch.body.detail, /Anton/)
    } finally {
      await isolated.cleanup()
    }
  })
})
