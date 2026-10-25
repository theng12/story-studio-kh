/**
 * Thumbnail text suggestions — model resolution and language detection.
 *
 * Covers:
 * - AGENTS §1 / requirement 7: the model sent is the ACTIVE Thumbnail Prompts
 *   preset's model, re-read on every call; a preset that names no model refuses
 *   plainly and submits nothing.
 * - Language resolution: channel > script > title.
 *
 * No real Gateway and no real model: every request is served by the in-process
 * mock GenStudio service (`fixtures/mock-genstudio-service.ts`), the same seam
 * `scene-plan-credit-floor.test.ts` uses. The submitted `model_id` is read back
 * off the mock's recorded submissions, so the assertion is about what the code
 * actually sent, not what it intended to send.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import {
  modelFromThumbnailPromptsPreset,
  resolveSuggestionLanguage,
  suggestThumbnailHeadlines,
} from '../services/thumbnail-text-suggestions.js'

let cleanup: (() => Promise<void>) | undefined
let service: MockGenStudioService

/** A chat product the live catalogue will accept as usable. */
function usableChatModel(id: string): Record<string, unknown> {
  return {
    id,
    display_name: id,
    description: 'In-process writer fixture.',
    available: true,
    qualification_only: false,
    context_window_tokens: 128_000,
    max_output_tokens: 4_096,
    max_structured_items_per_request: null,
    controls: ['temperature'],
    activation_blockers: [],
    supports_structured_output: true,
    structured_output_mode: 'request_json_schema',
  }
}

function headlineReply(): string {
  return JSON.stringify({
    suggestions: [
      { text: 'សួស្តី', length: 'short' },
      { text: 'ពិភពលោក', length: 'medium' },
      { text: 'ចំណងជើងវែង', length: 'long' },
    ],
  })
}

/** Every chat request the mock actually received. */
function chatSubmissions(): Array<Record<string, unknown>> {
  return service.submissions
    .filter(submission => submission.operation === 'chat')
    .map(submission => (submission.parsedBody || {}) as Record<string, unknown>)
}

before(async () => {
  await import('../providers/text/genstudio.js')
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  service = await startMockGenStudioService()
  const settings = await import('../services/app-settings.js')
  const { setApiKey } = await import('../services/app-secrets-store.js')
  const { clearGenStudioCatalogCache } = await import('../lib/genstudio-client.js')
  // Two usable writers, so "which model was sent" can only be answered by the preset.
  service.chatModels = [usableChatModel('writer-preset-a'), usableChatModel('writer-preset-b')]
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()
})

after(async () => {
  await new Promise<void>(resolve => service.server.close(() => resolve()))
  await cleanup?.()
})

describe('thumbnail-text suggestions — the submitted model is the active preset model', () => {
  test('submits the active preset model, and re-reads the selection on the next call', async () => {
    const config: Record<string, any> = {
      thumbnail_prompts_presets: [
        { id: 'a', data: { form: { model: 'writer-preset-a' } } },
        { id: 'b', data: { form: { model: 'writer-preset-b' } } },
      ],
      thumbnail_prompts_last_preset: 'b',
    }
    const input = {
      config,
      source: { title: 'English title', script: 'Episode script', channelLanguage: 'km' },
      where: 'the Thumbnail Prompts page',
    }

    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const first = await suggestThumbnailHeadlines(input)
    assert.equal(first.model, 'writer-preset-b')
    assert.equal(first.language, 'km')
    assert.equal(first.language_source, 'channel')
    assert.deepEqual(first.suggestions.map(s => s.text), ['សួស្តី', 'ពិភពលោក', 'ចំណងជើងវែង'])

    // Switching the ACTIVE preset changes the model the very next call sends.
    config.thumbnail_prompts_last_preset = 'a'
    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const second = await suggestThumbnailHeadlines(input)
    assert.equal(second.model, 'writer-preset-a')

    const submitted = chatSubmissions()
    assert.equal(submitted.length, 2, 'one chat request per call, no retries and no fallback model')
    assert.deepEqual(
      submitted.map(body => body.model_id),
      ['writer-preset-b', 'writer-preset-a'],
      'the model actually sent must be the active preset model, in order',
    )
    // The headline language travelled with the request.
    assert.match(JSON.stringify(submitted[0]), /Khmer/)
  })

  test('a preset whose model is not in the live catalogue is refused, never substituted', async () => {
    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const before = chatSubmissions().length
    await assert.rejects(
      () => suggestThumbnailHeadlines({
        config: {
          thumbnail_prompts_presets: [{ id: 'a', data: { form: { model: 'writer-not-available' } } }],
          thumbnail_prompts_last_preset: 'a',
        },
        source: { title: 'Title', script: '' },
        where: 'the Thumbnail Prompts page',
      }),
      (error: any) => {
        assert.match(error.message, /writer-not-available/)
        assert.match(error.message, /did not switch to a different model/i)
        return true
      },
    )
    assert.equal(chatSubmissions().length, before, 'nothing was submitted for an unusable model')
  })

  test('a preset that names no model refuses plainly and submits nothing (§1)', async () => {
    const before = chatSubmissions().length
    await assert.rejects(
      () => suggestThumbnailHeadlines({
        config: {
          thumbnail_prompts_presets: [{ id: 'a', model: 'writer-preset-a' }, { id: 'b', data: {} }],
          thumbnail_prompts_last_preset: 'b',
        },
        source: { title: 'Title', script: '' },
        where: 'the Thumbnail Prompts page',
      }),
      (error: any) => {
        assert.match(error.message, /No writing model/i)
        assert.match(error.message, /Choose one on the Thumbnail Prompts page/i)
        // The model named by another preset is never quietly used.
        assert.doesNotMatch(error.message, /writer-preset-a/)
        return true
      },
    )
    assert.equal(chatSubmissions().length, before, 'a model-less preset must not reach the Gateway')
  })

  test('an absent configuration refuses before any request is made', async () => {
    const before = chatSubmissions().length
    await assert.rejects(
      () => suggestThumbnailHeadlines({
        config: null,
        source: { title: 'Test', script: 'Script' },
        where: 'the Thumbnail Prompts page',
      }),
      /Story Studio does not pick/i,
    )
    assert.equal(chatSubmissions().length, before)
  })
})

describe('thumbnail-text suggestions — the model name read out of a preset', () => {
  test('reads data.form.model of the active preset', () => {
    assert.equal(modelFromThumbnailPromptsPreset({
      thumbnail_prompts_presets: [
        { id: 'p1', data: { form: { model: 'model-A' } } },
        { id: 'p2', data: { form: { model: 'model-B' } } },
      ],
      thumbnail_prompts_last_preset: 'p2',
    }), 'model-B')
  })

  test('reads a flat model field (older preset shape)', () => {
    assert.equal(modelFromThumbnailPromptsPreset({
      thumbnail_prompts_presets: [{ id: 'p1', model: 'flat-model' }],
      thumbnail_prompts_last_preset: 'p1',
    }), 'flat-model')
  })

  test('reads the legacy prompt_model field', () => {
    assert.equal(modelFromThumbnailPromptsPreset({
      thumbnail_prompts_presets: [{ id: 'p1', data: { prompt_model: 'legacy-model' } }],
      thumbnail_prompts_last_preset: 'p1',
    }), 'legacy-model')
  })

  test('falls back to the last-used preset, then the last entry', () => {
    assert.equal(modelFromThumbnailPromptsPreset({
      thumbnail_prompts_presets: [
        { id: 'p1', data: { form: { model: 'model-A' } } },
        { id: 'p2', data: { form: { model: 'model-B' } }, last_used: true },
      ],
    }), 'model-B')
    assert.equal(modelFromThumbnailPromptsPreset({
      thumbnail_prompts_presets: [
        { id: 'p1', data: { form: { model: 'model-A' } } },
        { id: 'p2', data: { form: { model: 'model-B' } } },
      ],
    }), 'model-B')
  })

  test('the selection changes immediately when the active preset changes', () => {
    const config: Record<string, any> = {
      thumbnail_prompts_presets: [
        { id: 'a', data: { form: { model: 'writer-a' } } },
        { id: 'b', data: { form: { model: 'writer-b' } } },
      ],
      thumbnail_prompts_last_preset: 'b',
    }
    assert.equal(modelFromThumbnailPromptsPreset(config), 'writer-b')
    config.thumbnail_prompts_last_preset = 'a'
    assert.equal(modelFromThumbnailPromptsPreset(config), 'writer-a')
  })

  test('reads no model out of an absent or empty configuration', () => {
    for (const config of [null, undefined, {}, { thumbnail_prompts_presets: [] }]) {
      assert.equal(modelFromThumbnailPromptsPreset(config as any), '')
    }
  })
})

describe('thumbnail-text suggestions — language resolution', () => {
  test('channel language wins when present', () => {
    const result = resolveSuggestionLanguage({
      title: 'English Title',
      script: 'English script',
      channelLanguage: 'km',
    })
    assert.equal(result.language, 'km')
    assert.equal(result.language_source, 'channel')
  })

  test('channel language ignores a region subtag', () => {
    const result = resolveSuggestionLanguage({
      title: 'Title',
      script: 'Script',
      channelLanguage: 'en-US',
    })
    assert.equal(result.language, 'en')
    assert.equal(result.language_source, 'channel')
  })

  test('a Khmer script wins over a Latin title when the channel states nothing', () => {
    const result = resolveSuggestionLanguage({
      title: 'English Title',
      script: 'សួស្តីពិភពលោក',
      channelLanguage: null,
    })
    assert.equal(result.language, 'km')
    assert.equal(result.language_source, 'script')
  })

  test('a Latin title alone is read as English', () => {
    const result = resolveSuggestionLanguage({ title: 'Hello World', script: '', channelLanguage: '' })
    assert.equal(result.language, 'en')
    assert.equal(result.language_source, 'title')
  })

  test('defaults to en when nothing distinctive is found', () => {
    const result = resolveSuggestionLanguage({ title: '', script: '', channelLanguage: null })
    assert.equal(result.language, 'en')
    assert.equal(result.language_source, 'title')
  })
})
