import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'sidecar-path-project'
const CODE = 'EP0011'

async function makeProjectWithRenamedEpisode() {
  const projDir = path.join(tmp.dir, 'projects', SLUG)
  const outputRoot = path.join(projDir, 'episodes')
  const seasonDir = path.join(outputRoot, 'Season 001')
  const staleDir = path.join(seasonDir, `${CODE} - Old Title`)
  const currentDir = path.join(seasonDir, `${CODE} - Current Title`)

  await fs.mkdir(staleDir, { recursive: true })
  await fs.mkdir(currentDir, { recursive: true })
  await fs.writeFile(path.join(projDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Sidecar Path Project',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }, null, 2))
  await fs.writeFile(path.join(projDir, 'ideas.json'), JSON.stringify({
    ideas: [{
      id: 'idea-0011',
      episode_code: CODE,
      title: 'Old Title',
      status: 'accepted',
    }],
    next_episode_number: 12,
    recycled_numbers: [],
  }, null, 2))
  await fs.writeFile(path.join(currentDir, 'scene_plan.json'), JSON.stringify({
    schema_version: 1,
    scenes: [{ id: 'scene-001', scene_index: 1 }],
  }, null, 2))

  return { staleDir, currentDir }
}

describe('episode sidecar path resolution', () => {
  before(async () => {
    tmp = await useTempDataDir()
  })

  after(async () => {
    await tmp.cleanup()
  })

  test('prefers same-code sibling folder that already has the requested sidecar', async () => {
    const { staleDir, currentDir } = await makeProjectWithRenamedEpisode()
    const utils = await import('../services/utils.js')

    const plain = await utils.resolveEpisodePathsByCode(SLUG, CODE)
    assert.equal(path.resolve(plain.episode_dir), path.resolve(staleDir))

    const withPlan = await utils.resolveEpisodePathsByCodeWithSidecar(SLUG, CODE, 'scene_plan.json')
    assert.equal(path.resolve(withPlan.episode_dir), path.resolve(currentDir))
    assert.equal(path.dirname(withPlan.subtitles_dir), path.resolve(currentDir))
    assert.equal(path.dirname(withPlan.metadata_json), path.join(currentDir, `${CODE} - 02 Metadata`))
  })
})
