/**
 * Gateway D6 — every job-creating request carries `job_group` (`<project-slug>/<episode-id|'project'>`)
 * taken from the running queue job, and nothing else about the request moves.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService } from './fixtures/mock-genstudio-service.js'
import { formatJobGroup } from '../lib/genstudio-client.js'
import type { JobType } from '../models/types.js'

test('formatJobGroup: slug/episode, project fallback, sanitised, capped, omitted without a slug', () => {
  assert.equal(formatJobGroup('my-show', 'EP0007'), 'my-show/EP0007')
  assert.equal(formatJobGroup('my-show', ''), 'my-show/project')
  assert.equal(formatJobGroup('my-show', undefined), 'my-show/project')
  assert.equal(formatJobGroup('Café Show!', 'EP 1/2'), 'Caf-Show-/EP-1-2')
  const long = formatJobGroup('a'.repeat(200), 'EP1')!
  assert.equal(long.length, 120)
  assert.match(long, /^[A-Za-z0-9._:/-]+$/)
  assert.equal(formatJobGroup('', 'EP1'), undefined)
  assert.equal(formatJobGroup(undefined, 'EP1'), undefined)
})

test('each job kind carries the running job group; outside a job the field is absent; keys are unchanged', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  const settings = await import('../services/app-settings.js')
  const previousUrl = await settings.getGenStudioUrl()
  const client = await import('../lib/genstudio-client.js')
  const jq = await import('../services/job-queue.js')
  const pm = await import('../services/project-manager.js')
  try {
    await settings.setGenStudioUrl(service.baseUrl)
    client.clearGenStudioCatalogCache()
    const project = await pm.createProject({ name: 'Group Show' })
    const audioFile = path.join(temp.dir, 'in.wav')
    await fs.writeFile(audioFile, Buffer.from('RIFF....WAVE'))
    const imageFile = path.join(temp.dir, 'in.png')
    await fs.writeFile(imageFile, Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKSQAAAABJRU5ErkJggg==', 'base64'))
    const key = MOCK_GENSTUDIO_FULL_KEY

    // One call per kind. Errors after the POST (artifact download etc.) are irrelevant to the request body.
    const calls: Record<string, () => Promise<unknown>> = {
      tts: () => client.generateTtsToFile(key, path.join(temp.dir, 'o.mp3'), {
        text: 'Hello there.', voiceId: 'mock-voice', modelId: 'mock-tts-model', maxInputCharacters: 5_000,
        speed: 1, requestIdentity: 'group:tts',
      } as any),
      image: () => client.generateImageWithGenStudio(key, {
        prompt: 'a lighthouse', modelId: 'mock-image-model', aspectRatio: '16:9', requestIdentity: 'group:image',
      } as any),
      music: () => client.generateMusicWithGenStudio(key, {
        title: 'T', prompt: 'slow strings', instrumental: true, modelId: 'mock-music-model', requestIdentity: 'group:music',
      }),
      chat: () => client.callChatWithGenStudio(key, {
        modelId: 'mock-chat-v1', system: 's', userMessage: 'u', requestIdentity: 'group:chat',
      } as any),
      transcription: () => client.transcribeWithGenStudio(key, {
        audioPath: audioFile, modelId: 'mock-transcription-model', requestIdentity: 'group:stt',
      } as any),
      video: () => client.generateVideoWithGenStudio(key, {
        prompt: 'a slow pan across the water', modelId: 'mock-video-model', sourceImagePath: imageFile, operation: 'image-to-video',
        durationSeconds: 5, resolution: '720p', requestIdentity: 'group:video',
      } as any),
    }
    const paths: Record<string, string> = {
      tts: '/v1/audio/jobs', image: '/v1/images/generations', music: '/v1/music/generations',
      chat: '/v1/chat/responses', // transcription: the quote only prices; the confirm creates the job
      transcription: '/confirm', video: '/v1/videos/generations',
    }
    const wasPaused = jq.isQueuePaused()
    const submissions = (kind: string) => service.requests.filter(r => r.method === 'POST' && r.path.includes(paths[kind]!))
    const fieldOf = (r: { bodyText: string }) => { try { return JSON.parse(r.bodyText).job_group } catch { return undefined } }

    // Outside any queue job: nothing is sent.
    const baseline: Record<string, string> = {}
    for (const [kind, call] of Object.entries(calls)) {
      service.requests.length = 0
      const err = await call().then(() => null, (e: unknown) => e)
      const sent = submissions(kind)
      assert.ok(sent.length >= 1, `${kind}: no request reached the Gateway outside a job: ${String(err)}`)
      for (const r of sent) assert.equal(fieldOf(r), undefined, `${kind}: job_group sent outside a job`)
      baseline[kind] = sent[0]!.idempotencyKey
      assert.equal(sent[0]!.bodyText.includes('job_group'), false)
    }

    // Inside real queue jobs: the group is the job's project + episode, keys identical to the baseline.
    const jobTypes: Record<string, JobType> = {
      tts: 'audio', image: 'scene_image_generate', music: 'music_generate',
      chat: 'expand_chapters', transcription: 'subtitles_transcribe', video: 'scene_clip_generate',
    }
    // Real episode codes are letters-then-digits (`storedEpisodeNumber`); the
    // queue refuses a fixture id no generator could resolve.
    const episodeCodes: Record<string, string> = {
      tts: 'EP1', image: 'EP2', music: '', chat: 'EP3', transcription: 'EP4', video: 'EP5',
    }
    for (const [kind, call] of Object.entries(calls)) {
      const episode = episodeCodes[kind]!
      const done = new Promise<void>(resolve => {
        jq.registerExecutor(jobTypes[kind]!, async () => { service.requests.length = 0; await call().catch(() => {}); resolve() })
      })
      await jq.enqueue({ project_slug: project.slug, type: jobTypes[kind]!, episode_id: episode, title: kind })
      await done
      const sent = submissions(kind)
      assert.ok(sent.length >= 1, `${kind}: no request inside a job`)
      for (const r of sent) {
        assert.equal(fieldOf(r), `${project.slug}/${episode || 'project'}`, `${kind}: wrong or missing job_group`)
        assert.equal(r.idempotencyKey, baseline[kind], `${kind}: idempotency key moved`)
      }
    }
    if (!wasPaused) await jq.setQueuePaused(false)
  } finally {
    await jq._waitForJobPersistenceForTesting()
    await settings.setGenStudioUrl(previousUrl).catch(() => {})
    client.clearGenStudioCatalogCache()
    await service.close()
    await temp.cleanup()
  }
})
