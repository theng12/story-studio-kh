/**
 * The ✕ on a subtitle file used to `unlink` it: one click, no undo, and a transcript can cost a
 * transcription to remake. It now moves to the project's `_trash` (2026-10-03 audio audit).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

void test('deleting a subtitle file moves it to the project trash instead of destroying it', async () => {
  const isolated = await useTempDataDir()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const app = (await import('../app.js')).app
    const pm = await import('../services/project-manager.js')
    const ideas = await import('../services/idea-manager.js')
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const project = await pm.createProject({ name: 'Subtitle trash fixture', episode_prefix: 'EP', episode_digits: 4 })
    const [idea] = await ideas.addIdeas(project.slug, [{
      title: 'One chapter', logline: 'Fixture.', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm',
    }], 'mock-chat-v1')
    const { episode_code: code } = await ideas.acceptIdea(project.slug, idea!.id, false)
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(paths.subtitles_dir, { recursive: true })
    const name = `${code}_Chapter_01.srt`
    await fs.writeFile(path.join(paths.subtitles_dir, name), '1\n00:00:00,000 --> 00:00:01,000\nHello\n')

    const res = await request(app).delete(`/api/projects/${project.slug}/video-editor/subtitles/${code}/${name}`)
    assert.equal(res.status, 200, JSON.stringify(res.body))
    assert.ok(!res.body.existing_srts.some((row: any) => row.filename === name))
    await assert.rejects(fs.access(path.join(paths.subtitles_dir, name)))
    const kept = await fs.readFile(path.join(path.dirname(pm.getProjectDir(project.slug)!), '_trash', path.basename(pm.getProjectDir(project.slug)!), code, 'subtitles', name), 'utf8')
    assert.match(kept, /Hello/)

    const again = await request(app).delete(`/api/projects/${project.slug}/video-editor/subtitles/${code}/${name}`)
    assert.equal(again.status, 404)
  } finally {
    await isolated.cleanup()
  }
})
