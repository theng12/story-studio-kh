/**
 * Thumbnail text language — the authority, the per-episode override, and the sidecar.
 *
 * The bug this pins: the suggestions route read the channel language from
 * `config.content_language`, which nothing ever writes, so a channel that states its language in
 * `project.content_language` (the app's one authority — `lib/content-language.ts`) was ignored.
 *
 * Covers:
 * - default = `project.content_language`, even when a stale `config.content_language` disagrees;
 * - an episode's own override is used by the suggestions and persists;
 * - clearing the override returns the episode to following the channel;
 * - choosing an override never modifies the channel's own language;
 * - a malformed/unsupported setting file refuses loudly rather than silently following (AGENTS §6).
 *
 * No real Gateway: every chat request is served by the in-process mock GenStudio service, the same
 * seam `thumbnail-text-suggestions.test.ts` uses.
 */
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import express from 'express'
import fs from 'node:fs/promises'
import path from 'node:path'
import request from 'supertest'
import { useTempDataDir } from './_helpers.js'
import {
  MOCK_GENSTUDIO_FULL_KEY,
  startMockGenStudioService,
  type MockGenStudioService,
} from './fixtures/mock-genstudio-service.js'
import {
  THUMBNAIL_TEXT_SETTINGS_FILENAME,
  effectiveThumbnailTextLanguage,
  isThumbnailTextLanguage,
  readThumbnailTextLanguage,
  writeThumbnailTextLanguage,
} from '../services/thumbnail-text-settings.js'
import { resolveSuggestionLanguage } from '../services/thumbnail-text-suggestions.js'
import type { ThumbnailTextSuggestions } from '../contracts/thumbnail-text.js'

let cleanup: (() => Promise<void>) | undefined
let service: MockGenStudioService
let app: express.Express
let slug: string
let episodeDir: string
const code = 'EP0001'
const endpoint = (action: string) => `/api/projects/${slug}/episodes/${code}/thumbnail-text/${action}`

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
  return JSON.stringify({ suggestions: [{ text: 'ចំណងជើង', length: 'short' }] })
}

/** Every chat request the mock actually received, so "what was sent" is asserted, not intended. */
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
  const pm = await import('../services/project-manager.js')
  const { resolveEpisodePaths } = await import('../services/utils.js')

  service.chatModels = [usableChatModel('writer-a')]
  await settings.setGenStudioUrl(service.baseUrl)
  await setApiKey('genstudio', MOCK_GENSTUDIO_FULL_KEY)
  clearGenStudioCatalogCache()

  const project = await pm.createProject({ name: 'Thumbnail text language', content_language: 'km' })
  slug = project.slug
  // A stale copy of the language in config.json — the field the route used to read. Nothing writes
  // it, so a channel language set on the project would be ignored. The override must beat this too.
  await pm.updateConfig(slug, {
    content_language: 'en',
    thumbnail_prompts_presets: [{ id: 'p1', data: { form: { model: 'writer-a' } } }],
    thumbnail_prompts_last_preset: 'p1',
  } as any)

  episodeDir = (await resolveEpisodePaths(slug, code, '')).episode_dir
  await fs.mkdir(episodeDir, { recursive: true })

  const { router } = await import('../routes/thumbnail-text.js')
  app = express().use(express.json()).use('/api', router)
})

after(async () => {
  await new Promise<void>(resolve => service.server.close(() => resolve()))
  await cleanup?.()
})

// ── Pure resolution ─────────────────────────────────────────────────────────

describe('thumbnail text language — resolving the effective value', () => {
  test('an override beats the channel language and says so', () => {
    assert.deepEqual(effectiveThumbnailTextLanguage('en', 'km'), { language: 'en', source: 'override' })
  })

  test('with no override the channel language is used', () => {
    assert.deepEqual(effectiveThumbnailTextLanguage(null, 'km'), { language: 'km', source: 'channel' })
  })

  test('with neither, there is no language (the suggestions fall back to script/title)', () => {
    assert.deepEqual(effectiveThumbnailTextLanguage(null, null), { language: null, source: null })
  })

  test('only the app\'s two languages are accepted', () => {
    assert.equal(isThumbnailTextLanguage('en'), true)
    assert.equal(isThumbnailTextLanguage('km'), true)
    assert.equal(isThumbnailTextLanguage('th'), false)
    assert.equal(isThumbnailTextLanguage(''), false)
    assert.equal(isThumbnailTextLanguage(null), false)
  })

  test('the override is reported as its own source, not as "channel"', () => {
    const result = resolveSuggestionLanguage({ title: 'Title', script: 'Script', channelLanguage: 'km', overrideLanguage: 'en' })
    assert.equal(result.language, 'en')
    assert.equal(result.language_source, 'override')
  })

  test('no override still reports the channel language as the channel', () => {
    const result = resolveSuggestionLanguage({ title: 'Title', script: 'Script', channelLanguage: 'km', overrideLanguage: null })
    assert.equal(result.language, 'km')
    assert.equal(result.language_source, 'channel')
  })
})

// ── The sidecar (per episode) ───────────────────────────────────────────────

describe('thumbnail text language — the per-episode sidecar', () => {
  const readFile = () => fs.readFile(path.join(episodeDir, THUMBNAIL_TEXT_SETTINGS_FILENAME), 'utf8')

  test('an absent file means "follow the channel language"', async () => {
    await fs.rm(path.join(episodeDir, THUMBNAIL_TEXT_SETTINGS_FILENAME), { force: true })
    assert.equal(await readThumbnailTextLanguage(slug, code), null)
  })

  test('writing a language round-trips, and writing null restores following', async () => {
    await writeThumbnailTextLanguage(slug, code, 'en')
    assert.equal(await readThumbnailTextLanguage(slug, code), 'en')
    assert.match(await readFile(), /"language": "en"/)
    await writeThumbnailTextLanguage(slug, code, null)
    assert.equal(await readThumbnailTextLanguage(slug, code), null)
    // "Following" is WRITTEN, not deleted — an explicit choice, not an absent file.
    assert.match(await readFile(), /"language": null/)
  })

  test('a malformed file refuses loudly rather than silently following (§6)', async () => {
    await fs.writeFile(path.join(episodeDir, THUMBNAIL_TEXT_SETTINGS_FILENAME), 'not json')
    await assert.rejects(() => readThumbnailTextLanguage(slug, code), /malformed/i)
  })

  test('a file naming an unsupported language refuses loudly', async () => {
    await fs.writeFile(path.join(episodeDir, THUMBNAIL_TEXT_SETTINGS_FILENAME), JSON.stringify({ schema: 1, language: 'th' }))
    await assert.rejects(() => readThumbnailTextLanguage(slug, code), /does not support/i)
  })
})

// ── The routes (through the real suggestions service + mock GenStudio) ──────

describe('thumbnail text language — the routes', () => {
  test('the language defaults to the project authority, never the stale config copy', async () => {
    // Start from "follows the channel" — the sidecar block above deliberately left bad files behind.
    await fs.rm(path.join(episodeDir, THUMBNAIL_TEXT_SETTINGS_FILENAME), { force: true })
    // The config copy says 'en'; the project says 'km'. The project wins.
    const settings = await request(app).get(endpoint('settings'))
    assert.equal(settings.status, 200, JSON.stringify(settings.body))
    assert.equal(settings.body.channel_language, 'km')
    assert.equal(settings.body.override, null)
    assert.equal(settings.body.effective, 'km')

    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const response = await request(app).post(endpoint('suggestions')).send({})
    assert.equal(response.status, 200, JSON.stringify(response.body))
    const body = response.body as ThumbnailTextSuggestions
    assert.equal(body.language, 'km', 'the stale config.content_language must not decide')
    assert.equal(body.language_source, 'channel')
  })

  test('an override is used by the suggestions and persists; clearing it follows the channel again', async () => {
    const saved = await request(app).put(endpoint('settings')).send({ language: 'en' })
    assert.equal(saved.status, 200, JSON.stringify(saved.body))
    assert.equal(saved.body.override, 'en')
    assert.equal(saved.body.effective, 'en')
    assert.equal(saved.body.channel_language, 'km', 'the channel language is untouched')

    // It is on disk, so a fresh read (a reopen) still sees it.
    assert.equal(await readThumbnailTextLanguage(slug, code), 'en')
    const reread = await request(app).get(endpoint('settings'))
    assert.equal(reread.body.override, 'en')

    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const overridden = await request(app).post(endpoint('suggestions')).send({})
    assert.equal(overridden.status, 200, JSON.stringify(overridden.body))
    assert.equal(overridden.body.language, 'en')
    assert.equal(overridden.body.language_source, 'override')

    // Clearing returns to following the channel.
    const cleared = await request(app).put(endpoint('settings')).send({ language: null })
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body))
    assert.equal(cleared.body.override, null)
    assert.equal(cleared.body.effective, 'km')

    service.queueScenario('chat', { states: ['succeeded'], outputText: headlineReply() })
    const followed = await request(app).post(endpoint('suggestions')).send({})
    assert.equal(followed.body.language, 'km')
    assert.equal(followed.body.language_source, 'channel')
  })

  test('choosing an override never modifies the channel\'s own language', async () => {
    await request(app).put(endpoint('settings')).send({ language: 'en' })
    // The channel language the rest of the app reads is unchanged.
    const { getContentLanguage } = await import('../lib/content-language.js')
    assert.equal(await getContentLanguage(slug), 'km')
    const pm = await import('../services/project-manager.js')
    const projectJson = JSON.parse(await fs.readFile(path.join(pm.getProjectDir(slug)!, 'project.json'), 'utf8'))
    assert.equal(projectJson.content_language, 'km')
    // Put it back to following for the other tests.
    await request(app).put(endpoint('settings')).send({ language: null })
  })

  test('a language the app does not support is refused before anything is written', async () => {
    const before = await readThumbnailTextLanguage(slug, code).catch(() => 'unreadable')
    const response = await request(app).put(endpoint('settings')).send({ language: 'th' })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(response.body), /language|invalid|expected/i)
    assert.equal(await readThumbnailTextLanguage(slug, code).catch(() => 'unreadable'), before)
  })

  test('a settings write for an episode with no folder refuses rather than creating one', async () => {
    const missing = 'EP9999'
    const response = await request(app).put(`/api/projects/${slug}/episodes/${missing}/thumbnail-text/settings`).send({ language: 'en' })
    assert.equal(response.status, 400)
    assert.match(response.body.detail, /could not find|folder/i)
  })

  test('the suggestion request that was actually sent carried the resolved language', () => {
    // The mock recorded real submissions; the prompt names the language.
    const submitted = chatSubmissions()
    assert.ok(submitted.length >= 3, 'the route made one request per suggestions call')
    assert.match(JSON.stringify(submitted[submitted.length - 1]), /Khmer/, 'the last call followed the channel (km)')
  })
})
