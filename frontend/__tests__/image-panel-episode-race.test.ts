/**
 * Regression: a delayed read for the episode the user LEFT must not paint the
 * board, and a row click on a stale grid must not submit.
 *
 * BUG. `images.vue` keeps `ImageGeneratorPanel` alive with `v-show` (no `key`),
 * so its props change under a live instance. `loadPrompts` and `loadScan`
 * awaited their GET and assigned blindly, and the episode watcher cleared only
 * `busy`/`errors` — no prompts/images/loading/error reset and no request
 * sequence. Switching A→B where B answers first and A answers late left A's
 * grid under B's header, and Generate on one of those rows built B's LIVE
 * parameters with `force: true` and A's row number, overwriting B's real image.
 * The page's own `imageScopeSequence` guards the page's loaders, not the
 * panel's.
 *
 * FIX. One request revision, bumped by every load cycle and by an episode
 * change, checked in the success, catch and finally paths (the pattern
 * `useGenStudioVoices` uses for `voiceLoadRevision`); the episode's board state
 * blanked synchronously on change; `runOne` refuses a row that belongs to
 * another episode.
 *
 * HARNESS. Mounts the REAL `ImageGeneratorPanel.vue` (`<script setup>` compiled
 * with `@vue/compiler-sfc` + esbuild, the Nuxt auto-imports stubbed) with
 * REACTIVE props, so an episode change is a real prop change on a live
 * instance. Every `get` hangs until the test answers it, which is what lets two
 * reads for two episodes be in flight at once. RUNNER: the frontend lane,
 * `cd frontend && npx tsx --import ./__tests__/setup.ts --test --test-force-exit
 * __tests__/image-panel-episode-race.test.ts`.
 * On the pre-fix code the first three tests FAIL — that is the point.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, reactive, type Component } from 'vue'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction.js'
import { customerSafeJobText, jobRequestIds } from '../utils/job-presentation.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Compile a component's <script setup>, expose its bindings on globalThis.__fx.state. */
async function loadSetup(rel: string, support: string): Promise<Component> {
  const filename = fileURLToPath(new URL(rel, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: rel })
  const vueUrl = import.meta.resolve('vue')
  const content = script.content.replace(/^import[^\n]+\n/gm, '').replace('export default', 'const __sfc__ =')
  const output = await transform(`
    import { computed, defineComponent as _defineComponent, h, ref, watch, onBeforeUnmount, onMounted } from ${JSON.stringify(vueUrl)}
    const fx = globalThis.__fx
    ${support}
    ${content}
    const setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => { const state = setup(props, ctx); fx.state = state; return () => h('main') }
    export default __sfc__
    export const nonce = ${Math.random()} // a fresh module per mount, so fx is this test's fixture`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) { await Promise.resolve(); await nextTick() }
}

const PANEL_SUPPORT = `
  const ImageGeneratorRow = {}
  const useApi = () => ({ get: fx.get, post: fx.post })
  const useToast = () => ({ success: (m) => fx.toasts.push(['ok', m]), error: (m) => fx.toasts.push(['error', m]) })
  const useJobs = () => ({ isJobActiveFor: () => false })
  const useFreshGenerationAction = fx.useFreshGenerationAction
  const customerSafeJobText = fx.customerSafeJobText
  const jobRequestIds = fx.jobRequestIds
`

type Deferred = { resolve: (value: any) => void; reject: (reason?: any) => void }

/** Every read hangs until the test answers it, so two reads can overlap. */
function raceFixture() {
  const fx: any = {
    useFreshGenerationAction, customerSafeJobText, jobRequestIds,
    toasts: [], posts: [] as any[], prepares: [] as any[],
    calls: [] as string[],
    pending: new Map<string, Deferred>(),
    get: (path: string) => {
      fx.calls.push(path)
      return new Promise((resolve, reject) => { fx.pending.set(path, { resolve, reject }) })
    },
    post: async (_path: string, body: any) => { fx.posts.push(body); return { job_id: 'job-1' } },
    prepareResult: (force: boolean) => ({
      episode_id: 'x', model: 'm', mode: 'thumbs', aspect_ratio: '16:9', force,
    }),
  }
  ;(globalThis as any).__fx = fx
  return fx
}

async function mountPanel(fx: any, props: Record<string, any>) {
  const Panel = await loadSetup('../components/ImageGeneratorPanel.vue', PANEL_SUPPORT)
  const app = createApp({ render: () => h(Panel, {
    ...props,
    prepare: async (force: boolean, ask: boolean) => { fx.prepares.push([force, ask]); return fx.prepareResult(force) },
  }) })
  app.mount(document.body.appendChild(document.createElement('div')))
  await flush()
  return app
}

/** Answer the newest read whose path matches, then let the panel settle. */
async function answer(fx: any, match: string, value: any): Promise<void> {
  const key = [...fx.calls].reverse().find((p: string) => p.includes(match) && fx.pending.has(p))
  assert.ok(key, `no read in flight matching "${match}" (issued: ${fx.calls.join(' | ')})`)
  const deferred = fx.pending.get(key!)!
  fx.pending.delete(key!)
  deferred.resolve(value)
  await flush()
}

async function fail(fx: any, match: string, reason: any): Promise<void> {
  const key = [...fx.calls].reverse().find((p: string) => p.includes(match) && fx.pending.has(p))
  assert.ok(key, `no read in flight matching "${match}" (issued: ${fx.calls.join(' | ')})`)
  const deferred = fx.pending.get(key!)!
  fx.pending.delete(key!)
  deferred.reject(reason)
  await flush()
}

test('a late prompt list for the episode the user left does not repaint the board', async () => {
  const fx = raceFixture()
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-A', title: 'A' })
  const app = await mountPanel(fx, props)
  try {
    // EP-A's read is issued on mount and deliberately left hanging.
    assert.ok(fx.calls.some((p: string) => p.includes('/episodes/EP-A/image-prompts')))

    props.episodeId = 'EP-B'
    props.title = 'B'
    await flush()

    // The episode on screen changed, so the previous board is gone at once.
    assert.deepEqual(fx.state.prompts.value, [], 'the previous episode’s rows stayed on screen')

    // B answers first…
    await answer(fx, '/episodes/EP-B/image-prompts', { thumbnails: [{ number: 1, title: 'B1', prompt: 'b' }] })
    assert.equal(fx.state.prompts.value[0]?.title, 'B1')

    // …and A answers late. Its grid must not appear under B's header.
    await answer(fx, '/episodes/EP-A/image-prompts', { thumbnails: [{ number: 1, title: 'A1', prompt: 'a' }] })
    assert.equal(
      fx.state.prompts.value[0]?.title,
      'B1',
      'the late reply for EP-A repainted the board as EP-A under EP-B',
    )
    assert.equal(fx.state.loading.value, false)
  } finally { app.unmount() }
})

test('a late error for the episode the user left does not mark the current board failed', async () => {
  const fx = raceFixture()
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-A', title: 'A' })
  const app = await mountPanel(fx, props)
  try {
    props.episodeId = 'EP-B'
    props.title = 'B'
    await flush()

    await answer(fx, '/episodes/EP-B/image-prompts', { thumbnails: [{ number: 1, title: 'B1', prompt: 'b' }] })

    await fail(fx, '/episodes/EP-A/image-prompts',
      Object.assign(new Error('late failure'), { status: 500, data: { detail: 'late failure' } }))

    assert.equal(fx.state.loadError.value, null, 'an abandoned read’s failure blanked the current board')
    assert.equal(fx.state.prompts.value[0]?.title, 'B1')
    assert.equal(fx.state.loading.value, false)
  } finally { app.unmount() }
})

test('a late disk scan for the episode the user left does not repaint the current grid', async () => {
  const fx = raceFixture()
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-A', title: 'A' })
  const app = await mountPanel(fx, props)
  try {
    props.episodeId = 'EP-B'
    props.title = 'B'
    await flush()

    await answer(fx, '/episodes/EP-B/image-prompts', { thumbnails: [{ number: 1, title: 'B1', prompt: 'b' }] })
    await answer(fx, '/video-editor/scan/EP-B', { thumbnails: [{ filename: 'EP-B_Thumb01_v1.png', path: '/b/1.png', number: 1 }] })
    assert.equal(fx.state.renderedCount.value, 1, 'EP-B’s own scan did not land')

    await answer(fx, '/video-editor/scan/EP-A', { thumbnails: [] })
    assert.equal(fx.state.renderedCount.value, 1, 'the late scan for EP-A blanked EP-B’s rendered images')
  } finally { app.unmount() }
})

test('a row click after the selection moved does not submit against the new episode', async () => {
  const fx = raceFixture()
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-A', title: 'A' })
  const app = await mountPanel(fx, props)
  try {
    await answer(fx, '/episodes/EP-A/image-prompts', { thumbnails: [{ number: 3, title: 'A3', prompt: 'a' }] })
    assert.equal(fx.state.prompts.value.length, 1)

    props.episodeId = 'EP-B'
    props.title = 'B'
    await flush()

    // The click that raced the selection change still carries EP-A's row number.
    // Not awaited: the pre-fix code accepts it and polls its job forever.
    void fx.state.runOne(3)
    await flush()

    assert.equal(fx.prepares.length, 0, 'a stale row consulted the page’s live parameters')
    assert.equal(fx.posts.length, 0, 'a stale row submitted a render against the new episode')
  } finally { app.unmount() }
})

test('a row click on the current episode still renders and re-reads the disk scan', async () => {
  const fx = raceFixture()
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-1', title: 'T' })
  const app = await mountPanel(fx, props)
  try {
    await answer(fx, '/episodes/EP-1/image-prompts', { thumbnails: [{ number: 1, title: 'a', prompt: 'p' }] })
    await answer(fx, '/video-editor/scan/EP-1', { thumbnails: [] })
    assert.equal(fx.state.renderedCount.value, 0)

    const render = fx.state.runOne(1)
    await flush()
    assert.equal(fx.posts.length, 1, 'the live row did not submit')
    assert.equal(fx.posts[0].thumb_number, 1)
    assert.equal(fx.posts[0].force, true)

    // The job finishes, then the panel re-reads the disk and finds the new file.
    await answer(fx, '/jobs/job-1', { status: 'done' })
    await answer(fx, '/video-editor/scan/EP-1', {
      thumbnails: [{ filename: 'EP-1_Thumb01_v1.png', path: '/x/1.png', number: 1 }],
    })
    await render

    assert.equal(fx.state.renderedCount.value, 1, 'the post-render scan did not land')
    assert.equal(fx.state.errors.value[1], '')
  } finally { app.unmount() }
})

test('the panel carries one request revision checked in success, catch and finally', () => {
  const panel = read('../components/ImageGeneratorPanel.vue')
  assert.match(panel, /let boardRevision = 0/)
  assert.match(panel, /const revision = \+\+boardRevision/)
  // Both loaders guard their success AND their failure; the prompt list also
  // guards `loading`, which its abandoned `finally` no longer owns.
  assert.equal((panel.match(/revision !== boardRevision/g) || []).length, 4,
    'both loaders must check the revision in success and catch')
  assert.match(panel, /if \(revision === boardRevision\) loading\.value = false/)
  // The episode change blanks the board synchronously and invalidates in-flight reads.
  assert.match(panel, /watch\(\(\) => props\.episodeId, \(\) => \{[\s\S]{0,400}boardRevision\+\+[\s\S]{0,200}prompts\.value = \[\]/)
  assert.match(panel, /prompts\.value = \[\]\s*\n\s*renderedImages\.value = \[\]\s*\n\s*loading\.value = false\s*\n\s*loadError\.value = null/)
})
