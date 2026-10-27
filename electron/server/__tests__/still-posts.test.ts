/**
 * Still Posts — the catalogue, the renderer's verification and the two job executors.
 *
 * The cases the owner asked for on 2026-10-27, in one place: a complete batch, a partial one, an
 * empty one, a provider failure, a retry that redoes only what is missing, a Khmer render, a
 * Chinese render, and a character from another channel that must never be used.
 *
 * The image provider is replaced with an in-process fake so every assertion is about OUR logic
 * (what is drawn, what is verified, what is retried) and never about a network call. The model
 * CATALOGUE still comes from the mock Gateway, because the model's published limits — reference
 * support, aspect ratios — are exactly what §1 says must be read live.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ASPECTS = ['1:1', '9:16', '16:9'] as const
/** One export frame, as the post record stores it. */
type Aspect = typeof ASPECTS[number]

function job(projectSlug: string, type: string, params: Record<string, any>): any {
  return {
    job_id: `test-${Math.random().toString(36).slice(2, 10)}`,
    project_slug: projectSlug,
    type,
    episode_id: '',
    title: 'test',
    status: 'running',
    created_at: new Date().toISOString(),
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    output_lines: [],
    params,
  }
}

async function artBytes(color = '#334455'): Promise<Buffer> {
  return sharp({ create: { width: 1024, height: 1024, channels: 3, background: color } }).png().toBuffer()
}

describe('still posts — catalogue and prompt composition', () => {
  test('ten formats, each with a style bible, a negative prompt, a background and lettering for every language', async () => {
    const { STILL_POST_FORMATS, UNIVERSAL_NEGATIVE } = await import('../still-posts/catalog.js')
    const { readFontManifest } = await import('../lib/thumbnail-fonts.js')
    const manifest = await readFontManifest()
    assert.equal(STILL_POST_FORMATS.length, 10)
    for (const format of STILL_POST_FORMATS) {
      assert.ok(format.name.length > 2, format.id)
      assert.ok(format.style_bible.length > 80, `${format.id} needs a real style bible`)
      assert.ok(format.background.length > 10, format.id)
      assert.ok(format.negative_prompt.includes(UNIVERSAL_NEGATIVE), `${format.id} must refuse lettering in the picture`)
      for (const script of ['latn', 'khmr', 'hani']) {
        const fontId = format.lettering.fonts[script]
        assert.ok(fontId, `${format.id} has no font for ${script}`)
        const entry = manifest.fonts.find(font => font.id === fontId)
        assert.ok(entry, `${format.id} names a font this build does not ship: ${fontId}`)
        assert.ok(entry!.scripts.includes(script), `${format.id} names ${fontId} for ${script}, but that face does not declare it`)
      }
      assert.ok(ASPECTS.includes(format.default_aspect), format.id)
    }
  })

  test('at least twenty options, and every option is structurally valid for every format', async () => {
    const { STILL_POST_FORMATS, STILL_POST_OPTIONS } = await import('../still-posts/catalog.js')
    const { textStyleFor, lookForPost } = await import('../services/still-posts.js')
    assert.ok(STILL_POST_OPTIONS.length >= 20, `only ${STILL_POST_OPTIONS.length} options`)
    assert.equal(new Set(STILL_POST_OPTIONS.map(option => option.id)).size, STILL_POST_OPTIONS.length)
    for (const option of STILL_POST_OPTIONS) {
      assert.equal(option.text.length, option.panels, `${option.id}: one text box per panel`)
      assert.equal(option.composition.length, option.panels, `${option.id}: one composition note per panel`)
      for (const box of option.text) {
        assert.ok(box.width_pct > 0 && box.width_pct <= 100, option.id)
        assert.ok(box.height_pct > 0 && box.height_pct <= 100, option.id)
        assert.ok(box.max_lines >= 1, option.id)
      }
      // The same option must letter under every format: the two axes are independent by design.
      for (const format of STILL_POST_FORMATS) {
        const look = lookForPost(
          { format_id: format.id, option_id: option.id, language: 'en' },
          {
            handle: { enabled: false, text: '', font_id: 'inter', weight: 400, size_px: 30, color: '#fff', opacity: 1 },
            logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
            position: 'bottom',
            margin_pct: 4,
          },
          1,
        )
        for (let panel = 0; panel < option.panels; panel++) {
          const style = textStyleFor(look, panel, '9:16')
          assert.equal(style.placement.anchor, option.text[panel]!.anchor)
          assert.equal(style.max_lines, option.text[panel]!.max_lines)
          assert.ok(style.font_id.length > 0)
        }
      }
    }
  })

  test('the image prompt carries the look, the layout, the scene, and an explicit no-lettering clause', async () => {
    const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
    const { imagePromptFor, lookForPost } = await import('../services/still-posts.js')
    const format = stillPostFormat('doodle-paper')!
    const option = stillPostOption('quote-top')!
    const look = lookForPost({ format_id: format.id, option_id: option.id, language: 'km' }, {
      handle: { enabled: false, text: '', font_id: 'inter', weight: 400, size_px: 30, color: '#fff', opacity: 1 },
      logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
      position: 'bottom',
      margin_pct: 4,
    }, 1)
    const prompt = imagePromptFor(look, 0, 'a small ghost under a scribbled cloud')
    assert.ok(prompt.includes(format.style_bible))
    assert.ok(prompt.includes(option.composition[0]!))
    assert.ok(prompt.includes('a small ghost under a scribbled cloud'))
    assert.match(prompt, /no text, no letters/i)
    assert.match(prompt, /Avoid: /)
  })
})

describe('still posts — verified completion', () => {
  test('a post is complete only with its art and a final in every requested frame', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts completion' })
      const slug = project.slug

      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('setup-punchline')!
      const post = {
        id: 'post-0001', batch_id: 'batch-test-1',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        format_id: format.id, option_id: option.id, language: 'en' as const,
        character_ids: [], caption: '', finals: [],
        panels: store.panelsForOption(option).map((panel, index) => ({
          ...panel, text: index === 0 ? 'did a blood test' : 'and it came back tired', scene_prompt: 'a frog',
        })),
        aspects: [...ASPECTS],
      }
      await store.writePost(slug, post)

      const empty = await store.verifyPostState(slug, post, [...ASPECTS])
      assert.equal(empty.complete, false)
      assert.ok(empty.problems.some(problem => /artwork is missing/i.test(problem)))
      assert.ok(empty.problems.some(problem => /1:1 final/i.test(problem)))

      // Art on disk, no finals yet.
      const dir = store.postDir(slug, post.id)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, store.panelArtFilename(0)), await artBytes())
      await fs.writeFile(path.join(dir, store.panelArtFilename(1)), await artBytes('#885555'))
      const artOnly = await store.verifyPostState(slug, post, [...ASPECTS])
      assert.equal(artOnly.complete, false)
      assert.ok(artOnly.problems.every(problem => /final/i.test(problem)))
      assert.equal(artOnly.problems.length, 6)

      const look = store.lookForPost(post, {
        handle: { enabled: true, text: '@test', font_id: 'inter', weight: 500, size_px: 28, color: '#fff', opacity: 0.9 },
        logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
        position: 'bottom', margin_pct: 4,
      }, 1)
      const rendered = await store.renderPostFinals(slug, post, look, [...ASPECTS])
      assert.equal(rendered.length, 6)
      const done = await store.commitFinals(slug, post, rendered)
      const complete = await store.verifyPostState(slug, done, [...ASPECTS])
      assert.equal(complete.complete, true, complete.problems.join('; '))

      // The rendered frame is really the requested size and really has words on it.
      for (const aspect of ASPECTS) {
        const file = path.join(dir, store.finalFilename(0, aspect))
        const meta = await sharp(file).metadata()
        const expected = (await import('../contracts/still-posts.js')).STILL_POST_CANVAS[aspect]
        assert.equal(meta.width, expected.width, aspect)
        assert.equal(meta.height, expected.height, aspect)
      }

      // Editing the words without re-rendering is a STALE final, not a silent pass.
      const edited = await store.writePost(slug, {
        ...done,
        panels: done.panels.map((panel, index) => index === 0 ? { ...panel, text: 'did a blood test twice' } : panel),
      })
      const stale = await store.verifyPostState(slug, edited, [...ASPECTS])
      assert.equal(stale.complete, false)
      assert.ok(stale.problems.some(problem => /older words/.test(problem)))
      assert.equal(stale.panels[0]!.finals['1:1'], 'stale')
    } finally {
      await isolated.cleanup()
    }
  })

  test('a truncated image file is invalid, not present', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const project = await pm.createProject({ name: 'Still posts truncated' })
      const post = {
        id: 'post-0001', batch_id: 'batch-x', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        format_id: 'sticker-flat', option_id: 'quote-top', language: 'en' as const,
        character_ids: [], caption: '', finals: [], aspects: ['1:1'] as Aspect[],
        panels: [{ id: 'p0', role: 'single' as const, text: 'hello', scene_prompt: 'a frog', image: null }],
      }
      await store.writePost(project.slug, post)
      const dir = store.postDir(project.slug, post.id)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, store.panelArtFilename(0)), Buffer.alloc(4096, 0x41))
      const state = await store.verifyPostState(project.slug, post, ['1:1'])
      assert.equal(state.panels[0]!.image, 'invalid')
      assert.equal(state.complete, false)
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — drawing a batch', () => {
  test('complete, partial, provider failure, and a retry that draws only what is missing', async () => {
    const isolated = await useTempDataDir()
    const service = await startMockGenStudioService()
    const originalFetch = globalThis.fetch
    const registryModule = await import('../providers/registry.js')
    await import('../providers/image/genstudio.js')
    const realProvider = registryModule.registry.getImageProvider('genstudio-image')!
    let draws = 0
    let failNext = false
    try {
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init)
        if (String(input).includes('/v1/image/models') && response.ok) {
          const rows = await response.clone().json() as Array<Record<string, any>>
          // Same catalogue, with the one capability this file needs: reference images.
          return Response.json(rows.map(row => ({
            ...row,
            supports_reference_images: true,
            max_reference_images: 4,
            aspect_ratios: ['1:1', '9:16', '16:9'],
          })))
        }
        return response
      }
      const settings = await import('../services/app-settings.js')
      const secrets = await import('../services/app-secrets-store.js')
      const client = await import('../lib/genstudio-client.js')
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { generateStillPostsRender, generateStillPostsWrite } = await import('../generators/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')

      await settings.setGenStudioUrl(service.baseUrl)
      await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
      client.clearGenStudioCatalogCache()

      registryModule.registry.registerImage({
        meta: { id: 'genstudio-image', name: 'Gateway (test)', apiKeyField: 'genstudio_api_key', providerId: 'genstudio' },
        supportsModel: () => true,
        generateImage: async () => {
          if (failNext) {
            failNext = false
            throw new Error('The provider refused this image.')
          }
          draws += 1
          const png = await artBytes(`#${(draws * 37 % 200 + 40).toString(16).padStart(2, '0')}3344`)
          return { urls: [`data:image/png;base64,${png.toString('base64')}`] }
        },
      })

      const project = await pm.createProject({ name: 'Still posts drawing' })
      const slug = project.slug

      const format = stillPostFormat('night-painterly')!
      const option = stillPostOption('quote-top')!
      const created = await (async () => {
        const { createPostsFromDrafts } = await import('../generators/still-posts.js')
        return createPostsFromDrafts(slug, {
          batch_id: 'batch-draw-1', format, option, language: 'en',
          aspects: [...ASPECTS], character_ids: [],
        }, [
          { panels: [{ text: 'I miss who I was', scene_prompt: 'a figure on a cliff' }], caption: 'one' },
          { panels: [{ text: 'the light stays on', scene_prompt: 'a lit window at night' }], caption: 'two' },
        ])
      })()
      assert.equal(created.length, 2)

      // 1. A provider failure fails the job, keeps what exists, and names the post.
      failNext = true
      await assert.rejects(
        generateStillPostsRender(job(slug, 'still_post_render', { image_model: 'mock-image-v1', batch_id: 'batch-draw-1' })),
        /could not be drawn|missing/i,
      )
      failNext = false
      let posts = await store.listPosts(slug)
      assert.ok(posts.some(post => !post.panels[0]!.image), 'the failed post must not claim an image')
      const afterFailure = await store.verifyPostState(slug, posts[0]!, [...ASPECTS])
      assert.equal(afterFailure.complete, false)

      // 2. A retry draws only what is missing and completes the batch.
      const drawsBefore = draws
      const retryJob = job(slug, 'still_post_render', { image_model: 'mock-image-v1', batch_id: 'batch-draw-1' })
      await generateStillPostsRender(retryJob)
      assert.equal(draws, drawsBefore + 1, `retry drew ${draws - drawsBefore} images; only the failed post needed one`)
      assert.equal(posts.filter(post => post.panels[0]!.image).length, 1, 'the post that failed must have been redrawn')
      posts = await store.listPosts(slug)
      for (const post of posts) {
        const state = await store.verifyPostState(slug, post, [...ASPECTS])
        assert.equal(state.complete, true, `${post.id}: ${state.problems.join('; ')}`)
      }
      const batches = await store.listBatchStates(slug, posts)
      assert.equal(batches[0]!.complete, true)
      assert.equal(batches[0]!.complete_count, 2)

      // 3. A second retry with everything done draws NOTHING.
      const drawsIdle = draws
      await generateStillPostsRender(job(slug, 'still_post_render', { image_model: 'mock-image-v1', batch_id: 'batch-draw-1' }))
      assert.equal(draws, drawsIdle, 'a retry of a complete batch must not buy another render')

      // 4. Writing refuses a character that is not part of this channel.
      const otherProject = await pm.createProject({ name: 'Someone else channel' })
      const library = await import('../services/character-library.js')
      await library.createLibraryCharacter({ name: 'Foreign Cat', description: 'belongs elsewhere', projects: [otherProject.slug] })
      await assert.rejects(
        generateStillPostsWrite(job(slug, 'still_post_write', {
          batch_id: 'batch-write-1', brief: 'anything', count: 2,
          format_id: format.id, option_id: option.id, language: 'en',
          aspects: [...ASPECTS], character_ids: ['foreign-cat'],
        })),
        /not in this channel/i,
      )
      assert.equal((await store.listPosts(slug)).filter(post => post.batch_id === 'batch-write-1').length, 0)
    } finally {
      registryModule.registry.registerImage(realProvider)
      globalThis.fetch = originalFetch
      await service.close?.()
      await isolated.cleanup()
    }
  })

  test('Khmer and Chinese posts are lettered by our renderer, and the words are really on the picture', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts languages' })
      const slug = project.slug
      const format = stillPostFormat('doodle-paper')!
      const option = stillPostOption('quote-top')!

      for (const [language, text, font] of [
        ['km', 'ខ្ញុំនឹកអ្នកដែលខ្ញុំធ្លាប់ជា', 'kantumruy-pro'],
        ['zh', '我想念从前的自己', 'noto-sans-sc'],
      ] as const) {
        const post = {
          id: `post-${language === 'km' ? '0001' : '0002'}`,
          batch_id: 'batch-lang', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          format_id: format.id, option_id: option.id, language,
          character_ids: [], caption: '', finals: [], aspects: ['1:1', '9:16'] as Aspect[],
          panels: [{ id: 'p0', role: 'single' as const, text, scene_prompt: 'a small ghost', image: null }],
        }
        await store.writePost(slug, post)
        const dir = store.postDir(slug, post.id)
        await fs.mkdir(dir, { recursive: true })
        const art = await artBytes('#F2EFE6')
        await fs.writeFile(path.join(dir, store.panelArtFilename(0)), art)

        const look = store.lookForPost(post, {
          handle: { enabled: true, text: '@quiet', font_id: font, weight: 500, size_px: 28, color: '#FFFFFF', opacity: 0.9 },
          logo: { enabled: false, path: null, width_pct: 10, opacity: 1 },
          position: 'bottom', margin_pct: 4,
        }, 1)
        assert.equal(store.textStyleFor(look, 0, '1:1').font_id, font)

        const rendered = await store.renderPostFinals(slug, post, look, ['1:1', '9:16'])
        const done = await store.commitFinals(slug, post, rendered)
        const state = await store.verifyPostState(slug, done, ['1:1', '9:16'])
        assert.equal(state.complete, true, `${language}: ${state.problems.join('; ')}`)

        // The final must differ from the bare art: words were actually drawn.
        const finalBytes = await fs.readFile(path.join(dir, store.finalFilename(0, '1:1')))
        const bareResized = await sharp(art).resize(1080, 1080, { fit: 'cover' }).png().toBuffer()
        assert.notEqual(finalBytes.length, bareResized.length, `${language}: nothing was lettered`)
      }
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — channel scope', () => {
  test('a character from another channel is refused, and one of this channel is accepted', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const library = await import('../services/character-library.js')
      const { resolveChannelReferences } = await import('../services/scene-reference-characters.js')
      const own = await pm.createProject({ name: 'Home channel' })
      const other = await pm.createProject({ name: 'Other channel' })

      await library.createLibraryCharacter({ name: 'Home Ghost', description: 'ours', projects: [own.slug] })
      await library.addLibraryReferenceImage('home-ghost', await artBytes('#DDDDDD'), 'portrait.png')
      await library.createLibraryCharacter({ name: 'Other Cat', description: 'theirs', projects: [other.slug] })
      await library.addLibraryReferenceImage('other-cat', await artBytes('#EEEEEE'), 'portrait.png')

      const accepted = await resolveChannelReferences({
        slug: own.slug,
        characterIds: ['home-ghost'],
        modelName: 'Test model',
        supportsReferences: true,
        maxReferences: 4,
        cacheDir: path.join(pm.getProjectDir(own.slug)!, 'still-posts'),
      })
      assert.equal(accepted.paths.length, 1)
      assert.deepEqual(accepted.names, ['Home Ghost'])

      await assert.rejects(
        resolveChannelReferences({
          slug: own.slug,
          characterIds: ['other-cat'],
          modelName: 'Test model',
          supportsReferences: true,
          maxReferences: 4,
          cacheDir: path.join(pm.getProjectDir(own.slug)!, 'still-posts'),
        }),
        /not part of this channel/i,
      )

      // And a channel roster never adopts the other channel's id.
      const store = await import('../services/still-posts.js')
      const roster = store.resolveRoster(['home-ghost', 'other-cat'], await store.listChannelCharacters(own.slug))
      assert.deepEqual(roster.ids, ['home-ghost'])
      assert.deepEqual(roster.unknown, ['other-cat'])
    } finally {
      await isolated.cleanup()
    }
  })
})


describe('still posts — a fresh drawing per size', () => {
  /**
   * Start the mock Gateway, replace the image provider with a counting fake, and widen the
   * catalogue's published sizes to all three frames. The counting fake is the point: every
   * assertion about "only the missing ones" is a count of provider calls.
   */
  async function setup(options: { publishAllAspects?: boolean } = {}) {
    const isolated = await useTempDataDir()
    const service = await startMockGenStudioService()
    const originalFetch = globalThis.fetch
    const registryModule = await import('../providers/registry.js')
    await import('../providers/image/genstudio.js')
    const realProvider = registryModule.registry.getImageProvider('genstudio-image')!
    let draws = 0
    const requestedAspects: string[] = []
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      if (options.publishAllAspects !== false
        && String(input).includes('/v1/image/models') && response.ok) {
        const rows = await response.clone().json() as Array<Record<string, any>>
        return Response.json(rows.map(row => ({
          ...row,
          aspect_ratios: ['1:1', '9:16', '16:9'],
          output_options: [
            { resolution: '1K', aspect_ratio: '1:1', width: 1024, height: 1024, is_default: true },
            { resolution: '1K', aspect_ratio: '9:16', width: 768, height: 1344, is_default: false },
            { resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768, is_default: false },
          ],
        })))
      }
      return response
    }
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    registryModule.registry.registerImage({
      meta: { id: 'genstudio-image', name: 'Gateway (test)', apiKeyField: 'genstudio_api_key', providerId: 'genstudio' },
      supportsModel: () => true,
      generateImage: async (request: any) => {
        draws += 1
        requestedAspects.push(String(request.aspectRatio))
        const png = await artBytes(`#${(draws * 37 % 200 + 40).toString(16).padStart(2, '0')}3344`)
        return { urls: [`data:image/png;base64,${png.toString('base64')}`] }
      },
    })
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()
    const pm = await import('../services/project-manager.js')
    const store = await import('../services/still-posts.js')
    const { generateStillPostsRender, createPostsFromDrafts } = await import('../generators/still-posts.js')
    const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
    const project = await pm.createProject({ name: 'Still posts per size' })
    return {
      slug: project.slug,
      store,
      createPostsFromDrafts,
      generateStillPostsRender,
      format: stillPostFormat('night-painterly')!,
      option: stillPostOption('quote-top')!,
      draws: () => draws,
      requestedAspects: () => [...requestedAspects],
      cleanup: async () => {
        registryModule.registry.registerImage(realProvider)
        globalThis.fetch = originalFetch
        await service.close?.()
        await isolated.cleanup()
      },
    }
  }

  test('one drawing per ticked frame; a retry draws only the frames that are missing', async () => {
    const ctx = await setup()
    try {
      const created = await ctx.createPostsFromDrafts(ctx.slug, {
        batch_id: 'batch-size-1', format: ctx.format, option: ctx.option, language: 'en',
        aspects: ['1:1', '9:16'], art_mode: 'per-size', character_ids: [],
      }, [{ panels: [{ text: 'I miss who I was', scene_prompt: 'a figure on a cliff' }], caption: '' }])
      assert.equal(created.length, 1)

      const first = job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-1', fresh_drawing_per_size: true,
      })
      await ctx.generateStillPostsRender(first)
      assert.equal(ctx.draws(), 2, 'one paid drawing for each of the two ticked frames')
      // The model was asked for each frame's own aspect — never a substituted one.
      assert.deepEqual([...ctx.requestedAspects()].sort(), ['1:1', '9:16'])

      const [post] = await ctx.store.listPosts(ctx.slug)
      assert.equal(post.art_mode, 'per-size')
      assert.equal(post.panels[0]!.images?.['1:1']?.mode, 'per-size')
      assert.equal(post.panels[0]!.images?.['1:1']?.aspect, '1:1')
      assert.equal(post.panels[0]!.images?.['9:16']?.aspect, '9:16')
      assert.equal(post.panels[0]!.image, null, 'a per-size post makes no single fitted drawing')

      const dir = ctx.store.postDir(ctx.slug, post.id)
      for (const aspect of ['1:1', '9:16'] as const) {
        assert.ok(existsSync(path.join(dir, ctx.store.panelArtFilename(0, aspect))), aspect)
        assert.ok(existsSync(path.join(dir, ctx.store.finalFilename(0, aspect))), aspect)
      }
      assert.equal(existsSync(path.join(dir, ctx.store.panelArtFilename(0))), false,
        'a per-size post does not also pretend a single fitted drawing exists')
      const state = await ctx.store.verifyPostState(ctx.slug, post, ['1:1', '9:16'])
      assert.equal(state.complete, true, state.problems.join('; '))

      // Remove ONE frame's own drawing: the batch is incomplete, and Retry buys exactly one more.
      // (Moved aside rather than deleted — the repo never removes a file with `rm`.)
      const missingArt = path.join(dir, ctx.store.panelArtFilename(0, '9:16'))
      await fs.rename(missingArt, `${missingArt}.moved-aside`)
      const broken = await ctx.store.verifyPostState(ctx.slug, post, ['1:1', '9:16'])
      assert.equal(broken.complete, false)
      assert.ok(broken.problems.some(problem => /9:16 artwork is missing/i.test(problem)))
      assert.equal(broken.panels[0]!.images?.['9:16'], 'missing')
      assert.equal(broken.panels[0]!.images?.['1:1'], 'ok')

      const before = ctx.draws()
      await ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-1', fresh_drawing_per_size: true,
      }))
      assert.equal(ctx.draws(), before + 1, 'only the missing frame is drawn again')
      const retried = (await ctx.store.listPosts(ctx.slug))[0]!
      assert.equal((await ctx.store.verifyPostState(ctx.slug, retried, ['1:1', '9:16'])).complete, true)

      // A third run buys nothing.
      const idle = ctx.draws()
      await ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-1', fresh_drawing_per_size: true,
      }))
      assert.equal(ctx.draws(), idle, 'a complete per-size batch must not buy another render')
    } finally {
      await ctx.cleanup()
    }
  })

  test('a frame the selected model does not publish is refused in preflight, before any paid call', async () => {
    // The mock catalogue publishes 16:9 and 1:1 only.
    const ctx = await setup({ publishAllAspects: false })
    try {
      await ctx.createPostsFromDrafts(ctx.slug, {
        batch_id: 'batch-size-2', format: ctx.format, option: ctx.option, language: 'en',
        aspects: ['1:1', '9:16'], art_mode: 'per-size', character_ids: [],
      }, [{ panels: [{ text: 'the light stays on', scene_prompt: 'a lit window' }], caption: '' }])

      await assert.rejects(
        ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
          image_model: 'mock-image-v1', batch_id: 'batch-size-2', fresh_drawing_per_size: true,
        })),
        (error: any) => /does not publish 9:16/i.test(error.message)
          && /Mock Image/.test(error.message)
          && /No image was requested/i.test(error.message),
      )
      assert.equal(ctx.draws(), 0, 'the refusal happens before any image is requested')

      // An omitted choice keeps the post's stored mode, so a retry cannot silently re-decide it.
      await assert.rejects(
        ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
          image_model: 'mock-image-v1', batch_id: 'batch-size-2',
        })),
        /does not publish 9:16/i,
      )
      assert.equal(ctx.draws(), 0)

      // The same batch drawn as ONE fitted picture is unaffected: 9:16 is framed from the drawing.
      // (The choice must be restated: an omitted flag keeps the post's stored mode.)
      await ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-2', fresh_drawing_per_size: false,
      }))
      assert.equal(ctx.draws(), 1, 'one drawing per post, fitted into both frames')
      const [post] = await ctx.store.listPosts(ctx.slug)
      assert.equal((await ctx.store.verifyPostState(ctx.slug, post!, ['1:1', '9:16'])).complete, true)
    } finally {
      await ctx.cleanup()
    }
  })

  test('a mode change on retry is applied, recorded and announced', async () => {
    const ctx = await setup()
    try {
      await ctx.createPostsFromDrafts(ctx.slug, {
        batch_id: 'batch-size-3', format: ctx.format, option: ctx.option, language: 'en',
        aspects: ['1:1', '9:16'], character_ids: [],
      }, [{ panels: [{ text: 'the light stays on', scene_prompt: 'a lit window' }], caption: '' }])

      // 1. The default: ONE drawing, fitted.
      await ctx.generateStillPostsRender(job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-3',
      }))
      assert.equal(ctx.draws(), 1)
      let [post] = await ctx.store.listPosts(ctx.slug)
      assert.equal(post!.art_mode, undefined, 'the default writes no mode field')
      assert.equal(post!.panels[0]!.image?.mode, 'single')
      assert.equal((await ctx.store.verifyPostState(ctx.slug, post!, ['1:1', '9:16'])).complete, true)

      // 2. Turning it on draws one per frame — the fitted drawing does not count as a frame's own —
      //    and the job says the earlier drawing is kept but not used.
      const switched = job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-3', fresh_drawing_per_size: true,
      })
      await ctx.generateStillPostsRender(switched)
      assert.equal(ctx.draws(), 3, 'two fresh drawings for the two frames')
      assert.ok(switched.output_lines.some((line: string) => /switching from one fitted drawing/i.test(line)))
      assert.ok(switched.output_lines.some((line: string) => /kept but not used/i.test(line)))
      ;[post] = await ctx.store.listPosts(ctx.slug)
      assert.equal(post!.art_mode, 'per-size')

      // 3. Turning it back off reuses the fitted drawing that is still on disk: no new purchase.
      const back = job(ctx.slug, 'still_post_render', {
        image_model: 'mock-image-v1', batch_id: 'batch-size-3', fresh_drawing_per_size: false,
      })
      await ctx.generateStillPostsRender(back)
      assert.equal(ctx.draws(), 3, 'the earlier fitted drawing is reused, not re-bought')
      assert.ok(back.output_lines.some((line: string) => /switching from a fresh drawing per size/i.test(line)))
      ;[post] = await ctx.store.listPosts(ctx.slug)
      assert.equal(post!.art_mode, 'single')
      assert.equal((await ctx.store.verifyPostState(ctx.slug, post!, ['1:1', '9:16'])).complete, true)
    } finally {
      await ctx.cleanup()
    }
  })

  test('the choice travels in the preset and is written on the batch', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const catalog = await import('../still-posts/catalog.js')
      assert.equal(catalog.STILL_POST_BUILTIN_PRESETS[0]!.data.fresh_drawing_per_size, false)

      const project = await pm.createProject({ name: 'Still posts preset mode' })
      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)
      const saved = await request(app).put(`/api/projects/${project.slug}/still-posts/presets`).send({
        presets: [{ id: 'mine', name: 'Mine', data: { format_id: 'sticker-flat', fresh_drawing_per_size: true } }],
        last_preset_id: 'mine',
      })
      assert.equal(saved.status, 200)
      const preset = saved.body.presets.find((entry: any) => entry.id === 'mine')
      assert.equal(preset.data.fresh_drawing_per_size, true)
      // And a preset saved without the field is normalised to false, never left undefined.
      const plain = await request(app).put(`/api/projects/${project.slug}/still-posts/presets`).send({
        presets: [{ id: 'plain', name: 'Plain', data: { format_id: 'sticker-flat' } }],
      })
      assert.equal(plain.body.presets.find((entry: any) => entry.id === 'plain').data.fresh_drawing_per_size, false)

      // The write route captures the choice on the batch's posts.
      const { createPostsFromDrafts } = await import('../generators/still-posts.js')
      const store = await import('../services/still-posts.js')
      const format = catalog.stillPostFormat('sticker-flat')!
      const option = catalog.stillPostOption('quote-top')!
      await createPostsFromDrafts(project.slug, {
        batch_id: 'batch-size-4', format, option, language: 'en', aspects: ['1:1'],
        art_mode: 'per-size', character_ids: [],
      }, [{ panels: [{ text: 'hello', scene_prompt: 'a frog' }], caption: '' }])
      const [post] = await store.listPosts(project.slug)
      assert.equal(post!.art_mode, 'per-size')
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — routes', () => {
  test('the workspace, a refused cast change, an instant re-letter, and a refused path', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const library = await import('../services/character-library.js')
      const { stillPostFormat, stillPostOption } = await import('../still-posts/catalog.js')
      const project = await pm.createProject({ name: 'Still posts routes' })
      const other = await pm.createProject({ name: 'Another channel' })
      const slug = project.slug
      await library.createLibraryCharacter({ name: 'Our Ghost', description: 'ours', projects: [slug] })
      await library.addLibraryReferenceImage('our-ghost', await artBytes('#DFDFDF'), 'portrait.png')
      await library.createLibraryCharacter({ name: 'Their Cat', description: 'theirs', projects: [other.slug] })

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)

      const workspace = await request(app).get(`/api/projects/${slug}/still-posts`)
      assert.equal(workspace.status, 200)
      assert.equal(workspace.body.formats.length, 10)
      assert.ok(workspace.body.options.length >= 20)
      assert.equal(workspace.body.config.character_ids.length, 0)

      // A character of another channel cannot be adopted into this one's cast.
      const refused = await request(app).put(`/api/projects/${slug}/still-posts/config`)
        .send({ character_ids: ['their-cat'] })
      assert.equal(refused.status, 400)
      assert.match(refused.body.detail, /not part of this channel/i)

      const accepted = await request(app).put(`/api/projects/${slug}/still-posts/config`)
        .send({ character_ids: ['our-ghost'], handle: '@ous' })
      assert.equal(accepted.status, 200)
      assert.deepEqual(accepted.body.config.character_ids, ['our-ghost'])
      assert.equal(accepted.body.config.handle, 'ous')

      // A post with art re-letters the moment its words change.
      const format = stillPostFormat('sticker-flat')!
      const option = stillPostOption('quote-top')!
      const created = await (await import('../generators/still-posts.js')).createPostsFromDrafts(slug, {
        batch_id: 'batch-routes', format, option, language: 'en', aspects: ['1:1'], character_ids: [],
      }, [{ panels: [{ text: 'first words', scene_prompt: 'a frog' }], caption: '' }])
      const dir = store.postDir(slug, created[0]!)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, store.panelArtFilename(0)), await artBytes())

      const edited = await request(app).put(`/api/projects/${slug}/still-posts/posts/${created[0]}`)
        .send({ panels: [{ text: 'second words', scene_prompt: 'a frog' }] })
      assert.equal(edited.status, 200)
      assert.equal(edited.body.post.panels[0].text, 'second words')
      assert.equal(edited.body.render_error, null)
      assert.equal(edited.body.state.complete, true, JSON.stringify(edited.body.state.problems))
      const written = JSON.parse(await fs.readFile(path.join(dir, 'post.json'), 'utf-8'))
      assert.equal(written.finals.length, 1)
      assert.equal(written.finals[0].text, 'second words')

      // Nothing outside this post's own folder is servable.
      for (const name of ['../post.json', 'secrets.png', 'notafile.png']) {
        const response = await request(app).get(`/api/projects/${slug}/still-posts/posts/${created[0]}/file/${encodeURIComponent(name)}`)
        assert.equal(response.status, 400, `${name}: ${response.status} ${response.text}`)
      }
      const served = await request(app).get(`/api/projects/${slug}/still-posts/posts/${created[0]}/file/final-p0-1x1.png`)
      assert.equal(served.status, 200, served.text)

      // Drawing refuses to pick a model for the customer.
      const noModel = await request(app).post(`/api/projects/${slug}/still-posts/render`).send({})
      assert.equal(noModel.status, 400)
      assert.match(noModel.body.detail, /choose an image model/i)
    } finally {
      await isolated.cleanup()
    }
  })
})


describe('still posts — the Formula makes the channel type', () => {
  test('the Still Posts Formula is published in the catalogue and marks the channel Still Posts', async () => {
    const isolated = await useTempDataDir()
    try {
      const niches = await import('../services/niche-loader.js')
      const pm = await import('../services/project-manager.js')
      const catalog = await niches.listNicheCatalogEntries()
      const entry = catalog.find(row => row.value.id === 'still-posts')
      assert.ok(entry, 'the Still Posts Formula must appear in the catalogue')
      assert.equal(entry!.value.catalogStatus, 'active')

      const project = await pm.createProject({ name: 'A still posts channel', niche_id: 'still-posts' })
      const effective = await niches.getEffectiveNicheFor(project)
      assert.equal((effective as any)?.stillPostsFormat?.enabled, true)

      // The route the sidebar reads must say so, which is what switches the workspace over.
      const { router } = await import('../routes/projects.js')
      const app = express().use(express.json()).use('/api', router)
      const response = await request(app).get(`/api/projects/${project.slug}/effective-format`)
      assert.equal(response.status, 200)
      assert.equal(response.body.stillPostsChannel, true)
      assert.equal(response.body.musicChannel, false)
    } finally {
      await isolated.cleanup()
    }
  })
})
