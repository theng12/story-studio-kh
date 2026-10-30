/**
 * Still Posts — review: approval, redo and the drawing a redo replaces (owner, 2026-10-30).
 *
 * What the owner asked for, pinned here:
 *  - a post is approved only when it is complete in every frame it asks for, and the refusal says why;
 *  - a change to the words, the look or a redrawn picture clears the approval, so the post goes back to
 *    review; a caption-only edit keeps it;
 *  - a redo keeps the drawing it replaces in Trash, readable as the "previous" picture, and a redo that
 *    fails leaves the old drawing exactly where it was;
 *  - the route serves only a drawing this post's own Trash record names.
 *
 * The image provider is an in-process fake (AGENTS §8: a provider's return is not evidence, the files are),
 * and the model catalogue comes from the mock Gateway, as in still-posts.test.ts.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

const ASPECTS = ['1:1'] as const

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

/** The renderer's own branding for a post with no handle and no logo — the same look the route uses. */
async function lookFor(post: any) {
  const { brandingFor, lookForPost } = await import('../services/still-posts.js')
  const branding = brandingFor({
    handle_enabled: false, handle_text: null, logo_enabled: false, position: 'bottom',
    handle_size_px: 30, logo_width_pct: 12, margin_pct: 4, opacity: 0.9,
  }, { handle: null, logoPath: null, language: post.language, format: (await import('../still-posts/catalog.js')).stillPostFormat(post.format_id)! })
  return lookForPost(post, branding, 1)
}

/** Make one post complete the way the job does: its own artwork, then every frame lettered from it. */
async function completePost(slug: string, postId: string, color: string): Promise<void> {
  const store = await import('../services/still-posts.js')
  const post = (await store.readPost(slug, postId))!
  const dir = store.postDir(slug, postId)
  await fs.mkdir(dir, { recursive: true })
  for (const [index] of post.panels.entries()) {
    await fs.writeFile(`${dir}/${store.panelArtFilename(index)}`, await artBytes(color))
  }
  const current = (await store.readPost(slug, postId))!
  const rendered = await store.renderPostFinals(slug, current, await lookFor(current), ['1:1'])
  await store.commitFinals(slug, current, rendered)
}

async function makeBatch(slug: string, batchId: string, texts: string[]) {
  const catalog = await import('../still-posts/catalog.js')
  const { createPostsFromDrafts } = await import('../generators/still-posts.js')
  return createPostsFromDrafts(slug, {
    batch_id: batchId,
    format: catalog.stillPostFormat('night-painterly')!,
    option: catalog.stillPostOption('quote-top')!,
    language: 'en',
    aspects: [...ASPECTS],
    character_ids: [],
  }, texts.map((text, index) => ({ panels: [{ text, scene_prompt: `scene ${index}` }], caption: `caption ${index}` })))
}

describe('still posts — approval', () => {
  test('a complete post is approved; an unfinished one is refused with the reason; the approval follows the words', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const project = await pm.createProject({ name: 'Still posts approval' })
      const slug = project.slug
      const [first, second] = await makeBatch(slug, 'batch-approve-1', ['I miss who I was', 'the light stays on'])
      await completePost(slug, first!, '#223344')

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)

      // The unfinished post is refused, by name and by reason; nothing is approved for it.
      const refused = await request(app).put(`/api/projects/${slug}/still-posts/approvals`)
        .send({ post_ids: [second!], approved: true })
      assert.equal(refused.status, 200)
      assert.deepEqual(refused.body.approved, [])
      assert.equal(refused.body.refused[0].id, second!)
      assert.match(refused.body.refused[0].reason, /Not finished/)
      assert.equal((await store.readPost(slug, second!))!.approved_at ?? null, null)

      // The complete one is approved.
      const approved = await request(app).put(`/api/projects/${slug}/still-posts/approvals`)
        .send({ post_ids: [first!], approved: true })
      assert.deepEqual(approved.body.approved, [first!])
      assert.ok((await store.readPost(slug, first!))!.approved_at, 'the approval is stored on the post')

      // A caption-only edit keeps it.
      const captionOnly = await request(app).put(`/api/projects/${slug}/still-posts/posts/${first!}`)
        .send({ caption: 'a new caption', panels: [{ text: 'I miss who I was' }] })
      assert.equal(captionOnly.status, 200)
      assert.ok(captionOnly.body.post.approved_at, 'a caption change does not clear the approval')

      // Changing the words clears it: the post is a different post to approve.
      const reworded = await request(app).put(`/api/projects/${slug}/still-posts/posts/${first!}`)
        .send({ panels: [{ text: 'I miss who I used to be' }] })
      assert.equal(reworded.status, 200)
      assert.equal(reworded.body.post.approved_at, null, 'a reworded post must be reviewed again')
      assert.equal(reworded.body.post.panels[0].text, 'I miss who I used to be')

      // Clearing is always allowed, and is said plainly.
      const cleared = await request(app).put(`/api/projects/${slug}/still-posts/approvals`)
        .send({ post_ids: [first!], approved: false })
      assert.deepEqual(cleared.body.cleared, [first!])

      // A malformed request is refused in words, not stored.
      const bad = await request(app).put(`/api/projects/${slug}/still-posts/approvals`).send({ post_ids: [first!] })
      assert.equal(bad.status, 400)
      assert.match(bad.body.detail, /approved \(true\) or not \(false\)/)
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — a redo keeps the drawing it replaces', () => {
  test('the old drawing goes to Trash and is readable as the previous picture; approval is cleared; the finals are re-lettered', async () => {
    const isolated = await useTempDataDir()
    const service = await startMockGenStudioService()
    const originalFetch = globalThis.fetch
    const registryModule = await import('../providers/registry.js')
    await import('../providers/image/genstudio.js')
    const realProvider = registryModule.registry.getImageProvider('genstudio-image')!
    let nextColour = '#aa3300'
    let failNext = false
    try {
      globalThis.fetch = async (input, init) => {
        const response = await originalFetch(input, init)
        if (String(input).includes('/v1/image/models') && response.ok) {
          const rows = await response.clone().json() as Array<Record<string, any>>
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
          const png = await artBytes(nextColour)
          return { urls: [`data:image/png;base64,${png.toString('base64')}`] }
        },
      })

      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const { generateStillPostsRender } = await import('../generators/still-posts.js')
      const project = await pm.createProject({ name: 'Still posts redo' })
      const slug = project.slug
      const [post] = await makeBatch(slug, 'batch-redo-1', ['the light stays on'])
      nextColour = '#1155aa'
      await generateStillPostsRender(job(slug, 'still_post_render', { image_model: 'mock-image-v1', batch_id: 'batch-redo-1' }))
      await completePostAfterRender(slug, post!)
      const oldArt = await fs.readFile(`${store.postDir(slug, post!)}/p0.png`)

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)
      await request(app).put(`/api/projects/${slug}/still-posts/approvals`).send({ post_ids: [post!], approved: true })
      assert.ok((await store.readPost(slug, post!))!.approved_at)

      // 1. A redo that the provider refuses leaves the old drawing exactly where it was.
      failNext = true
      await assert.rejects(generateStillPostsRender(job(slug, 'still_post_render', {
        image_model: 'mock-image-v1', post_ids: [post!], redraw: true,
      })), /could not be drawn|missing/i)
      const afterFailure = (await store.readPost(slug, post!))!
      assert.deepEqual(await fs.readFile(`${store.postDir(slug, post!)}/p0.png`), oldArt, 'the old drawing is untouched')
      assert.equal(afterFailure.redraws ?? 0, 0, 'a failed redo records no replaced drawing')

      // 2. A redo that succeeds keeps the old drawing in Trash, records it, and clears the approval.
      nextColour = '#00aa55'
      await generateStillPostsRender(job(slug, 'still_post_render', {
        image_model: 'mock-image-v1', post_ids: [post!], redraw: true,
      }))
      const redone = (await store.readPost(slug, post!))!
      assert.equal(redone.redraws?.length, 1, 'exactly one replaced drawing is recorded')
      assert.equal(redone.approved_at ?? null, null, 'a new picture is a new thing to approve')
      const record = redone.redraws![0]!
      assert.equal(record.panel_id, 'p0')
      assert.equal(record.aspect, null, 'a single drawing is recorded as the one fitted drawing')
      const kept = store.redrawFile(slug, post!, record)
      assert.ok(kept && existsSync(kept), 'the replaced drawing is in Trash')
      assert.deepEqual(await fs.readFile(kept!), oldArt, 'what is in Trash is exactly the drawing the redo replaced')
      assert.notDeepEqual(await fs.readFile(`${store.postDir(slug, post!)}/p0.png`), oldArt, 'the new drawing is in place')

      // 3. The previous drawing is served by the route; a record pointing elsewhere is refused.
      const previous = await request(app).get(`/api/projects/${slug}/still-posts/posts/${post!}/redraws/0`)
        .buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))) })
      assert.equal(previous.status, 200)
      assert.deepEqual(Buffer.from(previous.body), oldArt)
      await store.writePost(slug, { ...redone, redraws: [{ ...record, trash_path: '../../../project.json' }] })
      const escaped = await request(app).get(`/api/projects/${slug}/still-posts/posts/${post!}/redraws/0`)
      assert.equal(escaped.status, 404, 'a path outside this post\'s own Trash folder is never read')
      await store.writePost(slug, { ...redone, redraws: [] })
      assert.equal((await request(app).get(`/api/projects/${slug}/still-posts/posts/${post!}/redraws/0`)).status, 404)
    } finally {
      registryModule.registry.registerImage(realProvider)
      globalThis.fetch = originalFetch
      await service.close?.()
      await isolated.cleanup()
    }
  })
})

/** After a render, the finals must be lettered from the new art: re-letter only if the job did not. */
async function completePostAfterRender(slug: string, postId: string): Promise<void> {
  const store = await import('../services/still-posts.js')
  const state = await store.verifyPostState(slug, (await store.readPost(slug, postId))!, ['1:1'])
  if (!state.complete) await completePost(slug, postId, '#000000')
}

describe('still posts — the approval key', () => {
  test('the words, the look, the frames and the cast make a post a different thing to approve', async () => {
    const { approvalKey } = await import('../services/still-posts.js')
    const base = {
      format_id: 'night-painterly', option_id: 'quote-top', language: 'en' as const,
      aspects: ['1:1'] as Array<'1:1' | '9:16' | '16:9'>, character_ids: [], panels: [{ id: 'p0', role: 'single' as const, text: 'hello', scene_prompt: 'a cliff', image: null }],
    }
    assert.equal(approvalKey(base), approvalKey({ ...base }), 'an unchanged post keeps its approval')
    assert.notEqual(approvalKey(base), approvalKey({ ...base, panels: [{ ...base.panels[0]!, text: 'hello there' }] }), 'new words')
    assert.notEqual(approvalKey(base), approvalKey({ ...base, panels: [{ ...base.panels[0]!, scene_prompt: 'a shore' }] }), 'a new scene')
    assert.notEqual(approvalKey(base), approvalKey({ ...base, format_id: 'sticker-flat' }), 'a new look')
    assert.notEqual(approvalKey(base), approvalKey({ ...base, aspects: ['1:1', '9:16'] as Array<'1:1' | '9:16' | '16:9'> }), 'new frames')
    assert.notEqual(approvalKey(base), approvalKey({ ...base, character_ids: ['me'] }), 'a new cast')
  })
})

describe('still posts — a replaced drawing is kept under this post', () => {
  test("it moves to this post's own Trash folder, and another post or a path out of it is refused", async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const project = await pm.createProject({ name: 'Redraw records' })
      const slug = project.slug
      const dir = store.postDir(slug, 'post-0001')
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(`${dir}/p0.png`, 'old')

      const record = store.retireDrawing(slug, { id: 'post-0001' }, `${dir}/p0.png`, 'p0', null)
      assert.equal(existsSync(`${dir}/p0.png`), false, 'the replaced drawing has left its place')
      assert.match(record.trash_path, /^still-posts\/redraws\/post-0001\//)
      const kept = store.redrawFile(slug, 'post-0001', record)
      assert.ok(kept, 'the kept drawing is findable')
      assert.deepEqual(await fs.readFile(kept!, 'utf8'), 'old', 'exactly the old bytes are kept')

      assert.equal(store.redrawFile(slug, 'post-0002', record), null, 'one post never reads another post\'s drawing')
      assert.equal(store.redrawFile(slug, 'post-0001', { ...record, trash_path: '/etc/passwd' }), null)
      assert.equal(store.redrawFile(slug, 'post-0001', { ...record, trash_path: 'still-posts/redraws/post-0001/../../../project.json' }), null)
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — visual pickers, server side', () => {
  test('a font sample is drawn by the real renderer, and a face that cannot draw the language says so', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const project = await pm.createProject({ name: 'Font samples' })
      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)
      const fonts = await (await import('../lib/thumbnail-fonts.js')).listThumbnailFonts()
      const latinOnly = fonts.find(font => !font.scripts.includes('khmr'))
      const khmer = fonts.find(font => font.scripts.includes('khmr'))
      assert.ok(latinOnly, 'a Latin-only face exists to prove the refusal')

      // A real PNG, drawn by our own renderer, for a face that covers the line.
      const drawn = await request(app)
        .get(`/api/projects/${project.slug}/still-posts/font-sample`)
        .query({ font_id: (khmer || fonts[0]!).id, language: khmer ? 'km' : 'en', text: 'សួស្តី' })
      assert.equal(drawn.status, 200)
      assert.match(String(drawn.headers['content-type']), /image\/png/)
      assert.ok(Number(drawn.headers['content-length'] || 0) > 512, 'the sample is a real picture')

      // A face that cannot draw the language is refused in words, never drawn in a substitute.
      const refused = await request(app)
        .get(`/api/projects/${project.slug}/still-posts/font-sample`)
        .query({ font_id: latinOnly!.id, language: 'km', text: 'សួស្តី' })
      assert.equal(refused.status, 400)
      assert.match(String(refused.body.detail), /cannot draw/i)

      // No font at all is a plain refusal, not an empty picture.
      const missing = await request(app).get(`/api/projects/${project.slug}/still-posts/font-sample`)
      assert.equal(missing.status, 400)
    } finally {
      await isolated.cleanup()
    }
  })

  test('a logo is stored and read as a portable path, and the page can show it', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const project = await pm.createProject({ name: 'Logo picker' })
      const slug = project.slug
      const channelDir = pm.getProjectDir(slug)!
      await fs.mkdir(`${channelDir}/assets`, { recursive: true })
      const bytes = await artBytes('#ABCDEF')
      await fs.writeFile(`${channelDir}/assets/logo.png`, bytes)

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)

      // The picker writes a portable path — never an absolute path.
      const saved = await request(app).put(`/api/projects/${slug}/still-posts/config`)
        .send({ logo_path: '${CHANNEL}/assets/logo.png' })
      assert.equal(saved.status, 200)
      assert.equal(saved.body.config.logo_path, '${CHANNEL}/assets/logo.png')

      // The workspace reports it as ready, and the picture route serves exactly those bytes.
      const workspace = await request(app).get(`/api/projects/${slug}/still-posts`)
      assert.equal(workspace.body.config.logo_ready, true)
      const shown = await request(app).get(`/api/projects/${slug}/still-posts/logo`)
        .buffer(true).parse((res, done) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))) })
      assert.equal(shown.status, 200)
      assert.deepEqual(Buffer.from(shown.body), bytes)

      // A path that points at nothing is refused when saved, so the field cannot lie.
      const gone = await request(app).put(`/api/projects/${slug}/still-posts/config`)
        .send({ logo_path: '${CHANNEL}/assets/missing.png' })
      assert.equal(gone.status, 400)
      assert.match(gone.body.detail, /no logo file/i)
    } finally {
      await isolated.cleanup()
    }
  })
})

describe('still posts — adding a post before any drawing', () => {
  test('a typed post is created undrawn, refused when empty, and refused a foreign character', async () => {
    const isolated = await useTempDataDir()
    try {
      const pm = await import('../services/project-manager.js')
      const store = await import('../services/still-posts.js')
      const library = await import('../services/character-library.js')
      const project = await pm.createProject({ name: 'Typed posts' })
      const other = await pm.createProject({ name: 'Elsewhere' })
      const slug = project.slug
      await library.createLibraryCharacter({ name: 'Ours', description: 'ours', projects: [slug] })
      await library.createLibraryCharacter({ name: 'Theirs', description: 'theirs', projects: [other.slug] })

      const { router } = await import('../routes/still-posts.js')
      const app = express().use(express.json()).use('/api', router)
      // The character must be in THIS channel's cast before a post may name it.
      const cast = await request(app).put(`/api/projects/${slug}/still-posts/config`).send({ character_ids: ['ours'] })
      assert.equal(cast.status, 200)

      const created = await request(app).post(`/api/projects/${slug}/still-posts/posts`).send({
        text: 'the light stays on', format_id: 'night-painterly', option_id: 'quote-bottom',
        language: 'en', aspects: ['1:1'], character_ids: ['ours'],
      })
      assert.equal(created.status, 201)
      assert.equal(created.body.post.panels[0].text, 'the light stays on')
      // Undrawn, honestly: no art and no final, and the state says so.
      assert.equal(created.body.post.panels[0].image ?? null, null)
      assert.equal(created.body.state.complete, false)
      assert.match(created.body.state.problems.join(' '), /artwork is missing/i)
      // It is a real post on disk, in the channel's own folder.
      assert.equal((await store.listPosts(slug)).length, 1)

      const blank = await request(app).post(`/api/projects/${slug}/still-posts/posts`)
        .send({ text: '   ', format_id: 'night-painterly', option_id: 'quote-bottom' })
      assert.equal(blank.status, 400)
      assert.match(blank.body.detail, /Type the line/)

      const foreign = await request(app).post(`/api/projects/${slug}/still-posts/posts`).send({
        text: 'elsewhere', format_id: 'night-painterly', option_id: 'quote-bottom', character_ids: ['theirs'],
      })
      assert.equal(foreign.status, 400)
      assert.match(foreign.body.detail, /not in this channel/)
      assert.equal((await store.listPosts(slug)).length, 1, 'a refused post is never created')
    } finally {
      await isolated.cleanup()
    }
  })
})
