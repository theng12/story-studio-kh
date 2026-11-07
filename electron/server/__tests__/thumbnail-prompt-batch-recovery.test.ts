/**
 * Thumbnail prompt batching — the recovery contract of the 1.4.386 image-prompts
 * fix (AGENTS §8, verified completion).
 *
 * The mock chat model publishes a 4,096-token answer ceiling and one thumbnail
 * prompt is sized at 2,350 answer tokens, so three prompts are THREE
 * single-prompt requests. The generator must:
 *   - write every completed batch to disk BEFORE the next provider request, so
 *     a later failure keeps output that is already valid and already paid for;
 *   - still fail the run loudly, naming exactly the missing prompts;
 *   - on `fill_gaps` Retry, request ONLY the missing prompt — never re-bill the
 *     ones already verified on disk.
 *
 * Scenario: request 1 succeeds, request 2 fails at the provider, request 3
 * succeeds. The run must leave prompts 1 and 3 on disk, name only Thumbnail 2,
 * and the retry must make exactly one more request.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import { inspectPromptCompletion } from '../services/prompt-completion.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import { toMdPath } from '../lib/episode-artifacts.js'

let cleanup: () => Promise<void>
let service: MockGenStudioService
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
  pm = await import('../services/project-manager.js')
})

after(async () => {
  await new Promise<void>(resolve => service.server.close(() => resolve()))
  await cleanup?.()
})

function thumbnailReply(): string {
  return JSON.stringify({
    thumbnails: [{
      number: 1,
      title: 'Variation 1',
      prompt: 'A bold thumbnail for variation 1, one clear focal subject.',
    }],
  })
}

/**
 * Every chat request the mock actually performed, in order.
 *
 * Replays of a settled job are excluded: a retry moves its identity after a
 * settled failure and submits fresh work, so a replay is not another request.
 */
function chatPrompts(): string[] {
  return service.submissions
    .filter(submission => submission.operation === 'chat' && !submission.replay)
    .map(submission => JSON.stringify(submission.parsedBody ?? {}))
}

let directJobSeq = 0
function directJob(slug: string, episodeId: string, params: Record<string, unknown> = {}): any {
  return {
    job_id: `test-thumbnail-recovery-${++directJobSeq}`,
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

/** One `## Thumbnail N:` section of the prompt document. */
function promptSection(markdown: string, number: number): string {
  const start = markdown.indexOf(`## Thumbnail ${number}:`)
  assert.ok(start >= 0, `Thumbnail ${number} is on disk`)
  const next = markdown.indexOf('\n## Thumbnail ', start + 1)
  return next < 0 ? markdown.slice(start) : markdown.slice(start, next)
}

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

describe('thumbnail prompt batches survive a later provider failure and retry only the gap', () => {
  test('ok / failed / ok leaves prompts 1 and 3 on disk, names only Thumbnail 2, and the retry makes one more request', async () => {
    const { slug, episodeId } = await episodeProject('Batch Recovery')
    const { generateImagePrompts } = await import('../generators/image-prompts.js')
    const file = await promptFilePath(slug, episodeId)

    service.queueScenario('chat', { states: ['succeeded'], outputText: thumbnailReply() })
    service.queueScenario('chat', { states: ['failed'] })
    service.queueScenario('chat', { states: ['succeeded'], outputText: thumbnailReply() })

    const job = directJob(slug, episodeId)
    await assert.rejects(() => generateImagePrompts(job), (error: any) => {
      assert.match(String(error?.message), /Thumbnail 2/, 'the failed prompt is named')
      assert.doesNotMatch(String(error?.message), /Thumbnail 1\b|Thumbnail 3\b/,
        'the two prompts already on disk are not reported missing')
      return true
    })

    // The checkpoint writer ran BEFORE the next provider request went out.
    const lines = job.output_lines
    const firstSave = lines.findIndex(line => /^Saved thumbnails/.test(line))
    const secondRequest = lines.findIndex(line => /\(request 2\/3\)/.test(line))
    assert.ok(firstSave >= 0 && secondRequest >= 0, 'both the save and the second request were logged')
    assert.ok(firstSave < secondRequest, 'batch 1 reached disk before request 2 went out')

    assert.equal(chatPrompts().length, 3, 'one request per prompt: the failure did not skip the third')
    const afterFailure = await fs.readFile(file, 'utf-8')
    assert.equal((afterFailure.match(/^## Thumbnail \d+:/gm) || []).length, 2,
      'the successful batches are kept, not thrown away')
    assert.match(afterFailure, /^## Thumbnail 1:/m)
    assert.match(afterFailure, /^## Thumbnail 3:/m)
    assert.doesNotMatch(afterFailure, /^## Thumbnail 2:/m, 'the failed batch wrote nothing')
    const keptOne = promptSection(afterFailure, 1)
    const keptThree = promptSection(afterFailure, 3)

    const audit = await inspectPromptCompletion(path.dirname(file), episodeId, 'thumbnail')
    assert.equal(audit.authoritative, true)
    assert.equal(audit.complete, false, '2 of 3 is not done')
    assert.deepEqual(audit.missing, [2], 'Thumbnail 2 is the only gap')

    // Retry exactly as the job queue re-runs it: only the missing prompt.
    service.queueScenario('chat', { states: ['succeeded'], outputText: thumbnailReply() })
    const retry = directJob(slug, episodeId, { fill_gaps: true })
    await generateImagePrompts(retry)

    const retryPrompts = chatPrompts().slice(3)
    assert.equal(retryPrompts.length, 1, 'the retry made one request, not three')
    assert.match(retryPrompts[0], /thumbnail numbers 2\b/, 'and asked only for the missing prompt')

    const completed = await fs.readFile(file, 'utf-8')
    assert.equal((completed.match(/^## Thumbnail \d+:/gm) || []).length, 3, 'the set is now complete')
    // The retry re-saves the document (the parser joins paragraphs with a
    // space), so compare content, not whitespace. The words must be unchanged
    // and the render clauses must not be appended a second time.
    const words = (text: string) => text.replace(/\s+/g, ' ').trim()
    assert.equal(words(promptSection(completed, 1)), words(keptOne), 'the completed prompt 1 was not re-decided')
    assert.equal(words(promptSection(completed, 3)), words(keptThree), 'the completed prompt 3 was not re-decided')
    assert.equal((completed.match(/Render the exact title/g) || []).length, 3,
      'the render clauses appear once per prompt, not twice')
    const finalAudit = await inspectPromptCompletion(path.dirname(file), episodeId, 'thumbnail')
    assert.equal(finalAudit.complete, true)
    assert.deepEqual(finalAudit.missing, [])
    assert.equal(chatPrompts().length, 4, 'three first-run requests plus one retry request')
  })
})
