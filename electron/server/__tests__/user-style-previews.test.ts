import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import sharp from 'sharp'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import { router as userStylePreviewsRouter } from '../routes/user-style-previews.js'
import {
  USER_STYLE_PREVIEW_SLOTS,
  SettledPreviewFailure,
  generateUserStylePreviews,
  hashUserStyleSource,
  pathForUserStylePreviewAsset,
  previewRequestIdentity,
  publishUserStylePreviews,
  readUserStylePreviewEntry,
  saveUserStylePreview,
  userStylePreviewPrompts,
  userStylePreviewUrl,
  type UserStylePreviewSlot,
} from '../services/user-style-previews.js'
import { useTempDataDir } from './_helpers.js'

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => { await cleanup?.(); cleanup = undefined })

/** Real PNG bytes via sharp — the same decoder the service uses. */
async function pngBytes(width = 16, height = 9): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 40, g: 60, b: 90 } } }).png().toBuffer()
}
async function jpegBytes(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 9, channels: 3, background: { r: 40, g: 60, b: 90 } } }).jpeg().toBuffer()
}
async function webpBytes(): Promise<Buffer> {
  return sharp({ create: { width: 16, height: 9, channels: 3, background: { r: 40, g: 60, b: 90 } } }).webp().toBuffer()
}
const STYLE = { style_bible: 'Soft watercolour brushwork, no text.', negative_prompt: 'photo, 3D render' }
const STYLE_ID = 'kh.art-styles.dreamlands'

describe('user style previews — persistence', () => {
  test('saveUserStylePreview decodes, persists, and serves the bytes back by content hash', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const stored = await saveUserStylePreview({
      styleId: STYLE_ID,
      sourceHash: hashUserStyleSource(STYLE),
      slot: 'hero',
      imageBytes: bytes,
      now: () => '2026-10-25T00:00:00.000Z',
    })
    assert.equal(stored.format, 'png')
    assert.equal(stored.mime, 'image/png')
    assert.equal(stored.width, 16)
    assert.equal(stored.height, 9)
    assert.equal(stored.bytes, bytes.length)
    assert.equal(stored.created_at, '2026-10-25T00:00:00.000Z')
    // Content-addressed: the hash is the SHA-256 of the bytes.
    assert.equal(stored.hash, createHash('sha256').update(bytes).digest('hex'))
    // The served URL is the content key, so it is immutable.
    assert.equal(userStylePreviewUrl(stored.hash), `/api/user-style-previews/assets/${stored.hash}`)
    // The asset resolves to an absolute path on disk that actually exists.
    const abs = await pathForUserStylePreviewAsset(stored.hash)
    assert.ok(abs && abs.endsWith(`/${stored.hash}.png`))
    await fs.access(abs!)
    const onDisk = await fs.readFile(abs!)
    assert.ok(onDisk.equals(bytes))
  })

  test('saveUserStylePreview accepts JPEG and WebP, refuses animated/multipage and empty bytes', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const jpeg = await jpegBytes()
    const jpegStored = await saveUserStylePreview({
      styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'scene', imageBytes: jpeg,
    })
    assert.equal(jpegStored.format, 'jpeg')
    assert.equal(jpegStored.mime, 'image/jpeg')
    assert.ok((await pathForUserStylePreviewAsset(jpegStored.hash))?.endsWith('.jpg'))

    const webp = await webpBytes()
    const webpStored = await saveUserStylePreview({
      styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'face', imageBytes: webp,
    })
    assert.equal(webpStored.format, 'webp')
    assert.equal(webpStored.mime, 'image/webp')

    await assert.rejects(
      saveUserStylePreview({
        styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'hero', imageBytes: Buffer.alloc(0),
      }),
      /zero bytes/,
    )
    await assert.rejects(
      saveUserStylePreview({
        styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'hero', imageBytes: Buffer.from('not an image'),
      }),
      /not a usable image/,
    )
  })

  test('pathForUserStylePreviewAsset refuses ids that are not 64-hex, before touching the filesystem', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    assert.equal(await pathForUserStylePreviewAsset('not-a-hash'), null)
    assert.equal(await pathForUserStylePreviewAsset('../etc/passwd'), null)
    assert.equal(await pathForUserStylePreviewAsset('ABC'.repeat(22)), null) // 66 chars
    assert.equal(await pathForUserStylePreviewAsset('a'.repeat(63)), null)  // 63 chars
    assert.equal(await pathForUserStylePreviewAsset('g'.repeat(64)), null)  // non-hex
  })
})

describe('user style previews — stale after edit', () => {
  test('publishUserStylePreviews flags stored previews as stale when the style text changes', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const originalHash = hashUserStyleSource(STYLE)
    await saveUserStylePreview({ styleId: STYLE_ID, sourceHash: originalHash, slot: 'hero', imageBytes: bytes })
    const current = await publishUserStylePreviews(STYLE_ID, STYLE)
    assert.equal(current.stale, false)
    assert.equal(current.urls.length, 1)

    // Edit the style's own text: the same stored bytes are now out of date.
    const edited = { ...STYLE, style_bible: 'Hard-edged ink brushwork, no text.' }
    const afterEdit = await publishUserStylePreviews(STYLE_ID, edited)
    assert.equal(afterEdit.stale, true)
    // The bytes still serve — they are a real picture of what the look used to be —
    // but the publication says they are out of date.
    assert.equal(afterEdit.urls.length, 1)

    // hashUserStyleSource is stable for the same text and distinct for different text.
    assert.equal(hashUserStyleSource(STYLE), hashUserStyleSource({ ...STYLE }))
    assert.notEqual(hashUserStyleSource(STYLE), hashUserStyleSource(edited))
    // Whitespace normalisation: "Soft  watercolour" == "Soft watercolour".
    assert.equal(
      hashUserStyleSource({ style_bible: 'Soft  watercolour brushwork, no text.', negative_prompt: 'photo, 3D render' }),
      originalHash,
    )
    // Swapping the two halves produces a different hash — the NUL separator matters.
    const swapped = { style_bible: STYLE.negative_prompt!, negative_prompt: STYLE.style_bible }
    assert.notEqual(hashUserStyleSource(swapped), originalHash)
  })

  test('saving a preview for an edited style starts again — old slots are not carried forward', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const originalHash = hashUserStyleSource(STYLE)
    await saveUserStylePreview({ styleId: STYLE_ID, sourceHash: originalHash, slot: 'hero', imageBytes: bytes })
    await saveUserStylePreview({ styleId: STYLE_ID, sourceHash: originalHash, slot: 'scene', imageBytes: bytes })
    const before = await readUserStylePreviewEntry(STYLE_ID)
    assert.ok(before && before.slots.hero && before.slots.scene)

    const edited = { ...STYLE, style_bible: 'Different look entirely.' }
    const editedHash = hashUserStyleSource(edited)
    await saveUserStylePreview({ styleId: STYLE_ID, sourceHash: editedHash, slot: 'hero', imageBytes: bytes })
    const after = await readUserStylePreviewEntry(STYLE_ID)
    assert.ok(after && after.slots.hero)
    // The scene slot from the OLD text is gone, not carried forward as if it
    // described the new one.
    assert.equal(after?.slots.scene, undefined)
    assert.equal(after?.source_hash, editedHash)
  })
})

describe('user style previews — generate orchestration', () => {
  test('generateUserStylePreviews renders each missing slot once and reports partial failures by name', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const calls: Array<{ slot: UserStylePreviewSlot; identity: string }> = []
    const result = await generateUserStylePreviews({
      styleId: STYLE_ID,
      style: STYLE,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      async generate(job) {
        calls.push({ slot: job.slot, identity: job.requestIdentity })
        // The face slot fails; hero and scene succeed.
        if (job.slot === 'face') throw new Error('the Gateway refused the face')
        return bytes
      },
    })
    assert.deepEqual(calls.map(c => c.slot), ['hero', 'scene', 'face'])
    assert.deepEqual(result.generated, ['hero', 'scene'])
    assert.deepEqual(result.failed.map(f => f.slot), ['face'])
    assert.match(result.failed[0]!.error, /Gateway refused the face/)
    // Each slot got its own stable paid identity — same style text + same model
    // + same slot always produces the same key, so an unintended repeat is not
    // a second charge.
    const heroIdentities = calls.filter(c => c.slot === 'hero').map(c => c.identity)
    assert.equal(heroIdentities.length, 1)
    assert.match(heroIdentities[0]!, /^user-style-preview:kh\.art-styles\.dreamlands:[a-f0-9]{64}:hero:/)
    // The two published images are hero and scene, in that order.
    assert.equal(result.urls.length, 2)
    assert.equal(result.stale, false)
  })

  test('a retry after partial failure regenerates only the missing slot, not the ones that already succeeded', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    let firstRunCalls = 0
    const first = await generateUserStylePreviews({
      styleId: STYLE_ID,
      style: STYLE,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      async generate(job) {
        firstRunCalls++
        if (job.slot === 'face') throw new Error('first-attempt face failure')
        return bytes
      },
    })
    assert.deepEqual(first.generated, ['hero', 'scene'])
    assert.equal(first.failed.length, 1)
    assert.equal(firstRunCalls, 3, 'first run calls the generator for every slot')
    let secondRunCalls = 0
    const second = await generateUserStylePreviews({
      styleId: STYLE_ID,
      style: STYLE,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      async generate() { secondRunCalls++; return bytes },
    })
    // Only the face slot was regenerated. Hero and scene were skipped.
    assert.deepEqual(second.generated, ['face'])
    assert.deepEqual(second.skipped.sort(), ['hero', 'scene'])
    assert.equal(second.failed.length, 0)
    assert.equal(secondRunCalls, 1, 'only one Gateway call on retry')
    // All three slots now publish.
    assert.equal(second.urls.length, 3)
  })

  test('explicit slots restrict the run to those slots only', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const calls: UserStylePreviewSlot[] = []
    await generateUserStylePreviews({
      styleId: STYLE_ID,
      style: STYLE,
      modelId: 'mock-image-v1',
      aspectRatio: '16:9',
      slots: ['face'],
      async generate(job) { calls.push(job.slot); return bytes },
    })
    assert.deepEqual(calls, ['face'])
  })

  test('force=true re-renders every slot, even ones already saved for this text', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9',
      async generate() { return bytes },
    })
    const forced: UserStylePreviewSlot[] = []
    const result = await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9',
      force: true,
      async generate(job) { forced.push(job.slot); return bytes },
    })
    assert.deepEqual(forced.sort(), ['face', 'hero', 'scene'])
    assert.deepEqual(result.skipped, [])
    // Forced identities are UUID-suffixed so the provider treats them as new.
    assert.equal(result.generated.length, 3)
  })
})

describe('user style previews — a retry after a settled failure', () => {
  /**
   * A settled provider job can never be reopened, so a retry that resubmits the
   * same idempotency key can only re-read the same dead job: Retry would report
   * the identical failure for ever and never repair the slot (§8). The identity
   * therefore moves — but ONLY after the provider SETTLED the attempt, because a
   * dropped connection may have left the job running and a moved key would buy
   * the same image twice.
   */
  test('a settled provider failure moves the identity, and the retry repairs the slot', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const identities = new Map<string, string>()
    const first = await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9',
      async generate(job) {
        identities.set(`1:${job.slot}`, job.requestIdentity)
        if (job.slot === 'hero') throw new SettledPreviewFailure('the Gateway settled this job as failed')
        return bytes
      },
    })
    assert.deepEqual(first.generated, ['scene', 'face'])
    assert.deepEqual(first.failed.map(failure => failure.slot), ['hero'])
    // The failure is recorded against the style text it was rendered from.
    const afterFailure = await readUserStylePreviewEntry(STYLE_ID)
    assert.equal(afterFailure?.failed?.hero?.attempt, 1)
    assert.equal(afterFailure?.failed?.hero?.identity, identities.get('1:hero'))

    const retry = await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9',
      async generate(job) {
        identities.set(`2:${job.slot}`, job.requestIdentity)
        return bytes
      },
    })

    // The slot that failed is repaired; the two that succeeded are not re-asked.
    assert.deepEqual(retry.generated, ['hero'])
    assert.deepEqual([...retry.skipped].sort(), ['face', 'scene'])
    assert.equal(retry.failed.length, 0)
    assert.ok(identities.get('2:hero'))
    assert.notEqual(identities.get('2:hero'), identities.get('1:hero'), 'the dead key must not be replayed')
    assert.match(identities.get('2:hero')!, /:retry:2$/)
    assert.equal(identities.get('2:scene'), undefined, 'a saved slot is never rendered again')
    // A success spends the failure record.
    assert.equal((await readUserStylePreviewEntry(STYLE_ID))?.failed, undefined)
  })

  test('a failure the provider did NOT settle keeps its identity, so the retry cannot pay twice', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const identities: string[] = []
    await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9', slots: ['hero'],
      // A dropped connection: the job may still be running at the provider.
      async generate(job) { identities.push(job.requestIdentity); throw new Error('fetch failed') },
    })
    await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9', slots: ['hero'],
      async generate(job) { identities.push(job.requestIdentity); return bytes },
    })
    assert.equal(identities.length, 2)
    assert.equal(identities[0], identities[1], 'the retry replays the same job rather than buying a second one')
    assert.equal((await readUserStylePreviewEntry(STYLE_ID))?.failed, undefined)
  })

  test('a save that fails after the render succeeded keeps the identity — the pixels exist', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    const identities: string[] = []
    const unusable = Buffer.from('not an image at all')
    const first = await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9', slots: ['hero'],
      async generate(job) { identities.push(job.requestIdentity); return unusable },
    })
    assert.deepEqual(first.generated, [])
    assert.match(first.failed[0]!.error, /not a usable image/)
    const second = await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9', slots: ['hero'],
      async generate(job) { identities.push(job.requestIdentity); return bytes },
    })
    assert.deepEqual(second.generated, ['hero'])
    assert.equal(identities[0], identities[1],
      'a local failure must not move the identity: the render was already bought')
  })

  test('the next identity is derived from the recorded attempt, so two retries after one failure agree', () => {
    const base = {
      styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'hero' as const,
      modelId: 'mock-image-v1', aspectRatio: '16:9',
    }
    const first = previewRequestIdentity(base)
    const retry = previewRequestIdentity({ ...base, failedAttempt: 1 })
    // Deterministic: the same recorded failure always yields the same next key.
    assert.equal(retry, previewRequestIdentity({ ...base, failedAttempt: 1 }))
    assert.notEqual(retry, first)
    // A failure of the retry itself moves it again, so a slot cannot get stuck.
    const secondRetry = previewRequestIdentity({ ...base, failedAttempt: 2 })
    assert.notEqual(secondRetry, retry)
    assert.notEqual(secondRetry, first)
  })

  test('a slot that fails keeps its record when a sibling slot succeeds', async () => {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const bytes = await pngBytes()
    await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9',
      async generate(job) {
        if (job.slot === 'hero') throw new SettledPreviewFailure('hero settled failed')
        return bytes
      },
    })
    // Saving the face and scene must carry the hero's record across rather than
    // replacing the entry, or the hero's retry would replay its dead job.
    const entry = await readUserStylePreviewEntry(STYLE_ID)
    assert.equal(entry?.failed?.hero?.attempt, 1)
    const identities: string[] = []
    await generateUserStylePreviews({
      styleId: STYLE_ID, style: STYLE, modelId: 'mock-image-v1', aspectRatio: '16:9', slots: ['hero'],
      async generate(job) { identities.push(job.requestIdentity); return bytes },
    })
    assert.match(identities[0]!, /:retry:2$/)
  })
})

describe('user style previews — prompts', () => {
  test('each slot prompt restates the style bible, its own framing, and the negative list', () => {
    const prompts = userStylePreviewPrompts(STYLE)
    for (const slot of USER_STYLE_PREVIEW_SLOTS) {
      assert.ok(prompts[slot].startsWith(STYLE.style_bible))
      assert.match(prompts[slot], /No text, no lettering, no watermark/)
      assert.match(prompts[slot], /Avoid: photo, 3D render/)
    }
    assert.match(prompts.hero, /the shot the look exists for/)
    assert.match(prompts.scene, /NO FIGURE IN IT AT ALL/)
    assert.match(prompts.face, /hardest case/)
  })

  test('a style with no negative prompt omits the Avoid line', () => {
    const prompts = userStylePreviewPrompts({ style_bible: 'Look.' })
    for (const slot of USER_STYLE_PREVIEW_SLOTS) {
      assert.doesNotMatch(prompts[slot], /Avoid:/)
    }
  })
})

describe('user style previews — route', () => {
  async function appWithTempData() {
    const temp = await useTempDataDir(); cleanup = temp.cleanup
    const app = express()
    app.use(express.json({ limit: '10mb' }))
    app.use('/api', userStylePreviewsRouter)
    return app
  }

  test('GET /api/user-style-previews/assets/:hash serves the saved bytes with the right content-type', async () => {
    const app = await appWithTempData()
    const bytes = await pngBytes()
    const stored = await saveUserStylePreview({
      styleId: STYLE_ID, sourceHash: hashUserStyleSource(STYLE), slot: 'hero', imageBytes: bytes,
    })
    const response = await request(app).get(`/api/user-style-previews/assets/${stored.hash}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'image/png')
    assert.match(response.headers['cache-control'] || '', /immutable/)
    assert.ok(Buffer.from(response.body).equals(bytes))
  })

  test('GET refuses ids that are not 64-hex before touching the filesystem', async () => {
    const app = await appWithTempData()
    const bad = await request(app).get('/api/user-style-previews/assets/not-a-hash')
    assert.equal(bad.status, 400)
    // Express normalises `..` out of the URL path before routing, so a traversal
    // attempt never reaches the handler — the route simply does not match and
    // Express answers 404. Either way, the bytes on disk are never read.
    const traversal = await request(app).get('/api/user-style-previews/assets/../etc/passwd')
    assert.ok(traversal.status === 400 || traversal.status === 404,
      `expected 400 or 404, got ${traversal.status}`)
    // A 63-char hex string and a 65-char hex string both fail the regex.
    const short = await request(app).get(`/api/user-style-previews/assets/${'a'.repeat(63)}`)
    assert.equal(short.status, 400)
    const long = await request(app).get(`/api/user-style-previews/assets/${'a'.repeat(65)}`)
    assert.equal(long.status, 400)
    // Upper-case hex is rejected — the route stores lower-case only.
    const upper = await request(app).get(`/api/user-style-previews/assets/${'A'.repeat(64)}`)
    assert.equal(upper.status, 400)
  })

  test('GET 404s a well-formed hash that is not in the index', async () => {
    const app = await appWithTempData()
    const missing = await request(app).get(`/api/user-style-previews/assets/${'a'.repeat(64)}`)
    assert.equal(missing.status, 404)
  })
})