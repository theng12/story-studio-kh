import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
after(async () => { await temp.cleanup() })
const { resolveLabelTargets } = await import('../lib/label-target.js')
const client = await import('../lib/scene-vision-client.js')
const { setApiKey } = await import('../services/app-secrets-store.js')

test('label targets follow the scene image and fail soft', async () => {
  const episodeDir = path.join(temp.dir, 'episode')
  const sceneDir = path.join(episodeDir, 'scene_images')
  await fs.mkdir(sceneDir, { recursive: true })
  const image = path.join(sceneDir, 'scene-42.png')
  const picture = (color: string) => sharp({ create: { width: 64, height: 36, channels: 3, background: color } }).png().toBuffer()
  await fs.writeFile(image, await picture('red'))
  await setApiKey('genstudio', 'test-key')
  let calls = 0
  let reply: any = { subject: { source: 'grounding', box: [0.2, 0.3, 0.2, 0.4] } }
  client._setVisionFetchForTesting((async (_url: any, init: any) => {
    calls++
    const body = JSON.parse(init.body)
    assert.deepEqual(body.tasks, ['subject'])
    assert.equal(body.text, 'the bell')
    assert.equal(body.image.mime, 'image/jpeg')
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply), { status: 200 })
  }) as any)
  const logs: string[] = []
  const cue = { id: 'cue', scene_id: 'scene-42', title: 'Bell', point_at: 'the bell', template: 'label:location-pin' } as any
  const plan = { scenes: [{ id: 'scene-42', scene_index: 42 }] } as any
  const resolve = (item = cue) => resolveLabelTargets({ episodeDir, plan, cues: [item], sceneImages: new Map([['scene-42', image]]), log: line => logs.push(line) })
  try {
    const [found] = await resolve()
    assert.ok(Math.abs(found!.target_x_pct! - 30) < 1e-8)
    assert.ok(Math.abs(found!.target_y_pct! - 50) < 1e-8)
    await resolve()
    assert.equal(calls, 1, 'the same cue and picture reuse the result')

    const [manual] = await resolve({ ...cue, target_x_pct: 11, target_y_pct: 22 })
    assert.equal(manual!.target_x_pct, 11)
    assert.equal(manual!.target_y_pct, 22)
    assert.equal(calls, 1)

    await fs.writeFile(image, await picture('blue'))
    reply = { subject: { source: 'grounding', box: [0, 0, 0.99, 0.99] } }
    const [large] = await resolve()
    assert.equal(large!.target_x_pct, undefined)
    assert.match(logs.at(-1)!, /too much.*without a pointer/)
    assert.equal(calls, 2, 'a changed image is analysed again')
    await resolve()
    assert.equal(calls, 2, 'refusals are cached too')

    await fs.writeFile(image, await picture('green'))
    reply = new Error('offline')
    const [failed] = await resolve()
    assert.equal(failed!.target_x_pct, undefined)
    assert.match(logs.at(-1)!, /offline.*without a pointer/)
    reply = { subject: { source: 'grounding', box: [0.2, 0.3, 0.2, 0.4] } }
    const [retried] = await resolve()
    assert.ok(Math.abs(retried!.target_x_pct! - 30) < 1e-8)
    assert.equal(calls, 4, 'the failed call is retried and succeeds on the second call for this image')
    await resolve()
    assert.equal(calls, 4, 'the successful retry is cached')

    await fs.writeFile(image, await picture('white'))
    reply = { subject: null }
    await resolve()
    assert.match(logs.at(-1)!, /no target found.*without a pointer/)
  } finally {
    client._setVisionFetchForTesting(null)
  }
})
