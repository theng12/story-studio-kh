import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'
import { buildYouTubeMetadataPackage, resolveYouTubeUploadSettings } from '../services/youtube-metadata-package.js'
import { createProject } from '../services/project-manager.js'
import { resolveEpisodePaths } from '../services/utils.js'

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString()

/** A project with one episode whose metadata sidecar holds `meta`. */
async function withEpisode(meta: {
  title?: string
  description?: string
  tags?: string[]
}): Promise<{ slug: string; episode_code: string }> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const project = await createProject({ name: 'Package Project' })
  const episode_code = 'EP0001'
  const paths = await resolveEpisodePaths(project.slug, episode_code, '')
  await fs.mkdir(path.dirname(paths.metadata_json), { recursive: true })
  await fs.writeFile(paths.metadata_json, JSON.stringify({
    title: meta.title ?? 'A Perfectly Ordinary Title',
    description: meta.description ?? 'A perfectly ordinary description.',
    tags: meta.tags ?? ['alpha', 'beta'],
  }))
  return { slug: project.slug, episode_code }
}

describe('youtube metadata package', () => {
  test('is deterministic, and any payload change changes the revision', async () => {
    const episode = await withEpisode({})
    const input = {
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'public' as const,
      mark_as_ai_generated: true,
    }

    const first = await buildYouTubeMetadataPackage(input)
    const second = await buildYouTubeMetadataPackage(input)
    assert.equal(first.package_revision, second.package_revision)
    assert.match(first.package_revision, /^[0-9a-f]{64}$/)
    assert.match(first.source_sha256, /^[0-9a-f]{64}$/)

    const different = await buildYouTubeMetadataPackage({ ...input, privacy_status: 'unlisted' })
    assert.notEqual(different.package_revision, first.package_revision)
  })

  test('reports every sanitizer change instead of applying it silently', async () => {
    const episode = await withEpisode({
      title: `A Very Long Title With A Link https://example.com ${'x'.repeat(140)}`,
      tags: Array.from({ length: 20 }, (_, i) => `tag-number-${i}`),
    })
    const built = await buildYouTubeMetadataPackage({
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'public',
      mark_as_ai_generated: false,
    })

    assert.equal(built.snippet.title.length <= 100, true)
    assert.equal(built.snippet.title.includes('https://'), false)
    assert.equal((built.snippet.tags ?? []).length <= 15, true)
    assert.equal(built.modifications.length > 0, true)
    // The disclosure names the field, so "N changes applied" can be itemized.
    assert.equal(built.modifications.every(m => typeof m.reason === 'string' && m.reason.length > 0), true)
    assert.equal(built.modifications.some(m => m.field === 'title'), true)
    assert.equal(built.modifications.some(m => m.field === 'tags'), true)
  })

  test('shows the privacy the request will actually carry, not the one asked for', async () => {
    // youtube-client silently forces `private` whenever publishAt is set.
    // Spec section 8 forbids a hidden sanitizer after the preview, so the
    // package has to make that correction visible here.
    const episode = await withEpisode({})
    const built = await buildYouTubeMetadataPackage({
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'public',
      publish_at: FUTURE,
      mark_as_ai_generated: false,
    })

    assert.equal(built.status.privacyStatus, 'private')
    assert.equal(built.status.publishAt, FUTURE)
    assert.equal(built.modifications.some(m => m.field === 'privacy'), true)
  })

  test('a past or missing schedule is a warning, never a silent correction', async () => {
    const episode = await withEpisode({})
    const past = await buildYouTubeMetadataPackage({
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'private',
      publish_at: PAST,
      mark_as_ai_generated: false,
    })
    assert.equal(past.warnings.some(w => /past/i.test(w)), true)
    // The value is still exactly what was asked for — nothing was rewritten.
    assert.equal(past.status.publishAt, PAST)
    // The words matter: YouTube does NOT reject a past publishAt, it publishes
    // the video immediately with no error. A warning that promises a rejection
    // reads as a guarantee the video stays safe, so it has to say what the
    // provider actually does.
    // (https://developers.google.com/youtube/data/revision_history)
    assert.equal(past.warnings.some(w => /publishes a video immediately/i.test(w)), true,
      'the warning names what YouTube does, not what it used to be believed to do')
    assert.equal(past.warnings.some(w => /reject/i.test(w)), false,
      'a rejected publishAt is the one behaviour YouTube does not have')

    const malformed = await buildYouTubeMetadataPackage({
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'private',
      publish_at: 'not-a-time',
      mark_as_ai_generated: false,
    })
    assert.equal(malformed.warnings.some(w => /is not a valid date/i.test(w)), true)
    // A date inside the lead time is refused too, and the preview says why.
    const soon = await buildYouTubeMetadataPackage({
      project_slug: episode.slug,
      episode_code: episode.episode_code,
      privacy_status: 'private',
      publish_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      mark_as_ai_generated: false,
    })
    assert.equal(soon.warnings.some(w => /less than 6 hours away/i.test(w)), true)
  })

  test('strips the finalizer-s private description markers and angle brackets', async () => {
    // PR #24 fixed this on the legacy upload path. The canonical package is
    // that path-s sibling, so the same rule has to hold here - proven, not
    // assumed, because it reuses `snippetFromMeta` rather than restating it.
    const episode = await withEpisode({
      description: '<!-- youtube:chapters:start -->\nChapter one\n<!-- youtube:chapters:end -->\nA <real> description.',
    })
    const built = await buildYouTubeMetadataPackage({
      project_slug: episode.slug, episode_code: episode.episode_code,
      privacy_status: 'private', mark_as_ai_generated: false,
    })

    assert.doesNotMatch(built.snippet.description ?? '', /youtube:chapters/)
    assert.doesNotMatch(built.snippet.description ?? '', /[<>]/)
    assert.match(built.snippet.description ?? '', /Chapter one/)
    assert.match(built.snippet.description ?? '', /A real description\./)
    // And the owner is told, rather than it happening invisibly.
    assert.equal(built.modifications.some(m => /private YouTube description markers/.test(m.reason)), true)
  })

  test('carries the AI disclosure exactly as chosen', async () => {
    const episode = await withEpisode({})
    const on = await buildYouTubeMetadataPackage({
      project_slug: episode.slug, episode_code: episode.episode_code,
      privacy_status: 'private', mark_as_ai_generated: true,
    })
    const off = await buildYouTubeMetadataPackage({
      project_slug: episode.slug, episode_code: episode.episode_code,
      privacy_status: 'private', mark_as_ai_generated: false,
    })
    assert.equal(on.status.containsSyntheticMedia, true)
    assert.equal(off.status.containsSyntheticMedia, false)
    assert.notEqual(on.package_revision, off.package_revision)
  })

  test('the revision covers the bytes the request will carry', async () => {
    const episode = await withEpisode({})
    const built = await buildYouTubeMetadataPackage({
      project_slug: episode.slug, episode_code: episode.episode_code,
      privacy_status: 'private', mark_as_ai_generated: false,
    })
    // What Phase 3 persists as `final_payload` must be exactly what was
    // previewed, so the record can prove preview/upload equality later.
    assert.deepEqual(JSON.parse(built.final_payload.snippet_json), built.snippet)
    assert.deepEqual(JSON.parse(built.final_payload.status_json), built.status)
    assert.equal(built.final_payload.source_sha256, built.source_sha256)
  })

  test('a corrupt project config never falls back to app upload defaults', async () => {
    const episode = await withEpisode({})
    const dataDir = process.env.STORY_STUDIO_DATA_DIR!
    await fs.writeFile(path.join(dataDir, 'projects', episode.slug, 'config.json'), '{broken')

    await assert.rejects(resolveYouTubeUploadSettings(episode.slug))
  })
})
