/**
 * A failed chapter expansion leaves the same deterministic idempotency key on
 * Retry. The retry must take GenStudio 0.93.1's read-only lookup path, never
 * issue another POST for that key.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { useTempDataDir } from './_helpers.js'
import type { ChunkedNarrationParams } from '../lib/chunked-narration.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
} from './fixtures/mock-genstudio-service.js'

const temp = await useTempDataDir()

void test('an exact-replay chapter retry reaches GET by idempotency key with zero replacement submissions', async () => {
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { generateNarrativeChunked } = await import('../lib/chunked-narration.js')
    await import('../providers/text/genstudio.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const scriptDir = `${temp.dir}/scripts`
    const outline = JSON.stringify({
      chapters: [
        { n: 1, title: 'Chapter one', synopsis: 'First chapter.', key_beats: ['a', 'b'] },
        { n: 2, title: 'Chapter two', synopsis: 'Second chapter.', key_beats: ['c', 'd'] },
        { n: 3, title: 'Chapter three', synopsis: 'Third chapter.', key_beats: ['e', 'f'] },
      ],
    })
    service.queueScenario('chat', { states: ['succeeded'], outputText: outline })
    // Owner decision 2026-10-12: the lost batch gets one fresh resend, which is lost too.
    for (let index = 0; index < 2; index++) {
      service.queueScenario('chat', {
        states: ['failed'],
        failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN',
      })
    }

    const params: ChunkedNarrationParams = {
      episode_id: 'EP0001', title: 'Recovery wiring', totalChapters: 3,
      wordsPerChapter: 500,
      format: {
        id: 'narrative', name: 'Narrative', description: '', builtin: false, schemaVersion: 1,
        idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
        script: {
          systemPromptRole: 'role', additionalRules: [], pacingArc: [], closingHint: '',
          defaultChapterCount: 3, chapterCountRange: [3, 3], defaultLengthMinutes: 10,
          lengthMinutesRange: [10, 10], narratorStyles: [], defaultNarratorStyleId: '', chaptersIndependent: false,
        },
        imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [1, 1], defaultThumbnails: 1, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
        metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: '', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 0 } },
      },
      systemPrompt: 'Write exactly the requested chapters.', scriptDir, model: 'mock-chat-v1', apiKeys: {},
    }
    const makeJob = (recovery = false, recoveryKeys: string[] = []) => ({
      job_id: recovery ? 'retry-job' : 'original-job', project_slug: 'recovery-project',
      episode_id: 'EP0001', type: 'expand_chapters', status: 'running', output_lines: [], params: {},
      created_at: new Date().toISOString(), ...(recovery ? {
        genstudio_chat_recovery: true as const,
        genstudio_chat_recovery_keys: recoveryKeys,
      } : {}),
    }) as any

    await assert.rejects(
      generateNarrativeChunked(makeJob(), params),
      /lost track of this request/i,
    )
    assert.equal(service.providerSubmissionCount('chat'), 3, 'outline, the failed chapter batch and its one fresh resend')
    const historicChapterKey = service.submissions.at(-2)?.idempotencyKey
    assert.ok(historicChapterKey, 'the original chapter batch must retain its durable key')

    await assert.rejects(
      generateNarrativeChunked(makeJob(true, ['an-unrelated-recorded-key', historicChapterKey]), params),
      /lost track of this request/i,
    )
    // The retry may re-POST the already-sent resend's key, which the Gateway answers by replay.
    assert.equal(service.providerSubmissionCount('chat'), 3, 'the exact replay must not create a replacement request')
    assert.ok(service.requests.some(request =>
      request.method === 'GET'
      && request.path === `/v1/chat/responses/by-idempotency-key/${encodeURIComponent(historicChapterKey)}`,
    ), 'the retried generator must use the exact recorded chapter key, not entry order')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

void test('a conclusively failed outline retry posts once with a fresh durable key', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { buildOutlineOnly } = await import('../lib/chunked-narration.js')
    await import('../providers/text/genstudio.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const params: ChunkedNarrationParams = {
      episode_id: 'EP-OUTLINE-FRESH', title: 'Fresh outline retry', totalChapters: 3, wordsPerChapter: 500,
      format: {
        id: 'narrative', name: 'Narrative', description: '', builtin: false, schemaVersion: 1,
        idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
        script: { systemPromptRole: 'role', additionalRules: [], pacingArc: [], closingHint: '', defaultChapterCount: 3, chapterCountRange: [3, 3], defaultLengthMinutes: 10, lengthMinutesRange: [10, 10], narratorStyles: [], defaultNarratorStyleId: '', chaptersIndependent: false },
        imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [1, 1], defaultThumbnails: 1, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
        metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: '', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 0 } },
      },
      systemPrompt: 'Write exactly the requested outline.', scriptDir: `${temp.dir}/scripts`, model: 'mock-chat-v1', apiKeys: {},
    }
    const outline = JSON.stringify({ chapters: [
      { n: 1, title: 'One', synopsis: 'One.', key_beats: ['a'] },
      { n: 2, title: 'Two', synopsis: 'Two.', key_beats: ['b'] },
      { n: 3, title: 'Three', synopsis: 'Three.', key_beats: ['c'] },
    ] })
    service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_FAILED' })
    service.queueScenario('chat', { states: ['succeeded'], outputText: outline })
    const original = {
      job_id: 'outline-original', project_slug: 'outline-project', episode_id: params.episode_id,
      type: 'outline_only', status: 'running', output_lines: [], params: {}, created_at: new Date().toISOString(),
    } as any
    await assert.rejects(buildOutlineOnly(original, params, 'narrative'), /writing model/i)
    const historicKey = service.submissions[0]?.idempotencyKey
    assert.ok(historicKey)

    const retry = {
      ...original,
      job_id: 'outline-retry',
      genstudio_chat_retry_scope: 'terminal:mock-chat-001:outline-original',
    }
    await buildOutlineOnly(retry, params, 'narrative')

    const chatPosts = service.submissions.filter(submission => submission.operation === 'chat')
    assert.equal(chatPosts.length, 2, 'a settled terminal outline retry is allowed exactly one fresh provider POST')
    assert.notEqual(chatPosts[1]?.idempotencyKey, historicKey, 'the fresh retry must mint a different request identity/key')
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

void test('multiple listicle recovery keys match by exact membership, not request order, with zero replacement submissions', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { generateListicleChunked } = await import('../lib/chunked-narration.js')
    await import('../providers/text/genstudio.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const params: ChunkedNarrationParams = {
      episode_id: 'EP-LISTICLE-RECOVERY', title: 'Listicle recovery', totalChapters: 9, wordsPerChapter: 500,
      format: {
        id: 'listicle', name: 'Listicle', description: '', builtin: false, schemaVersion: 1,
        idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
        script: { systemPromptRole: 'role', additionalRules: [], pacingArc: [], closingHint: '', defaultChapterCount: 9, chapterCountRange: [9, 9], defaultLengthMinutes: 10, lengthMinutesRange: [10, 10], narratorStyles: [], defaultNarratorStyleId: '', chaptersIndependent: true },
        imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [1, 1], defaultThumbnails: 1, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
        metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: '', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 0 } },
      },
      systemPrompt: 'Write exactly the requested listicle.', scriptDir: `${temp.dir}/scripts`, model: 'mock-chat-v1', apiKeys: {},
    }
    const outline = JSON.stringify({ chapters: Array.from({ length: 9 }, (_, index) => ({
      n: index + 1, title: `Topic ${index + 1}`, hook_line: `Hook ${index + 1}`, key_facts: ['fact'],
    })) })
    service.queueScenario('chat', { states: ['succeeded'], outputText: outline })
    // Three batches, each lost and its one fresh resend lost too (owner decision 2026-10-12).
    for (let index = 0; index < 6; index++) {
      service.queueScenario('chat', { states: ['failed'], failureCode: 'LANGUAGE_PROVIDER_SUBMISSION_UNCERTAIN' })
    }
    const original = {
      job_id: 'listicle-original', project_slug: 'listicle-project', episode_id: params.episode_id,
      type: 'expand_chapters', status: 'running', output_lines: [], params: {}, created_at: new Date().toISOString(),
    } as any
    await generateListicleChunked(original, params)
    const historicKeys = service.submissions
      .filter(submission => submission.operation === 'chat' && !submission.idempotencyKey.startsWith('story-chat-resend-'))
      .slice(1)
      .map(submission => submission.idempotencyKey)
    assert.ok(historicKeys.length > 1, 'the fixture must create multiple independent listicle batches')
    const submissionsBeforeRetry = service.providerSubmissionCount('chat')

    const retry = {
      ...original,
      job_id: 'listicle-retry',
      genstudio_chat_recovery: true as const,
      genstudio_chat_recovery_keys: [...historicKeys].reverse(),
    }
    await generateListicleChunked(retry, params)

    // A re-POST of an already-sent resend key is answered by replay; no new provider work.
    assert.equal(service.providerSubmissionCount('chat'), submissionsBeforeRetry,
      'listicle recovery must not post a replacement for any recorded key')
    const recoveredKeys = service.requests
      .filter(request => request.method === 'GET' && request.path.startsWith('/v1/chat/responses/by-idempotency-key/'))
      .map(request => decodeURIComponent(request.path.slice('/v1/chat/responses/by-idempotency-key/'.length)))
    assert.deepEqual(new Set(recoveredKeys), new Set(historicKeys))
  } finally {
    await service.close()
    await temp.cleanup()
  }
})

void test('a manual narrative repair retry retrieves its recorded result and writes every original slot without POSTing', async () => {
  const temp = await useTempDataDir()
  const service = await startMockGenStudioService()
  process.env.STORY_STUDIO_DISABLE_LISTEN = '1'
  try {
    const settings = await import('../services/app-settings.js')
    const secrets = await import('../services/app-secrets-store.js')
    const client = await import('../lib/genstudio-client.js')
    const { expandChapters, writeImportedOutline } = await import('../lib/chunked-narration.js')
    await import('../providers/text/genstudio.js')
    await settings.setGenStudioUrl(service.baseUrl)
    await secrets.setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
    client.clearGenStudioCatalogCache()

    const episodeId = 'EP-REPAIR-RECOVERY'
    const scriptDir = `${temp.dir}/scripts`
    await writeImportedOutline(scriptDir, episodeId, [
      { title: 'Chapter 1' }, { title: 'Chapter 2' },
    ])
    const repairKey = 'repair-recorded-key'
    const repairText = [1, 2].map(number =>
      `## Chapter ${String(number).padStart(2, '0')}: Chapter ${number}\n\nRecovered narration for chapter ${number}.`,
    ).join('\n\n')
    service.queueScenario('chat', { states: ['succeeded'], outputText: repairText })
    const seeded = await fetch(`${service.baseUrl}/v1/chat/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MOCK_GENSTUDIO_FULL_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': repairKey,
      },
      body: JSON.stringify({ model_id: 'mock-chat-v1', input: [{ role: 'user', content: 'repair seed' }], response_format: { type: 'text' }, max_output_tokens: 2048 }),
    })
    assert.equal(seeded.status, 202)
    const postsBeforeRetry = service.requests.filter(request => request.method === 'POST' && request.path === '/v1/chat/responses').length
    const job = {
      job_id: 'repair-retry', project_slug: 'repair-project', episode_id: episodeId,
      type: 'expand_chapters', status: 'running', output_lines: [], params: {}, created_at: new Date().toISOString(),
      genstudio_chat_recovery: true as const,
      genstudio_chat_recovery_key: repairKey,
      genstudio_chat_recovery_purpose: 'narrative-repair' as const,
      genstudio_chat_recovery_chapters: [1, 2],
      genstudio_chat_recovery_keys: [repairKey],
    } as any
    await expandChapters(job, {
      episode_id: episodeId, title: 'Recovered repair', totalChapters: 2, wordsPerChapter: 100,
      format: {
        id: 'narrative', name: 'Narrative', description: '', builtin: false, schemaVersion: 1,
        idea: { systemPromptRole: '', audienceDefault: '', moodVocabulary: [], themeVocabulary: [], guidanceText: '' },
        script: { systemPromptRole: 'role', additionalRules: [], pacingArc: [], closingHint: '', defaultChapterCount: 2, chapterCountRange: [2, 2], defaultLengthMinutes: 10, lengthMinutesRange: [10, 10], narratorStyles: [], defaultNarratorStyleId: '', chaptersIndependent: false },
        imagePrompts: { purposeNote: '', visualStyleHint: '', defaultScenesTotalRange: [1, 1], defaultThumbnails: 1, defaultStyleTag: '', characterReferenceMode: 'inline', recommendedAspect: '16:9' },
        metadata: { purposeNote: '', titleStyleHint: '', titleHookRules: [], tagsContext: '', tagsHookRules: [], broadKeywords: [], youtubeDescriptionStructure: { musicLabel: '', booksSectionLabel: '', supportSection: '', aiDisclosure: '', defaultHashtags: [], totalHashtagCount: 0 } },
      },
      systemPrompt: 'Write exactly the requested chapters.', scriptDir, model: 'mock-chat-v1', apiKeys: {},
    })

    assert.equal(
      service.requests.filter(request => request.method === 'POST' && request.path === '/v1/chat/responses').length,
      postsBeforeRetry,
      'repair recovery must use only the existing durable result',
    )
    assert.ok(service.requests.some(request =>
      request.method === 'GET'
      && request.path === `/v1/chat/responses/by-idempotency-key/${repairKey}`,
    ))
    for (const chapter of [1, 2]) {
      assert.equal(existsSync(`${scriptDir}/${episodeId}_Chapter_${String(chapter).padStart(2, '0')}.md`), true)
    }
  } finally {
    await service.close()
    await temp.cleanup()
  }
})
