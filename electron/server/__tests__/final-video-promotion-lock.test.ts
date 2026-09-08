import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'

import { useTempDataDir } from './_helpers.js'
import { DEFAULT_SUBFOLDER_NAMES } from '../models/types.js'

let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let uploadQueue: typeof import('../services/upload-queue.js')
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
  im = await import('../services/idea-manager.js')
  uploadQueue = await import('../services/upload-queue.js')
})

after(async () => { await tmp.cleanup() })

beforeEach(async () => {
  await fs.rm(pm.projectsRoot(), { recursive: true, force: true })
  await makeProject()
})

describe('final-video promotion locks', () => {
  test('episode imports preserve an existing canonical final and select a versioned target', async () => {
    const [idea] = await im.addIdeas(SLUG, [{
      title: TITLE, logline: 'l', themes: [], suggested_chapters: 1, suggested_length: '5 min', mood: 'm',
    }], 'test')
    const accepted = await im.acceptIdea(SLUG, idea.id, false, { override_code: 'EP0001' })
    const videoDir = path.join(accepted.episode_dir, 'EP0001 - 10 Video Assembly Output')
    const canonical = path.join(videoDir, 'EP0001_final_video.mp4')
    await fs.mkdir(videoDir, { recursive: true })
    await fs.writeFile(canonical, 'rendered-by-assembly')

    const imports = await uploadQueue.ensureEpisodeImportFolder(SLUG, 'EP0001')
    await fs.writeFile(path.join(imports, 'external-render.mp4'), 'imported-video')

    const result = await uploadQueue.scanEpisodeImports(SLUG, 'EP0001')
    const versioned = path.join(videoDir, 'EP0001_final_video_v2.mp4')
    assert.deepEqual(result.moved, [{ from: path.join(imports, 'external-render.mp4'), to: versioned }])
    assert.equal(await fs.readFile(canonical, 'utf8'), 'rendered-by-assembly')
    assert.equal(await fs.readFile(versioned, 'utf8'), 'imported-video')
  })

  test('all reachable final writers use the shared pathname lock', async () => {
    const [videoSource, brollSource, importSource] = await Promise.all([
      fs.readFile(new URL('../generators/video.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../generators/broll-assemble.ts', import.meta.url), 'utf8'),
      fs.readFile(new URL('../services/upload-queue.ts', import.meta.url), 'utf8'),
    ])
    assert.match(videoSource, /withFinalVideoPathLock\(finalPath/)
    assert.match(videoSource, /withFinalVideoPathLock\(compFinalPath/)
    assert.match(videoSource, /withFinalVideoPathLock\(projectTreeFinalPath/)
    assert.match(brollSource, /withFinalVideoPathLock\(outPath, \(\) => fsp\.rename\(tempPath, outPath\)\)/)
    assert.match(importSource, /withFinalVideoImportSelectionLock\(videoDir, code, ext/)
    assert.match(importSource, /withFinalVideoPathLock\(target/)
  })
})
