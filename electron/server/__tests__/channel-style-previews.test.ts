/**
 * A channel's own custom styles (`ProjectConfig.style_presets`) show the same
 * three previews a style from a pack does — the hero, a quiet wide scene with no
 * figure in it, and the hardest legal case — and never a different number
 * (owner, 2026-10-25: "make sure all old and new previews have 3 options only.
 * No more or less.").
 *
 * What these tests pin, and why each one matters:
 *
 *   - a channel style renders the SAME three framings as a signed pack, with the
 *     prompt built on the server from the style's own text;
 *   - two channels whose style text is identical share ONE set of three images —
 *     the second run skips all three instead of paying for them again. This is
 *     the whole point of keying the shared store by the text's hash: the owner's
 *     215 channel styles are only 34 distinct texts;
 *   - a retry regenerates only what is missing, and a failure costs one image;
 *   - a style whose text was edited is shown OUT OF DATE, still showing the
 *     images the earlier text produced, rather than passing them for the look it
 *     has now;
 *   - an older gallery of up to eight files is displayed capped at three and is
 *     NEVER deleted from disk (§5);
 *   - a style with fewer than three previews reports the ones it still needs.
 *
 * ZERO paid calls: every request here goes to the in-process mock Gateway.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'

type Pm = typeof import('../services/project-manager.js')
type Service = Awaited<ReturnType<typeof startMockGenStudioService>>
type App = ReturnType<typeof express>

let pm: Pm
let app: App
let service: Service
let cleanup: (() => Promise<void>) | undefined

const MODEL = 'mock-image-v1'

async function pngBytes(): Promise<Buffer> {
  return sharp({ create: { width: 24, height: 14, channels: 3, background: { r: 30, g: 60, b: 90 } } }).png().toBuffer()
}

/** Create a channel and return its slug. */
async function channel(name: string): Promise<string> {
  const project = await pm.createProject({ name })
  return project.slug
}

/** Write style presets straight onto the project config, as the editor does. */
async function seedPresets(slug: string, presets: Array<Record<string, unknown>>): Promise<void> {
  const config = await pm.getConfig(slug)
  const existing = Array.isArray((config as any)?.style_presets) ? (config as any).style_presets : []
  await pm.updateConfig(slug, {
    style_presets: [...existing, ...presets.map(preset => ({
      created_at: '2026-10-25T00:00:00.000Z',
      ...preset,
    }))],
  } as any)
}

async function generatePreview(slug: string, body: Record<string, unknown>): Promise<any> {
  const response = await request(app)
    .post(`/api/projects/${slug}/channel-style-previews`)
    .send({ model: MODEL, aspect_ratio: '16:9', ...body })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body
}

async function previewStates(slug: string): Promise<any[]> {
  const response = await request(app).get(`/api/projects/${slug}/channel-style-previews`)
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.styles
}

async function stateFor(slug: string, presetId: string): Promise<any> {
  const styles = await previewStates(slug)
  const state = styles.find(style => style.preset_id === presetId)
  assert.ok(state, `no resolved state for ${presetId}`)
  return state
}

/** Every image prompt the mock Gateway was asked to render. */
function imagePrompts(): string[] {
  return imageSubmissions().map(submission => String((submission.parsedBody as any)?.prompt ?? submission.bodyText))
}

/** Every image submission the mock Gateway accepted, in order. */
function imageSubmissions(): Array<{ idempotencyKey: string; operation: string; parsedBody?: unknown; bodyText: string }> {
  return service.submissions.filter(submission => submission.operation === 'image') as never
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  const client = await import('../lib/genstudio-client.js')
  pm = await import('../services/project-manager.js')
  const { router: channelRouter } = await import('../routes/channel-style-previews.js')
  const { router: stylePreviewRouter } = await import('../routes/style-preview.js')

  await settings.setGenStudioUrl(service.baseUrl)
  await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  client.clearGenStudioCatalogCache()

  app = express()
  app.use(express.json({ limit: '10mb' }))
  app.use('/api', stylePreviewRouter)
  app.use('/api', channelRouter)
})

after(async () => {
  await service?.close()
  await cleanup?.()
})

describe('channel style previews — the three framings', () => {
  test('a channel style renders the same three framings a signed pack ships, from its own text', async () => {
    const slug = await channel('Three framings')
    const text = 'Hand-painted Khmer temple mural in flat gouache, warm ochre and jade.'
    await seedPresets(slug, [{ id: 'temple-mural', name: 'Temple mural', description: text }])

    const body = await generatePreview(slug, { style_tag: text })

    assert.deepEqual(body.generated, ['hero', 'scene', 'face'])
    assert.deepEqual(body.skipped, [])
    assert.deepEqual(body.failed, [])
    assert.equal(body.slots.length, 3)
    assert.deepEqual(body.slots.map((slot: any) => slot.slot), ['hero', 'scene', 'face'])
    for (const slot of body.slots) {
      assert.match(slot.url, /^\/api\/user-style-previews\/assets\/[a-f0-9]{64}$/)
    }
    assert.deepEqual(body.images, body.slots.map((slot: any) => slot.url))

    // The prompts are the style's own text plus the shared framings — built on
    // the server, never sent by the client.
    const prompts = imagePrompts()
    assert.equal(prompts.length, 3)
    for (const prompt of prompts) assert.ok(prompt.startsWith(text), prompt.slice(0, 40))
    assert.match(prompts[0]!, /the shot the look exists for/)
    assert.match(prompts[1]!, /NO FIGURE IN IT AT ALL/)
    assert.match(prompts[2]!, /hardest case/)
    for (const prompt of prompts) assert.match(prompt, /No text, no lettering/)

    // The preset now points at the text its previews describe, so a later edit
    // is visible rather than silent.
    const config = await pm.getConfig(slug)
    const preset = (config as any).style_presets.find((entry: any) => entry.id === 'temple-mural')
    assert.equal(preset.preview_source_hash, body.source_hash)
    assert.equal(preset.preview_model, MODEL)
    assert.equal(preset.preview_aspect_ratio, '16:9')
    assert.deepEqual(body.updated_preset_ids, ['temple-mural'])

    const state = await stateFor(slug, 'temple-mural')
    assert.equal(state.stale, false)
    assert.equal(state.needs_previews, false)
    assert.deepEqual(state.slots, body.slots)
    assert.deepEqual(state.stored_files, [])
  })

  test('a model outside the live Gateway catalogue is refused before anything is rendered', async () => {
    const slug = await channel('Refused model')
    const text = 'Flat vector shapes with a two-colour palette.'
    const callsBefore = imagePrompts().length
    const response = await request(app)
      .post(`/api/projects/${slug}/channel-style-previews`)
      .send({ style_tag: text, model: 'retired-image-model', aspect_ratio: '16:9' })
    assert.equal(response.status, 400)
    assert.match(response.body.detail, /not in the live Gateway image catalog/)
    assert.equal(imagePrompts().length, callsBefore, 'nothing was rendered')
  })

  test('an unknown project is a 404, not an empty style list', async () => {
    const response = await request(app).get('/api/projects/no-such-channel/channel-style-previews')
    assert.equal(response.status, 404)
  })
})

describe('channel style previews — one set of images per style text', () => {
  test('two channels with the same style text share one set of three images and the second run skips all three', async () => {
    const text = 'Soft watercolour wash of a flooded rice field at dusk.'
    const first = await channel('Shared text A')
    const second = await channel('Shared text B')
    await seedPresets(first, [{ id: 'watercolour', name: 'Watercolour', description: text }])
    await seedPresets(second, [{ id: 'watercolour-mural', name: 'Watercolour (copied)', description: text }])

    const rendered = await generatePreview(first, { style_tag: text })
    assert.deepEqual(rendered.generated, ['hero', 'scene', 'face'])
    const rendersAfterFirst = imagePrompts().length

    const shared = await generatePreview(second, { style_tag: text })

    // Nothing was rendered for the second channel: all three were already
    // stored for this text, so all three are reported as skipped.
    assert.deepEqual(shared.generated, [])
    assert.deepEqual([...shared.skipped].sort(), ['face', 'hero', 'scene'])
    assert.deepEqual(shared.failed, [])
    assert.equal(imagePrompts().length, rendersAfterFirst, 'the identical text cost nothing the second time')
    // The same three images, not copies of them.
    assert.deepEqual(shared.slots, rendered.slots)
    // And the second channel's preset points at the same text.
    assert.deepEqual(shared.updated_preset_ids, ['watercolour-mural'])

    const firstState = await stateFor(first, 'watercolour')
    const secondState = await stateFor(second, 'watercolour-mural')
    assert.deepEqual(secondState.slots, firstState.slots)
    assert.equal(secondState.stale, false)
  })

  test('every preset of a channel that shows the same text is recorded together', async () => {
    const text = 'Bold ink-outline cartoon with a limited palette.'
    const slug = await channel('Twinned styles')
    await seedPresets(slug, [
      { id: 'look-a', name: 'Look A', description: text },
      { id: 'look-b', name: 'Look B', description: text },
      { id: 'look-c', name: 'Look C', description: 'Something else entirely.' },
    ])

    const body = await generatePreview(slug, { style_tag: text })

    assert.deepEqual([...body.updated_preset_ids].sort(), ['look-a', 'look-b'])
    assert.equal((await stateFor(slug, 'look-a')).stale, false)
    assert.equal((await stateFor(slug, 'look-b')).stale, false)
  })

  test('rendering for a style that is not saved yet still publishes the three images', async () => {
    const slug = await channel('Unsaved style')
    await seedPresets(slug, [{ id: 'saved', name: 'Saved', description: 'A saved look.' }])

    const body = await generatePreview(slug, { style_tag: 'A look being written but not saved yet.' })

    assert.deepEqual(body.generated, ['hero', 'scene', 'face'])
    assert.deepEqual(body.updated_preset_ids, [], 'no saved preset shows this text')
    assert.equal(body.slots.length, 3)
  })
})

describe('channel style previews — missing slots and retries', () => {
  test('a style with fewer than three previews reports what it is still missing', async () => {
    const text = 'Cut-paper collage with visible fibre and torn edges.'
    const slug = await channel('Partial set')
    await seedPresets(slug, [{ id: 'collage', name: 'Collage', description: text }])

    const body = await generatePreview(slug, { style_tag: text, slots: ['hero'] })
    assert.deepEqual(body.generated, ['hero'])
    assert.equal(body.slots.length, 1)

    const state = await stateFor(slug, 'collage')
    assert.deepEqual(state.slots.map((slot: any) => slot.slot), ['hero'])
    assert.equal(state.needs_previews, true, 'the two missing previews are still offered')
    assert.equal(state.stale, false, 'what IS shown describes this style')
  })

  test('a retry renders only the missing slot and never re-renders one that succeeded', async () => {
    const text = 'Charcoal study with smudged shadow and no outlines.'
    const slug = await channel('Retry')
    await seedPresets(slug, [{ id: 'charcoal', name: 'Charcoal', description: text }])

    await generatePreview(slug, { style_tag: text, slots: ['hero'] })
    const afterFirst = imagePrompts().length

    const retry = await generatePreview(slug, { style_tag: text })

    assert.deepEqual(retry.generated, ['scene', 'face'])
    assert.deepEqual(retry.skipped, ['hero'], 'the hero is asked for and already saved')
    assert.equal(imagePrompts().length, afterFirst + 2, 'exactly the two missing images were rendered')
    assert.equal(retry.slots.length, 3)
  })

  test('a slot that fails is reported by name and does not stop the others', async () => {
    const text = 'Risograph print with visible misregistration.'
    const slug = await channel('Partial failure')
    await seedPresets(slug, [{ id: 'riso', name: 'Riso', description: text }])
    // One scripted answer per image: the hero fails, the other two succeed.
    service.clearQueuedScenarios('image')
    service.queueScenario('image', { states: ['failed'] })
    service.queueScenario('image', { states: ['succeeded'] })
    service.queueScenario('image', { states: ['succeeded'] })

    const submissionsBeforeFirst = imageSubmissions().length
    const body = await generatePreview(slug, { style_tag: text })

    assert.deepEqual(body.generated, ['scene', 'face'], 'the two that could render still landed')
    assert.deepEqual(body.failed.map((failure: any) => failure.slot), ['hero'])
    assert.match(body.failed[0].error, /\w/, 'the failure carries its own reason')
    assert.deepEqual(body.slots.map((slot: any) => slot.slot), ['scene', 'face'])
    const failedHeroKey = imageSubmissions()[submissionsBeforeFirst]!.idempotencyKey

    // A retry asks only for what is still missing — the settled success IS
    // reported as asked-for-and-already-saved, so nothing is rendered twice —
    // AND the slot the provider settled as failed is repaired under a NEW
    // idempotency identity. A stable identity would replay the dead job for ever
    // and Retry would never fix the slot (§8); see `SettledPreviewFailure`.
    const submissionsBeforeRetry = imageSubmissions().length
    const retried = await generatePreview(slug, { style_tag: text })
    assert.deepEqual([...retried.skipped].sort(), ['face', 'scene'])
    assert.deepEqual(retried.generated, ['hero'], 'the failed slot is really re-rendered')
    assert.deepEqual(retried.failed, [])
    assert.equal(retried.slots.length, 3, 'all three previews now exist')

    const retriedSubmissions = imageSubmissions().slice(submissionsBeforeRetry)
    assert.equal(retriedSubmissions.length, 1, 'exactly one new render, for the hero alone')
    assert.notEqual(
      retriedSubmissions[0]!.idempotencyKey,
      failedHeroKey,
      'the retry must not replay the key the provider settled as failed',
    )
  })
})

describe('channel style previews — an edited style is out of date', () => {
  test('editing the text shows the earlier images as out of date, then re-rendering replaces them', async () => {
    const before = 'Golden hour woodblock print with carved sky lines.'
    const after = 'Blue hour woodblock print with carved sky lines.'
    const slug = await channel('Edited style')
    await seedPresets(slug, [{ id: 'woodblock', name: 'Woodblock', description: before }])
    // The editor saves through the preset route; the edit must not clear the
    // pointer to the images that already exist.
    await request(app).put(`/api/projects/${slug}/style-presets/woodblock`)
      .send({ name: 'Woodblock', description: before })
      .expect(200)

    const rendered = await generatePreview(slug, { style_tag: before })
    assert.equal((await stateFor(slug, 'woodblock')).stale, false)

    const edited = await request(app).put(`/api/projects/${slug}/style-presets/woodblock`)
      .send({ name: 'Woodblock', description: after })
      .expect(200)
    assert.equal(edited.body.preview_source_hash, rendered.source_hash,
      'the pointer still names the text the displayed previews came from')

    const stale = await stateFor(slug, 'woodblock')
    assert.equal(stale.stale, true)
    assert.deepEqual(stale.slots, rendered.slots, 'the images made from the earlier text are still shown')
    assert.equal(stale.source_hash, rendered.source_hash)

    const rendersBefore = imagePrompts().length
    const refreshed = await generatePreview(slug, { style_tag: after })
    assert.deepEqual(refreshed.generated, ['hero', 'scene', 'face'])
    assert.equal(imagePrompts().length, rendersBefore + 3, 'the edited text rendered a new set of three')
    const current = await stateFor(slug, 'woodblock')
    assert.equal(current.stale, false)
    assert.equal(current.source_hash, refreshed.source_hash)
    assert.notEqual(current.source_hash, rendered.source_hash)
  })

  test('a preset saved for text that already has previews is recorded as current', async () => {
    const text = 'Airbrushed retro-futurist poster with chrome reflections.'
    const slug = await channel('Saved after previews')
    await generatePreview(slug, { style_tag: text })

    const created = await request(app)
      .post(`/api/projects/${slug}/style-presets`)
      .send({ name: 'Chrome poster', description: text, preview_model: MODEL, preview_aspect_ratio: '16:9' })
      .expect(200)

    assert.ok(created.body.preview_source_hash, 'the new preset points at the text its previews describe')
    assert.equal(created.body.preview_model, MODEL)
    assert.equal((await stateFor(slug, created.body.id)).stale, false)
  })
})

describe('channel style previews — the older files', () => {
  test('a legacy gallery of more than three files is shown capped at three, and nothing on disk is deleted', async () => {
    const slug = await channel('Legacy gallery')
    const files = ['legacy.png', 'legacy-2.png', 'legacy-3.png', 'legacy-4.png', 'legacy-5.png']
    const previewsDir = path.join(pm.getProjectDir(slug)!, 'style-previews')
    await fs.mkdir(previewsDir, { recursive: true })
    const bytes = await pngBytes()
    for (const file of files) await fs.writeFile(path.join(previewsDir, file), bytes)
    await seedPresets(slug, [{
      id: 'legacy',
      name: 'Legacy',
      description: 'Old single-proof style with eight saved samples.',
      preview_filename: 'legacy.png',
      preview_files: files,
    }])

    const state = await stateFor(slug, 'legacy')

    assert.deepEqual(state.slots, [], 'no shared slot images exist for this text yet')
    assert.deepEqual(state.stored_files, files.slice(0, 3), 'shown capped at the three the owner allows')
    assert.equal(state.stale, true, 'files from the older flow are out of date')
    assert.equal(state.needs_previews, true)

    await previewStates(slug)
    for (const file of files) {
      await fs.access(path.join(previewsDir, file))
    }
  })

  test('a style saved with no picture of its own takes the hero as its img2img reference, and an existing picture is never overwritten', async () => {
    const text = 'Gouache travel-journal sketch with visible pencil underdrawing.'
    const slug = await channel('Reference image')
    await generatePreview(slug, { style_tag: text })

    const created = await request(app)
      .post(`/api/projects/${slug}/style-presets`)
      .send({ name: 'Travel journal', description: text, preview_model: MODEL, preview_aspect_ratio: '16:9' })
      .expect(200)

    assert.equal(created.body.preview_filename, `${created.body.id}.png`)
    assert.deepEqual(created.body.preview_files, [`${created.body.id}.png`])
    const previewsDir = path.join(pm.getProjectDir(slug)!, 'style-previews')
    const referencePath = path.join(previewsDir, created.body.preview_filename)
    const seeded = await fs.readFile(referencePath)
    assert.ok(seeded.length > 0)
    // ONE file, not a copy of all three: the displayed previews come from the
    // shared store.
    assert.deepEqual((await fs.readdir(previewsDir)).sort(), [`${created.body.id}.png`])

    // A later save leaves that picture exactly as it is.
    await fs.writeFile(referencePath, Buffer.from('an older picture the customer already had'))
    await request(app).put(`/api/projects/${slug}/style-presets/${created.body.id}`)
      .send({ name: 'Travel journal', description: text })
      .expect(200)
    assert.equal(await fs.readFile(referencePath, 'utf8'), 'an older picture the customer already had')
  })

  test('the three slot images take over the display, and the older files stay on disk', async () => {
    const text = 'Screen-printed poster with a coarse halftone dot.'
    const slug = await channel('Legacy replaced')
    const files = ['old.png', 'old-2.png', 'old-3.png', 'old-4.png']
    const previewsDir = path.join(pm.getProjectDir(slug)!, 'style-previews')
    await fs.mkdir(previewsDir, { recursive: true })
    const bytes = await pngBytes()
    for (const file of files) await fs.writeFile(path.join(previewsDir, file), bytes)
    await seedPresets(slug, [{
      id: 'halftone', name: 'Halftone', description: text, preview_filename: 'old.png', preview_files: files,
    }])

    const body = await generatePreview(slug, { style_tag: text })
    const state = await stateFor(slug, 'halftone')

    assert.deepEqual(state.slots, body.slots)
    assert.deepEqual(state.stored_files, [], 'the slots win outright; an older sample is never mixed in beside them')
    assert.equal(state.stale, false)
    for (const file of files) {
      await fs.access(path.join(previewsDir, file))
    }
  })
})
