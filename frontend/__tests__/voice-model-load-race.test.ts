/**
 * Regression for D1 — a delayed OLD voice-catalogue reply must not overwrite the
 * newly selected model's voices.
 *
 * BUG. `useGenStudioVoices.loadVoices` (frontend/composables/useGenStudioVoices.ts,
 * lines 337-366) has no request-revision guard, unlike its sibling `loadModels`
 * in the SAME file (`modelLoadRevision`, lines 281-311). `VoicePicker.vue`
 * re-reads the voice list on every model change (`watch(() => props.ttsModelId, …)`,
 * lines 489-493), on the `voiceFilter` crossing (lines 379-382) and on `clearVoices`/
 * a blank model. Two reads in flight (model A, then model B) resolve in any order;
 * when A resolves last it overwrites `voices` / `voicesModelId` with model A's,
 * while the UI shows B.
 *
 * TRIGGER. Select voice model A, then model B before A's read resolves.
 * WRONG STATE. The list shows A's voices under B; `voicesModelId` says A, so
 * `setSaved` scopes a save request to A while the visible model is B, and
 * `VoicePicker.reconcileSelection` judges the selected voice against A.
 *
 * HARNESS. This drives the REAL `useGenStudioVoices` composable. That module
 * relies on Nuxt auto-imports for BOTH `ref` (vue) and `useApi` (`./useApi`), so
 * the real ones are injected as globals here and restored afterwards. `useApi`'s
 * `api()` awaits `waitForBootReady()` (useApi.ts:315) BEFORE it calls `$fetch`
 * (useApi.ts:327), so the boot gate is resolved explicitly and a bounded
 * microtask barrier waits until the stub has actually been called — no sleeps.
 * Any request other than the two voice URLs fails loudly.
 *
 * RUNNER. The frontend lane: `tsx --import ./__tests__/setup.ts`, cwd `frontend`.
 * This file belongs at `frontend/__tests__/voice-model-load-race.test.ts`.
 * On the current (pre-fix) code the assertions below FAIL — that is the point.
 */
import { test, describe, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useApi, _markBootReadyForTests } from '../composables/useApi.js'

// ── Inject the Nuxt auto-imports the composable expects, restore them after ──
const previousGlobals = new Map<string, unknown>()
function installGlobal(name: string, value: unknown): void {
  previousGlobals.set(name, (globalThis as any)[name])
  ;(globalThis as any)[name] = value
}
function restoreGlobals(): void {
  for (const [name, value] of previousGlobals) {
    if (value === undefined) delete (globalThis as any)[name]
    else (globalThis as any)[name] = value
  }
}

// ── Controllable $fetch stub ────────────────────────────────────────────────
type Deferred = { resolve: (value: any) => void; reject: (reason?: any) => void }
const pending = new Map<string, Deferred>()
let fetchCalls: string[] = []

const VOICE_URL = /^\/api\/app-settings\/genstudio\/voices\?model_id=/

installGlobal('ref', ref)
installGlobal('useApi', useApi)
installGlobal('$fetch', (url: string) => {
  const key = String(url)
  if (!VOICE_URL.test(key)) {
    // No other request belongs in these tests. Fail loudly (a resolved request
    // for an unexpected path would hide a real change in what the app calls).
    return Promise.reject(Object.assign(
      new Error(`unexpected request in voice-race test: ${key}`),
      { data: { detail: `unexpected ${key}` } },
    ))
  }
  fetchCalls.push(key)
  return new Promise((resolve, reject) => { pending.set(key, { resolve, reject }) })
})

// Resolve useApi's boot-ready gate so api() does not probe /api/health.
// setup.ts does this too; done here so the file is self-sufficient.
_markBootReadyForTests()

after(restoreGlobals)

const { useGenStudioVoices } = await import('../composables/useGenStudioVoices.js')

const urlFor = (modelId: string) =>
  `/api/app-settings/genstudio/voices?model_id=${encodeURIComponent(modelId)}`

/**
 * Deterministic barrier: yield microtasks until `ready()` holds. Once the boot
 * gate is resolved, every remaining step of `useApi.api()`'s path to `$fetch` is
 * microtask work, so this converges without a timer. The bound makes a broken
 * chain fail loudly instead of hanging.
 */
async function until(ready: () => boolean, label: string, max = 5000): Promise<void> {
  for (let i = 0; i < max; i++) {
    if (ready()) return
    await Promise.resolve()
  }
  throw new Error(`barrier timed out waiting for ${label}`)
}

beforeEach(() => {
  pending.clear()
  fetchCalls = []
})

describe('useGenStudioVoices — a delayed old reply must not win', () => {
  test('the newest model change keeps the voice list, not the slower older reply', async () => {
    const voices = useGenStudioVoices()

    const first = voices.loadVoices('model-a')
    const second = voices.loadVoices('model-b')
    // Both reads must actually reach the network before either is answered.
    await until(() => pending.size === 2, 'both voice reads to be issued')

    // The NEWER read answers first…
    pending.get(urlFor('model-b'))!.resolve({ voices: [{ id: 'b-1', display_name: 'B voice' }] })
    await second
    assert.equal(voices.voicesModelId.value, 'model-b')

    // …then the OLDER read answers late. It must NOT overwrite B.
    pending.get(urlFor('model-a'))!.resolve({ voices: [{ id: 'a-1', display_name: 'A voice' }] })
    await first

    assert.equal(
      voices.voicesModelId.value,
      'model-b',
      'the stale model-a reply overwrote the model the user selected',
    )
    assert.deepEqual(
      voices.voices.value.map((v: any) => v.id),
      ['b-1'],
      'the voice list shows the model the user left',
    )
  })

  test('a late error for the abandoned model does not clear the current list', async () => {
    const voices = useGenStudioVoices()

    const first = voices.loadVoices('model-a')
    const second = voices.loadVoices('model-b')
    await until(() => pending.size === 2, 'both voice reads to be issued')

    pending.get(urlFor('model-b'))!.resolve({ voices: [{ id: 'b-1', display_name: 'B voice' }] })
    await second

    // The abandoned read fails after the new one has already answered.
    pending.get(urlFor('model-a'))!.reject(
      Object.assign(new Error('old read failed'), { data: { detail: 'old read failed' } }),
    )
    await first

    assert.equal(voices.voicesModelId.value, 'model-b')
    assert.deepEqual(voices.voices.value.map((v: any) => v.id), ['b-1'])
  })

  test('clearVoices invalidates an in-flight read for the model it abandoned', async () => {
    const voices = useGenStudioVoices()

    const first = voices.loadVoices('model-a')
    await until(() => pending.size === 1, 'the model-a read to be issued')

    voices.clearVoices()
    assert.equal(voices.voicesModelId.value, null)

    // The abandoned read answers after the list was cleared.
    pending.get(urlFor('model-a'))!.resolve({ voices: [{ id: 'a-1', display_name: 'A voice' }] })
    await first

    assert.equal(voices.voicesModelId.value, null, 'a cleared voice list was repopulated by an in-flight read')
    assert.deepEqual(voices.voices.value.map((v: any) => v.id), [], 'the cleared list was refilled')
  })

  test('choosing no model invalidates an in-flight read for the previous one', async () => {
    const voices = useGenStudioVoices()

    const first = voices.loadVoices('model-a')
    await until(() => pending.size === 1, 'the model-a read to be issued')

    // A blank model is the "pick a model first" state; it must not be undone by
    // the read already in flight for the model the user left.
    await voices.loadVoices('')
    assert.equal(voices.voicesModelId.value, null)

    pending.get(urlFor('model-a'))!.resolve({ voices: [{ id: 'a-1', display_name: 'A voice' }] })
    await first

    assert.equal(voices.voicesModelId.value, null, 'a blanked selection was repopulated by an in-flight read')
    assert.deepEqual(voices.voices.value.map((v: any) => v.id), [])
  })

  test('a single read still populates the list (the guard must not disable loading)', async () => {
    const voices = useGenStudioVoices()

    const only = voices.loadVoices('model-a')
    await until(() => pending.size === 1, 'the model-a read to be issued')

    pending.get(urlFor('model-a'))!.resolve({ voices: [{ id: 'a-1', display_name: 'A voice' }] })
    await only

    assert.equal(voices.voicesModelId.value, 'model-a')
    assert.deepEqual(voices.voices.value.map((v: any) => v.id), ['a-1'])
  })
})
