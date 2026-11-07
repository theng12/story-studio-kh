/**
 * Thumbnail count defaults — the ONE rule for how many candidates new
 * thumbnail work makes, and how completion is observed.
 *
 * Owner requirement, 2026-10-25: *"from now on all thumbnail prompts and
 * generation is required to have 3 each, so I have something to choose from."*
 * Scope correction the same day: **3 is the DEFAULT, not a hard rule** — a
 * channel or preset that states another count keeps it, and the owner can still
 * change it.
 *
 * WHAT THIS FILE PINS
 * -------------------
 *   - `thumbnailCount()` is the ONE default: 3 when nothing named a count, and a
 *     given count is used as given (1 stays 1, 6 stays 6, 10 stays 10 — nothing
 *     is capped, because Story Studio does not invent a limit the catalogue
 *     never published, AGENTS §1).
 *   - A NEW channel is seeded with a "Three thumbnail options" Thumbnail Prompts
 *     preset that names NO model, and an EXISTING channel is never rewritten.
 *   - The prompt generator's own default is the same 3 (it was 5), proven by
 *     running the real generator against the in-process mock Gateway: complete
 *     (3/3), partial (2/3 → the job FAILS naming Thumbnail 3, the two prompts
 *     are kept), retry (only the missing one is requested), empty, malformed and
 *     provider-failure outcomes.
 *   - The mock chat model publishes a 4,096-token answer ceiling and a thumbnail
 *     prompt is measured at 2,350 tokens, so three prompts are THREE single-
 *     prompt requests. Every scenario below is queued per request, and the call
 *     count is asserted rather than assumed.
 *   - Completion is the episode's OWN count from the completion manifest, so an
 *     episode complete under its own count of 1 is not reopened by today's 3,
 *     and a preset that explicitly says 1 keeps saying 1.
 *   - An ACCEPTED thumbnail (pinned for upload, file still on disk) is this
 *     episode's thumbnail: the episode is done and nothing calls it incomplete.
 *     A pin naming a missing or empty file proves nothing.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import {
  DEFAULT_THUMBNAIL_COUNT,
  thumbnailCount,
  thumbnailOptionsLabel,
} from '../contracts/thumbnail-counts.js'
import { inspectPromptCompletion, writePromptCompletionManifest } from '../services/prompt-completion.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { toMdPath } from '../lib/episode-artifacts.js'

/** A 1×1 PNG — enough for "a file with content on disk". */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

let cleanup: () => Promise<void>
let service: MockGenStudioService
let app: any
let pm: typeof import('../services/project-manager.js')

before(async () => {
  await import('../providers/text/genstudio.js')
  await import('../providers/image/genstudio.js')
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
  app = (await import('../app.js')).app
  pm = await import('../services/project-manager.js')
})

after(async () => {
  await new Promise<void>(resolve => service.server.close(() => resolve()))
  await cleanup?.()
})

/** What one chat reply looks like for N thumbnail prompts. */
function thumbnailReply(count: number): string {
  return JSON.stringify({
    thumbnails: Array.from({ length: count }, (_, index) => ({
      number: index + 1,
      title: `Variation ${index + 1}`,
      prompt: `A bold thumbnail for variation ${index + 1}, one clear focal subject.`,
    })),
  })
}

/**
 * Every chat request the mock actually performed, in order. Replays of a
 * settled job are excluded: a retry moves its identity after a settled
 * failure, so a replay is not another provider request.
 */
function chatPrompts(): string[] {
  return service.submissions
    .filter(submission => submission.operation === 'chat' && !submission.replay)
    .map(submission => JSON.stringify(submission.parsedBody ?? {}))
}

/**
 * Queue one chat answer per single-prompt request.
 *
 * The mock model's 4,096-token answer ceiling cannot hold three 2,350-token
 * thumbnail prompts, so the generator asks for them one at a time. `answers`
 * is one entry per request, in order.
 */
function queuePromptRequests(answers: Array<{ state?: 'succeeded' | 'failed', outputText?: string }>): void {
  for (const answer of answers) {
    service.queueScenario('chat', {
      states: [answer.state ?? 'succeeded'],
      ...(answer.outputText === undefined ? {} : { outputText: answer.outputText }),
    })
  }
}

/** A project with one accepted episode, ready for thumbnail prompts. */
async function episodeProject(name: string): Promise<{ slug: string, episodeId: string }> {
  const project = await pm.createProject({ name, episode_prefix: 'EP', episode_digits: 3 })
  const ideas = await import('../services/idea-manager.js')
  const [idea] = await ideas.addIdeas(project.slug, [{
    title: 'The Hidden System',
    logline: 'Fixture.',
    themes: [],
    suggested_chapters: 1,
    suggested_length: 'short',
    mood: 'neutral',
  }], 'mock-chat-v1')
  const episodeId = (await ideas.acceptIdea(project.slug, idea!.id, false, { override_code: 'EP001' })).episode_code
  return { slug: project.slug, episodeId }
}

/**
 * A job object for calling the generator DIRECTLY.
 *
 * These tests are about what the generator writes, not about queue scheduling:
 * running them through the queue would leave a queued job behind for the next
 * test in this file (the queue dedupes per episode), and would make a pass
 * depend on this machine's timing. The executor reads nothing from the queue.
 */
let directJobSeq = 0
function directJob(slug: string, episodeId: string, params: Record<string, unknown> = {}): any {
  return {
    job_id: `test-thumbnail-prompts-${++directJobSeq}`,
    project_slug: slug,
    episode_id: episodeId,
    type: 'image_prompts',
    title: 'Thumbnail Prompts',
    status: 'running',
    params: { episode_id: episodeId, mode: 'thumbnails', model: 'mock-chat-v1', ...params },
    output_lines: [] as string[],
  }
}

const promptFilePath = async (slug: string, episodeId: string) =>
  toMdPath((await resolveEpisodePathsByCode(slug, episodeId)).thumb_prompts_docx)

// ── The ONE default ─────────────────────────────────────────────────────────

describe('the ONE default is 3, and a given count is used as given', () => {
  test('nothing given means three', () => {
    for (const absent of [undefined, null, '', 0, -1, NaN, 'not a number']) {
      assert.equal(thumbnailCount(absent), DEFAULT_THUMBNAIL_COUNT, `${String(absent)} should fall back`)
    }
    assert.equal(DEFAULT_THUMBNAIL_COUNT, 3, "the owner's number")
  })

  test('a count the caller gave is returned unchanged, uncapped', () => {
    for (const given of [1, 2, 3, 6, 10]) assert.equal(thumbnailCount(given), given)
    assert.equal(thumbnailCount('5'), 5, 'a numeric string is a count, not a blank')
  })

  test('the label is plain words — "3 options", never "variants"', () => {
    assert.equal(thumbnailOptionsLabel(1), '1 option')
    assert.equal(thumbnailOptionsLabel(3), '3 options')
    assert.doesNotMatch(thumbnailOptionsLabel(3), /variant/i)
  })
})

// ── A new channel starts at three; an existing one is untouched ─────────────

describe('a new channel starts with the seeded three-option preset', () => {
  test('the seeded preset carries the default count and names NO model', async () => {
    const created = await request(app).post('/api/projects').send({
      name: 'New Channel Thumbnail Default', episode_prefix: 'EP', episode_digits: 3,
    })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const config = await pm.getConfig(created.body.slug) as any
    assert.equal(config.thumbnail_prompts_presets.length, 1, 'exactly one seeded preset')
    const preset = config.thumbnail_prompts_presets[0]
    assert.equal(preset.name, 'Three thumbnail options')
    assert.equal(preset.data.form.thumb_count, DEFAULT_THUMBNAIL_COUNT)
    assert.equal(config.thumbnail_prompts_last_preset, preset.id, 'marked last-used')
    // AGENTS §1 / §5: a seed must never bake in a model. The owner chooses one.
    assert.equal(JSON.stringify(preset).includes('model'), false, 'the seed must not name a model')
  })

  test('creating a channel never rewrites another channel\'s thumbnail presets', async () => {
    const existing = await pm.createProject({ name: 'Existing Thumbnail Channel' })
    const configPath = path.join(pm.projectsRoot(), existing.slug, 'config.json')
    const theirs = JSON.parse(await fs.readFile(configPath, 'utf-8'))
    theirs.thumbnail_prompts_presets = [{
      id: 'preset-theirs', name: 'Their single option', data: { form: { thumb_count: 1, model: 'writer-of-theirs' } },
    }]
    theirs.thumbnail_prompts_last_preset = 'preset-theirs'
    await fs.writeFile(configPath, JSON.stringify(theirs, null, 2), 'utf-8')
    const before = await fs.readFile(configPath, 'utf-8')

    const fresh = await pm.createProject({ name: 'Another New Thumbnail Channel' })

    assert.equal(await fs.readFile(configPath, 'utf-8'), before, 'no existing channel is rewritten')
    assert.equal((await pm.getConfig(existing.slug) as any).thumbnail_prompts_presets[0].data.form.thumb_count, 1,
      'a channel that chose 1 keeps 1')
    assert.equal((await pm.getConfig(fresh.slug) as any).thumbnail_prompts_presets[0].data.form.thumb_count, 3,
      'while the channel created now starts at three')
  })
})

// ── The generator: default, complete, partial, retry, empty, failure ────────

describe('the prompt generator makes the default three, and reports what it could not make', () => {
  test('complete: no count named → 3 prompts written, all three verified', async () => {
    const { slug, episodeId } = await episodeProject('Generator Complete')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    queuePromptRequests([{ outputText: thumbnailReply(1) }, { outputText: thumbnailReply(1) }, { outputText: thumbnailReply(1) }])
    const callsBefore = chatPrompts().length

    // thumb_count is deliberately ABSENT: this is the default path.
    const job = directJob(slug, episodeId)
    await generateImagePrompts(job)

    assert.equal(chatPrompts().length - callsBefore, 3, 'the published answer ceiling split three prompts into three requests')
    assert.match(job.output_lines.join('\n'), /Target: 3 thumbnail prompt\(s\) — 3 options to choose from/)
    const content = await fs.readFile(await promptFilePath(slug, episodeId), 'utf-8')
    assert.equal((content.match(/^## Thumbnail \d+:/gm) || []).length, 3, 'three prompts on disk')
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.expected, 3, 'the run recorded the count it was given')
    assert.deepEqual(audit.missing, [], 'nothing missing')
  })

  test('partial: a 2-of-3 answer FAILS loudly naming Thumbnail 3, and keeps the two', async () => {
    const { slug, episodeId } = await episodeProject('Generator Partial')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    // Two requests answer with a prompt; the third returns an empty set.
    queuePromptRequests([
      { outputText: thumbnailReply(1) },
      { outputText: thumbnailReply(1) },
      { outputText: JSON.stringify({ thumbnails: [] }) },
    ])

    const job = directJob(slug, episodeId)
    await assert.rejects(() => generateImagePrompts(job), (error: any) => {
      assert.match(String(error?.message), /Thumbnail 3/, 'the missing prompt is named')
      return true
    })
    // The two prompts that were produced are KEPT, not thrown away.
    const content = await fs.readFile(await promptFilePath(slug, episodeId), 'utf-8')
    assert.equal((content.match(/^## Thumbnail \d+:/gm) || []).length, 2, 'the two good prompts are kept')
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.authoritative, true)
    assert.equal(audit.complete, false, '2 of 3 is NOT done')
    assert.deepEqual(audit.missing, [3], 'thumbnail 3 is the one missing')
  })

  test('retry: fill_gaps asks for ONLY the missing prompt and completes the set', async () => {
    const { slug, episodeId } = await episodeProject('Generator Retry')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    queuePromptRequests([
      { outputText: thumbnailReply(1) },
      { outputText: thumbnailReply(1) },
      { state: 'failed' },
    ])
    const first = directJob(slug, episodeId)
    const callsBeforeFirst = chatPrompts().length
    await assert.rejects(() => generateImagePrompts(first))
    const promptsAfterFirst = chatPrompts().length
    assert.equal(promptsAfterFirst - callsBeforeFirst, 3, 'the first run made one request per prompt')

    // Retry: the same request, as the job queue re-runs it.
    queuePromptRequests([{ outputText: thumbnailReply(1) }])
    const retry = directJob(slug, episodeId, { fill_gaps: true })
    await generateImagePrompts(retry)

    assert.match(retry.output_lines.join('\n'), /\[repair\] 2\/3 verified on disk; requesting only 1 missing thumbnail prompt\(s\)/)
    // The retry asked the model for ONE prompt, not three.
    const retryPrompts = chatPrompts().slice(promptsAfterFirst)
    assert.equal(retryPrompts.length, 1, 'one model call for the retry')
    assert.match(retryPrompts[0], /thumbnail numbers 3\b/, 'the retry asks only for thumbnail 3')
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.complete, true, 'the set is now complete')
    assert.deepEqual(audit.missing, [])
  })

  test('empty: a reply with no usable prompt is refused loudly, and nothing is claimed complete', async () => {
    const { slug, episodeId } = await episodeProject('Generator Empty')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    queuePromptRequests([
      { outputText: JSON.stringify({ thumbnails: [] }) },
      { outputText: JSON.stringify({ thumbnails: [] }) },
      { outputText: JSON.stringify({ thumbnails: [] }) },
    ])

    const job = directJob(slug, episodeId)
    await assert.rejects(() => generateImagePrompts(job), (error: any) => {
      assert.ok(String(error?.message).length > 0, 'the refusal says something')
      return true
    })
    // No prompt document is claimed complete.
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail').catch(() => null)
    assert.notEqual(audit?.complete, true, 'an empty answer is never complete')
  })

  test('provider failure: the job fails and no prompt file is claimed', async () => {
    const { slug, episodeId } = await episodeProject('Generator Failure')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    queuePromptRequests([{ state: 'failed' }, { state: 'failed' }, { state: 'failed' }])

    const job = directJob(slug, episodeId)
    await assert.rejects(() => generateImagePrompts(job))
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail').catch(() => null)
    assert.notEqual(audit?.complete, true, 'a provider failure is never complete')
  })

  test('malformed: an answer that is not a thumbnail object is refused, never claimed complete', async () => {
    const { slug, episodeId } = await episodeProject('Generator Malformed')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    queuePromptRequests([
      { outputText: '{ not json' },
      { outputText: JSON.stringify({ variations: [] }) },
      { outputText: JSON.stringify(['bare array']) },
    ])

    const job = directJob(slug, episodeId)
    await assert.rejects(() => generateImagePrompts(job), (error: any) => {
      assert.match(String(error?.message), /Thumbnail 1, Thumbnail 2, Thumbnail 3/,
        'every rejected item is named')
      return true
    })
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.authoritative, true)
    assert.equal(audit.complete, false, 'a malformed answer is never complete')
    assert.deepEqual(audit.missing, [1, 2, 3])
  })
})

// ── Completion follows the episode's own count, not the default ─────────────

describe('completion follows the episode\'s own count', () => {
  /** Writes N prompts for an episode and records `expected` in the manifest. */
  async function seedPrompts(slug: string, episodeId: string, written: number, expected: number) {
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const lines = ['# Thumbnail Prompts', '']
    for (let n = 1; n <= written; n++) lines.push(`## Thumbnail ${n}: Variation ${n}`, '', `A prompt for ${n}.`, '')
    await fs.writeFile(file, lines.join('\n'))
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', expected)
  }

  test('a preset that explicitly says 1 is respected (1 expected, 1 written = done)', async () => {
    const { slug, episodeId } = await episodeProject('Own Count One')
    await seedPrompts(slug, episodeId, 1, 1)
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.expected, 1)
    assert.equal(audit.complete, true, 'the default of 3 does not reopen a complete episode')
  })

  test('3 expected with 2 written is not done, and names only the missing one', async () => {
    const { slug, episodeId } = await episodeProject('Own Count Three')
    await seedPrompts(slug, episodeId, 2, 3)
    const audit = await inspectPromptCompletion(path.dirname(await promptFilePath(slug, episodeId)), episodeId, 'thumbnail')
    assert.equal(audit.complete, false)
    assert.deepEqual(audit.missing, [3])
  })

  test('a malformed manifest is not "done" (the answer is unknown, not complete)', async () => {
    const { slug, episodeId } = await episodeProject('Malformed Manifest')
    await seedPrompts(slug, episodeId, 3, 3)
    const file = await promptFilePath(slug, episodeId)
    await fs.writeFile(path.join(path.dirname(file), `${episodeId}_Thumbnail_Prompts.completion.json`), '{ not json')
    const audit = await inspectPromptCompletion(path.dirname(file), episodeId, 'thumbnail')
    assert.equal(audit.authoritative, true)
    assert.equal(audit.complete, false, 'an unreadable manifest never proves completion')
  })

  test('the Pipeline params mapper keeps an explicit old count and invents none', async () => {
    const { resolveStepParams } = await import('../routes/pipeline.js')
    const withCount = resolveStepParams('image_prompts', 'EP001', 'Title', {
      id: 'p', name: 'p', data: { form: { thumb_count: 1, model: 'writer' } },
    } as any, null)
    assert.equal((withCount as any).thumb_count, 1, 'an explicit 1 is not overwritten by the default')

    const withoutCount = resolveStepParams('image_prompts', 'EP001', 'Title', {
      id: 'p', name: 'p', data: { form: { model: 'writer' } },
    } as any, null)
    assert.equal('thumb_count' in (withoutCount as any), false,
      'no count is invented in the mapper — the generator takes the one default')
  })

  test('a preset carrying an unusable old count is normalised at read, never rewritten', async () => {
    const { resolveStepParams } = await import('../routes/pipeline.js')
    // A zero from an old build: the mapper heals it from the format default, and
    // the generator normalises whatever still arrives unusable.
    const zero = resolveStepParams('image_prompts', 'EP001', 'Title', {
      id: 'p', name: 'p', data: { form: { thumb_count: 0, model: 'writer' } },
    } as any, null)
    assert.equal(thumbnailCount((zero as any).thumb_count), DEFAULT_THUMBNAIL_COUNT)
    // A count stored as a string is still the count the owner chose.
    const asString = resolveStepParams('image_prompts', 'EP001', 'Title', {
      id: 'p', name: 'p', data: { form: { thumb_count: '5', model: 'writer' } },
    } as any, null)
    assert.equal(thumbnailCount((asString as any).thumb_count), 5)
    // An older explicit 5 (before the default became 3) stays 5: a default is not a rewrite.
    const oldFive = resolveStepParams('image_prompts', 'EP001', 'Title', {
      id: 'p', name: 'p', data: { form: { thumb_count: 5, model: 'writer' } },
    } as any, null)
    assert.equal(thumbnailCount((oldFive as any).thumb_count), 5)
  })
})

// ── Candidate images: the count, observed on disk ──────────────────────────

describe('candidate images are observed on disk, one per expected prompt', () => {
  async function seedImages(slug: string, episodeId: string, written: number) {
    const { resolveImageDirs } = await import('../generators/images.js')
    const { thumbDir } = await resolveImageDirs(slug, await promptFilePath(slug, episodeId), episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    for (let n = 1; n <= written; n++) {
      await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb${String(n).padStart(2, '0')}_v1.png`), ONE_PIXEL_PNG)
    }
    return thumbDir
  }

  test('3 expected with 3 images is done; with 2 it names the third', async () => {
    const { slug, episodeId } = await episodeProject('Image Count')
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const lines = ['# Thumbnail Prompts', '']
    for (let n = 1; n <= 3; n++) lines.push(`## Thumbnail ${n}: Variation ${n}`, '', `A prompt for ${n}.`, '')
    await fs.writeFile(file, lines.join('\n'))
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', 3)

    const { getImageStatus } = await import('../services/asset-status.js')
    const thumbDir = await seedImages(slug, episodeId, 2)
    let status = await getImageStatus(slug, episodeId, 'thumbnails')
    assert.equal(status.thumbnails?.total, 3, 'three candidates are expected')
    assert.equal(status.thumbnails?.present, 2)
    assert.deepEqual(status.thumbnails?.missing, [3], 'the third candidate is the one missing')

    // A zero-byte file is not a candidate: it cannot be uploaded.
    await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb03_v1.png`), '')
    status = await getImageStatus(slug, episodeId, 'thumbnails')
    assert.deepEqual(status.thumbnails?.missing, [3], 'an empty file is still missing')

    await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb03_v1.png`), ONE_PIXEL_PNG)
    status = await getImageStatus(slug, episodeId, 'thumbnails')
    assert.deepEqual(status.thumbnails?.missing, [], 'three usable candidates = done')
  })
})

// ── An accepted thumbnail is never reopened or replaced ────────────────────

describe('an accepted thumbnail is not reopened and not replaced', () => {
  test('an episode whose accepted thumbnail came with a complete set stays done', async () => {
    const { slug, episodeId } = await episodeProject('Accepted Complete')
    const { resolveImageDirs } = await import('../generators/images.js')
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const lines = ['# Thumbnail Prompts', '']
    for (let n = 1; n <= 3; n++) lines.push(`## Thumbnail ${n}: Variation ${n}`, '', `A prompt for ${n}.`, '')
    await fs.writeFile(file, lines.join('\n'))
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', 3)
    const { thumbDir, episodeDir } = await resolveImageDirs(slug, file, episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    for (const n of [1, 2, 3]) {
      await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb0${n}_v1.png`), ONE_PIXEL_PNG)
    }
    // The owner accepted candidate 3 through the picker.
    await fs.writeFile(path.join(episodeDir, 'upload_metadata_overrides.json'), JSON.stringify({
      youtube: { selected_thumbnail: `${episodeId}_Thumb03_v1.png` },
    }))

    const response = await request(app).get(`/api/projects/${slug}/episodes/${episodeId}/status`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.status.thumbnails, true, 'the episode stays done')

    // Nothing in this change rewrites what an accepted episode already holds:
    // the prompts, the count it recorded and the pinned file are untouched.
    const after = await fs.readFile(file, 'utf-8')
    assert.equal(after, lines.join('\n'), 'the prompt file is byte-identical')
    const manifest = JSON.parse(await fs.readFile(
      path.join(path.dirname(file), `${episodeId}_Thumbnail_Prompts.completion.json`), 'utf-8'))
    assert.equal(manifest.expected, 3, 'the recorded count is unchanged')
    assert.equal((await fs.readFile(path.join(thumbDir, `${episodeId}_Thumb03_v1.png`))).equals(ONE_PIXEL_PNG), true,
      'the accepted artwork is unchanged')
  })

  test('an uploaded episode with an accepted thumbnail and an OLD count of 1 is not reopened', async () => {
    const { slug, episodeId } = await episodeProject('Accepted Old Count')
    const { resolveImageDirs } = await import('../generators/images.js')
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, ['# Thumbnail Prompts', '', '## Thumbnail 1: Only', '', 'Prompt one.', ''].join('\n'))
    // An episode published under the old rule: one prompt, one image, accepted.
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', 1)
    const { thumbDir, episodeDir } = await resolveImageDirs(slug, file, episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb01_v1.png`), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(episodeDir, 'upload_metadata_overrides.json'), JSON.stringify({
      youtube: { selected_thumbnail: `${episodeId}_Thumb01_v1.png` },
    }))

    const response = await request(app).get(`/api/projects/${slug}/episodes/${episodeId}/status`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.status.thumbnails, true,
      'the new default of three does not backfill or reopen an episode complete under its own count')
  })

  test('a short set with one candidate pinned is still short (no partial set is called done)', async () => {
    const { slug, episodeId } = await episodeProject('Partial With Pin')
    const { resolveImageDirs } = await import('../generators/images.js')
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const lines = ['# Thumbnail Prompts', '']
    for (let n = 1; n <= 3; n++) lines.push(`## Thumbnail ${n}: Variation ${n}`, '', `A prompt for ${n}.`, '')
    await fs.writeFile(file, lines.join('\n'))
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', 3)
    const { thumbDir, episodeDir } = await resolveImageDirs(slug, file, episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    await fs.writeFile(path.join(thumbDir, `${episodeId}_Thumb01_v1.png`), ONE_PIXEL_PNG)
    await fs.writeFile(path.join(episodeDir, 'upload_metadata_overrides.json'), JSON.stringify({
      youtube: { selected_thumbnail: `${episodeId}_Thumb01_v1.png` },
    }))

    const response = await request(app).get(`/api/projects/${slug}/episodes/${episodeId}/status`)
    assert.equal(response.status, 200, JSON.stringify(response.body))
    assert.equal(response.body.status.thumbnails, false,
      'one pinned candidate does not complete a counted set (AGENTS §8; the music-channel precedent)')
    assert.deepEqual(response.body.thumbnail_images,
      { total: 3, present: 1, complete: false }, 'and the shortfall is still reported')
  })
})

// ── The accepted artwork is never re-rendered or replaced ─────────────────

describe('a re-run never replaces the artwork a person already has', () => {
  const FREE_MODEL = 'studio-hub::mock-image-v1'
  const freeCatalogRow = () => ({
    id: FREE_MODEL, display_name: 'Mock Fleet Image', description: 'In-process PNG fixture.',
    available: true, qualification_only: false, chargeable: false,
    aspect_ratios: ['16:9'], default_aspect_ratio: '16:9', default_resolution: '1K',
    output_options: [{
      resolution: '1K', aspect_ratio: '16:9', width: 1344, height: 768,
      is_default: true, credits_per_image: 0, price_version: 'free',
    }],
    max_prompt_characters: 4800, prompt_token_allowance: 1200, min_reference_images: 0, max_reference_images: 0,
  })

  test('existing candidates (one of them accepted) are kept: no submit, no charge, same bytes', async () => {
    const { slug, episodeId } = await episodeProject('No Replacement')
    const file = await promptFilePath(slug, episodeId)
    await fs.mkdir(path.dirname(file), { recursive: true })
    const lines = ['# Thumbnail Prompts', '']
    for (let n = 1; n <= 3; n++) lines.push(`## Thumbnail ${n}: Variation ${n}`, '', `A prompt for ${n}.`, '')
    await fs.writeFile(file, lines.join('\n'))
    await writePromptCompletionManifest(path.dirname(file), episodeId, 'thumbnail', 3)
    const { resolveImageDirs } = await import('../generators/images.js')
    const { thumbDir, episodeDir } = await resolveImageDirs(slug, file, episodeId)
    await fs.mkdir(thumbDir, { recursive: true })
    const acceptedName = `${episodeId}_Thumb02_v1.png`
    for (const name of [`${episodeId}_Thumb01_v1.png`, acceptedName, `${episodeId}_Thumb03_v1.png`]) {
      await fs.writeFile(path.join(thumbDir, name), ONE_PIXEL_PNG)
    }
    await fs.writeFile(path.join(episodeDir, 'upload_metadata_overrides.json'), JSON.stringify({
      youtube: { selected_thumbnail: acceptedName },
    }))
    const acceptedBefore = await fs.readFile(path.join(thumbDir, acceptedName))

    const originalFetch = globalThis.fetch
    const submissionsBefore = service.providerSubmissionCount('image')
    globalThis.fetch = async (input: any, init: any) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (url.pathname === '/v1/image/models') return Response.json([freeCatalogRow()])
      return originalFetch(input, init)
    }
    try {
      const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
      clearGenStudioCatalogCache()
      const { generateImages } = await import('../generators/images.js')
      const job = directJob(slug, episodeId, { mode: 'thumbs', aspect_ratio: '16:9', resolution: '1K', model: FREE_MODEL })
      await generateImages(job)

      const output = job.output_lines.join('\n')
      assert.match(output, /Skipping .*Thumb01/, 'an existing candidate is skipped')
      assert.match(output, /Skipping .*Thumb02/, 'including the accepted one')
      assert.equal(service.providerSubmissionCount('image') - submissionsBefore, 0,
        'nothing was submitted, so nothing was charged')
      assert.equal((await fs.readFile(path.join(thumbDir, acceptedName))).equals(acceptedBefore), true,
        'the accepted artwork is byte-identical')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
