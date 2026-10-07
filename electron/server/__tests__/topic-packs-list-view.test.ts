import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let app: express.Express
let tpl: typeof import('../services/topic-pack-loader.js')
let writeJsonAtomic: typeof import('../lib/atomic-store.js')['writeJsonAtomic']

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  tpl = await import('../services/topic-pack-loader.js')
  ;({ writeJsonAtomic } = await import('../lib/atomic-store.js'))
  const { router } = await import('../routes/niches.js')
  app = express().use(express.json()).use('/api', router)
})
after(async () => { await cleanup() })

// S9: the pickers read a slim list; the full pack stays one GET away.
test('GET /topic-packs?view=list drops generation inventories and coverage tuples, keeping counts', async () => {
  const pack = {
    id: 'deep-time', name: 'Deep Time', description: 'd', builtin: false, schemaVersion: 1,
    compatibleNicheIds: [], subjects: ['Taung child'], tags: ['science'],
    ideaAxes: [{ id: 'era', label: 'Era', values: ['Pliocene'] }],
    mechanisms: ['m'.repeat(500)], evidenceLenses: ['e'], episodeObjects: ['o'], timePlaceScopes: ['t'],
    coverageProfiles: [{ id: 'p1', label: 'Profile', tuples: [{ a: 1 }, { a: 2 }, { a: 3 }] }],
  }
  await tpl.ensureTopicPacksDir()
  await writeJsonAtomic(tpl.topicPackFilePath(pack.id), pack)
  tpl.invalidateTopicPackCache(pack.id)

  const full = (await request(app).get('/api/topic-packs').expect(200)).body.topic_packs.find((p: any) => p.id === pack.id)
  const slim = (await request(app).get('/api/topic-packs?view=list').expect(200)).body.topic_packs.find((p: any) => p.id === pack.id)
  assert.ok(full, 'the fixture pack is listed')
  assert.equal(full.coverageProfiles?.[0]?.tuples?.length, 3, 'the default view is unchanged')
  assert.deepEqual(slim.coverageProfiles, [{ id: 'p1', label: 'Profile', tuple_count: 3 }])
  for (const field of ['mechanisms', 'evidenceLenses', 'episodeObjects', 'timePlaceScopes']) assert.equal(slim[field], undefined, field)
  assert.deepEqual(slim.subjects, ['Taung child'])
  assert.deepEqual(slim.ideaAxes, pack.ideaAxes)
  assert.ok(slim.catalog, 'catalog metadata is still attached')
})
