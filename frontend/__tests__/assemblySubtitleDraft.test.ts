import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyAssemblyStepDraft,
  beginAssemblyStepDraft,
  cancelAssemblyStepDraft,
  type AssemblyStepApplyResult,
  type AssemblyStepScope,
} from '../utils/assembly-step-draft.ts'

interface SubtitleSettings {
  enabled: boolean
  source: 'chapters' | 'upload' | 'whisper'
  hide_during_intro: boolean
  style: { font_size: number; word: { mode: string } }
  pinned_subtitle: string
}

interface OutroSettings {
  enabled: boolean
  text: string
  duration: number
  style: string
  background_media_path: string
}

const DREAMLANDS = { channel: 'dreamlands', episode: 'EP0007' }

function failure(result: AssemblyStepApplyResult): string {
  if (result.ok) assert.fail('expected Apply to be refused')
  return result.error
}

function subtitleSource(): SubtitleSettings {
  return {
    enabled: true,
    source: 'chapters',
    hide_during_intro: false,
    style: { font_size: 42, word: { mode: 'off' } },
    pinned_subtitle: '',
  }
}

test('subtitle popup is detached: style and file choice stay in the draft until Apply', () => {
  const live = subtitleSource()
  const draft = beginAssemblyStepDraft(live, DREAMLANDS)

  draft.value.style.font_size = 64
  draft.value.style.word.mode = 'word-by-word'
  draft.value.pinned_subtitle = 'EP0007_full.srt'

  assert.equal(live.style.font_size, 42)
  assert.equal(live.style.word.mode, 'off')
  assert.equal(live.pinned_subtitle, '')
  assert.equal(draft.value.pinned_subtitle, 'EP0007_full.srt')
  assert.equal(draft.state, 'editing')
})

test('Cancel discards a subtitle edit without calling the save callback', async () => {
  let calls = 0
  const draft = beginAssemblyStepDraft(subtitleSource(), DREAMLANDS)
  draft.value.pinned_subtitle = 'EP0007_full.srt'
  draft.value.enabled = false

  cancelAssemblyStepDraft(draft)
  const refused = await applyAssemblyStepDraft(draft, draft.scope, async () => { calls += 1 })

  assert.match(failure(refused), /cancelled/i)
  assert.equal(calls, 0)
})

test('Apply saves the subtitle file pin and settings once, against the captured episode', async () => {
  const seen: { value: SubtitleSettings; scope: AssemblyStepScope }[] = []
  const draft = beginAssemblyStepDraft(subtitleSource(), DREAMLANDS)
  draft.value.pinned_subtitle = 'EP0007_full.srt'
  draft.value.style.font_size = 56

  const result = await applyAssemblyStepDraft(draft, draft.scope, (value, scope) => {
    seen.push({ value, scope })
  })

  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.value.pinned_subtitle, 'EP0007_full.srt')
  assert.equal(seen[0]!.value.style.font_size, 56)
  assert.deepEqual(seen[0]!.scope, { channel: 'dreamlands', episode: 'EP0007', scene: undefined })
})

test('a subtitle Apply after switching episode is refused and writes nothing', async () => {
  let calls = 0
  const draft = beginAssemblyStepDraft(subtitleSource(), DREAMLANDS)
  draft.value.pinned_subtitle = 'EP0007_full.srt'

  const refused = await applyAssemblyStepDraft(
    draft,
    { channel: 'dreamlands', episode: 'EP0008' },
    async () => { calls += 1 },
  )

  assert.match(failure(refused), /EP0007/)
  assert.match(failure(refused), /EP0008/)
  assert.equal(calls, 0)
  assert.equal(draft.value.pinned_subtitle, 'EP0007_full.srt')
})

test('an outro card draft saves its own detached values and never the live object', async () => {
  const live: OutroSettings = {
    enabled: false,
    text: 'Thanks for watching',
    duration: 4,
    style: 'white',
    background_media_path: '',
  }
  const draft = beginAssemblyStepDraft(live, { channel: 'dreamlands', episode: 'EP0007' })
  draft.value.enabled = true
  draft.value.text = 'See you next time'
  draft.value.duration = 6

  let saved: OutroSettings | null = null
  const result = await applyAssemblyStepDraft(draft, draft.scope, (value) => { saved = value })

  assert.equal(result.ok, true)
  assert.equal(live.enabled, false)
  assert.equal(live.text, 'Thanks for watching')
  assert.deepEqual(saved, {
    enabled: true,
    text: 'See you next time',
    duration: 6,
    style: 'white',
    background_media_path: '',
  })
})
