/**
 * A Gateway sound clip has to reach THIS Mac before the mixer can use it.
 *
 * Production, 2026-10-30: an approved Sound & Labels cue pointed at a clip kept
 * in the Gateway's library. The resolver looked for the bytes in
 * `STORY_STUDIO_GATEWAY_SOUND_LIBRARY` — a folder on the machine running the
 * Gateway, which on the mini is a different Mac and which nothing set there —
 * so the clip had no bytes and the render could not mix the sound the reviewer
 * approved.
 *
 * The rules pinned here (AGENTS §6 and §8):
 *  - a clip is downloaded ONCE into this Mac's own cache, and the cached bytes
 *    are hashed before they are used;
 *  - the cache filename is matched on what it ENDS with (`<sha256>.<ext>`), so a
 *    sidecar beside the clip is never claimed;
 *  - a clip that cannot be fetched, or arrives with the wrong hash, stops the
 *    render with a message naming the clip — it is never silently skipped;
 *  - `/v1/sounds/library` tags reach the candidate's description so selection can
 *    read them, and a row kept before tags existed reads as "no tags", not as an
 *    error.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

const CLIP = Buffer.from('ID3 fake clip bytes for the gateway sound cache test')
const CLIP_SHA = createHash('sha256').update(CLIP).digest('hex')

let isolated: Awaited<ReturnType<typeof useTempDataDir>>
let originalFetch: typeof globalThis.fetch
let requests: Array<{ url: string; method: string }> = []
/** What the fake Gateway answers for a path. */
let answer: (url: string, method: string) => Response | Promise<Response>

before(async () => {
  isolated = await useTempDataDir()
  const settings = await import('../services/app-settings.js')
  const secrets = await import('../services/app-secrets-store.js')
  // A loopback address the fetch stub answers; nothing listens there.
  await settings.setGenStudioUrl('http://127.0.0.1:9')
  await secrets.setApiKey('genstudio', 'test-key')
  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input)
    const method = String(init?.method || 'GET').toUpperCase()
    requests.push({ url, method })
    return await answer(url, method)
  }) as unknown as typeof globalThis.fetch
})

after(async () => {
  globalThis.fetch = originalFetch
  await isolated.cleanup()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('the Gateway clip cache', () => {
  test('downloads a clip once, hashes it, and answers from the cache after that', async () => {
    const lib = await import('../lib/gateway-sound-library.js')
    requests = []
    answer = () => new Response(CLIP, { status: 200, headers: { 'content-type': 'audio/mpeg' } })

    const first = await lib.ensureSoundClipCached(CLIP_SHA, 'Temple bells')
    assert.ok(first.endsWith(`${CLIP_SHA}.mp3`), first)
    assert.deepEqual(await fs.readFile(first), CLIP, 'the cached bytes are the Gateway’s bytes')
    assert.equal(requests.length, 1)
    assert.match(requests[0]!.url, new RegExp(`/v1/sounds/library/${CLIP_SHA}/audio$`))

    const second = await lib.ensureSoundClipCached(CLIP_SHA, 'Temple bells')
    assert.equal(second, first)
    assert.equal(requests.length, 1, 'a second render downloads nothing')
  })

  test('a cached file that no longer hashes to its name is moved aside and fetched again', async () => {
    const lib = await import('../lib/gateway-sound-library.js')
    const dir = await lib.soundClipCacheDir()
    const cached = path.join(dir, `${CLIP_SHA}.mp3`)
    await fs.writeFile(cached, Buffer.from('torn bytes'))
    requests = []
    answer = () => new Response(CLIP, { status: 200, headers: { 'content-type': 'audio/mpeg' } })

    const file = await lib.ensureSoundClipCached(CLIP_SHA, 'Temple bells')
    assert.deepEqual(await fs.readFile(file), CLIP)
    const names = await fs.readdir(dir)
    assert.ok(names.some(name => name.startsWith(`${CLIP_SHA}.mp3.corrupt-`)), 'the bad file is kept, not deleted')
    assert.equal(requests.length, 1)
  })

  test('a sidecar whose name merely starts with the hash is never claimed', async () => {
    const lib = await import('../lib/gateway-sound-library.js')
    const dir = await lib.soundClipCacheDir()
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, `${CLIP_SHA}.mp3.sidecar`), '{"licence":"cc0"}')
    answer = () => new Response(CLIP, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    const file = await lib.ensureSoundClipCached(CLIP_SHA, 'Temple bells')
    assert.ok(file.endsWith(`${CLIP_SHA}.mp3`), file)
  })

  test('the wrong bytes are refused and nothing is cached', async () => {
    const other = Buffer.from('a different clip entirely')
    answer = () => new Response(other, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    const missingSha = createHash('sha256').update('never served').digest('hex')
    const lib = await import('../lib/gateway-sound-library.js')
    await assert.rejects(
      () => lib.ensureSoundClipCached(missingSha, 'Temple bells'),
      /wrong content/i,
    )
    const dir = await lib.soundClipCacheDir()
    const names = await fs.readdir(dir).catch(() => [] as string[])
    assert.equal(names.some(name => name.startsWith(missingSha)), false, 'a hash mismatch writes nothing')
  })

  test('a clip the Gateway cannot send is reported by the name the customer knows', async () => {
    answer = () => json({ detail: 'That sound is no longer in the library.' }, 404)
    const lib = await import('../lib/gateway-sound-library.js')
    const goneSha = createHash('sha256').update('gone').digest('hex')
    await assert.rejects(
      () => lib.ensureSoundClipCached(goneSha, 'Temple bells'),
      (error: any) => /Temple bells/.test(error.message) && /could not be fetched/i.test(error.message),
    )
  })
})

describe('the render path', () => {
  test('an approved Gateway cue mixes from the cached file', async () => {
    const lib = await import('../lib/gateway-sound-library.js')
    answer = () => new Response(CLIP, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    await lib.ensureSoundClipCached(CLIP_SHA, 'Temple bells')
    const resolver = await import('../services/sound-design-resolver.js')
    requests = []
    const cues = await resolver.approvedSoundDesignMixCues([{
      id: 'sound-1', kind: 'spot', label: 'Temple bells', start_sec: 4, source: 'gateway',
      clip: CLIP_SHA, gain_db: -12, status: 'approved', created_at: 'now', updated_at: 'now',
    } as any])
    assert.equal(cues.length, 1)
    assert.deepEqual(await fs.readFile(cues[0]!.path), CLIP)
    assert.equal(requests.length, 0, 'a cached clip costs no download at render time')
  })

  test('an approved Gateway cue that cannot be fetched stops the render by name', async () => {
    answer = () => json({ detail: 'Gateway unreachable' }, 503)
    const resolver = await import('../services/sound-design-resolver.js')
    const goneSha = createHash('sha256').update('absent clip').digest('hex')
    await assert.rejects(
      () => resolver.approvedSoundDesignMixCues([{
        id: 'sound-2', kind: 'spot', label: 'Harbour horn', start_sec: 9, source: 'gateway',
        clip: goneSha, gain_db: -12, status: 'approved', created_at: 'now', updated_at: 'now',
      } as any]),
      (error: any) => /Harbour horn/.test(error.message) && /could not be fetched/i.test(error.message),
    )
  })
})

describe('tags', () => {
  test('the clip’s tags reach the candidate description, and an old row without tags reads as none', async () => {
    const lib = await import('../lib/gateway-sound-library.js')
    answer = url => url.endsWith('/v1/sounds/library')
      ? json({
        clips: [
          { sha256: 'a'.repeat(64), licence: 'cc0', title: 'Temple bells', source: 'freesound', tags: ['bell', 'temple'], kind: 'spot' },
          { sha256: 'b'.repeat(64), licence: 'cc0', title: 'Old row', source: 'freesound' },
        ],
      })
      : json({}, 404)

    const kept = await lib.listKeptSounds()
    assert.deepEqual(kept.find(clip => clip.sha256.startsWith('a'))!.tags, ['bell', 'temple'])
    assert.deepEqual(kept.find(clip => clip.sha256.startsWith('b'))!.tags, [], 'absent tags are no tags, not an error')

    assert.equal(kept.find(clip => clip.sha256.startsWith('a'))!.kind, 'spot')
    assert.equal(kept.find(clip => clip.sha256.startsWith('b'))!.kind, undefined)
    const source = await fs.readFile(new URL('../generators/contextual-cues.ts', import.meta.url), 'utf8')
    assert.match(source, /kind: clip\.kind/, 'the candidate carries the kind')
    assert.match(source, /\.\.\.\(clip\.tags \|\| \[\]\)/, 'the candidate description reads the tags')
  })
})
