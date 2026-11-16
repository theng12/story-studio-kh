/**
 * The supported headline change, end to end through the existing prompt edit route (2026-11-16).
 *
 * A temporary project and its Markdown prompts file exercise the real PUT, parser and save:
 * one headline replaced in place, siblings untouched, an ambiguous prompt refused without writing,
 * and a repeated edit a no-op.
 */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { before, test } from 'node:test'
import request from 'supertest'

import { useTempDataDir } from './_helpers.js'

const EPISODE = 'EP0001'
const TITLE = 'The Title'
const PROMPTS = `# Thumbnail Prompts

## Thumbnail 4: FIFTEEN MILES

A river at dusk. The top band is reserved for the line of outlined capitals reading FIFTEEN MILES, and a small badge reading FOR SLEEP sits bottom-left.

## Thumbnail 5: ANOTHER HEADLINE

A hill town. The serif line ANOTHER HEADLINE sits across the top.
`

let app: import('express').Express
let slug = ''
let promptsPath = ''

before(async () => {
  await useTempDataDir()
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name: 'Headline replacement route' })
  slug = project.slug
  promptsPath = (await resolveEpisodePaths(slug, EPISODE, TITLE)).thumb_prompts_docx
  await mkdir(path.dirname(promptsPath), { recursive: true })
  await writeFile(promptsPath, PROMPTS)
  const { app: localApp } = await import('../app.js')
  app = localApp
})

const url = () => `/api/projects/${slug}/episodes/${EPISODE}/image-prompts/item?title=${encodeURIComponent(TITLE)}`

async function saved(): Promise<string> {
  return readFile(promptsPath, 'utf8')
}

test('a headline is replaced through the route, siblings untouched', async () => {
  const response = await request(app).put(url()).send({
    kind: 'thumbnail', number: 4, title: 'ROME', replace_headline: { from: 'FIFTEEN MILES', to: 'ROME' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.match(response.body.prompt, /reading ROME,/)
  const disk = await saved()
  assert.match(disk, /## Thumbnail 4: ROME/)
  assert.match(disk, /reading ROME,/)
  assert.doesNotMatch(disk, /FIFTEEN MILES/)
  assert.match(disk, /## Thumbnail 5: ANOTHER HEADLINE/)
  assert.match(disk, /serif line ANOTHER HEADLINE/, 'the sibling prompt is unchanged')
  assert.match(disk, /FOR SLEEP/, 'the badge is unchanged')
})

test('repeating the same edit is a no-op and writes the same bytes', async () => {
  const before = await saved()
  const response = await request(app).put(url()).send({
    kind: 'thumbnail', number: 4, title: 'ROME', replace_headline: { from: 'FIFTEEN MILES', to: 'ROME' },
  })
  assert.equal(response.status, 200)
  assert.equal(await saved(), before, 'the second edit changes nothing')
})

test('an ambiguous prompt is refused and nothing is written', async () => {
  const before = await saved()
  const response = await request(app).put(url()).send({
    kind: 'thumbnail', number: 5, title: 'GREECE', replace_headline: { from: 'NOT IN THE PROMPT', to: 'GREECE' },
  })
  assert.equal(response.status, 400)
  assert.match(String(response.body.detail), /does not contain the old headline "NOT IN THE PROMPT"/)
  assert.equal(await saved(), before, 'a refusal writes nothing')
})

test('an already-conflicting saved prompt is reduced to the one intended headline', async () => {
  await writeFile(promptsPath, PROMPTS.replace(
    'reading FIFTEEN MILES, and a small badge reading FOR SLEEP sits bottom-left.',
    'reading FIFTEEN MILES, and a small badge reading FOR SLEEP sits bottom-left. IMPORTANT — headline: the frame MUST carry exactly "ROME".',
  ))
  const response = await request(app).put(url()).send({
    kind: 'thumbnail', number: 4, title: 'ROME', replace_headline: { from: 'FIFTEEN MILES', to: 'ROME' },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  const disk = await saved()
  assert.doesNotMatch(disk, /FIFTEEN MILES/, 'the stale headline is gone')
  assert.match(disk, /reading ROME,/, 'the captured headline names the intended words')
  assert.match(disk, /exactly "ROME"/, 'the appended instruction names the same words')
  assert.equal(disk.split('FIFTEEN MILES').length - 1, 0)
  assert.match(disk, /FOR SLEEP/)
})
