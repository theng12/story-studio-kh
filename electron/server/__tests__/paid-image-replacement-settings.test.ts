/**
 * Machine-local paid image replacement policy.
 *
 * This deliberately exercises the app-setting store, the flat route, the
 * async queue boundary, and the real preset composable.  A paid recovery
 * authorisation must never become project or preset data merely because a
 * machine setting changed.
 */

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

let temp: Awaited<ReturnType<typeof useTempDataDir>>
let app: express.Express

before(async () => {
  temp = await useTempDataDir()
  const { router } = await import('../routes/app-settings.js')
  app = express()
  app.use(express.json())
  app.use(router)
})

after(async () => {
  await temp.cleanup()
})

test('paid image replacement defaults, validates exactly, and exposes only the flat machine route', async () => {
  const queue = await import('../services/job-queue.js')
  const jobsBefore = queue.getQueueStats().total
  await request(app)
    .get('/app-settings/paid-image-replacement')
    .expect(200, { enabled: false, additional_credit_ceiling: null })

  await request(app)
    .put('/app-settings/paid-image-replacement')
    .send({ enabled: true, additional_credit_ceiling: 50 })
    .expect(200, { enabled: true, additional_credit_ceiling: 50 })

  const beforeInvalid = await request(app)
    .get('/app-settings/paid-image-replacement')
    .expect(200)

  const priorError = console.error
  try {
    console.error = () => undefined
    for (const body of [
      { enabled: true, additional_credit_ceiling: 0 },
      { enabled: true, additional_credit_ceiling: -1 },
      { enabled: true, additional_credit_ceiling: 1.5 },
      { enabled: true, additional_credit_ceiling: '50' },
      { enabled: true, additional_credit_ceiling: Number.MAX_SAFE_INTEGER + 1 },
      { paid_image_replacement: { enabled: true, additional_credit_ceiling: 50 } },
      { settings: { enabled: true, additional_credit_ceiling: 50 } },
      { enabled: true, additional_credit_ceiling: 50, wait_minutes: 0 },
      { enabled: true, additional_credit_ceiling: 50, max_replacements_per_asset: 99 },
    ]) {
      const rejected = await request(app)
        .put('/app-settings/paid-image-replacement')
        .send(body)
      assert.equal(rejected.status, 400)
      assert.deepEqual(
        (await request(app).get('/app-settings/paid-image-replacement')).body,
        beforeInvalid.body,
        'a rejected write must preserve the prior valid machine setting',
      )
    }
  } finally {
    console.error = priorError
  }

  await request(app).get('/app-settings/recovery').expect(404)
  assert.equal(queue.getQueueStats().total, jobsBefore, 'the setting route must not enqueue, retry, or cancel work')

  const settings = await import('../services/app-settings.js')
  for (const value of [NaN, Infinity, -Infinity]) {
    await assert.rejects(
      () => settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: value }),
      /positive safe whole number/i,
    )
  }

  await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: 50 })
  assert.deepEqual(
    await settings.getPaidImageReplacementSetting(),
    { enabled: false, additional_credit_ceiling: 50 },
    'disabling may retain an already-valid ceiling',
  )

  await fs.writeFile(
    path.join(temp.dir, 'app-settings.json'),
    JSON.stringify({ paid_image_replacement: { enabled: true, additional_credit_ceiling: 'not-a-number' } }),
  )
  assert.deepEqual(
    await settings.getPaidImageReplacementSetting(),
    { enabled: false, additional_credit_ceiling: null },
    'absent or malformed storage must fail closed to the exact off default',
  )
})

test('only supported image enqueue snapshots the machine policy outside request params', async () => {
  const settings = await import('../services/app-settings.js')
  const queue = await import('../services/job-queue.js')
  const projects = await import('../services/project-manager.js')
  await queue.setQueuePaused(true)
  await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 50 })

  const project = await projects.createProject({ name: 'Paid policy snapshot boundary' })
  const serverSnapshot = async (type: any, episode: string) => queue.enqueue({
    project_slug: project.slug,
    type,
    episode_id: episode,
    title: type,
    params: { paid_image_replacement: { enabled: false, additional_credit_ceiling: 1 } },
  })

  for (const [index, type] of ['continuity_render', 'image_pool_generate', 'thumb_images'].entries()) {
    const job = await serverSnapshot(type, `SUPPORTED-${index}`)
    assert.deepEqual(job.params.paid_image_replacement, { enabled: false, additional_credit_ceiling: 1 })
    assert.equal(job.paid_image_replacement?.enabled, true)
    assert.equal(job.paid_image_replacement?.additional_credit_ceiling, 50)
    assert.equal(job.paid_image_replacement?.wait_minutes, 30)
    assert.equal(job.paid_image_replacement?.max_replacements_per_asset, 1)
    assert.match(job.paid_image_replacement?.snapshotted_at || '', /^\d{4}-\d{2}-\d{2}T/)
  }

  await settings.setPaidImageReplacementSetting({ enabled: false, additional_credit_ceiling: null })
  const disabled = await serverSnapshot('continuity_render', 'SUPPORTED-OFF')
  assert.equal(disabled.paid_image_replacement?.enabled, false)
  assert.equal(disabled.paid_image_replacement?.additional_credit_ceiling, null)

  for (const [index, type] of ['audio', 'subtitles_transcribe', 'music_generate', 'video', 'broll_normalize', 'image_prompts'].entries()) {
    const job = await serverSnapshot(type, `UNSUPPORTED-${index}`)
    assert.equal(job.paid_image_replacement, undefined, `${type} must never receive the paid image policy`)
  }
})

test('machine setting and eligible enqueue leave project and preset bytes unchanged', async () => {
  const settings = await import('../services/app-settings.js')
  const queue = await import('../services/job-queue.js')
  const projects = await import('../services/project-manager.js')
  const project = await projects.createProject({ name: 'Paid policy bytes' })
  const projectDir = path.join(temp.dir, 'projects', project.slug)
  const configPath = path.join(projectDir, 'config.json')
  const generatorPresetPath = path.join(projectDir, 'generator-presets.json')
  const pipelinePresetPath = path.join(projectDir, 'pipeline-presets.json')
  await fs.writeFile(configPath, '{\n  "keep" : "project-bytes"\n}\n')
  await fs.writeFile(generatorPresetPath, '{ "generator" : [ 1, 2 ] }\n')
  await fs.writeFile(pipelinePresetPath, '{\n"pipeline" : { "name" : "keep" }\n}\n')
  const before = await Promise.all([configPath, generatorPresetPath, pipelinePresetPath].map(file => fs.readFile(file)))

  await settings.setPaidImageReplacementSetting({ enabled: true, additional_credit_ceiling: 50 })
  await queue.enqueue({
    project_slug: project.slug,
    type: 'continuity_render',
    episode_id: 'BYTES',
    title: 'eligible image job',
    params: {},
  })

  const after = await Promise.all([configPath, generatorPresetPath, pipelinePresetPath].map(file => fs.readFile(file)))
  for (const [index, label] of ['project config', 'generator preset', 'pipeline preset'].entries()) {
    assert.equal(Buffer.compare(before[index], after[index]), 0, `${label} must remain byte-identical`)
  }
})

test('real usePresets save/apply payloads are identical with the machine policy off or on', async () => {
  const settings = await import('../services/app-settings.js')
  // Keep frontend-only Nuxt types out of the Electron TypeScript program while
  // still exercising the real composable at test runtime.
  const frontendComposables = path.resolve(process.cwd(), '..', 'frontend', 'composables')
  const { _markBootReadyForTests } = await import(path.join(frontendComposables, 'useApi.js')) as any
  _markBootReadyForTests()
  const { usePresets } = await import(path.join(frontendComposables, 'usePresets.js')) as any

  const runFixture = async (enabled: boolean): Promise<{ project: Buffer; preset: Buffer; payloads: unknown[] }> => {
    await settings.setPaidImageReplacementSetting({ enabled, additional_credit_ceiling: enabled ? 50 : null })
    const store: Record<string, any> = {
      fixture: {
        script_presets: [{ id: 'saved', name: 'Saved', data: { model: 'image-model', style: 'old' } }],
        script_last_preset: 'saved',
      },
    }
    const payloads: unknown[] = []
    ;(globalThis as any).$fetch = async (url: string, options: any = {}) => {
      assert.equal(url, '/api/projects/fixture/settings/config')
      if (!options.method || options.method === 'GET') return structuredClone(store.fixture)
      assert.equal(options.method, 'PUT')
      payloads.push(structuredClone(options.body))
      Object.assign(store.fixture, structuredClone(options.body))
      return { ok: true }
    }

    const form: Record<string, unknown> = { model: '', style: '' }
    const controller = usePresets({
      slug: 'fixture',
      configKey: 'script',
      snapshot: () => ({ ...form }),
      apply: (value: Record<string, unknown>) => Object.assign(form, value),
    })
    await controller.load()
    controller.applyActive()
    form.style = 'new'
    await controller.overwrite()
    return {
      project: Buffer.from(JSON.stringify(store.fixture)),
      preset: Buffer.from(JSON.stringify(store.fixture.script_presets)),
      payloads,
    }
  }

  const off = await runFixture(false)
  const on = await runFixture(true)
  assert.equal(Buffer.compare(off.preset, on.preset), 0, 'preset save bytes must not depend on the machine policy')
  assert.equal(Buffer.compare(off.project, on.project), 0, 'project save bytes must not depend on the machine policy')
  for (const payload of [...off.payloads, ...on.payloads]) {
    assert.equal(JSON.stringify(payload).includes('paid_image_replacement'), false, 'preset save/apply payloads must carry no paid policy')
  }
})
