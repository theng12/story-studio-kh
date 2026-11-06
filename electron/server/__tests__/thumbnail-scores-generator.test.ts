/**
 * The thumbnail-scoring job (owner, 2026-11-01).
 *
 * A thumbnail list that could not be READ is not "this episode has no
 * artwork". The job stays optional — it never throws and never holds an
 * upload — but its log and result say which of the two happened (AGENTS §6/§8).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'

await useTempDataDir()

const { generateThumbnailScores } = await import('../generators/thumbnail-scores.js')
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const { resolveEpisodePaths } = await import('../services/utils.js')

let counter = 0

async function seededEpisode(name: string): Promise<{ slug: string; episodeCode: string; thumbDir: string }> {
  const project = await pm.createProject({ name: `${name} ${++counter}` })
  const [idea] = await im.addIdeas(project.slug, [{
    title: 'The Lighthouse at Dawn', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const episodeCode = accepted.idea.episode_code!
  const paths = await resolveEpisodePaths(project.slug, episodeCode, accepted.idea.title)
  await fs.mkdir(paths.thumb_dir, { recursive: true })
  return { slug: project.slug, episodeCode, thumbDir: paths.thumb_dir }
}

function jobFor(slug: string, episodeCode: string): any {
  return {
    job_id: `thumbnail-score-${++counter}`, project_slug: slug, type: 'thumbnail_score',
    episode_id: episodeCode, title: 'Thumbnail scores', status: 'running',
    created_at: new Date().toISOString(), started_at: new Date().toISOString(),
    finished_at: null, error: null, output_lines: [], params: {},
  }
}

test('an unreadable thumbnail folder is a read failure, never "no artwork"', async () => {
  const { slug, episodeCode, thumbDir } = await seededEpisode('Scoring Read Failure')
  // A FILE where the folder should be makes the real readdir fail (ENOTDIR).
  await fs.rename(thumbDir, `${thumbDir}.empty-fixture`)
  await fs.writeFile(thumbDir, 'not a folder')

  const job = jobFor(slug, episodeCode)
  await generateThumbnailScores(job) // must not throw — optional, never blocks

  const log = job.output_lines.join('\n')
  assert.match(log, /could not be read/)
  assert.doesNotMatch(log, /no thumbnail artwork/)
  assert.equal(job.result?.not_scored, true)
  assert.ok(String(job.result?.not_scored_reason || '').length > 0, 'the result names the reason')
})

test('an empty thumbnail folder still says there is no artwork', async () => {
  const { slug, episodeCode } = await seededEpisode('Scoring Empty Folder')
  const job = jobFor(slug, episodeCode)
  await generateThumbnailScores(job)

  assert.match(job.output_lines.join('\n'), /no thumbnail artwork/)
  assert.equal(job.result, undefined, 'nothing was scored — no result is claimed')
})
