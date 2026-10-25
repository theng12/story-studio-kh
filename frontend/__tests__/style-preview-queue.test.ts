import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  STYLE_PREVIEW_SLOTS,
  channelStylePreviewDisplay,
  channelStylesNeedingPreviews,
  runPreviewQueue,
  stylePreviewBulkTargets,
  userStylesNeedingPreviews,
  type ChannelStylePreviewState,
} from '../utils/style-preview-queue.js'

/** A channel custom style, as the channel-style-previews route reports it. */
function channelStyle(overrides: Partial<ChannelStylePreviewState> = {}): ChannelStylePreviewState {
  return {
    preset_id: 'preset',
    name: 'Preset',
    style_tag: 'A look.',
    source_hash: '',
    stale: false,
    slots: [],
    stored_files: [],
    needs_previews: true,
    ...overrides,
  }
}

function slot(slotName: string, url: string): { slot: string; url: string } {
  return { slot: slotName, url }
}

describe('channelStylePreviewDisplay — exactly three previews, in slot order', () => {
  test('a style with no previews shows three empty tiles, all three offered', () => {
    const display = channelStylePreviewDisplay(channelStyle())
    assert.equal(display.tiles.length, 3)
    assert.deepEqual(display.tiles.map(tile => tile.slot), [...STYLE_PREVIEW_SLOTS])
    assert.deepEqual(display.tiles.map(tile => tile.url), [null, null, null])
    assert.deepEqual(display.missing, [...STYLE_PREVIEW_SLOTS])
    assert.equal(display.stale, false)
  })

  test('the slot images win outright, and an older sample is never mixed in beside them', () => {
    const display = channelStylePreviewDisplay({
      slots: [slot('hero', '/api/user-style-previews/assets/a'), slot('scene', '/api/user-style-previews/assets/b'), slot('face', '/api/user-style-previews/assets/c')],
      stored_files: ['old.png', 'old-2.png', 'old-3.png', 'old-4.png'],
    })
    assert.equal(display.tiles.length, 3)
    assert.deepEqual(display.tiles.map(tile => tile.url), [
      '/api/user-style-previews/assets/a',
      '/api/user-style-previews/assets/b',
      '/api/user-style-previews/assets/c',
    ])
    assert.deepEqual(display.tiles.map(tile => tile.sourceFile), [null, null, null])
    assert.deepEqual(display.missing, [])
  })

  test('an older gallery of more than three files is shown capped at three, out of date', () => {
    const display = channelStylePreviewDisplay({
      stale: true,
      stored_files: ['old.png', 'old-2.png', 'old-3.png'],
    })
    assert.equal(display.tiles.length, 3, 'never more than the three the owner allows')
    assert.deepEqual(display.tiles.map(tile => tile.sourceFile), ['old.png', 'old-2.png', 'old-3.png'])
    assert.deepEqual(display.tiles.map(tile => tile.url), [null, null, null])
    assert.equal(display.stale, true)
    // The three tiles are older pictures of another text, so all three are still
    // offered for the style's own text.
    assert.deepEqual(display.missing, [...STYLE_PREVIEW_SLOTS])
  })

  test('a style with fewer than three shows the missing slots and keeps the ones it has', () => {
    const display = channelStylePreviewDisplay({
      slots: [slot('hero', '/api/user-style-previews/assets/a')],
    })
    assert.deepEqual(display.tiles.map(tile => tile.url), ['/api/user-style-previews/assets/a', null, null])
    assert.deepEqual(display.missing, ['scene', 'face'])
    assert.equal(display.stale, false)
  })

  test('a slot image with an unexpected name is ignored rather than shown in a wrong position', () => {
    const display = channelStylePreviewDisplay({
      slots: [slot('three-quarter', '/api/user-style-previews/assets/x'), slot('face', '/api/user-style-previews/assets/c')],
    })
    assert.deepEqual(display.tiles.map(tile => tile.url), [null, null, '/api/user-style-previews/assets/c'])
  })
})

describe('channelStylesNeedingPreviews', () => {
  test('de-duplicates by style text so one render covers every style that shows it', () => {
    const targets = channelStylesNeedingPreviews([
      channelStyle({ preset_id: 'a', name: 'Look A', style_tag: 'Same look.' }),
      channelStyle({ preset_id: 'b', name: 'Look B', style_tag: 'Same look.' }),
      channelStyle({ preset_id: 'c', name: 'Look C', style_tag: 'Same look.' }),
      channelStyle({ preset_id: 'd', name: 'Other', style_tag: 'Another look.' }),
    ])
    assert.equal(targets.length, 2, 'one entry per distinct text, not per preset')
    assert.deepEqual(targets.map(target => target.style_tag), ['Same look.', 'Another look.'])
    assert.deepEqual(targets[0]!.preset_ids, ['a', 'b', 'c'])
    assert.equal(targets[0]!.label, 'Look C (3 styles)')
  })

  test('leaves a style alone when its three previews are current, and asks again when it is out of date', () => {
    const targets = channelStylesNeedingPreviews([
      channelStyle({ preset_id: 'current', style_tag: 'Current look.', needs_previews: false }),
      channelStyle({ preset_id: 'stale', style_tag: 'Edited look.', stale: true, needs_previews: true }),
      channelStyle({ preset_id: 'blank', style_tag: '   ' }),
    ])
    assert.deepEqual(targets.map(target => target.style_tag), ['Edited look.'])
  })
})

describe('stylePreviewBulkTargets — the bulk action covers both kinds of style', () => {
  test('lists the owner\'s own styles and this channel\'s styles as one queue', () => {
    const targets = stylePreviewBulkTargets({
      userStyles: [
        { id: 'own.none', name: 'Own none', user_style: true, preview_images: [] },
        { id: 'own.ok', name: 'Own ok', user_style: true, preview_images: ['a', 'b', 'c'] },
        { id: 'signed.a', name: 'Signed', preview_images: [] },
      ],
      channelStyles: [
        channelStyle({ preset_id: 'channel-a', name: 'Channel A', style_tag: 'Channel look.' }),
        channelStyle({ preset_id: 'channel-b', name: 'Channel B', style_tag: 'Channel look.' }),
        channelStyle({ preset_id: 'channel-c', name: 'Channel C', style_tag: 'Done look.', needs_previews: false }),
      ],
    })

    assert.deepEqual(targets.map(target => target.kind), ['user', 'channel'])
    assert.equal(targets[0]!.kind === 'user' && targets[0]!.styleId, 'own.none')
    const channelEntry = targets[1]!
    assert.equal(channelEntry.kind, 'channel')
    assert.equal(channelEntry.kind === 'channel' && channelEntry.styleTag, 'Channel look.')
    assert.equal(channelEntry.kind === 'channel' && channelEntry.presetIds.length, 2)
    assert.equal(targets.length, 2, 'a signed style and a channel style with previews are not queued')
  })

  test('an empty channel and an empty library queue nothing at all', () => {
    assert.deepEqual(stylePreviewBulkTargets({ userStyles: [], channelStyles: [] }), [])
  })
})

describe('userStylesNeedingPreviews', () => {
  test('selects only the owner\'s own styles that lack previews or are stale', () => {
    const styles = [
      { id: 'signed.a', user_style: undefined, preview_images: [] },
      { id: 'signed.b', user_style: false, preview_images: [] },
      { id: 'own.none', user_style: true, preview_images: [] },
      { id: 'own.ok', user_style: true, preview_images: ['a', 'b', 'c'] },
      { id: 'own.stale', user_style: true, preview_images: ['a'], preview_stale: true },
      { id: 'own.current', user_style: true, preview_images: ['a', 'b', 'c'], preview_stale: false },
    ]
    assert.deepEqual(
      userStylesNeedingPreviews(styles).map(s => s.id),
      ['own.none', 'own.stale'],
    )
  })
})

describe('runPreviewQueue', () => {  test('runs each entry in order, reports progress, and collects completions', async () => {
    const seen: string[] = []
    const progress: string[] = []
    const outcome = await runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      async generate(entry) { seen.push(entry.key) },
      isCancelled: () => false,
      onProgress: (p) => progress.push(`${p.index}/${p.total}:${p.entry.key}:${p.status}`),
    })
    assert.deepEqual(seen, ['a', 'b', 'c'])
    assert.deepEqual(outcome.completed, ['a', 'b', 'c'])
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.cancelled, false)
    assert.deepEqual(outcome.notStarted, [])
    assert.deepEqual(progress, [
      '1/3:a:running', '1/3:a:done',
      '2/3:b:running', '2/3:b:done',
      '3/3:c:running', '3/3:c:done',
    ])
  })

  test('a failure on one entry is reported by name and does not stop the others', async () => {
    const outcome = await runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
      ],
      async generate(entry) {
        if (entry.key === 'b') throw new Error('b refused')
      },
      isCancelled: () => false,
    })
    assert.deepEqual(outcome.completed, ['a', 'c'])
    assert.equal(outcome.failed.length, 1)
    assert.equal(outcome.failed[0]!.key, 'b')
    assert.equal(outcome.failed[0]!.label, 'B')
    assert.match(outcome.failed[0]!.error, /b refused/)
    assert.equal(outcome.cancelled, false)
  })

  test('a stop is honoured BETWEEN entries, never mid-entry', async () => {
    const seen: string[] = []
    let cancelled = false
    const outcomePromise = runPreviewQueue({
      entries: [
        { key: 'a', label: 'A' },
        { key: 'b', label: 'B' },
        { key: 'c', label: 'C' },
        { key: 'd', label: 'D' },
      ],
      async generate(entry) {
        seen.push(entry.key)
        // Cancel right after the second entry completes.
        if (entry.key === 'b') cancelled = true
      },
      isCancelled: () => cancelled,
    })
    const outcome = await outcomePromise
    // 'a' and 'b' ran; 'c' and 'd' never started.
    assert.deepEqual(seen, ['a', 'b'])
    assert.equal(outcome.cancelled, true)
    assert.deepEqual(outcome.completed, ['a', 'b'])
    assert.deepEqual(outcome.notStarted, ['c', 'd'])
  })

  test('a stop asked for during the last entry still marks the queue as cancelled', async () => {
    let cancelled = false
    const outcome = await runPreviewQueue({
      entries: [{ key: 'only', label: 'Only' }],
      async generate() { cancelled = true },
      isCancelled: () => cancelled,
    })
    assert.equal(outcome.cancelled, true)
    assert.deepEqual(outcome.completed, ['only'])
  })

  test('an empty queue completes immediately with nothing started', async () => {
    const outcome = await runPreviewQueue({
      entries: [],
      async generate() { throw new Error('should not run') },
      isCancelled: () => false,
    })
    assert.deepEqual(outcome.completed, [])
    assert.deepEqual(outcome.failed, [])
    assert.equal(outcome.cancelled, false)
    assert.deepEqual(outcome.notStarted, [])
  })
})