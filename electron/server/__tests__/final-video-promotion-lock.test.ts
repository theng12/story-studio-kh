import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'

let pm: typeof import('../services/project-manager.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

const SLUG = 'final-promotion-lock'
const TITLE = 'Final promotion lock'

async function makeProject(): Promise<void> {
  const projectDir = path.join(pm.projectsRoot(), SLUG)
  await fs.mkdir(projectDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG, name: TITLE,
    episode_prefix: 'EP', episode_digits: 4,
    season_size: 20, season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
    subfolder_names: DEFAULT_SUBFOLDER_NAMES,
    created_at: new Date().toISOString(),
  }))
  await fs.writeFile(path.join(projectDir, 'config.json'), JSON.stringify({}))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [], next_episode_number: 1, recycled_numbers: [],
  }))
}

before(async () => {
  tmp = await useTempDataDir()
  pm = await import('../services/project-manager.js')
})

after(async () => { await tmp.cleanup() })

beforeEach(async () => {
  await fs.rm(pm.projectsRoot(), { recursive: true, force: true })
  await makeProject()
})

describe('final-video promotion locks', () => {
  test('all reachable final writers use the shared pathname lock', async () => {
    const [videoSource, brollSource] = await Promise.all([
      fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../generators/broll-assemble.ts', import.meta.url), 'utf8'),
    ])
    assert.match(videoSource, /withFinalVideoPathLock\(finalPath/)
    assert.match(videoSource, /withFinalVideoPathLock\(compFinalPath/)
    assert.match(videoSource, /withFinalVideoPathLock\(projectTreeFinalPath/)
    assert.match(brollSource, /withFinalVideoPathLock\(input\.finalPath/)
    assert.match(brollSource, /fsp\.rename\(input\.tempPath, input\.finalPath\)/)
    assert.match(brollSource, /promoteVerifiedBrollFinal\(\{[\s\S]{0,600}?finalPath: outPath/)
  })
})
