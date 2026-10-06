/**
 * The episode list keeps each row's visual source and local-media cleanup
 * summary on the cached status row (1.4.257). On the owner's 405-episode
 * channel those reads resolved three sidecars per episode on every list read.
 * Pinned: a warm list does not re-read them, and Story's own writes to them
 * still show on the very next read.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, test } from 'node:test'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

const temp = await useTempDataDir()
const pm = await import('../services/project-manager.js')
const im = await import('../services/idea-manager.js')
const { resolveEpisodePaths } = await import('../services/utils.js')
const { setVideoVisualSource } = await import('../services/video-visual-source.js')
const { stopAllWatchers, bindInvalidator } = await import('../services/episode-folder-watcher.js')
const { router } = await import('../routes/ideas.js')
after(async () => { stopAllWatchers(); await temp.cleanup() })

test('a warm list serves cached row reads, and a visual-source switch shows at once', async () => {
  const project = await pm.createProject({ name: 'Row Reads' })
  const [idea] = await im.addIdeas(project.slug, [{ title: 'First', logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: 'calm' }], 'test')
  await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', 'First')
  await fs.mkdir(paths.script_dir, { recursive: true })
  await fs.writeFile(path.join(paths.script_dir, 'EP0001_Script_Narration.md'), 'Once.')
  const app = express().use(express.json()).use(router)
  const list = async () => (await request(app).get(`/projects/${project.slug}/episodes`).expect(200)).body[0]

  assert.equal((await list()).visual_source, 'scene_plan')
  const read = fs.readFile.bind(fs)
  const sidecarReads: string[] = []
  const spy = (fs as any).readFile = async (file: any, ...args: any[]) => {
    if (/broll-selection\.json$|local_media_cleanup\.json$/.test(String(file))) sidecarReads.push(path.basename(String(file)))
    return (read as any)(file, ...args)
  }
  try {
    const warm = await list()
    assert.equal(warm.visual_source, 'scene_plan')
    assert.equal(warm.local_media_status.state, 'available')
    assert.deepEqual(sidecarReads, [], 'a warm list must not re-read the row sidecars')
  } finally {
    if ((fs as any).readFile === spy) (fs as any).readFile = read
  }

  // Deaf watcher: the switch must invalidate the row itself, not rely on an event.
  bindInvalidator(() => {})
  await setVideoVisualSource(project.slug, 'EP0001', 'image_pool')
  assert.equal((await list()).visual_source, 'image_pool', 'Story\'s own switch reaches the list on the next read')
})
