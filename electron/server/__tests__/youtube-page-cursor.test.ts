import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'

import { useTempDataDir } from './_helpers.js'

import { cursorDecision, cursorKey, type PageCursor } from '../services/youtube-page-cursor.js'

const CHANNEL = 'UC-center-channel'
const cursor = (overrides: Partial<PageCursor> = {}): PageCursor => ({
  channel_id: CHANNEL, token: 'page-2', issued_at: '2026-09-03T10:00:00.000Z', ...overrides,
})

describe('resuming a paged sweep', () => {
  test('a cursor issued under this channel resumes', () => {
    assert.deepEqual(cursorDecision(cursor(), CHANNEL), { resume: true, token: 'page-2' })
  })

  test('a cursor from a departed channel is discarded with a named reason', () => {
    // Resuming it would page through a stranger's list under this project's
    // name and file the results as its own.
    assert.deepEqual(
      cursorDecision(cursor({ channel_id: 'UC-a-previous-channel' }), CHANNEL),
      { resume: false, reason: 'channel_changed' },
    )
  })

  test('no cursor and no channel are both refusals, never a resume', () => {
    assert.equal(cursorDecision(undefined, CHANNEL).resume, false)
    // The opt-out shape would be "no channel, so allow it". There is no such
    // branch: every path that is not an exact match refuses.
    assert.equal(cursorDecision(cursor(), null).resume, false)
  })

  test('an empty token is not a cursor', () => {
    // It would resume from the newest batch while reporting a resume, so the
    // restart would never be named.
    assert.deepEqual(cursorDecision(cursor({ token: '' }), CHANNEL), { resume: false, reason: 'no_cursor' })
    assert.deepEqual(cursorDecision(cursor({ token: '   ' }), CHANNEL), { resume: false, reason: 'no_cursor' })
  })

  test('keys are scoped by surface so two never collide', () => {
    assert.equal(cursorKey('comments', 'v1'), 'comments:v1')
    assert.notEqual(cursorKey('comments', 'v1'), cursorKey('comments', 'v2'))
  })
})

describe('writing only the cursors one sweep touched', () => {
  let cleanup: (() => Promise<void>) | null = null
  afterEach(async () => { await cleanup?.(); cleanup = null })

  async function project(): Promise<string> {
    const dir = await useTempDataDir()
    cleanup = dir.cleanup
    const pm = await import('../services/project-manager.js')
    return (await pm.createProject({ name: 'Cursor Project' })).slug
  }

  test('a sweep that covers some videos does not erase the rest', async () => {
    // The write-side twin of tell 7b. Written as an overwrite this erases the
    // resume points of every video the sweep did not cover, silently
    // restarting them — the exact bug the cursor exists to fix, arriving from
    // the writer instead of the reader. A test that writes everything and
    // reads everything back cannot see it.
    const slug = await project()
    const store = await import('../services/youtube-project-publishing-store.js')

    await store.recordYouTubePageCursors({
      project_slug: slug,
      cursors: {
        'comments:a': cursor({ token: 'a-2' }),
        'comments:b': cursor({ token: 'b-2' }),
      },
    })

    // A later sweep covers only 'a', and finds it finished (no cursor back).
    await store.recordYouTubePageCursors({
      project_slug: slug,
      cursors: {},
      covered_keys: ['comments:a'],
    })

    const state = await store.readYouTubeProjectPublishingState(slug)
    // 'a' finished, so its stale cursor is gone rather than resuming past the end.
    assert.equal(state.page_cursors?.['comments:a'], undefined)
    // 'b' was never touched by that sweep and MUST survive it.
    assert.equal(state.page_cursors?.['comments:b']?.token, 'b-2')
  })

  test('a stored cursor with an empty token is a corrupt file, not a usable one', async () => {
    const slug = await project()
    const store = await import('../services/youtube-project-publishing-store.js')
    await assert.rejects(
      store.recordYouTubePageCursors({
        project_slug: slug,
        cursors: { 'comments:a': { channel_id: CHANNEL, token: '', issued_at: '2026-09-03T10:00:00.000Z' } },
      }),
      /empty/i,
    )
  })

  test('a state file written before page_cursors existed still decodes', async () => {
    const slug = await project()
    const store = await import('../services/youtube-project-publishing-store.js')
    const state = await store.readYouTubeProjectPublishingState(slug)
    assert.equal(state.page_cursors, undefined, 'absent, not invalid')
  })
})
