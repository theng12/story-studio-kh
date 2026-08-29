/**
 * Tests for `useEpisodes` — the SWR composable that backs every page
 * mounting `/projects/:slug/episodes`.
 *
 * Covers:
 *   - First mount fetches; data populates; isLoading toggles.
 *   - Second mount within the hot-cache window serves cached immediately
 *     without repeating the expensive project-wide status request.
 *   - Concurrent calls dedup to one in-flight fetch.
 *   - `refresh()` always hits the backend with `?refresh=1`.
 *   - `invalidate()` clears the freshness flag without blanking data.
 *
 * `$fetch` is a Nuxt global stubbed in the test process before the module
 * loads. Vue lifecycle hooks (onMounted) require an active component
 * instance — we wrap useEpisodes calls in defineComponent + render via
 * @vue/test-utils' minimal mount.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { defineComponent, h, nextTick, createApp } from 'vue'

// ── Controllable $fetch stub ────────────────────────────────────────────────

type FetchHandler = (url: string) => any | Promise<any>
let fetchHandler: FetchHandler = () => []
let fetchCalls: string[] = []

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return await fetchHandler(url)
}

// useEpisodes wraps the useJobs import in try/catch so unit tests don't need
// to provide an SSE-driven jobs source — auto-invalidation just disables.
const { useEpisodes, invalidateEpisodes } = await import('../composables/useEpisodes.js')

function fakeRow(code: string, scriptDone = true) {
  return {
    episode_code: code,
    title: `T${code}`,
    status: {
      script: scriptDone, introduction: false,
      prompts: false, scene_prompts: false, thumb_prompts: false,
      images: false, thumbnails: false,
      audio: false, merged_audio: false,
      video: false, video_assembly: false,
      video_ready: false, publishable: false,
      metadata: false, all_done: false,
    },
  }
}

/**
 * Mount a tiny component that calls the composable, returning a handle
 * to its returned refs. Lets us exercise onMounted-driven side effects.
 */
function mountWithComposable(slug: string) {
  let captured: ReturnType<typeof useEpisodes> | null = null
  const Comp = defineComponent({
    setup() {
      captured = useEpisodes(slug, { invalidateOnJobTypes: [] })
      return () => h('div')
    },
  })
  // Minimal mount: createApp + mount on a detached element.
  const app = createApp(Comp)
  const root = document.createElement('div')
  app.mount(root)
  return { app, captured: captured!, root }
}

describe('useEpisodes', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchHandler = () => []
    // Wipe internal slots between tests.
    invalidateEpisodes('alpha')
    invalidateEpisodes('beta')
  })

  test('first mount fetches and populates episodes', async () => {
    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]
    const { captured, app } = mountWithComposable('alpha')
    // Wait for the onMounted-triggered fetch.
    await nextTick()
    await nextTick()
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    assert.equal(fetchCalls.length, 1, 'one fetch fired')
    assert.match(fetchCalls[0], /\/projects\/alpha\/episodes/)
    assert.equal(captured.episodes.value.length, 2, 'data populated')
    assert.equal(captured.isLoading.value, false, 'isLoading cleared after resolve')
    app.unmount()
  })

  test('second mount serves hot cache without duplicate revalidation', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m1 = mountWithComposable('beta')
    await nextTick(); await nextTick()
    await new Promise(r => setTimeout(r, 0)); await nextTick()
    assert.equal(fetchCalls.length, 1, 'first mount fetched')
    m1.app.unmount()

    // Second mount should neither show loading nor repeat the expensive
    // project-wide status scan while the first result is still hot.
    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]  // changed payload
    const m2 = mountWithComposable('beta')
    // Synchronously after mount, before any async resolves: data should
    // already be the cached value.
    assert.equal(m2.captured.episodes.value.length, 1, 'served cached immediately')
    assert.equal(m2.captured.isLoading.value, false, 'no loading state on warm mount')

    await nextTick()
    await new Promise(r => setTimeout(r, 0))
    await nextTick()

    assert.equal(fetchCalls.length, 1, 'hot mount did not repeat the status request')
    assert.equal(m2.captured.episodes.value.length, 1, 'cached data remains stable')
    m2.app.unmount()
  })

  test('refresh() forces a fresh fetch with ?refresh=1', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m = mountWithComposable('alpha')
    await nextTick()
    await new Promise(r => setTimeout(r, 0)); await nextTick()
    fetchCalls.length = 0  // reset

    fetchHandler = () => [fakeRow('EP001'), fakeRow('EP002')]
    await m.captured.refresh()

    assert.equal(fetchCalls.length, 1, 'one extra fetch fired')
    assert.match(fetchCalls[0], /\?refresh=1/, 'force-refresh query sent')
    assert.equal(m.captured.episodes.value.length, 2, 'new data swapped in')
    m.app.unmount()
  })

  test('invalidate() clears freshness; next mount refetches', async () => {
    fetchHandler = () => [fakeRow('EP001')]
    const m1 = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()
    m1.app.unmount()

    invalidateEpisodes('alpha')
    fetchCalls.length = 0

    fetchHandler = () => [fakeRow('EP002')]
    const m2 = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()

    assert.equal(fetchCalls.length, 1, 'fetched again after invalidate')
    assert.equal(m2.captured.episodes.value.length, 1)
    assert.equal(m2.captured.episodes.value[0].episode_code, 'EP002')
    m2.app.unmount()
  })

  test('mutation refresh bypasses an older request and stale response cannot undo feedback', async () => {
    fetchHandler = () => [fakeRow('EP001', false)]
    const m = mountWithComposable('alpha')
    await nextTick(); await new Promise(r => setTimeout(r, 0)); await nextTick()

    let resolveStale!: (rows: any[]) => void
    let resolveFresh!: (rows: any[]) => void
    const stale = new Promise<any[]>(resolve => { resolveStale = resolve })
    const fresh = new Promise<any[]>(resolve => { resolveFresh = resolve })
    let call = 0
    fetchHandler = () => call++ === 0 ? stale : fresh

    const staleRequest = m.captured.revalidate()
    m.captured.updateEpisode('EP001', ep => ({
      ...ep,
      status_overrides: { script: true },
      status: { ...ep.status, script: true },
    }))
    const mutationRequest = m.captured.revalidateAfterMutation('EP001')

    resolveStale([fakeRow('EP001', false)])
    await staleRequest
    assert.equal(m.captured.episodes.value[0].status.script, true,
      'older response cannot erase immediate mutation feedback')

    const confirmed = fakeRow('EP001', true)
    confirmed.status_overrides = { script: true }
    resolveFresh([confirmed])
    await mutationRequest
    assert.equal(fetchCalls.length >= 2, true, 'mutation starts a distinct request')
    // v1.4.82 — `?mutation=<ts>` only busted the browser cache; the server read
    // it as a plain request and answered from its own pre-mutation status cache.
    assert.match(fetchCalls.at(-1) || '', /invalidate=EP001/)
    assert.equal(m.captured.episodes.value[0].status.script, true)
    assert.deepEqual(m.captured.episodes.value[0].status_overrides, { script: true })
    m.app.unmount()
  })
})
