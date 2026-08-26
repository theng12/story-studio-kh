/**
 * v1.0.467 — scene_plan.json now lives inside the "03 Scene Prompts" folder.
 *
 * Covers resolveScenePlanPath: new-location preferred, legacy-root fallback,
 * fresh-write default, and "✅ "-prefixed scene-prompts folder tolerance.
 */

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let tempDir: string
let cleanup: () => Promise<void>
let utils: typeof import('../services/utils.js')
let projectsRoot: string

before(async () => {
  const t = await useTempDataDir()
  tempDir = t.dir
  cleanup = t.cleanup
  utils = await import('../services/utils.js')
  const pm = await import('../services/project-manager.js')
  projectsRoot = pm.projectsRoot()
})

after(async () => { await cleanup() })

beforeEach(async () => {
  await fs.rm(projectsRoot, { recursive: true, force: true })
  await fs.mkdir(projectsRoot, { recursive: true })
  await fs.rm(path.join(tempDir, 'migrations.json'), { force: true })
})

const PLAN = JSON.stringify({ scenes: [{ id: 's1', visual_prompt: 'a cabin at dusk' }] })

/** Seed one project + one episode folder. Returns useful paths. */
async function seedEpisode(slug: string, code = 'EP0001'): Promise<{
  episodeDir: string
  scenePromptsDir: string
  legacyPlan: string
  newPlan: string
}> {
  const projectDir = path.join(projectsRoot, slug)
  const seasonDir = path.join(projectDir, 'episodes', 'Season 001')
  const episodeDir = path.join(seasonDir, `${code} - Test Title`)
  const scenePromptsDir = path.join(episodeDir, `${code} - 03 Scene Prompts`)
  await fs.mkdir(episodeDir, { recursive: true })
  await fs.writeFile(
    path.join(projectDir, 'project.json'),
    JSON.stringify({ slug, name: slug }, null, 2),
  )
  return {
    episodeDir,
    scenePromptsDir,
    legacyPlan: path.join(episodeDir, 'scene_plan.json'),
    newPlan: path.join(scenePromptsDir, 'scene_plan.json'),
  }
}

describe('resolveScenePlanPath', () => {
  test('fresh episode → returns the new 03 Scene Prompts location', async () => {
    const { episodeDir, newPlan } = await seedEpisode('alpha')
    const resolved = await utils.resolveScenePlanPath('alpha', 'EP0001', episodeDir)
    assert.equal(resolved, newPlan)
  })

  test('legacy file at episode root → returns the root location', async () => {
    const { episodeDir, legacyPlan } = await seedEpisode('alpha')
    await fs.writeFile(legacyPlan, PLAN)
    const resolved = await utils.resolveScenePlanPath('alpha', 'EP0001', episodeDir)
    assert.equal(resolved, legacyPlan)
  })

  test('file already in 03 folder → returns the new location', async () => {
    const { episodeDir, scenePromptsDir, newPlan } = await seedEpisode('alpha')
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(newPlan, PLAN)
    const resolved = await utils.resolveScenePlanPath('alpha', 'EP0001', episodeDir)
    assert.equal(resolved, newPlan)
  })

  test('both present → prefers the 03 folder (new) location', async () => {
    const { episodeDir, scenePromptsDir, legacyPlan, newPlan } = await seedEpisode('alpha')
    await fs.writeFile(legacyPlan, PLAN)
    await fs.mkdir(scenePromptsDir, { recursive: true })
    await fs.writeFile(newPlan, PLAN)
    const resolved = await utils.resolveScenePlanPath('alpha', 'EP0001', episodeDir)
    assert.equal(resolved, newPlan)
  })

  test('"✅ "-prefixed 03 folder is found, not duplicated', async () => {
    const { episodeDir } = await seedEpisode('alpha')
    const doneDir = path.join(episodeDir, '✅ EP0001 - 03 Scene Prompts')
    await fs.mkdir(doneDir, { recursive: true })
    const donePlan = path.join(doneDir, 'scene_plan.json')
    await fs.writeFile(donePlan, PLAN)
    const resolved = await utils.resolveScenePlanPath('alpha', 'EP0001', episodeDir)
    assert.equal(resolved, donePlan)
  })
})
