/**
 * The one measurement of "what precedes the scenes" (v1.3.1).
 *
 * Scene Plan reserves this number and the renderer composes to it. When they
 * were two independent sums they drifted, and every scene visual landed after
 * the narration it was planned against. These tests pin the shared function's
 * contract: which buckets count, what a missing probe does, and — the part
 * that actually prevents recurrence — that the input type names every bucket
 * so a new one cannot be added on one side only.
 */

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  OPENING_HEAD_ORDER,
  describeOpeningHead,
  emptyOpeningHead,
  measureOpeningSec,
  type OpeningHead,
} from '../lib/opening-duration.js'

const durations: Record<string, number> = {
  '/intro.mp4': 10,
  '/pre.mp4': 2.5,
  '/post.mp4': 1.25,
  '/title.png': 0,
  '/broken.mp4': 0,
}
const probe = async (p: string) => durations[p]

describe('opening duration', () => {
  test('nothing before the scenes measures zero', async () => {
    assert.equal(await measureOpeningSec(emptyOpeningHead(), probe), 0)
  })

  test('a lone intro reserves exactly its probed length', async () => {
    const head: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/intro.mp4' } }
    assert.equal(await measureOpeningSec(head, probe), 10)
  })

  test('all four head buckets count, and tail content never reaches this function', async () => {
    // `after_scenes` / `after_outro` are not part of the type at all — that is
    // the guarantee. A caller cannot accidentally inflate the opening with
    // tail clips, because there is nowhere to put them.
    assert.deepEqual([...OPENING_HEAD_ORDER], ['before_intro', 'intro', 'title', 'after_intro'])
    const head: OpeningHead = {
      before_intro: [{ path: '/pre.mp4' }],
      intro: { path: '/intro.mp4' },
      title: { duration_sec: 5 },
      after_intro: [{ path: '/post.mp4' }],
    }
    assert.equal(await measureOpeningSec(head, probe), 18.75)
  })

  test('a known duration is trusted over the probe, so still cards need no file', async () => {
    const head: OpeningHead = { ...emptyOpeningHead(), title: { path: '/title.png', duration_sec: 7 } }
    assert.equal(await measureOpeningSec(head, probe), 7)
  })

  /**
   * OWNER DECISION, 2026-09-20: FAIL LOUDLY. This reverses what these two tests
   * used to assert, deliberately — do not restore the old expectations.
   *
   * The old behaviour was that the renderer reserved `fallback_sec || 5` while
   * the plan reserved `0` for the very same unreadable clip. That is how a plan
   * and a render came to disagree about the caption offset, and a wrong offset
   * shifts EVERY caption in the episode — ahead of the voice if it is too
   * short, behind it if it is too long. Both now refuse to guess.
   */
  test('an opening clip that exists but cannot be measured is an error, not a guess', async () => {
    const rendererStyle: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/broken.mp4', fallback_sec: 5 } }
    await assert.rejects(() => measureOpeningSec(rendererStyle, probe), /could not be measured/)
    const planStyle: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/broken.mp4' } }
    await assert.rejects(() => measureOpeningSec(planStyle, probe), /could not be measured/)
  })

  test('a probe that throws fails loudly rather than reserving the fallback', async () => {
    const angry = async () => { throw new Error('ffprobe exploded') }
    const head: OpeningHead = { ...emptyOpeningHead(), intro: { path: '/intro.mp4', fallback_sec: 4 } }
    await assert.rejects(() => measureOpeningSec(head, angry), /could not be measured/)
  })

  test('a clip with no path still uses its stated length', async () => {
    // Nothing was probed because there is no file at all, so the stated length
    // is the only information that exists and is used honestly.
    const head: OpeningHead = { ...emptyOpeningHead(), intro: { fallback_sec: 4 } }
    assert.equal(await measureOpeningSec(head, probe), 4)
  })

  test('the total is rounded to the millisecond so plan and render compare equal', async () => {
    const thirds = async () => 1 / 3
    const head: OpeningHead = {
      before_intro: [{ path: '/a' }, { path: '/b' }],
      intro: { path: '/c' },
      title: null,
      after_intro: [],
    }
    assert.equal(await measureOpeningSec(head, thirds), 1)
  })

  test('the breakdown names the parts, and says nothing when there are none', async () => {
    const head: OpeningHead = {
      before_intro: [{ path: '/pre.mp4', label: 'before_intro clip' }],
      intro: { path: '/intro.mp4', label: 'intro' },
      title: null,
      after_intro: [],
    }
    assert.equal(await describeOpeningHead(head, probe), 'before_intro clip 2.50s + intro 10.00s')
    assert.equal(await describeOpeningHead(emptyOpeningHead(), probe), '')
  })
})
