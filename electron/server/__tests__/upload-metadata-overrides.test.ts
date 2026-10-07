/**
 * A bad upload_metadata_overrides.json is surfaced, not swallowed (2026-10-07).
 * Swallowing it uploaded the generated title and description in place of the
 * ones the owner typed, with no word that his edits were ignored.
 */
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { useTempDataDir } from './_helpers.js'

let cleanup: () => Promise<void>
let dataDir = ''
before(async () => { const temp = await useTempDataDir(); cleanup = temp.cleanup; dataDir = temp.dir })
after(async () => { await cleanup() })

test('an unreadable overrides file stops metadata resolution with a plain message', async () => {
  const { createProject } = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')
  const project = await createProject({ name: 'Overrides Surface' })
  await fs.writeFile(path.join(dataDir, 'projects', project.slug, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: 'EP0001', title: 'Episode', status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await resolveEpisodePaths(project.slug, 'EP0001', 'Episode')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({ title: 'Generated', description: 'Generated.', tags: ['a'] }))

  await fs.writeFile(path.join(paths.episode_dir, 'upload_metadata_overrides.json'), JSON.stringify({ youtube: { title: 'Typed by hand' } }))
  const good = await resolveUploadMetadata({ slug: project.slug, episode_code: 'EP0001', fallback_title: 'Episode', platform: 'youtube' })
  assert.equal(good.title, 'Typed by hand')

  await fs.writeFile(path.join(paths.episode_dir, 'upload_metadata_overrides.json'), '{ "youtube": { "title": ')
  await assert.rejects(
    resolveUploadMetadata({ slug: project.slug, episode_code: 'EP0001', fallback_title: 'Episode', platform: 'youtube' }),
    /EP0001's upload_metadata_overrides\.json could not be read .*Fix or remove that file/,
  )
})
