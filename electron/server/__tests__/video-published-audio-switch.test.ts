/**
 * The published `audio` switch, end to end through the motion lane.
 *
 * Measured 2026-09-27: Studio Hub 0.6.83 gave a local video lane an `audio` switch
 * (default on) and gateway-kh 0.2.60 relayed it on the video row as `controls`.
 * Story Studio's job is the middle of that chain — read the switch from what the
 * lane publishes, show it, carry the operator's choice on the request, and keep
 * the choice inside the request's identity so a retry cannot re-attach to the
 * other half of the switch.
 *
 * The rule these tests pin, in the order the request travels:
 *
 *   1. the transport carries the lane's switches and nothing else;
 *   2. the provider sends a value only for a switch the SELECTED model publishes;
 *   3. the generator records the choice in the request, the input hash and the
 *      idempotency key, and drops a value the model does not publish;
 *   4. the route refuses a value the model does not publish before anything is
 *      queued, and refuses a non-boolean outright;
 *   5. the page renders the switch from the published list, keeps it in the
 *      preset, and sends it only when the operator chose it.
 *
 * Everything runs against the in-process mock GenStudio service — zero network,
 * zero spend — and the assertions are on the submitted body, not on a helper's
 * return value.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { generateSceneClipJob } from '../generators/scene-clip.js'
import { publishedAudioChoice } from '../providers/video/genstudio.js'
import { publishedVideoControls } from '../lib/genstudio-client.js'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { tinyVideoBytes } from './fixtures/tiny-video.js'

const AUDIO_NOTE = 'the model generates picture and sound together, so this does not change generation time'

/** One published switch, in the shape the gateway relays it. */
function audioSwitch(publishedDefault: boolean | null = true) {
  return { name: 'audio', type: 'boolean', default: publishedDefault, note: AUDIO_NOTE }
}

async function createClipFixture(name: string, options: {
  controls?: Array<Record<string, unknown>>
  audio?: unknown
} = {}) {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  const pm = await import('../services/project-manager.js')
  const ideas = await import('../services/idea-manager.js')
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')

  service.setVideoModels([{
    id: 'mock-video-switch',
    display_name: 'Mock Video Switch',
    available: true,
    modes: ['image-to-video'],
    aspect_ratios: ['16:9'],
    generates_audio: true,
    ...(options.controls ? { controls: options.controls } : {}),
    variants: [{
      operation: 'image-to-video',
      duration_seconds: 1,
      resolution: '720p',
      credits_per_video: 10,
      minimum_credits: 10,
      price_version: 'mock-switch-v1',
    }],
  }])
  service.queueScenario('video', { videoArtifact: tinyVideoBytes() })
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()

  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: name,
    logline: 'Disposable audio-switch fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  assert.ok(idea)
  const accepted = await ideas.acceptIdea(project.slug, idea.id, false)
  const episodeId = accepted.episode_code
  const paths = await resolveEpisodePathsByCode(project.slug, episodeId)
  const imagePath = path.join(paths.episode_dir, 'scene-switch-source.png')
  await fs.writeFile(imagePath, Buffer.from('disposable-scene-image'))
  await fs.mkdir(paths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(path.join(paths.scene_prompts_dir, 'scene_plan.json'), JSON.stringify({ scenes: [{
    id: 'scene-switch',
    scene_index: 1,
    image_path: imagePath,
    motion_prompt: 'A slow push in over a silent harbour.',
    motion_choice: 'clip',
  }] }))

  const now = new Date().toISOString()
  return {
    temp,
    service,
    job: {
      job_id: `audio-switch-${Math.random().toString(16).slice(2)}`,
      project_slug: project.slug,
      episode_id: episodeId,
      type: 'scene_clip_generate',
      title: 'audio switch test',
      status: 'running',
      created_at: now,
      started_at: now,
      finished_at: null,
      error: null,
      output_lines: [],
      progress: 0,
      params: {
        episode_id: episodeId,
        scene_id: 'scene-switch',
        model: 'mock-video-switch',
        aspect_ratio: '16:9',
        operation: 'image-to-video',
        duration_seconds: 1,
        resolution: '720p',
        ...(options.audio === undefined ? {} : { audio: options.audio }),
      },
    } as any,
  }
}

// ── 1. The transport ─────────────────────────────────────────────────────

test('the transport reads only boolean switches, and keeps the lane\'s own default and note', () => {
  assert.deepEqual(publishedVideoControls([audioSwitch()]), [{
    name: 'audio', type: 'boolean', default: true, note: AUDIO_NOTE,
  }])
  // A lane that stated no default carries `null` rather than an invented one, and a
  // published name is the only thing a caller can key a value by.
  assert.deepEqual(publishedVideoControls([{ name: 'audio', type: 'boolean' }]), [
    { name: 'audio', type: 'boolean', default: null, note: null },
  ])
  assert.deepEqual(publishedVideoControls([
    { name: 'seed', type: 'integer', default: -1 },
    { type: 'boolean', default: true },
    { name: '  ', type: 'boolean', default: true },
    { name: 'quality', type: 'string', default: 'high' },
  ]), [])
  // Not a list at all — an older catalogue — is no switches, never a crash.
  assert.deepEqual(publishedVideoControls(undefined), [])
  assert.deepEqual(publishedVideoControls({ name: 'audio' }), [])
})

// ── 2. The provider ──────────────────────────────────────────────────────

test('the provider sends the switch only for a model that publishes it', () => {
  const published = { controls: [audioSwitch()] } as any
  const unpublished = { controls: [] } as any
  // `false` is the value the switch exists for, and it must survive intact.
  assert.equal(publishedAudioChoice(published, { audio: false }), false)
  assert.equal(publishedAudioChoice(published, { audio: true }), true)
  // Nothing stated stays nothing: the lane's own default decides.
  assert.equal(publishedAudioChoice(published, {}), undefined)
  assert.equal(publishedAudioChoice(published, undefined), undefined)
  // A model that publishes no switch gets no field, whatever the caller sent.
  assert.equal(publishedAudioChoice(unpublished, { audio: false }), undefined)
  // A string is not a boolean, so it is not a request either.
  assert.equal(publishedAudioChoice(published, { audio: 'false' }), undefined)
})

// ── 3. The generator, on the wire ────────────────────────────────────────

test('a silent clip request is submitted as silent', async () => {
  const fixture = await createClipFixture('Silent clip request', {
    controls: [audioSwitch()],
    audio: false,
  })
  try {
    await generateSceneClipJob(fixture.job)

    const submissions = fixture.service.submissions.filter(entry => entry.operation === 'video' && !entry.replay)
    assert.equal(submissions.length, 1, 'exactly one paid submission')
    assert.equal(submissions[0]?.parsedBody?.audio, false,
      'the OFF half of the switch is what the operator asked for and what must reach the lane')
  } finally {
    await fixture.service.close()
    await fixture.temp.cleanup()
  }
})

test('a model that publishes no switch never receives one, and says so in the job log', async () => {
  const fixture = await createClipFixture('Unpublished switch', { audio: false })
  try {
    await generateSceneClipJob(fixture.job)

    const submissions = fixture.service.submissions.filter(entry => entry.operation === 'video' && !entry.replay)
    assert.equal(submissions.length, 1)
    assert.equal('audio' in (submissions[0]?.parsedBody || {}), false,
      'a lane that publishes no switch must not be sent one')
    assert.ok(
      fixture.job.output_lines.some((line: string) => /publishes no audio switch/.test(line)),
      'and the drop is recorded rather than silent',
    )
  } finally {
    await fixture.service.close()
    await fixture.temp.cleanup()
  }
})

test('the switch changes the idempotency key, not just the body', async () => {
  // One fixture at a time: a temp data dir is process-wide state, so the two runs are
  // sequential and each is closed before the next fixture exists.
  const runWith = async (name: string, audio: boolean): Promise<string> => {
    const fixture = await createClipFixture(name, { controls: [audioSwitch()], audio })
    try {
      await generateSceneClipJob(fixture.job)
      const key = fixture.job.output_lines
        .map((line: string) => /GenStudio request: scene-switch -> (story-video-\S+)/.exec(line)?.[1])
        .find(Boolean)
      assert.ok(key, `the run must log the key it submitted (${fixture.job.output_lines.join(' | ')})`)
      return key
    } finally {
      await fixture.service.close()
      await fixture.temp.cleanup()
    }
  }
  const on = await runWith('Switch on', true)
  const off = await runWith('Switch off', false)
  assert.notEqual(on, off,
    'the two halves of a published switch are two different purchases and must not share a key')
})

// ── 4. The route ─────────────────────────────────────────────────────────

test('the route refuses an unpublished switch and a non-boolean, before anything is queued', () => {
  const route = readFileSync(new URL('../routes/scene-review.ts', import.meta.url), 'utf8')
  // Every enqueue path resolves the switch against the row it priced, through one helper.
  const calls = route.match(/requestedSceneClipAudio\(body, selected\.model\)/g) || []
  assert.ok(calls.length >= 4, `every clip lane must resolve the switch (found ${calls.length})`)
  assert.match(route, /publishes no audio switch/)
  assert.match(route, /audio must be true or false when it is sent/)
})

// ── 5. The page ──────────────────────────────────────────────────────────

test('the page renders the switch from the published list and presets it', () => {
  const page = readFileSync(
    new URL('../../../frontend/pages/projects/[slug]/motion-review.vue', import.meta.url),
    'utf8',
  )
  assert.match(page, /v-for="control in selectedVideoControls"/)
  assert.match(page, /control\.note/)
  // The choice is a reusable setting, so it travels in the preset — and is restored
  // whole, so a preset that stored none cannot inherit the previous one's choice.
  assert.match(page, /switches: \{ \.\.\.switchChoices\.value \}/)
  assert.match(page, /switchChoices\.value = Object\.fromEntries/)
  // Only a chosen switch travels on the request.
  assert.match(page, /typeof chosenAudio === 'boolean' \? \{ audio: chosenAudio \} : \{\}/)
  // The lane's own sentence is what is shown about the switch, and the silent case
  // says the run is not cheaper or faster rather than implying a saving.
  assert.match(page, /SILENT_CLIP_NOTICE/)
  assert.match(page, /not cheaper and not faster/)
})
