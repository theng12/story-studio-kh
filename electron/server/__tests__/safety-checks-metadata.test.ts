/**
 * 1.4.300 — the "Chapter marks before the description" safety check in the YouTube Finalizer.
 * Block refuses before any model call (as before); Off/Warn write the description without chapter marks.
 * No model is called: the edited package is preserved, so only the deterministic finalizer runs.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'

let temp: { dir: string; cleanup: () => Promise<void> }
let slug = ''
const CODE = 'EP0001'
const TITLE = 'Lantern Harbour'

before(async () => {
  temp = await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  slug = (await pm.createProject({ name: 'Chapter Marks', episode_prefix: 'EP', episode_digits: 4 })).slug
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const paths = await resolveEpisodePaths(slug, CODE, TITLE)
  const narration = paths.narration_docx.replace(/\.docx$/i, '.md')
  await fs.mkdir(path.dirname(narration), { recursive: true })
  await fs.writeFile(narration, 'The lantern keeper walks the harbour wall as the tide turns.')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
})
after(async () => { await temp.cleanup() })

const job = (): any => ({
  job_id: `meta-${Math.random().toString(16).slice(2)}`, project_slug: slug, episode_id: CODE, output_lines: [] as string[],
  params: {
    episode_id: CODE, title: TITLE, model: 'test-model',
    existing_package: { title: TITLE, description: 'A calm walk along the harbour wall.', tags: ['harbour', 'sleep'] },
  },
})

test('chapter marks Block: no Audio Assembly refuses before any model call, as before', async () => {
  const pm = await import('../services/project-manager.js')
  await pm.updateConfig(slug, { safety_checks: { chapter_marks: 'block' } } as any)
  const { generateMetadata } = await import('../generators/metadata.js')
  await assert.rejects(generateMetadata(job()), (error: any) => error.code === 'YOUTUBE_FINALIZER_AUDIO_REQUIRED')
})

test('chapter marks Warn: the description is written without chapter marks, with a warning', async () => {
  const pm = await import('../services/project-manager.js')
  await pm.updateConfig(slug, { safety_checks: { chapter_marks: 'warn' } } as any)
  const { generateMetadata } = await import('../generators/metadata.js')
  const run = job()
  await generateMetadata(run)
  assert.equal(run.result?.safety_warnings?.[0]?.check, 'chapter_marks')
  const saved = JSON.parse(await fs.readFile(path.join(run.output_dir, `${CODE}_Metadata.json`), 'utf8'))
  assert.equal(saved.description.includes('youtube:chapters'), false)
  assert.match(saved.description, /A calm walk along the harbour wall\./)
  assert.equal(saved.youtube_finalization.chapter_count, 0)
})
