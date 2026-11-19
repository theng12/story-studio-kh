/**
 * A preview must never hand back a silently empty description for an episode that has one
 * (angkor 2026-11-19: same request, "" once and 881 characters the next time, HTTP 200 both ways
 * and nothing in the log).
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

async function episode(name: string, code: string) {
  const { createProject } = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await createProject({ name })
  await fs.writeFile(path.join(dataDir, 'projects', project.slug, 'ideas.json'), JSON.stringify({
    ideas: [{ id: 'idea-1', episode_code: code, title: 'Episode', status: 'accepted' }],
    next_episode_number: 2,
    recycled_numbers: [],
  }))
  const paths = await resolveEpisodePaths(project.slug, code, 'Episode')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  return { project, paths }
}

test('a metadata file that exists but does not parse fails loudly instead of reading as empty', async () => {
  const { project, paths } = await episode('Truncated Metadata', 'EP0001')
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')
  await fs.writeFile(paths.metadata_json, '{"title":"Generated","description":"A real sentence about')
  await assert.rejects(
    resolveUploadMetadata({ slug: project.slug, episode_code: 'EP0001', fallback_title: 'Episode', platform: 'youtube' }),
    /saved metadata could not be read .*looks half-written or damaged/,
  )
})
