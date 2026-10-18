/**
 * Future-only introduction activation.
 *
 * An episode's eligibility is a FACT captured at acceptance, never a guess
 * from the current project setting, queue order, or time:
 *   - new episode + switch ON  -> intro_eligible: true
 *   - new episode + switch OFF -> intro_eligible: false
 *   - old/imported episode     -> no fact; never eligible, never backfilled
 *
 * The manual Introduction action is a separate explicit path and is not
 * gated by these facts.
 */
import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

let pm: typeof import('../services/project-manager.js')
let im: typeof import('../services/idea-manager.js')
let facts: typeof import('../lib/episode-creation-facts.js')
let tmp: { dir: string; cleanup: () => Promise<void> }

before(async () => {
  pm = await import('../services/project-manager.js')
  im = await import('../services/idea-manager.js')
  facts = await import('../lib/episode-creation-facts.js')
})
after(async () => { await tmp?.cleanup() })
beforeEach(async () => {
  await tmp?.cleanup()
  tmp = await useTempDataDir()
  const projectsDir = path.join(tmp.dir, 'projects')
  await fs.rm(projectsDir, { recursive: true, force: true })
  await fs.mkdir(projectsDir, { recursive: true })
})

const baseIdea = {
  logline: 'A line.', themes: ['a'], suggested_chapters: 5, suggested_length: '30 min', mood: 'calm',
}

async function acceptOne(slug: string): Promise<any> {
  const [idea] = await im.addIdeas(slug, [{ ...baseIdea, title: `Episode ${Date.now()}` }], 'm')
  const result = await im.acceptIdea(slug, idea!.id)
  return JSON.parse(await fs.readFile(path.join(result.episode_dir, 'episode_info.json'), 'utf-8'))
}

describe('acceptIdea captures the creation snapshot', () => {
  test('switch ON + km captures both facts', async () => {
    const project = await pm.createProject({
      name: 'Future Intros',
      auto_introduction_enabled: true,
      content_language: 'km',
    })
    const info = await acceptOne(project.slug)
    assert.equal(info.intro_eligible, true)
    assert.equal(info.content_language, 'km')
  })

  test('switch OFF captures no eligible fact and never guesses a language', async () => {
    const project = await pm.createProject({ name: 'No Auto Intros' })
    const info = await acceptOne(project.slug)
    assert.equal('intro_eligible' in info, false, 'only an enabled creation writes the fact')
    assert.equal('content_language' in info, false, 'legacy create stays absent')
  })

  test('the snapshot does not follow a later setting change', async () => {
    const project = await pm.createProject({ name: 'Future Only' })
    const before = await acceptOne(project.slug)
    await pm.updateProject(project.slug, { auto_introduction_enabled: true, content_language: 'km' })
    const after = await acceptOne(project.slug)
    assert.equal('intro_eligible' in before, false)
    assert.equal(after.intro_eligible, true)
    assert.equal(after.content_language, 'km')
  })
})

describe('old and imported episodes have no fact', () => {
  test('episode_info without the field reads as ineligible', async () => {
    const episodeDir = path.join(tmp.dir, 'legacy-episode')
    await fs.mkdir(episodeDir, { recursive: true })
    await fs.writeFile(path.join(episodeDir, 'episode_info.json'), JSON.stringify({ episode_code: 'EP0001' }))
    assert.deepEqual(await facts.readEpisodeCreationFacts(episodeDir), {})
    assert.equal(await facts.episodeIsIntroEligible(episodeDir), false)
  })

  test('a missing or corrupt file is no fact, not a negative fact the UI can show', async () => {
    const missing = path.join(tmp.dir, 'missing-episode')
    assert.deepEqual(await facts.readEpisodeCreationFacts(missing), {})
    const corrupt = path.join(tmp.dir, 'corrupt-episode')
    await fs.mkdir(corrupt, { recursive: true })
    await fs.writeFile(path.join(corrupt, 'episode_info.json'), '{not json')
    assert.deepEqual(await facts.readEpisodeCreationFacts(corrupt), {})
    assert.equal(await facts.episodeIsIntroEligible(corrupt), false)
  })

  test('only an explicit true is eligible', async () => {
    const dir = path.join(tmp.dir, 'true-episode')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'episode_info.json'), JSON.stringify({ intro_eligible: true }))
    assert.equal(await facts.episodeIsIntroEligible(dir), true)
    await fs.writeFile(path.join(dir, 'episode_info.json'), JSON.stringify({ intro_eligible: false }))
    assert.equal(await facts.episodeIsIntroEligible(dir), false)
  })
})
