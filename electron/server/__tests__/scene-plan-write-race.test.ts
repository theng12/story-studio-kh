/**
 * Two job types write one episode's `scene_plan.json`, and until v1.4.70 only
 * one of them took the lock `lib/atomic-store.ts` documents.
 *
 * WHY THIS IS REACHABLE, NOT THEORETICAL. Enqueue dedup is per (project,
 * episode, type), so it cannot help across types. `scene_plan_run` sits in
 * `LLM_TYPES` and shares the LLM group's budget; `prompt_director` is in NO
 * group set, so `groupOf` returns the type name and it gets its own
 * single-slot lane. Different lanes means both can be running at the same
 * instant on the SAME episode, and the Scene Review routes can write the same
 * file from an HTTP request while either of them is mid-flight.
 *
 * WHY ATOMIC WRITES WERE NOT ENOUGH. `writeJsonAtomic` guarantees a reader
 * never sees half a file. It says nothing about two read-modify-write cycles
 * that each read the same prior state: the second write is a complete,
 * perfectly-formed document that simply does not contain the first writer's
 * change. Atomicity and mutual exclusion are different properties, and this
 * file only fails on the second one.
 *
 * HOW THE OVERLAP IS FORCED. Not by sleeping. The mock GenStudio service holds
 * the submission response open (`pauseNextSubmitResponse`) and tells the test
 * the moment the request arrives. At that point Prompt Director has provably
 * already read the plan into memory and cannot proceed, so the competing write
 * lands strictly between its read and its write every single run. There is no
 * interleaving to get lucky with.
 */

import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import { MOCK_GENSTUDIO_FULL_KEY, startMockGenStudioService, type MockGenStudioService } from './fixtures/mock-genstudio-service.js'
import type { Job, ScenePlan } from '../models/types.js'

const EPISODE_ID = 'EP001'
const TITLE = 'Scene Plan Write Race'

let cleanup: () => Promise<void>
let app: any
let slug: string
let episodeDir: string
let planPath: string
let service: MockGenStudioService

function directorJob(): Job {
  return {
    job_id: 'scene-plan-write-race',
    project_slug: slug,
    type: 'prompt_director',
    status: 'running',
    episode_id: EPISODE_ID,
    title: TITLE,
    params: { episode_id: EPISODE_ID, title: TITLE, model: 'mock-chat-v1' },
    created_at: new Date().toISOString(),
    output_lines: [],
  } as unknown as Job
}

async function readPlan(): Promise<ScenePlan> {
  return JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
}

before(async () => {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  await fs.mkdir(path.join(temp.dir, 'projects'), { recursive: true })
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'

  app = (await import('../app.js')).app
  const project = await request(app).post('/api/projects').send({
    name: 'Scene Plan Write Race',
    episode_prefix: 'EP',
    episode_digits: 3,
  })
  assert.equal(project.status, 201)
  slug = project.body.slug

  service = await startMockGenStudioService()
  assert.equal((await request(app).put('/api/app-settings/genstudio').send({ url: service.baseUrl })).status, 200)
  assert.equal((await request(app).put('/api/app-settings/api-keys/genstudio').send({ apiKey: MOCK_GENSTUDIO_FULL_KEY })).status, 200)

  // Resolve exactly the way the generator does (`resolveEpisodePathsByCode`),
  // so the test and the code under test agree on which folder the episode is.
  const { resolveEpisodePathsByCode, resolveScenePlanPath } = await import('../services/utils.js')
  const paths = await resolveEpisodePathsByCode(slug, EPISODE_ID)
  episodeDir = paths.episode_dir
  await fs.mkdir(episodeDir, { recursive: true })
  planPath = await resolveScenePlanPath(slug, EPISODE_ID, episodeDir)
})

after(async () => {
  await service.close()
  await cleanup()
})

test('a concurrent locked writer\'s field survives a Prompt Director run on the same episode', async () => {
  service.reset()

  await fs.mkdir(path.dirname(planPath), { recursive: true })
  await fs.writeFile(planPath, JSON.stringify({
    episode_id: EPISODE_ID,
    generated_at: new Date().toISOString(),
    total_duration_sec: 20,
    planning_stage: 'visual',
    scenes: [
      {
        id: 'scene-1', scene_index: 1, start_sec: 0, end_sec: 10,
        transcript_segment: 'A quiet harbour at dawn.', visual_prompt: 'a harbour at dawn',
      },
      {
        id: 'scene-2', scene_index: 2, start_sec: 10, end_sec: 20,
        transcript_segment: 'The tide turns.', visual_prompt: 'the tide turning',
      },
    ],
  }, null, 2))

  await fs.writeFile(path.join(episodeDir, 'continuity.json'), JSON.stringify({
    anchor_character_ids: [],
    recipe: {
      enabled: true,
      mode: 'scene',
      directive: 'Frame the subject as a clean centrepiece.',
      guide_character_id: '',
      emotion_mode: 'auto',
      fixed_emotion: '',
    },
  }, null, 2))

  service.queueScenario('chat', {
    outputText: JSON.stringify({
      scenes: [
        { id: 'scene-1', prompt: 'COMPOSED harbour at dawn' },
        { id: 'scene-2', prompt: 'COMPOSED tide turning' },
      ],
    }),
  })

  const { runPromptDirectorJob } = await import('../generators/prompt-director.js')
  const { checkpointScenePrompt } = await import('../services/scene-prompt-checkpoint.js')

  // Hold the LLM submission open. `started` resolves only once the request has
  // reached the mock, which proves Prompt Director has already read the plan.
  const submission = service.pauseNextSubmitResponse()
  const directorRun = runPromptDirectorJob(directorJob())

  await submission.started

  // The competing writer. This one already does everything right: it takes the
  // documented lock and writes atomically. It still loses, which is the point.
  await checkpointScenePrompt(planPath, 'scene-2', 'A slow push-in on the water.', 'motion')

  const betweenReadAndWrite = await readPlan()
  assert.equal(
    betweenReadAndWrite.scenes.find(s => s.id === 'scene-2')?.motion_prompt,
    'A slow push-in on the water.',
    'the competing write must be durable on disk before Prompt Director resumes',
  )

  submission.release()
  await directorRun

  const final = await readPlan()
  const scene1 = final.scenes.find(s => s.id === 'scene-1')
  const scene2 = final.scenes.find(s => s.id === 'scene-2')

  // Prompt Director's own work must land.
  assert.equal(scene1?.visual_prompt, 'COMPOSED harbour at dawn')
  assert.equal(scene2?.visual_prompt, 'COMPOSED tide turning')

  // …and it must not have silently discarded the other writer's field.
  assert.equal(
    scene2?.motion_prompt,
    'A slow push-in on the water.',
    'Prompt Director overwrote the plan from a stale in-memory copy — the concurrent motion prompt was lost',
  )
})
