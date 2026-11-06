import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  applyAssemblyStepDraft,
  beginAssemblyStepDraft,
  cancelAssemblyStepDraft,
  sameAssemblyStepScope,
  type AssemblyStepApplyResult,
  type AssemblyStepScope,
} from '../utils/assembly-step-draft.ts'

interface StepSettings {
  episode_files?: string[]
  effects?: { title_card?: { text?: string; layers?: { opacity: number }[] } }
  crf?: number
}

const DREAMLANDS = { channel: 'dreamlands', episode: 'EP0007' }

function failure(result: AssemblyStepApplyResult): string {
  if (result.ok) assert.fail('expected Apply to be refused')
  return result.error
}

function source(): StepSettings {
  return {
    episode_files: ['audio/take1.wav', 'scenes/scene-03.webp'],
    effects: { title_card: { text: 'EP0007', layers: [{ opacity: 0.6 }] } },
    crf: 18,
  }
}

test('begin is detached: nested edits never reach the live settings, and episode files stay in the draft', () => {
  const live = source()
  const draft = beginAssemblyStepDraft(live, DREAMLANDS)

  draft.value.effects!.title_card!.layers![0]!.opacity = 1
  draft.value.effects!.title_card!.text = 'EP0008'
  draft.value.episode_files!.push('scenes/scene-04.webp')

  // The live settings are untouched (§4) — no mutation before Apply…
  assert.equal(live.effects!.title_card!.layers![0]!.opacity, 0.6)
  assert.equal(live.effects!.title_card!.text, 'EP0007')
  assert.deepEqual(live.episode_files, ['audio/take1.wav', 'scenes/scene-03.webp'])
  // …and the draft kept the episode's own files and title text (not a preset sanitizer, §5).
  assert.deepEqual(draft.value.episode_files, ['audio/take1.wav', 'scenes/scene-03.webp', 'scenes/scene-04.webp'])
  assert.equal(draft.value.effects!.title_card!.text, 'EP0008')
  assert.equal(draft.state, 'editing')
  assert.equal(draft.error, null)
})

test('nothing is written until Apply, and Cancel discards without a single write', async () => {
  let calls = 0
  const save = async () => { calls += 1 }
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)

  draft.value.crf = 28
  cancelAssemblyStepDraft(draft)
  assert.equal(draft.state, 'cancelled')
  assert.equal(draft.error, null)

  const refused = await applyAssemblyStepDraft(draft, draft.scope, save)
  assert.match(failure(refused), /cancelled/i)
  assert.equal(calls, 0)
  assert.equal(draft.error, null)
})

test('Apply is the only write: it hands the existing persistence callback the value and the captured scope', async () => {
  const seen: { value: StepSettings; scope: AssemblyStepScope }[] = []
  const draft = beginAssemblyStepDraft(source(), { ...DREAMLANDS, scene: 'scene-03' })
  draft.value.crf = 20

  const result = await applyAssemblyStepDraft(draft, draft.scope, (value, scope) => {
    seen.push({ value, scope })
  })

  assert.equal(result.ok, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.value.crf, 20)
  assert.deepEqual(seen[0]!.scope, { channel: 'dreamlands', episode: 'EP0007', scene: 'scene-03' })
  assert.equal(draft.state, 'saved')
})

test('a scope switch under an open popup refuses: the old episode cannot save into the new one', async () => {
  let calls = 0
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)
  draft.value.crf = 30

  const refused = await applyAssemblyStepDraft(
    draft,
    { channel: 'dreamlands', episode: 'EP0008' },
    async () => { calls += 1 },
  )

  assert.match(failure(refused), /EP0007/)
  assert.match(failure(refused), /EP0008/)
  assert.equal(calls, 0)
  // The draft itself is retained, untouched and still editing.
  assert.equal(draft.state, 'editing')
  assert.equal(draft.value.crf, 30)
})

test('a failed Apply keeps the draft and surfaces the error, and the same draft can retry', async () => {
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)
  draft.value.crf = 22

  const boom = await applyAssemblyStepDraft(draft, draft.scope, async () => {
    throw new Error('disk full')
  })

  assert.match(failure(boom), /disk full/)
  assert.equal(draft.state, 'failed')
  assert.match(draft.error!, /disk full/)
  assert.equal(draft.value.crf, 22)

  const retry = await applyAssemblyStepDraft(draft, draft.scope, async () => {})
  assert.equal(retry.ok, true)
  assert.equal(draft.state, 'saved')
  assert.equal(draft.error, null)
})

test('Apply persists exactly once — a second click while saving or after saving never writes again', async () => {
  const gate = Promise.withResolvers<void>()
  let calls = 0
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)

  const pending = applyAssemblyStepDraft(draft, draft.scope, async () => {
    calls += 1
    await gate.promise
  })
  const during = await applyAssemblyStepDraft(draft, draft.scope, async () => { calls += 1 })
  assert.match(failure(during), /still saving/i)

  gate.resolve()
  assert.equal((await pending).ok, true)

  const after = await applyAssemblyStepDraft(draft, draft.scope, async () => { calls += 1 })
  assert.match(failure(after), /already saved/i)
  assert.equal(calls, 1)
  assert.equal(draft.state, 'saved')
})

test('a save in flight keeps the captured scope — a later episode switch cannot re-target it', async () => {
  const gate = Promise.withResolvers<void>()
  const seen: { value: StepSettings; scope: AssemblyStepScope }[] = []
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)

  const pending = applyAssemblyStepDraft(draft, draft.scope, (value, scope) => {
    seen.push({ value, scope })
    return gate.promise
  })

  // The customer opens EP0008 while EP0007's save is still running.
  const other = beginAssemblyStepDraft({ crf: 24 }, { channel: 'dreamlands', episode: 'EP0008' })
  gate.resolve()
  assert.equal((await pending).ok, true)

  assert.equal(seen[0]!.scope.episode, 'EP0007')
  assert.equal(seen[0]!.value, draft.value)
  assert.equal(other.state, 'editing')
  assert.equal(other.value.crf, 24)
  assert.equal(draft.state, 'saved')
})

test('the captured scope is frozen — a pending save can never be re-pointed at another episode', () => {
  const draft = beginAssemblyStepDraft(source(), DREAMLANDS)
  assert.throws(() => {
    ;(draft.scope as { episode?: string }).episode = 'EP0008'
  })
  assert.equal(draft.scope.episode, 'EP0007')
  assert.equal(sameAssemblyStepScope(draft.scope, { channel: 'dreamlands', episode: ' EP0007 ' }), true)
  assert.equal(sameAssemblyStepScope(draft.scope, { channel: 'dreamlands', episode: 'EP0008' }), false)
  assert.throws(() => beginAssemblyStepDraft(source(), { channel: '  ' }), /channel, an episode or a scene/)
})
