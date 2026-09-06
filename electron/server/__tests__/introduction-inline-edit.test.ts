import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import express from 'express'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const SLUG = 'introduction-editor-project'
const CODE = 'EP0071'
const EMPTY_CODE = 'EP0072'
const TITLE = 'The Lighthouse Clock'
const ORIGINAL_INTRO = 'Welcome to the old lighthouse, where the clock still keeps watch.'
const CHAPTER = 'At midnight, the keeper crossed the quiet room and wound the brass mechanism.'
const MANUAL_EDIT = 'Room 12 stays quiet at 3:30 p.m. This introduction is exactly as I wrote it.'
const CONCURRENT_EDIT_A = 'First editor keeps 17 brass keys beside the lighthouse ledger.'
const CONCURRENT_EDIT_B = 'Second editor records 29 quiet bells before the midnight watch.'

let tmp: { dir: string; cleanup: () => Promise<void> }
let app: express.Express
let scriptDir: string
let introductionAudioPath: string

before(async () => {
  tmp = await useTempDataDir()
  const projectDir = path.join(tmp.dir, 'projects', SLUG)
  scriptDir = path.join(
    projectDir,
    'episodes',
    'Season 004',
    `${CODE} - ${TITLE}`,
    `${CODE} - 01 Script`,
  )
  await fs.mkdir(scriptDir, { recursive: true })
  await fs.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    slug: SLUG,
    name: 'Introduction Editor Project',
    episode_prefix: 'EP',
    season_size: 20,
    season_prefix: 'Season',
    folder_template: '{season_prefix} {season_num}/{code} - {title}/',
  }))
  await fs.writeFile(path.join(projectDir, 'ideas.json'), JSON.stringify({
    ideas: [
      { id: 'idea-71', episode_code: CODE, title: TITLE, status: 'accepted' },
      { id: 'idea-72', episode_code: EMPTY_CODE, title: 'An Empty Episode', status: 'accepted' },
    ],
    next_episode_number: 72,
    recycled_numbers: [],
  }))

  const { writeChapterFiles, assembleUnifiedNarration } = await import('../lib/narration-assembly.js')
  await writeChapterFiles(scriptDir, CODE, TITLE, {
    intro: { text: ORIGINAL_INTRO },
    chapters: [{ number: 1, title: 'The Winding Room', text: CHAPTER }],
  }, { normalizeSpokenProse: false })
  await assembleUnifiedNarration(scriptDir, CODE, TITLE)
  introductionAudioPath = path.join(path.dirname(scriptDir), `${CODE} - 02 Audio`, `${CODE}_Introduction.mp3`)
  await fs.mkdir(path.dirname(introductionAudioPath), { recursive: true })
  await fs.writeFile(introductionAudioPath, 'disposable old audio')
  await fs.utimes(introductionAudioPath, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
  await fs.mkdir(path.join(
    projectDir, 'episodes', 'Season 004', `${EMPTY_CODE} - An Empty Episode`, `${EMPTY_CODE} - 01 Script`,
  ), { recursive: true })

  const { router } = await import('../routes/scripts.js')
  app = express()
  app.use(express.json())
  app.use('/api', router)
})

after(async () => {
  await tmp.cleanup()
})

function saveIntroduction(text: unknown, code = CODE) {
  return request(app)
    .put(`/api/projects/${SLUG}/episodes/${code}/introduction-content`)
    .send({ text })
}

describe('Introduction inline edit route', () => {
  test('writes only the introduction, preserves manual prose, and rebuilds combined narration', async () => {
    const chapterPath = path.join(scriptDir, `${CODE}_Chapter_01.md`)
    const chapterBefore = await fs.readFile(chapterPath)
    const res = await saveIntroduction(MANUAL_EDIT)

    assert.equal(res.status, 200)
    assert.equal(res.body.introduction.content, MANUAL_EDIT)
    assert.equal(res.body.introduction.wordCount, MANUAL_EDIT.split(/\s+/).length)
    assert.equal(res.body.ok, true)

    assert.deepEqual(await fs.readFile(chapterPath), chapterBefore, 'saving the intro must not rewrite a chapter')
    const introSource = await fs.readFile(path.join(scriptDir, `${CODE}_Introduction.md`), 'utf8')
    assert.match(introSource, /Room 12 stays quiet at 3:30 p\.m\./,
      'manual numbers and punctuation must not pass through spoken-number or AI cleanup')
    const [sourceStat, audioStat] = await Promise.all([
      fs.stat(path.join(scriptDir, `${CODE}_Introduction.md`)),
      fs.stat(introductionAudioPath),
    ])
    assert.ok(sourceStat.mtimeMs > audioStat.mtimeMs,
      'the existing audio status route must see the edited Introduction as stale')

    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const sections = await parseNarrationDocx(path.join(scriptDir, `${CODE}_Script_Narration.md`))
    assert.equal(sections.find(section => section.slug === 'Introduction')?.text, MANUAL_EDIT)
    assert.equal(sections.find(section => section.slug === 'Chapter_01')?.text, CHAPTER)
  })

  test('materializes a legacy unified-only episode before editing so its chapters cannot disappear', async () => {
    await fs.rm(path.join(scriptDir, `${CODE}_Introduction.md`))
    await fs.rm(path.join(scriptDir, `${CODE}_Chapter_01.md`))

    const legacyEdit = 'A second careful manual introduction.'
    const res = await saveIntroduction(legacyEdit)
    assert.equal(res.status, 200)
    assert.equal(res.body.introduction.content, legacyEdit)

    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const sections = await parseNarrationDocx(path.join(scriptDir, `${CODE}_Script_Narration.md`))
    assert.equal(sections.find(section => section.slug === 'Introduction')?.text,
      legacyEdit)
    assert.equal(sections.find(section => section.slug === 'Chapter_01')?.text, CHAPTER,
      'legacy chapters must survive the section-only save')
    await fs.access(path.join(scriptDir, `${CODE}_Chapter_01.md`))
  })

  test('serializes simultaneous introduction saves through their own readback', async () => {
    const [first, second] = await Promise.all([
      saveIntroduction(CONCURRENT_EDIT_A),
      saveIntroduction(CONCURRENT_EDIT_B),
    ])

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(first.body.introduction.content, CONCURRENT_EDIT_A)
    assert.equal(second.body.introduction.content, CONCURRENT_EDIT_B)

    const { parseNarrationDocx } = await import('../lib/docx-parser.js')
    const sourceSections = await parseNarrationDocx(path.join(scriptDir, `${CODE}_Introduction.md`))
    const unifiedSections = await parseNarrationDocx(path.join(scriptDir, `${CODE}_Script_Narration.md`))
    const sourceIntroduction = sourceSections.find(section => section.slug === 'Introduction')?.text
    assert.ok(sourceIntroduction === CONCURRENT_EDIT_A || sourceIntroduction === CONCURRENT_EDIT_B)
    assert.equal(unifiedSections.find(section => section.slug === 'Introduction')?.text, sourceIntroduction)
    assert.equal(unifiedSections.find(section => section.slug === 'Chapter_01')?.text, CHAPTER)
  })

  test('rejects an empty or non-text edit without changing the saved introduction', async () => {
    const introPath = path.join(scriptDir, `${CODE}_Introduction.md`)
    const before = await fs.readFile(introPath)

    assert.equal((await saveIntroduction('   ')).status, 400)
    assert.equal((await saveIntroduction({ prose: 'not text' })).status, 400)
    assert.deepEqual(await fs.readFile(introPath), before)
  })

  test('does not create narration for an absent episode or one with no saved narration', async () => {
    assert.equal((await saveIntroduction('Do not create me.', 'EP9999')).status, 404)
    assert.equal((await saveIntroduction('Do not create me either.', EMPTY_CODE)).status, 404)
    const emptyScriptDir = path.join(
      tmp.dir, 'projects', SLUG, 'episodes', 'Season 004',
      `${EMPTY_CODE} - An Empty Episode`, `${EMPTY_CODE} - 01 Script`,
    )
    assert.deepEqual(await fs.readdir(emptyScriptDir), [])
  })

  test('rejects the edit while generation owns the same introduction, without writing', async () => {
    const introPath = path.join(scriptDir, `${CODE}_Introduction.md`)
    const before = await fs.readFile(introPath)
    const jq = await import('../services/job-queue.js')
    await jq.setQueuePaused(true)
    const active = jq.enqueuePreparedForTest({ project_slug: SLUG, episode_id: CODE,
      type: 'introduction-only', title: TITLE, params: {} })
    await jq._waitForJobPersistenceForTesting()

    try {
      const res = await saveIntroduction('This must wait until generation finishes.')
      assert.equal(res.status, 409)
      assert.match(res.body.detail, /queued, running, or paused/i)
      assert.deepEqual(await fs.readFile(introPath), before)
    } finally {
      await jq.requestJobCancellation(SLUG, active.job_id)
      await jq._waitForJobPersistenceForTesting()
      await jq.setQueuePaused(false)
    }
  })
})
