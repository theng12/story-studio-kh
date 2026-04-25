/**
 * Tests for `useProject` — the slug-scoped project state composable.
 *
 * `useProject` is the trunk every project-scoped page reads from for
 * `project` metadata and `config`. An earlier architecture cycle added
 * two subtle correctness guards:
 *
 *   1. Switching slug CLEARS state synchronously before the new fetch
 *      lands, so a component rendered mid-navigation never sees the old
 *      project's data against the new `:slug` route param.
 *   2. Out-of-order HTTP responses from the PRIOR slug are dropped. If
 *      the user clicks from project A to B while A's requests are still
 *      in flight, A's response must NOT clobber B's state.
 *
 * Both guards are easy to regress with a careless refactor. These tests
 * pin them so a future change that drops the stale-response check fails
 * CI immediately.
 *
 * $fetch is a Nuxt global — we install a controllable stub before the
 * composable module loads so each test drives response timing + content.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ── Controllable $fetch stub ────────────────────────────────────────────────
// Each call pulls a handler off the front of `queue` if present; otherwise
// falls back to a default synchronous OK response. Tests that need to
// serialise responses (e.g. the out-of-order guard) push deferred promises.

interface Deferred<T> { promise: Promise<T>; resolve: (v: T) => void }
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

type FetchHandler = (url: string) => any | Promise<any>
const fetchQueue: FetchHandler[] = []
let fetchCalls: string[] = []
let defaultHandler: FetchHandler = (url) => {
  // Minimal happy-path shapes matching ProjectMeta / SafeProjectConfig.
  if (/settings\/config$/.test(url)) return { has_kie_key: false, has_fal_key: false, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' }
  return { name: 'DefaultName', slug: 'default', episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season', folder_template: '', subfolder_names: {}, output_root: '', created_at: '' }
}

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  const h = fetchQueue.shift() ?? defaultHandler
  return await h(url)
}

const { useProject } = await import('../composables/useProject.js')

// Module-scoped state persists across tests; each test walks through a
// clean lifecycle by calling clearProject() first.
beforeEach(() => {
  const { clearProject } = useProject()
  clearProject()
  fetchQueue.length = 0
  fetchCalls = []
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useProject.loadProject()', () => {
  test('hydrates project + config and toggles loading', async () => {
    const { loadProject, project, config, loading, slug } = useProject()

    const p = loadProject('alpha')
    // `loading` flips true before the await boundary returns — the stub is
    // async so the promise hasn't resolved yet.
    assert.equal(loading.value, true)
    await p

    assert.equal(slug.value, 'alpha')
    assert.equal(loading.value, false)
    assert.ok(project.value, 'project should be populated')
    assert.ok(config.value, 'config should be populated')
    // Both endpoints hit: project meta + settings/config.
    assert.ok(fetchCalls.some(u => u === '/api/projects/alpha'),
      `expected a call to /api/projects/alpha; got ${fetchCalls.join(', ')}`)
    assert.ok(fetchCalls.some(u => u === '/api/projects/alpha/settings/config'),
      `expected a call to /api/projects/alpha/settings/config; got ${fetchCalls.join(', ')}`)
  })

  test('switching slug clears state synchronously before the new fetch', async () => {
    const { loadProject, project, config } = useProject()

    await loadProject('first')
    assert.ok(project.value, 'first project loaded')
    assert.ok(config.value, 'first config loaded')

    // Make the next loadProject call hang so we can observe pre-fetch state.
    const d1 = defer<any>()
    const d2 = defer<any>()
    fetchQueue.push(() => d1.promise, () => d2.promise)

    const pending = loadProject('second')
    // Synchronous expectation: state MUST be cleared before the fetch resolves,
    // otherwise a mid-navigation component would render `first`'s data under
    // the `/projects/second/...` route.
    assert.equal(project.value, null, 'project cleared synchronously on slug change')
    assert.equal(config.value, null, 'config cleared synchronously on slug change')

    d1.resolve({ name: 'Second', slug: 'second', episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season', folder_template: '', subfolder_names: {}, output_root: '', created_at: '' })
    d2.resolve({ has_kie_key: false, has_fal_key: false, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' })
    await pending

    assert.equal(project.value?.name, 'Second')
  })

  test('out-of-order response from prior slug does NOT clobber new state', async () => {
    const { loadProject, project, slug } = useProject()

    // Start loading A with deferred responses.
    const aMeta = defer<any>()
    const aConfig = defer<any>()
    fetchQueue.push(() => aMeta.promise, () => aConfig.promise)
    const pA = loadProject('A')

    // Immediately switch to B with fast responses — B finishes first.
    fetchQueue.push(
      () => ({ name: 'B-name', slug: 'B', episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season', folder_template: '', subfolder_names: {}, output_root: '', created_at: '' }),
      () => ({ has_kie_key: false, has_fal_key: false, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' }),
    )
    await loadProject('B')

    assert.equal(slug.value, 'B', 'current slug should be B')
    assert.equal(project.value?.name, 'B-name', 'project should be B')

    // NOW resolve A's responses — they arrive stale and must be discarded.
    aMeta.resolve({ name: 'A-name', slug: 'A', episode_prefix: 'EP', episode_digits: 4, season_size: 20, season_prefix: 'Season', folder_template: '', subfolder_names: {}, output_root: '', created_at: '' })
    aConfig.resolve({ has_kie_key: true, has_fal_key: false, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' })
    await pA

    assert.equal(project.value?.name, 'B-name',
      'stale response from prior slug must NOT overwrite B')
    assert.equal(slug.value, 'B')
  })
})

describe('useProject.refreshConfig()', () => {
  test('updates config only when the slug still matches', async () => {
    const { loadProject, refreshConfig, config, slug } = useProject()
    await loadProject('active')
    assert.ok(config.value)

    // Slug-match: mutation applies.
    fetchQueue.push(() => ({ has_kie_key: true, has_fal_key: false, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' }))
    await refreshConfig('active')
    assert.equal(config.value?.has_kie_key, true, 'matching-slug refresh applies')

    // Slug-mismatch: returned value is discarded.
    fetchQueue.push(() => ({ has_kie_key: false, has_fal_key: true, has_openai_key: false, has_anthropic_key: false, image_models: {}, voice_presets: [], audio_models: {}, image_pricing_last_updated: '', audio_pricing_last_updated: '' }))
    await refreshConfig('some-other-slug')
    assert.equal(config.value?.has_kie_key, true,
      'refresh for a non-active slug must not mutate our state')
    assert.equal(config.value?.has_fal_key, false,
      'the returned payload must not leak into our state')
    assert.equal(slug.value, 'active', 'active slug unchanged')
  })
})

describe('useProject.clearProject()', () => {
  test('wipes project, config, and slug', async () => {
    const { loadProject, clearProject, project, config, slug } = useProject()
    await loadProject('to-clear')
    assert.ok(project.value)
    assert.ok(config.value)
    assert.equal(slug.value, 'to-clear')

    clearProject()
    assert.equal(project.value, null)
    assert.equal(config.value, null)
    assert.equal(slug.value, null)
  })
})
