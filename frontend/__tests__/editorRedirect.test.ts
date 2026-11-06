/**
 * The two retired editor pages (Effects Library, Channel Characters) are
 * redirect adapters now (JOB6, 1.4.384). What they must never do is guess a
 * channel or open an editor for an episode they were not given — the rules
 * are in frontend/utils/editor-redirect.ts, and this pins the behaviour the
 * pages rely on, not the shape of their source.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  characterLibraryRedirect,
  effectsLibraryRedirect,
  validChannelSlug,
} from '../utils/editor-redirect.ts'

describe('effects-library redirects into Video Assembly Step 4', () => {
  test('a real channel, episode and scene all ride along', () => {
    const target = effectsLibraryRedirect({ channel: 'dreamlands', episode: 'EP0048', scene: 'scene-03' })
    assert.equal(target.path, '/projects/dreamlands/video-assembly')
    assert.deepEqual(target.query, { step: '4', episode_id: 'EP0048', effects: '1', scene: 'scene-03' })
  })

  test('a channel with no episode opens the step but never the editor', () => {
    const target = effectsLibraryRedirect({ channel: 'dreamlands' })
    assert.equal(target.path, '/projects/dreamlands/video-assembly')
    assert.deepEqual(target.query, { step: '4' }, 'no episode means no editor request and no guessed id')
  })

  test('a scene without an episode is kept, but still no editor request', () => {
    const target = effectsLibraryRedirect({ channel: 'dreamlands', scene: 'scene-07' })
    assert.deepEqual(target.query, { step: '4', scene: 'scene-07' })
  })

  test('no channel goes to the chooser — never a fabricated slug', () => {
    for (const channel of ['', undefined, null, 'undefined', 'null']) {
      const target = effectsLibraryRedirect({ channel })
      assert.equal(target.path, '/', `channel ${String(channel)} must land on the chooser`)
      assert.deepEqual(target.query, {})
    }
  })

  test('a value that is not slug-shaped is refused rather than encoded', () => {
    for (const channel of ['../secrets', 'my channel', 'a/b', 'slug with space']) {
      assert.equal(effectsLibraryRedirect({ channel }).path, '/', `refused: ${channel}`)
    }
  })

  test('Nuxt\'s unresolved "undefined" param never becomes a real slug', () => {
    assert.equal(validChannelSlug('undefined'), '')
    assert.equal(validChannelSlug(' null '), '')
    assert.equal(validChannelSlug('dreamlands'), 'dreamlands')
    assert.equal(validChannelSlug('my-channel-2'), 'my-channel-2')
  })
})

describe('character-library redirects onto the Character Sheet roster', () => {
  test('the channel query carries the roster destination', () => {
    const target = characterLibraryRedirect({ channel: 'dreamlands' })
    assert.equal(target.path, '/projects/dreamlands/character-sheet')
    assert.deepEqual(target.query, {})
  })

  test('the sidebar\'s project= form works too, and channel wins when both are present', () => {
    assert.equal(characterLibraryRedirect({ channel: undefined, project: 'terra-nash' }).path, '/projects/terra-nash/character-sheet')
    assert.equal(characterLibraryRedirect({ channel: 'dreamlands', project: 'terra-nash' }).path, '/projects/dreamlands/character-sheet')
  })

  test('an episode query is preserved for the destination', () => {
    const target = characterLibraryRedirect({ channel: 'dreamlands', episode: 'EP0048' })
    assert.deepEqual(target.query, { episode_id: 'EP0048' })
  })

  test('no channel goes to the chooser, never a guessed slug', () => {
    for (const channel of ['', undefined, 'undefined', 'not a slug!']) {
      assert.equal(characterLibraryRedirect({ channel }).path, '/')
    }
  })
})
