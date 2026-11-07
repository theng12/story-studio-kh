/**
 * Per-channel story-context automation — the OFF-by-default seam
 * (Episode Visual Setup, owner-approved 2026-11-05).
 *
 * What this pins:
 *   - the decision is one pure rule: off unless the channel opted in, never
 *     for an unmeasurable/empty script, and no second provider read when the
 *     stored extraction already came from this exact script;
 *   - extraction proposals persist as a review DRAFT beside the inventory, so
 *     the automatic pass survives a page reload or restart;
 *   - reading the draft re-applies the stored Keep/Drop decision, and the
 *     draft never becomes inventory on its own;
 *   - an ordinary save preserves the draft; only an explicit review clears it.
 *
 * The queue wiring (enqueue after a complete script, executor, cancellation
 * audit) is exercised by the release gate's job suites; this file stays on the
 * pure seam and the sidecar contract so it needs no provider call.
 */
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { useTempDataDir } from './_helpers.js'
import { storyEntityAutomationDecision } from '../generators/story-entities.js'

describe('story entity automation decision', () => {
  const base = { chapters: 3, fingerprint: 'script-a' }

  test('a channel that never opted in never extracts', () => {
    assert.equal(storyEntityAutomationDecision({ ...base, enabled: false }), 'off')
  })

  test('a missing or empty script never triggers extraction', () => {
    assert.equal(storyEntityAutomationDecision({ enabled: true, chapters: null, fingerprint: null }), 'no-script')
    assert.equal(storyEntityAutomationDecision({ enabled: true, chapters: 0, fingerprint: 'script-a' }), 'no-script')
    assert.equal(storyEntityAutomationDecision({ enabled: true, chapters: 3, fingerprint: null }), 'no-script')
  })

  test('the same script fingerprint is fresh — no second provider read', () => {
    assert.equal(
      storyEntityAutomationDecision({ ...base, enabled: true, extractedFingerprint: 'script-a' }),
      'fresh',
    )
  })

  test('a changed script is extracted again', () => {
    assert.equal(
      storyEntityAutomationDecision({ ...base, enabled: true, extractedFingerprint: 'script-old' }),
      'extract',
    )
    assert.equal(storyEntityAutomationDecision({ ...base, enabled: true }), 'extract')
  })
})

describe('story entity review draft', () => {
  let cleanup: () => Promise<void>
  let slug: string
  let episodeId: string

  before(async () => {
    const temp = await useTempDataDir()
    cleanup = temp.cleanup
    const pm = await import('../services/project-manager.js')
    const project = await pm.createProject({
      name: 'Story Automation',
      episode_prefix: 'EP',
      episode_digits: 3,
    })
    slug = project.slug
    const im = await import('../services/idea-manager.js')
    const [idea] = await im.addIdeas(slug, [{
      title: 'Harbor at Dawn',
      logline: 'a guide walks the harbour',
      themes: ['journey'],
      suggested_chapters: 2,
      suggested_length: 'long',
      mood: 'calm',
    }], 'test-model')
    const accepted = await im.acceptIdea(slug, idea!.id)
    episodeId = accepted.episode_code
    const { resolveEpisodePathsByCode } = await import('../services/utils.js')
    const paths = await resolveEpisodePathsByCode(slug, episodeId)
    await fs.mkdir(paths.episode_dir, { recursive: true })
  })

  after(async () => {
    await cleanup?.()
  })

  test('the draft persists, keeps the stored decision, and clears only on review', async () => {
    const { readStoryEntities, recordStoryExtraction, writeStoryEntities } =
      await import('../services/story-entities.js')

    // Aria is already in the inventory and the customer DROPPED her.
    const saved = await writeStoryEntities(slug, episodeId, {
      entities: [{
        id: 'cast-aria',
        kind: 'cast',
        name: 'Aria',
        description: 'old facts',
        important: true,
        review: 'drop',
        reference_images: [],
      }],
    })
    assert.equal(saved.doc.entities[0]!.review, 'drop')

    await recordStoryExtraction(slug, episodeId, {
      extracted_at: new Date().toISOString(),
      model: 'test-model',
      chapters: 2,
      script_fingerprint: 'script-a',
    }, [
      { id: 'cast-aria', kind: 'cast', name: 'Aria', description: 'new facts', important: false },
      { id: 'object-lamp', kind: 'object', name: 'Lamp', description: 'a silver lamp', important: false },
    ])

    // A fresh read is what a page reload or restart does.
    const first = await readStoryEntities(slug, episodeId)
    assert.equal(first.pending_proposals.length, 2)
    const aria = first.pending_proposals.find(proposal => proposal.id === 'cast-aria')!
    assert.equal(aria.existing, true)
    assert.equal(aria.review, 'drop', 'the draft never reverses a stored Drop')
    assert.equal(aria.important, true, 'the stored reference decision wins')
    assert.equal(first.pending_proposals.find(proposal => proposal.id === 'object-lamp')!.existing, false)
    assert.equal(first.doc.entities.length, 1, 'the draft never adds to the inventory')

    // An ordinary save (even one that touches another field) keeps the draft.
    await writeStoryEntities(slug, episodeId, {
      entities: [{ id: 'cast-aria', kind: 'cast', name: 'Aria', description: 'old facts, edited' }],
    })
    const afterOrdinarySave = await readStoryEntities(slug, episodeId)
    assert.equal(afterOrdinarySave.pending_proposals.length, 2)

    // Only an explicit review clears it.
    await writeStoryEntities(slug, episodeId, {
      entities: [{ id: 'cast-aria', kind: 'cast', name: 'Aria', description: 'old facts, edited' }],
      dismiss_pending_proposals: true,
    })
    const afterReview = await readStoryEntities(slug, episodeId)
    assert.equal(afterReview.pending_proposals.length, 0)
    assert.equal(afterReview.doc.extraction?.script_fingerprint, 'script-a', 'provenance is untouched by review')
  })
})
