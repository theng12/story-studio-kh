import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import express from 'express'
import request from 'supertest'
import { router, sketchRevealSample } from '../routes/sketch-reveal-samples.js'
import { SKETCH_REVEAL_TYPES } from '../lib/sketch-reveal.js'
import type { SketchDrawJob } from '../lib/native-scene-clip.js'

test('catalog follows the native engine and rejects unknown sample requests', async () => {
  const app = express().use(router)
  const list = await request(app).get('/sketch-reveals').expect(200)
  assert.deepEqual(list.body.reveals.map((item: { id: string }) => item.id), [...SKETCH_REVEAL_TYPES])
  assert.ok(list.body.reveals.every((item: { label: string }) => item.label))
  await request(app).get('/sketch-reveals/no-such-reveal/sample?weight=normal').expect(400)
  await request(app).get('/sketch-reveals/line/sample?weight=heavy').expect(400)
})

test('a cached sample is served by the video route', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-route-test-'))
  const oldDataDir = process.env.STORY_STUDIO_DATA_DIR
  try {
    process.env.STORY_STUDIO_DATA_DIR = dir
    const image = fileURLToPath(new URL('../effects-gallery/sample-river.jpg', import.meta.url))
    await sketchRevealSample({ reveal: 'line', weight: 'normal', image, cacheDir: path.join(dir, 'sketch-reveal-samples'), render: async job => { await fs.writeFile(job.output, 'sample video') } })
    const response = await request(express().use(router)).get('/sketch-reveals/line/sample?weight=normal').expect(200)
    assert.match(response.headers['content-type'], /video\/mp4/)
    assert.equal(response.body.toString(), 'sample video')
  } finally {
    if (oldDataDir === undefined) delete process.env.STORY_STUDIO_DATA_DIR
    else process.env.STORY_STUDIO_DATA_DIR = oldDataDir
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('samples share native work and cache separately by reveal, weight, helper and image', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reveal-sample-test-'))
  try {
    const image = path.join(dir, 'sample.jpg')
    await fs.writeFile(image, 'image one')
    const jobs: SketchDrawJob[] = []
    const render = async (job: SketchDrawJob) => { jobs.push(job); await fs.writeFile(job.output, 'video') }
    const base = { reveal: 'line' as const, weight: 'normal' as const, image, cacheDir: path.join(dir, 'cache'), render, helperVersion: 7 }
    const [first, same] = await Promise.all([sketchRevealSample(base), sketchRevealSample(base)])
    assert.equal(first, same)
    assert.equal(jobs.length, 1)
    assert.deepEqual([jobs[0].reveal, jobs[0].line_weight, jobs[0].frames], ['line', 'normal', 60])
    assert.equal(await sketchRevealSample(base), first)
    assert.notEqual(await sketchRevealSample({ ...base, weight: 'bold' }), first)
    assert.notEqual(await sketchRevealSample({ ...base, reveal: 'bloom' }), first)
    assert.notEqual(await sketchRevealSample({ ...base, helperVersion: 8 }), first)
    await fs.writeFile(image, 'image two')
    assert.notEqual(await sketchRevealSample(base), first)
    assert.equal(jobs.length, 5)
    await assert.rejects(sketchRevealSample({ ...base, weight: 'thin', render: async () => { throw new Error('helper failed') } }), /helper failed/)
    assert.ok(await sketchRevealSample({ ...base, weight: 'thin' }))
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
