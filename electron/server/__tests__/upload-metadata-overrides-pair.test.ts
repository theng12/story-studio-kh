/**
 * Narrowly related tests for the title/description override pair:
 *
 *  - `writeTitleAndDescription` / `readTitleAndDescription` in
 *    services/upload-overrides.ts — the atomic pair write that preserves
 *    unrelated sidecar fields and prunes empty blocks;
 *  - POST /projects/:slug/youtube/metadata-overrides in
 *    routes/youtube-upload-center.ts — the compared write that lands it.
 *
 * The route never talks to the provider, so it is exercised through
 * supertest without a FakeYouTube transport — the router import under a
 * throwaway data dir follows upload-bulk-visibility-route.test.ts.
 */
import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'

// Import the router under a throwaway data dir so any module-level cache is
// keyed against it, then drop it — the same pattern
// upload-bulk-visibility-route.test.ts uses.
const boot = await useTempDataDir()
const { router } = await import('../routes/youtube-upload-center.js')
const { overrideRefusal } = await import('../services/upload-overrides.js')
await boot.cleanup()

const app = express()
app.use(express.json())
app.use('/api', router)

// A route that does NOT catch its own refusal, so the refusal has to survive
// the app's generic error handler on its own. This is the path a refusal
// takes whenever the route that throws it has no handler of its own — and
// it is where an unexposed error would become a bare 500 with the sentence
// "Internal server error", telling the owner nothing.
app.get('/api/__refusal', (_req, _res, next) => {
  next(overrideRefusal(409, 'EPISODE_FOLDER_AMBIGUOUS', 'Two folders carry EP0001, so nothing was written.'))
})
const { errorBoundary } = await import('../lib/error-boundary.js')
app.use(errorBoundary)

let cleanup: (() => Promise<void>) | undefined
afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const EPISODE_TITLE = 'The Lighthouse at Dawn'

/**
 * A project with one accepted episode whose folder holds generated metadata.
 *
 * `folderTitle` names the folder ON DISK, which may differ from the idea's
 * title: a rename leaves the folder under its old name, and the resolver
 * finds it by code. That is the case a writer that resolved by title would
 * get wrong.
 */
async function seededEpisode(name: string, options: { folderTitle?: string; uploadSidecar?: boolean } = {}): Promise<{
  slug: string; episodeCode: string; title: string; episodeDir: string
}> {
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup
  const pm = await import('../services/project-manager.js')
  const im = await import('../services/idea-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const project = await pm.createProject({ name })
  const [idea] = await im.addIdeas(project.slug, [{
    title: EPISODE_TITLE, logline: '', themes: [], suggested_chapters: 1, suggested_length: 'short', mood: '',
  }], 'test')
  const accepted = await im.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP0001' })
  const episodeCode = accepted.idea.episode_code!
  const title = accepted.idea.title
  const paths = await resolveEpisodePaths(project.slug, episodeCode, options.folderTitle || title)
  await fs.mkdir(paths.episode_dir, { recursive: true })
  // The upload sidecar is what identifies the folder among same-code
  // siblings — the resolver looks for exactly this file. An episode that has
  // NEVER been uploaded does not have one, and that is a different case.
  if (options.uploadSidecar !== false) {
    await fs.writeFile(path.join(paths.episode_dir, 'youtube_upload.json'), JSON.stringify({ channel_id: 'UC-test' }))
  }
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: 'Generated Title', description: 'Generated description.', tags: ['generated'],
  }))
  return { slug: project.slug, episodeCode, title, episodeDir: paths.episode_dir }
}

async function preview(slug: string, episodeCode: string): Promise<any> {
  const res = await request(app).post(`/api/projects/${slug}/youtube/preview`).send({ episode_code: episodeCode })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  return res.body
}

function save(slug: string, episodeCode: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/projects/${slug}/youtube/metadata-overrides`)
    .send({ episode_code: episodeCode, ...body })
}

test('writeTitleAndDescription saves both fields atomically and preserves unrelated keys', async () => {
  const { writeTitleAndDescription, readTitleAndDescription } = await import('../services/upload-overrides.js')
  const { slug, episodeCode, episodeDir } = await seededEpisode('Override Pair Write')

  // Seed an existing override (selected_thumbnail) that must survive the write.
  await fs.writeFile(path.join(episodeDir, 'upload_metadata_overrides.json'), JSON.stringify({
    youtube: { selected_thumbnail: 'EP0001_Thumb01_v1.png', tags: ['seeded'] },
  }))

  await writeTitleAndDescription(slug, episodeCode, EPISODE_TITLE, 'youtube', {
    title: 'Typed Title',
    description: 'Typed description with ខ្មែរ',
  })

  const raw = JSON.parse(await fs.readFile(path.join(episodeDir, 'upload_metadata_overrides.json'), 'utf-8'))
  assert.equal(raw.youtube.title, 'Typed Title')
  assert.equal(raw.youtube.description, 'Typed description with ខ្មែរ')
  assert.equal(raw.youtube.selected_thumbnail, 'EP0001_Thumb01_v1.png', 'unrelated field preserved')
  assert.deepEqual(raw.youtube.tags, ['seeded'], 'unrelated array preserved')

  const read = await readTitleAndDescription(slug, episodeCode, EPISODE_TITLE, 'youtube')
  assert.equal(read?.title, 'Typed Title')
  assert.equal(read?.description, 'Typed description with ខ្មែរ')
})

test('clearing both override fields prunes the platform block and deletes an empty file', async () => {
  const { writeTitleAndDescription, readTitleAndDescription } = await import('../services/upload-overrides.js')
  const { slug, episodeCode, episodeDir } = await seededEpisode('Override Prune')
  const sidecar = path.join(episodeDir, 'upload_metadata_overrides.json')
  await fs.writeFile(sidecar, JSON.stringify({ youtube: { title: 'Old', description: 'Old' } }))

  // Clear title via empty string, description via null — both paths prune.
  await writeTitleAndDescription(slug, episodeCode, EPISODE_TITLE, 'youtube', {
    title: '',
    description: null,
  })

  assert.equal(existsSync(sidecar), false, 'sidecar deleted when no overrides remain')
  const read = await readTitleAndDescription(slug, episodeCode, EPISODE_TITLE, 'youtube')
  assert.equal(read, null, 'reader returns null when nothing is stored')
})

test('the saved text is what the resolver reads back, marked as the owner\'s own', async () => {
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')
  const { slug, episodeCode, title } = await seededEpisode('Resolver Read Back')
  const before = await preview(slug, episodeCode)

  const res = await save(slug, episodeCode, {
    title: 'The Title The Owner Chose',
    description: 'The description the owner wrote.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const resolved = await resolveUploadMetadata({
    slug, episode_code: episodeCode, platform: 'youtube', fallback_title: title,
  })
  assert.equal(resolved.title, 'The Title The Owner Chose')
  assert.equal(resolved.description, 'The description the owner wrote.')
  assert.equal(resolved.title_from_override, true, 'the resolver knows the title is the owner\'s')
  assert.equal(resolved.description_from_override, true, 'the resolver knows the description is the owner\'s')
})

test('a renamed episode is written in the folder that holds it, and no second folder gets an override', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Renamed Episode', { folderTitle: 'Old Title' })
  const before = await preview(slug, episodeCode)

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  // The override landed in the folder the resolver reads.
  const drifted = await resolveEpisodePaths(slug, episodeCode, 'Old Title')
  const raw = JSON.parse(await fs.readFile(path.join(drifted.episode_dir, 'upload_metadata_overrides.json'), 'utf-8'))
  assert.equal(raw.youtube.title, 'Owner Title')

  // And the folder named after the CURRENT idea title did not get one.
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  assert.equal(
    existsSync(path.join(canonical.episode_dir, 'upload_metadata_overrides.json')),
    false,
    'the write did not land beside the folder that holds the episode',
  )
})

test('an episode code that is not in this project is refused, and creates nothing', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug } = await seededEpisode('Unknown Code')

  const res = await save(slug, 'EP9999', {
    title: 'Owner Title', description: '', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.code, 'YOUTUBE_EPISODE_NOT_FOUND')

  const paths = await resolveEpisodePaths(slug, 'EP9999', '')
  assert.equal(existsSync(paths.episode_dir), false, 'no stray episode folder was created')
})

test('a save is refused while an upload for the episode is in flight', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const jobQueue = await import('../services/job-queue.js')
  const { slug, episodeCode, title } = await seededEpisode('Upload In Flight')
  const before = await preview(slug, episodeCode)

  // A prepared job carries a recovery id, so the queue keeps it as a QUEUED
  // row without running an executor — the state a real upload is in.
  jobQueue.enqueuePreparedForTest({
    project_slug: slug, type: 'youtube_upload', episode_id: episodeCode,
    title: EPISODE_TITLE, params: {},
    episode_recovery_job_id: 'upload-in-flight',
  })

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'YOUTUBE_UPLOAD_IN_FLIGHT')

  const paths = await resolveEpisodePaths(slug, episodeCode, title)
  assert.equal(
    existsSync(path.join(paths.episode_dir, 'upload_metadata_overrides.json')),
    false,
    'the refused save wrote nothing',
  )
})

test('the answer is the payload that will be sent: the save and the next preview agree', async () => {
  const { slug, episodeCode } = await seededEpisode('Preview Diff')
  const before = await preview(slug, episodeCode)

  const saved = await save(slug, episodeCode, {
    title: 'A Title The Owner Chose',
    description: 'A description the owner wrote.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.snippet.title, 'A Title The Owner Chose')
  assert.equal(saved.body.snippet.description, 'A description the owner wrote.')
  assert.deepEqual(saved.body.limits, {
    title_max_characters: 100,
    description_max_bytes: 4900,
    description_max_bytes_youtube: 5000,
  })

  const after = await preview(slug, episodeCode)
  assert.equal(after.package_revision, saved.body.package_revision, 'the refreshed package is the one that will be sent')
  assert.equal(after.snippet.title, saved.body.snippet.title)
  assert.equal(after.snippet.description, saved.body.snippet.description)
})

test('a blank description is refused by name, and the saved text is left alone', async () => {
  const { slug, episodeCode } = await seededEpisode('Blank Description')
  const before = await preview(slug, episodeCode)

  // 1.4.417 reverses the old "save it blank" answer: a blank used to save clean and then fail the
  // upload hours later, with the reason only in the queue row (S26/S28, Production 2026-11-21).
  const saved = await save(slug, episodeCode, {
    title: 'Kept Title', description: '',
    expected_package_revision: before.package_revision,
  })
  assert.equal(saved.status, 400, JSON.stringify(saved.body))
  assert.equal(saved.body.code, 'YOUTUBE_DESCRIPTION_REQUIRED')
  assert.match(String(saved.body.detail), /Reset/)

  const after = await preview(slug, episodeCode)
  assert.equal(after.snippet.description, before.snippet.description, 'nothing was written over the saved text')
})

test('text YouTube would refuse is refused here, where it can still be fixed', async () => {
  const { slug, episodeCode } = await seededEpisode('Validation')
  const before = await preview(slug, episodeCode)

  const empty = await save(slug, episodeCode, {
    title: '   ', description: '', expected_package_revision: before.package_revision,
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.code, 'YOUTUBE_TITLE_REQUIRED')

  const long = await save(slug, episodeCode, {
    title: 'x'.repeat(101), description: '', expected_package_revision: before.package_revision,
  })
  assert.equal(long.status, 400)
  assert.equal(long.body.code, 'YOUTUBE_TITLE_TOO_LONG')

  // Khmer is 3 bytes a character: 1,634 chars = 4,902 bytes, over the cap.
  const khmer = await save(slug, episodeCode, {
    title: 'Fine', description: 'ក'.repeat(1634), expected_package_revision: before.package_revision,
  })
  assert.equal(khmer.status, 400)
  assert.equal(khmer.body.code, 'YOUTUBE_DESCRIPTION_TOO_LONG')
  assert.match(khmer.body.detail, /4902 bytes/)

  // The publish gate's own rule, said here instead of at upload time.
  const junk = await save(slug, episodeCode, {
    title: '# SEO-Optimized Video Titles', description: 'Fine description.', expected_package_revision: before.package_revision,
  })
  assert.equal(junk.status, 400)
  assert.equal(junk.body.code, 'YOUTUBE_METADATA_NOT_PUBLISHABLE')

  // YouTube drops angle brackets from every title. A text that would change
  // on the way out is refused with the text that WOULD arrive.
  const angles = await save(slug, episodeCode, {
    title: 'A title <with brackets>', description: 'Fine description.', expected_package_revision: before.package_revision,
  })
  assert.equal(angles.status, 400)
  assert.equal(angles.body.code, 'YOUTUBE_METADATA_WOULD_BE_CHANGED')
  assert.equal(angles.body.suggestion.title, 'A title with brackets')

  // A save with no reviewed revision behind it is refused.
  const unreviewed = await save(slug, episodeCode, { title: 'Fine', description: 'Fine description.' })
  assert.equal(unreviewed.status, 400)
  assert.equal(unreviewed.body.code, 'YOUTUBE_CONFIRMATION_REQUIRED')

  // A revision that is not the one on the server is refused as stale.
  const stale = await save(slug, episodeCode, {
    title: 'Fine', description: 'Fine description.', expected_package_revision: 'not-the-reviewed-revision',
  })
  assert.equal(stale.status, 409)
  assert.equal(stale.body.code, 'YOUTUBE_PREVIEW_STALE')
})

test('the corrected text is offered back, for the field that would change and no other', async () => {
  const { slug, episodeCode } = await seededEpisode('Suggestion')
  const before = await preview(slug, episodeCode)

  const angles = await save(slug, episodeCode, {
    title: 'A title <with brackets>', description: 'A description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(angles.status, 400)
  assert.equal(angles.body.code, 'YOUTUBE_METADATA_WOULD_BE_CHANGED')
  assert.equal(angles.body.suggestion.title, 'A title with brackets')
  assert.equal(
    angles.body.suggestion.description,
    undefined,
    'a field that would not change is not offered as if it had',
  )
})

test('an explicit null restores the generated text; an empty description does not', async () => {
  const { resolveUploadMetadata } = await import('../lib/upload-metadata.js')
  const { slug, episodeCode, title } = await seededEpisode('Explicit Reset')
  const before = await preview(slug, episodeCode)
  assert.equal(before.snippet.description, 'Generated description.')

  const saved = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.snippet.description, 'Owner description.')
  assert.equal(saved.body.authored.description, true, 'the description is the owner\'s own')

  // The RESET: null means "put the generated one back". The title is not
  // mentioned in this request, so it must be left exactly as it is.
  const reset = await save(slug, episodeCode, {
    description: null,
    expected_package_revision: saved.body.package_revision,
  })
  assert.equal(reset.status, 200, JSON.stringify(reset.body))
  assert.equal(reset.body.snippet.description, 'Generated description.', 'the generated description is back')
  assert.equal(reset.body.snippet.title, 'Owner Title', 'the title was not touched')
  assert.equal(reset.body.authored.description, false, 'the description is no longer the owner\'s')

  const resolved = await resolveUploadMetadata({
    slug, episode_code: episodeCode, platform: 'youtube', fallback_title: title,
  })
  assert.equal(resolved.description, 'Generated description.')
  assert.equal(resolved.title, 'Owner Title')

  // 1.4.417 reversed the old answer here. An EMPTY description used to save clean and then fail the
  // upload hours later with the reason only in the queue row (S26/S28, Production 2026-11-21), so it is
  // refused at the save — and it still must not be read as a reset that brings the generated text back.
  const emptied = await save(slug, episodeCode, {
    description: '',
    expected_package_revision: reset.body.package_revision,
  })
  assert.equal(emptied.status, 400, JSON.stringify(emptied.body))
  assert.equal(emptied.body.code, 'YOUTUBE_DESCRIPTION_REQUIRED')
  const afterEmpty = await preview(slug, episodeCode)
  assert.equal(afterEmpty.snippet.description, 'Generated description.', 'a refused save changes nothing')
})

test('a request that changes nothing is refused, and a field that is not mentioned is left alone', async () => {
  const { slug, episodeCode } = await seededEpisode('Nothing To Save')
  const before = await preview(slug, episodeCode)

  const nothing = await save(slug, episodeCode, { expected_package_revision: before.package_revision })
  assert.equal(nothing.status, 400)
  assert.equal(nothing.body.code, 'YOUTUBE_NOTHING_TO_SAVE')

  // Only the title is mentioned; the description on disk must survive.
  const titleOnly = await save(slug, episodeCode, {
    title: 'A New Title',
    expected_package_revision: before.package_revision,
  })
  assert.equal(titleOnly.status, 200, JSON.stringify(titleOnly.body))
  assert.equal(titleOnly.body.snippet.title, 'A New Title')
  assert.equal(titleOnly.body.snippet.description, 'Generated description.', 'the description was not touched')
})

test('the answer for an episode whose folder cannot be found is neutral, and writes nothing', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Neutral Folder Message')

  // Take the folder away, as a rename the resolver cannot follow would.
  const paths = await resolveEpisodePaths(slug, episodeCode, title)
  assert.equal(existsSync(paths.episode_dir), true, 'the folder was there to begin with')
  await fs.rm(paths.episode_dir, { recursive: true, force: true })

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 400, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_NOT_FOUND')
  assert.doesNotMatch(res.body.detail, /not in this project/i, 'the message does not blame the episode')
  assert.doesNotMatch(res.body.detail, /no episode folder yet/i, 'and does not assert a cause it cannot know')
  assert.equal(existsSync(paths.episode_dir), false, 'nothing was created')
})

test('a writer whose episode folder is missing refuses with a status and a code, never a bare error', async () => {
  const { writeTitleAndDescription, writeSelectedThumbnail } = await import('../services/upload-overrides.js')
  const { slug, episodeCode, title, episodeDir } = await seededEpisode('Writer Refusal')
  await fs.rm(episodeDir, { recursive: true, force: true })

  const isRefusal = (error: unknown) => {
    const tagged = error as { statusCode?: number; code?: string; message?: string } | null
    assert.equal(typeof tagged?.statusCode, 'number', 'the refusal carries a status')
    assert.equal(typeof tagged?.code, 'string', 'the refusal carries a code')
    assert.doesNotMatch(tagged?.message || '', /metadata edits/i, 'the shared message does not talk about metadata')
    assert.doesNotMatch(tagged?.message || '', /not in this project/i, 'and does not blame the episode')
    assert.match(tagged?.message || '', /could not find the folder/i)
    return true
  }
  // Both writers share the assertion, so both must produce a refusal a route
  // can answer as a 4xx rather than a 500.
  await assert.rejects(
    () => writeTitleAndDescription(slug, episodeCode, title, 'youtube', { title: 'Owner Title' }),
    isRefusal,
  )
  await assert.rejects(
    () => writeSelectedThumbnail(slug, episodeCode, title, 'youtube', 'EP0001_Thumb01_v1.png'),
    isRefusal,
  )
  assert.equal(existsSync(episodeDir), false, 'neither writer created a folder')
})

test('a refusal that reaches the error boundary keeps its status, its code and its message', async () => {
  // The log write inside the error path needs a claimed temp dir.
  const temporary = await useTempDataDir()
  cleanup = temporary.cleanup

  const res = await request(app).get('/api/__refusal')
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_AMBIGUOUS', 'the code survives the boundary')
  assert.match(res.body.detail, /Two folders carry EP0001/, 'the message survives the boundary')
  assert.doesNotMatch(res.body.detail, /Internal server error/, 'and is not the generic sentence')

  // The same error, humanized directly, must carry the code too — the
  // frontend matches on the code, not on prose.
  const { humanizeBackendError } = await import('../lib/humanize-backend-error.js')
  const refusal = overrideRefusal(400, 'EPISODE_FOLDER_NOT_FOUND', 'The folder is not there.')
  const humanized = humanizeBackendError(refusal, 'fallback')
  assert.equal(humanized.code, 'EPISODE_FOLDER_NOT_FOUND')
  assert.equal(humanized.detail, 'The folder is not there.')
  assert.equal((refusal as any).expose, true, 'the refusal opts in to being shown')
})

test('a sidecar parked in the scene-prompts subfolder claims the episode too', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { resolveOverrideEpisodePaths } = await import('../services/upload-overrides.js')
  const { slug, episodeCode, title } = await seededEpisode('Subfolder Claimant', { folderTitle: 'Old Title' })
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)

  // The renamed folder claims the episode at its ROOT. The second same-code
  // folder holds the same sidecar in its SCENE-PROMPTS SUBFOLDER — the other
  // place the by-code helper looks, so it is a claim there too, and the
  // guard has to see it.
  const otherPaths = await resolveEpisodePaths(slug, episodeCode, 'Another Title')
  await fs.mkdir(otherPaths.scene_prompts_dir, { recursive: true })
  await fs.writeFile(
    path.join(otherPaths.scene_prompts_dir, 'youtube_upload.json'),
    JSON.stringify({ channel_id: 'UC-other' }),
  )
  const renamed = await resolveEpisodePaths(slug, episodeCode, 'Old Title')

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_AMBIGUOUS')
  assert.match(res.body.detail, /claims/i)
  for (const dir of [renamed.episode_dir, otherPaths.episode_dir]) {
    assert.equal(
      existsSync(path.join(dir, 'upload_metadata_overrides.json')),
      false,
      'nothing was written into any of the folders that claim the episode',
    )
  }
  assert.equal(existsSync(canonical.episode_dir), true, 'the idea-index folder is untouched')

  // With only ONE claim left, the same folder is accepted — the guard must
  // not refuse a claim that is unique.
  await fs.rm(path.join(renamed.episode_dir, 'youtube_upload.json'), { force: true })
  const resolved = await resolveOverrideEpisodePaths(slug, episodeCode, title, 'youtube')
  assert.equal(
    path.basename(resolved.episode_dir),
    path.basename(otherPaths.episode_dir),
    'the folder whose subfolder holds the sidecar is the one that is used',
  )
})

test('two folders that both claim the episode are refused, not picked between', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Two Claimants', { folderTitle: 'Old Title' })
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)

  // The renamed folder claims the episode (it holds the upload sidecar) —
  // and so does a second same-code folder. The by-code helper takes the
  // first one it finds; the owner's edit must not land in whichever one
  // that happened to be.
  const other = path.join(path.dirname(canonical.episode_dir), `${episodeCode} - Another Title`)
  await fs.mkdir(other, { recursive: true })
  await fs.writeFile(path.join(other, 'youtube_upload.json'), JSON.stringify({ channel_id: 'UC-other' }))

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_AMBIGUOUS')
  assert.match(res.body.detail, /claims/i)
  assert.match(res.body.detail, /Resolve the conflicting folders/i)
  assert.doesNotMatch(res.body.detail, /delete|remove the extra folder/i,
    'the message does not tell the owner to destroy a folder')

  for (const dir of [canonical.episode_dir, other]) {
    assert.equal(
      existsSync(path.join(dir, 'upload_metadata_overrides.json')),
      false,
      'nothing was written into any of the folders that claim the episode',
    )
  }
})

test('the folder that claims the episode and a duplicate that also claims it are refused', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Canonical With Duplicate')
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  assert.equal(existsSync(path.join(canonical.episode_dir, 'youtube_upload.json')), true,
    'the idea-index folder claims the episode')

  // A duplicate claims it too. The helper's canonical-wins branch would
  // have accepted the idea-index folder without a word — and the duplicate
  // is exactly the folder the upload may never read.
  const duplicate = path.join(path.dirname(canonical.episode_dir), `${episodeCode} - Duplicate`)
  await fs.mkdir(duplicate, { recursive: true })
  await fs.writeFile(path.join(duplicate, 'youtube_upload.json'), JSON.stringify({ channel_id: 'UC-dupe' }))

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_AMBIGUOUS')
  assert.match(res.body.detail, /claims/i)

  for (const dir of [canonical.episode_dir, duplicate]) {
    assert.equal(
      existsSync(path.join(dir, 'upload_metadata_overrides.json')),
      false,
      'nothing was written into any of the folders that claim the episode',
    )
  }
})

test('one folder that claims the episode and a plain duplicate are not a conflict', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('One Claimant')
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)

  // A leftover folder with the same code that claims nothing: no sidecar,
  // so it is not a second claimant and the save is not refused.
  const leftover = path.join(path.dirname(canonical.episode_dir), `${episodeCode} - Leftover`)
  await fs.mkdir(leftover, { recursive: true })

  const before = await preview(slug, episodeCode)
  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const raw = JSON.parse(await fs.readFile(path.join(canonical.episode_dir, 'upload_metadata_overrides.json'), 'utf-8'))
  assert.equal(raw.youtube.title, 'Owner Title', 'the edit landed in the folder that claims the episode')
  assert.equal(
    existsSync(path.join(leftover, 'upload_metadata_overrides.json')),
    false,
    'and not in a folder that claims nothing',
  )
})

test('a renamed episode that was never uploaded is found, and the edit lands in its folder', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  // The folder carries the OLD name and has no upload sidecar — it was never
  // uploaded — so nothing but the read resolver's recovery can find it.
  const { slug, episodeCode, title } = await seededEpisode('Renamed Never Uploaded', {
    folderTitle: 'Old Title', uploadSidecar: false,
  })
  // A rename MOVES the folder: the one named after the current title is not
  // on disk any more. (Accepting the idea created it; the rename took it
  // away.) Without this the canonical folder would still exist and the
  // recovery below would never be reached.
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  await fs.rm(canonical.episode_dir, { recursive: true, force: true })

  const before = await preview(slug, episodeCode)
  assert.equal(before.snippet.title, 'Generated Title', 'the preview read the folder that holds the episode')

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.',
    expected_package_revision: before.package_revision,
  })
  assert.equal(res.status, 200, JSON.stringify(res.body))

  const drifted = await resolveEpisodePaths(slug, episodeCode, 'Old Title')
  const raw = JSON.parse(await fs.readFile(path.join(drifted.episode_dir, 'upload_metadata_overrides.json'), 'utf-8'))
  assert.equal(raw.youtube.title, 'Owner Title', 'the edit landed in the folder that holds the episode')
  assert.equal(
    existsSync(path.join(canonical.episode_dir, 'upload_metadata_overrides.json')),
    false,
    'and not in a folder that does not exist',
  )
})

test('two folders for one episode code are refused, not guessed between', async () => {
  const { resolveEpisodePaths } = await import('../services/utils.js')
  const { slug, episodeCode, title } = await seededEpisode('Ambiguous Folder')
  const canonical = await resolveEpisodePaths(slug, episodeCode, title)
  // Two folders with the same code — the case where the read resolver's
  // recovery would return the FIRST match without saying so.
  const siblings = ['Another Title', 'Yet Another Title'].map(name => {
    const dir = path.join(path.dirname(canonical.episode_dir), `${episodeCode} - ${name}`)
    return dir
  })
  for (const dir of siblings) await fs.mkdir(dir, { recursive: true })
  await fs.rm(canonical.episode_dir, { recursive: true, force: true })

  const res = await save(slug, episodeCode, {
    title: 'Owner Title', description: 'Owner description.', expected_package_revision: 'any-revision',
  })
  assert.equal(res.status, 409, JSON.stringify(res.body))
  assert.equal(res.body.code, 'EPISODE_FOLDER_AMBIGUOUS')
  assert.match(res.body.detail, /more than one folder/i)
  for (const dir of siblings) {
    assert.equal(
      existsSync(path.join(dir, 'upload_metadata_overrides.json')),
      false,
      'nothing was written into any of the candidate folders',
    )
  }
})
