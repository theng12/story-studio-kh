/**
 * EpisodeEffectsEditor — the controlled draft contract, from the browser's
 * side plus the pure draft rules.
 *
 * What it pins: browsing and editing never write; apply() is the only write
 * path (outline uploads and the analysis side-writes run only inside it, in
 * the fixed order); cancel() and a scope change discard the draft and say so;
 * an answer from the old episode is dropped after a scope change; the exact
 * preview's hint names the Ken Burns camera limit instead of claiming the
 * episode's own move. Late answers are fenced per operation: the same episode
 * id on another channel, a preview render that lands after the preview scene
 * changed, and an apply whose scope moved before its last write.
 *
 * What it cannot catch: layout, canvas pixels, and the exact-preview render
 * itself (the backend render tests own that). Not run here by instruction —
 * the lead coordinates suite runs.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const lib = await import('../utils/effects-library.js')
const draftUtil = await import('../utils/episode-effects-draft.js')
const { BUILT_IN_OVERLAYS } = await import('../../electron/server/contracts/scene-effect-presets.js')

const SLUG = 'history-explained'
const library = BUILT_IN_OVERLAYS as any[]
const BASELINE_ID = 'vignette-soft'
const BASELINE_NAME = library.find(e => e.id === BASELINE_ID)!.name
const scenes = [
  { id: 's1', scene_index: 1, start_sec: 0, end_sec: 60, has_image: true, theme: 'rainy', label: 'Porch' },
  { id: 's2', scene_index: 2, start_sec: 60, end_sec: 120, has_image: true, theme: null, label: 'Kitchen' },
]
/** The first card on the All tab — what a click on the library selects. */
const FIRST_ID = lib.sectionFor(library, 'all', '')[0].entries[0].id
const FIRST_NAME = lib.sectionFor(library, 'all', '')[0].entries[0].name

function fileEp1() {
  return { ...lib.emptyEffectsFile(), episode: [{ uid: 'a-1', id: BASELINE_ID, enabled: true }] }
}
function fileEp2() {
  // Deliberately empty: after a scope change the stack must read "Nothing here yet".
  return lib.emptyEffectsFile()
}

// ── The pure draft rules ─────────────────────────────────────────────────────
describe('the draft rules', () => {
  test('a clean file is not dirty; a changed file or a queued side-write is', () => {
    const baseline = fileEp1()
    const file = JSON.parse(JSON.stringify(baseline))
    assert.equal(draftUtil.isDraftDirty(baseline, file, []), false)
    file.episode[0].enabled = false
    assert.equal(draftUtil.isDraftDirty(baseline, file, []), true)
    const clean = JSON.parse(JSON.stringify(baseline))
    assert.equal(draftUtil.isDraftDirty(baseline, clean, [{ kind: 'analyse' }]), true)
  })

  test('planOps keeps only outlines the file still references, and orders writes switches → analyse → presets', () => {
    const file = { ...lib.emptyEffectsFile(), scenes: [{ scene_id: 's1', effects: [{ uid: 'u', id: 'fireflies', enabled: true, params: { region: { mask: 'draft-outline-1.png' } } }] }] }
    const ops = [
      { kind: 'preset-delete', preset_id: 'p1', name: 'Old stack' },
      { kind: 'preset-save', name: 'Night', effects: [{ id: 'rain' }] },
      { kind: 'analyse' },
      { kind: 'outline', placeholder: 'draft-outline-1.png', scene_id: 's1', label: 'Porch', shapes: [], feather_px: 4 },
      { kind: 'outline', placeholder: 'draft-outline-2', scene_id: 's1', label: 'Never referenced' },
      { kind: 'switches', switches: { depth: true, vision: false } },
    ] as any[]
    const plan = draftUtil.planOps(file as any, ops)
    assert.deepEqual(plan.outlines.map(o => o.placeholder), ['draft-outline-1.png'], 'an unreferenced upload is dropped, not fired')
    assert.deepEqual(plan.writes.map(o => o.kind), ['switches', 'analyse', 'preset-save', 'preset-delete'])
  })

  test('planOps matches masks by exact identity: draft-outline-1 is not draft-outline-10', () => {
    const file = { ...lib.emptyEffectsFile(), scenes: [{ scene_id: 's1', effects: [
      { uid: 'u1', id: 'fireflies', enabled: true, params: { region: { mask: 'draft-outline-10.png' } } },
    ] }] }
    const ops = [
      { kind: 'outline', placeholder: 'draft-outline-1.png', scene_id: 's1', label: 'A' },
      { kind: 'outline', placeholder: 'draft-outline-10.png', scene_id: 's1', label: 'B' },
    ] as any[]
    const plan = draftUtil.planOps(file as any, ops)
    assert.deepEqual(plan.outlines.map(o => o.placeholder), ['draft-outline-10.png'], 'the shorter placeholder does not ride on the longer mask')
  })

  test('adoptMasks replaces exactly: the longer name is untouched by the shorter one', () => {
    const file = { ...lib.emptyEffectsFile(), episode: [
      { uid: 'u1', id: 'fireflies', enabled: true, params: { region: { mask: 'draft-outline-1.png' } } },
      { uid: 'u2', id: 'rain', enabled: true, params: { region: { mask: 'draft-outline-10.png' } } },
    ] }
    const outlines = draftUtil.adoptMasks(file as any, ['draft-outline-1.png', 'draft-outline-10.png'], { 'draft-outline-1.png': 'real-a.png' })
    assert.equal(file.episode[0].params.region.mask, 'real-a.png')
    assert.equal(file.episode[1].params.region.mask, 'draft-outline-10.png', 'the longer mask keeps its placeholder')
    assert.deepEqual(outlines, ['real-a.png', 'draft-outline-10.png'])
  })

  test('the payload is the page\'s own compaction; adoptMasks replaces placeholders in file and list', () => {
    const file = { ...lib.emptyEffectsFile(), scenes: [{ scene_id: 's1', effects: [] }], episode: [{ uid: 'u', id: 'fireflies', enabled: true, params: { region: { mask: 'draft-outline-1.png' } } }] }
    const payload = draftUtil.applyFilePayload(file as any)
    assert.deepEqual(payload.scenes, [], 'empty stacks are dropped exactly as compactFile does')
    assert.equal(payload.episode[0].params.region.mask, 'draft-outline-1.png')
    const outlines = draftUtil.adoptMasks(file as any, ['draft-outline-1.png'], { 'draft-outline-1.png': 's1-porch.png' })
    assert.equal(file.episode[0].params.region.mask, 's1-porch.png')
    assert.deepEqual(outlines, ['s1-porch.png'])
  })
})

// ── The panel, mounted against stubbed endpoints ─────────────────────────────
interface Call { method: string; path: string; body?: any }

async function loadEditor(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/EpisodeEffectsEditor.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'episode-effects-editor-test' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'episode-effects-editor-test',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const util = (name: string) => JSON.stringify(new URL(`../utils/${name}.ts`, import.meta.url).href)
  const shared = (name: string) => JSON.stringify(new URL(`../../electron/server/contracts/${name}.ts`, import.meta.url).href)
  const support = `
    import { computed, defineComponent as _defineComponent, h, onBeforeUnmount, onMounted, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__fxHarness.api()
    const useToast = () => globalThis.__fxHarness.toast()
    const usePresets = (opts) => globalThis.__fxHarness.presets(opts)
  `
  const scriptCode = script.content
    // The support block above supplies these; stripping avoids a duplicate binding.
    .replace(/^import \{[^}]*\} from 'vue'\n/gm, '')
    .replace("'@shared/scene-effect-presets'", shared('scene-effect-presets'))
    .replace("'@shared/effect-params'", shared('effect-params'))
    .replace("'@shared/scene-effects'", shared('scene-effects'))
    .replace("'@shared/effect-loops'", shared('effect-loops'))
    .replace("'~/utils/effect-preview-canvas'", util('effect-preview-canvas'))
    .replace("'~/utils/effects-library'", util('effects-library'))
    .replace("'~/utils/episode-effects-draft'", util('episode-effects-draft'))
    .replace('export default', 'const __sfc__ =')
  const code = `${support}\n${scriptCode}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const finalCode = transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))
  return (await import(`data:text/javascript;base64,${Buffer.from(finalCode).toString('base64')}`)).default
}

interface HarnessOptions {
  /** Hold the first call whose method and path match, until resolveHeld(). */
  holdCall?: { method: 'GET' | 'PUT' | 'POST'; path: string }
  /** Hold a queued preset save inside the panel's apply, until resolvePresetHeld(). */
  holdPresetSave?: boolean
  /** User presets the panel lists (the delete side-write needs one). */
  presetList?: any[]
  /** The first preset delete fails, so a later retry has to run it again. */
  failRemoveOnce?: boolean
  /** Reject the first PUT to this path, then behave normally — a retry succeeds. */
  failPutOnce?: string
  /** Serve this exact object as ep1's file on every GET — the SWR cache's shared object. */
  sharedEpisodeFile?: any
}

/** The episode's own read, answered the same way whichever channel asks — the tests switch channels. */
function episodeAnswer(path: string, sharedEpisodeFile?: any): any | null {
  if (path.endsWith('/effects-library/ep1')) return { overlays: library, scenes, outlines: [], has_scene_plan: true, read_error: '', file: sharedEpisodeFile ?? fileEp1() }
  if (path.endsWith('/effects-library/ep2')) return { overlays: library, scenes, outlines: [], has_scene_plan: true, read_error: '', file: fileEp2() }
  return null
}

/** A FileReader that answers with fixed bytes — happy-dom's own one is not needed. */
class StubFileReader {
  result: string | null = null
  error: any = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(): void {
    this.result = 'data:image/png;base64,QUJD'
    queueMicrotask(() => this.onload?.())
  }
}

async function mountEditor(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const toasts: string[] = []
  const dirtyEvents: boolean[] = []
  const loadingEvents: boolean[] = []
  const presetSaves: Array<{ name: string; slug: string }> = []
  const presetLoads: string[] = []
  let held: { resolve?: (value: any) => void } | null = null
  let heldPreset: { resolve?: () => void } | null = null
  let heldMatched = false
  let removeFailed = false
  let putFailed = false

  function holdFor(method: string, path: string): Promise<any> | null {
    const hold = options.holdCall
    if (!hold || heldMatched || hold.method !== method || hold.path !== path) return null
    heldMatched = true
    return new Promise((resolve) => { held = { resolve } })
  }

  const api = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      const heldAnswer = holdFor('GET', path)
      if (heldAnswer) return heldAnswer
      const episode = episodeAnswer(path, options.sharedEpisodeFile)
      if (episode) return episode
      if (path.endsWith('/video-editor/effects/catalog')) return { overlays: library, scene_motions: [], motion_families: [] }
      if (path.endsWith('/effects-library-in-use')) return { overlays: [], motions: [], source: null }
      if (path.endsWith('/video-editor/transitions/catalog')) return { transitions: [] }
      if (path.endsWith('/scene-analysis')) return {
        switches: { depth: false, vision: false }, models: { depth: 'd1', vision: 'v1' },
        status: { state: 'idle', total: 0, done: 0, failed: 0, left: 0, message: '' }, scenes: [],
      }
      throw { data: { detail: `unstubbed GET ${path}` } }
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      const heldAnswer = holdFor('PUT', path)
      if (heldAnswer) return heldAnswer
      if (options.failPutOnce === path && !putFailed) {
        putFailed = true
        throw { data: { detail: 'disk full' } }
      }
      if (path.endsWith('/scene-analysis/switches')) return { switches: body }
      return {}
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      const heldAnswer = holdFor('POST', path)
      if (heldAnswer) return heldAnswer
      if (path.endsWith('/scene-analysis')) return { status: { state: 'running', total: 1, done: 0, failed: 0, left: 1, message: '' } }
      if (path.endsWith('/outlines')) return { mask: `uploaded-${body.label || 'outline'}.png` }
      if (path.endsWith('/exact-preview')) return { url: '/api/preview/x.webm', render_ms: 1200, width: 960, height: 540, duration_sec: 6, camera_engine: 'native', backdrop: 'gradient' }
      if (path.endsWith('/gallery/refresh')) return {}
      throw { data: { detail: `unstubbed POST ${path}` } }
    },
  }

  ;(globalThis as any).__fxHarness = {
    api: () => api,
    toast: () => ({ success: (m: string) => toasts.push(m), error: (m: string) => toasts.push(m) }),
    presets: (opts: { slug: string }) => ({
      presets: { value: options.presetList || [] },
      // Recorded at call time: proves the composable is pointed at the live channel.
      load: async () => { presetLoads.push(opts.slug) },
      saveAs: async (name: string) => {
        // The real composable reads opts.slug when it persists, after awaits.
        if (options.holdPresetSave) await new Promise<void>(resolve => { heldPreset = { resolve: () => resolve() } })
        presetSaves.push({ name, slug: opts.slug })
      },
      setActive: async () => undefined,
      remove: async () => {
        if (options.failRemoveOnce && !removeFailed) {
          removeFailed = true
          throw { data: { detail: 'preset delete failed' } }
        }
      },
    }),
  }

  const previousFileReader = (globalThis as any).FileReader
  ;(globalThis as any).FileReader = StubFileReader

  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const channel = ref(SLUG)
  const episode = ref('ep1')
  const panelRef = ref<any>(null)
  const Editor = await loadEditor()
  const Wrapper = defineComponent({
    setup() {
      return () => h(Editor, {
        projectSlug: channel.value,
        episodeId: episode.value,
        ref: panelRef,
        onDirtyChange: (value: boolean) => dirtyEvents.push(value),
        onLoadingChange: (value: boolean) => loadingEvents.push(value),
      })
    },
  })
  const app = createApp(Wrapper)
  app.mount(host)
  await flush()

  let unmounted = false
  return {
    host, calls, toasts, dirtyEvents, loadingEvents, presetSaves, presetLoads,
    panel: panelRef,
    writes: () => calls.filter(c => c.method !== 'GET'),
    setEpisode: async (next: string) => { episode.value = next; await flush() },
    setSlug: async (next: string) => { channel.value = next; await flush() },
    resolveHeld: async (value: any) => { held?.resolve?.(value); await flush() },
    resolvePresetHeld: async () => { heldPreset?.resolve?.(); await flush() },
    unmount: () => {
      if (unmounted) return
      unmounted = true
      app.unmount()
      delete (globalThis as any).__fxHarness
      ;(globalThis as any).FileReader = previousFileReader
    },
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function text(host: HTMLElement): string {
  return host.textContent || ''
}

/** The stack card's own words — effect names also appear in the library grid. */
function stackText(host: HTMLElement): string {
  return host.querySelector('.fx-stack')?.textContent || ''
}

function button(host: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => label.test(candidate.textContent || ''))
  assert.ok(found, `expected button ${label}`)
  return found
}

/** The target select ("Add effects to") — the first select in the context card. */
function targetSelect(host: HTMLElement): HTMLSelectElement {
  const found = host.querySelector<HTMLSelectElement>('.fx-context select')
  assert.ok(found, 'expected the target select')
  return found
}

async function pick(host: HTMLElement): Promise<void> {
  const card = [...host.querySelectorAll<HTMLButtonElement>('button.fx-card')][0]
  assert.ok(card, 'expected a library card')
  card.click()
  await flush()
}

async function addSelectedEffect(host: HTMLElement): Promise<void> {
  await pick(host)
  button(host, /^Add to /).click()
  await flush()
}

describe('the panel drafts until apply', () => {
  test('loading and browsing write nothing; the draft status says so', async () => {
    const mounted = await mountEditor()
    try {
      assert.ok(mounted.calls.every(c => c.method === 'GET'), 'only reads while open')
      assert.deepEqual(mounted.writes(), [], 'no write while open')
      assert.ok(stackText(mounted.host).includes(BASELINE_NAME), 'the loaded stack shows')
      assert.equal(mounted.dirtyEvents.at(-1), false)
      assert.ok(text(mounted.host).includes('Saved with this episode'), 'clean state reads as saved, not as "not checked"')
    } finally {
      mounted.unmount()
    }
  })

  test('an edit stays a draft; apply() writes once; unmount without apply writes nothing', async () => {
    const mounted = await mountEditor()
    try {
      targetSelect(mounted.host).value = 'episode'
      targetSelect(mounted.host).dispatchEvent(new Event('change'))
      await flush()

      await addSelectedEffect(mounted.host)
      assert.deepEqual(mounted.writes(), [], 'still no write after Add')
      assert.equal(mounted.dirtyEvents.at(-1), true, 'the panel announces dirty')
      assert.ok(text(mounted.host).includes('Unsaved changes'), 'draft state is visible')
      assert.match(text(mounted.host), /Ken Burns/, 'the exact preview states its camera limit')

      const result = await mounted.panel.value.apply()
      assert.deepEqual(result, { ok: true })
      const puts = mounted.writes()
      assert.equal(puts.length, 1, 'apply writes exactly once')
      assert.equal(puts[0].path, `/projects/${SLUG}/effects-library/ep1`)
      assert.equal(puts[0].body.episode.length, 2, 'baseline effect plus the added one')
      assert.equal(puts[0].body.episode[1].id, FIRST_ID)
      assert.equal(mounted.dirtyEvents.at(-1), false, 'clean after apply')

      // A further edit, then leaving the dialog: no autosave, no unmount flush.
      await addSelectedEffect(mounted.host)
      assert.equal(mounted.dirtyEvents.at(-1), true)
      mounted.unmount()
      assert.equal(mounted.writes().length, 1, 'unmount is a cancel, never a save')
    } finally {
      mounted.unmount()
    }
  })

  test('cancel() discards the draft back to the loaded file', async () => {
    const mounted = await mountEditor()
    try {
      targetSelect(mounted.host).value = 'episode'
      targetSelect(mounted.host).dispatchEvent(new Event('change'))
      await flush()
      await addSelectedEffect(mounted.host)
      assert.equal(mounted.dirtyEvents.at(-1), true)

      mounted.panel.value.cancel()
      await flush()
      assert.deepEqual(mounted.writes(), [], 'cancel writes nothing')
      assert.equal(mounted.dirtyEvents.at(-1), false, 'draft is clean again')
      assert.ok(stackText(mounted.host).includes(BASELINE_NAME), 'the loaded stack is back')
      assert.ok(!stackText(mounted.host).includes(FIRST_NAME), 'the added effect is gone from the stack')
    } finally {
      mounted.unmount()
    }
  })

  test('cancel then reopen never leaks the draft through the shared read cache; Apply survives a reopen', async () => {
    // The SWR read cache answers every GET with the same object; the draft must not mutate it.
    const shared = fileEp2()
    const first = await mountEditor({ sharedEpisodeFile: shared })
    try {
      targetSelect(first.host).value = 'episode'
      targetSelect(first.host).dispatchEvent(new Event('change'))
      await flush()
      await addSelectedEffect(first.host)
      assert.equal(first.dirtyEvents.at(-1), true)

      first.panel.value.cancel()
      await flush()
      assert.deepEqual(first.writes(), [], 'cancel writes nothing')
      assert.ok(!stackText(first.host).includes(FIRST_NAME), 'the cancelled addition leaves the draft')
      assert.ok(!JSON.stringify(shared).includes(FIRST_ID), 'the draft never mutates the shared read cache')
    } finally {
      first.unmount()
    }

    // Reopen against the same cached response: the cancelled addition is gone and the panel is clean.
    const second = await mountEditor({ sharedEpisodeFile: shared })
    try {
      assert.ok(!stackText(second.host).includes(FIRST_NAME), 'the cancelled addition is gone on reopen')
      assert.equal(second.dirtyEvents.at(-1), false, 'reopen is clean')
      assert.deepEqual(second.writes(), [], 'reopening writes nothing')

      // Apply, then reopen against what the PUT saved: an applied addition stays.
      targetSelect(second.host).value = 'episode'
      targetSelect(second.host).dispatchEvent(new Event('change'))
      await flush()
      await addSelectedEffect(second.host)
      assert.deepEqual(await second.panel.value.apply(), { ok: true })
      const put = second.writes().find(c => c.method === 'PUT')!
      Object.assign(shared, put.body)
    } finally {
      second.unmount()
    }

    const third = await mountEditor({ sharedEpisodeFile: shared })
    try {
      assert.ok(stackText(third.host).includes(FIRST_NAME), 'an applied addition survives reopen')
      assert.equal(third.dirtyEvents.at(-1), false, 'the saved file reads clean')
    } finally {
      third.unmount()
    }
  })

  test('cancel after a partly failed apply keeps the file that was already saved', async () => {
    const mounted = await mountEditor({
      presetList: [{ id: 'p-user', name: 'My night stack', data: { effects: [{ id: BASELINE_ID }] }, type: 'effect-stack' }],
      failRemoveOnce: true,
    })
    try {
      targetSelect(mounted.host).value = 'episode'
      targetSelect(mounted.host).dispatchEvent(new Event('change'))
      await flush()
      await addSelectedEffect(mounted.host)
      button(mounted.host, /^Delete$/).click()
      await flush()

      const result = await mounted.panel.value.apply()
      assert.equal(result.ok, false, 'the preset delete failed after the file had been written')
      assert.ok(text(mounted.host).includes('Apply incomplete'), 'a partly written Apply says incomplete')
      assert.ok(!text(mounted.host).includes('Not applied'), 'the panel never claims nothing was written')
      assert.equal(
        mounted.writes().filter(c => c.method === 'PUT' && c.path === `/projects/${SLUG}/effects-library/ep1`).length,
        1,
        'the file was saved before the side-write failed',
      )

      // Cancel is not "nothing was saved": the file write above is real.
      mounted.panel.value.cancel()
      await flush()
      assert.equal(
        mounted.host.querySelectorAll('.fx-row:not(.fx-row-fixed)').length,
        2,
        'the saved addition is still in the stack',
      )
      assert.equal(mounted.dirtyEvents.at(-1), false, 'the panel now matches the saved file')
      assert.equal(mounted.writes().length, 1, 'cancel adds no write')
    } finally {
      mounted.unmount()
    }
  })

  test('a scope change discards the draft and says so; a late answer from the old episode is dropped', async () => {
    const mounted = await mountEditor({ holdCall: { method: 'GET', path: `/projects/${SLUG}/effects-library/ep1` } })
    try {
      // ep1's file read is held open: nothing loaded, nothing dirty, nothing written.
      assert.equal(mounted.dirtyEvents.at(-1), false)
      assert.deepEqual(mounted.writes(), [], 'a held load writes nothing')

      await mounted.setEpisode('ep2')
      assert.ok(mounted.calls.some(c => c.path === `/projects/${SLUG}/effects-library/ep2`), 'the new scope loads')
      assert.deepEqual(mounted.writes(), [], 'a scope change never writes')

      // ep1's stale answer arrives now — it must lose to the ep2 scope.
      await mounted.resolveHeld({ overlays: library, scenes, outlines: [], has_scene_plan: true, read_error: '', file: fileEp1() })
      assert.ok(stackText(mounted.host).includes('Nothing here yet'), 'the stack shows ep2 (empty), not the stale ep1 file')
      assert.ok(!stackText(mounted.host).includes(BASELINE_NAME), 'the stale baseline effect never appears')
      assert.equal(mounted.dirtyEvents.at(-1), false)
      assert.equal(mounted.loadingEvents.at(-1), false, 'loading settles for the live scope')
    } finally {
      mounted.unmount()
    }
  })

  test('edits before a scope change are discarded with a spoken message', async () => {
    const mounted = await mountEditor()
    try {
      targetSelect(mounted.host).value = 'episode'
      targetSelect(mounted.host).dispatchEvent(new Event('change'))
      await flush()
      await addSelectedEffect(mounted.host)
      assert.equal(mounted.dirtyEvents.at(-1), true)

      await mounted.setEpisode('ep2')
      assert.ok(mounted.toasts.some(t => t.includes('discarded')), 'losing the draft is announced, never silent')
      assert.equal(mounted.dirtyEvents.at(-1), false, 'the draft is clean for the new scope')
      assert.ok(stackText(mounted.host).includes('Nothing here yet'), 'the new scope shows its own empty stack')
      assert.ok(!stackText(mounted.host).includes(FIRST_NAME), 'the old episode’s addition does not survive')
      assert.deepEqual(mounted.writes(), [], 'discarding is not a save')
    } finally {
      mounted.unmount()
    }
  })

  test('scene-analysis switches and the run queue up and fire only inside apply, in order', async () => {
    const mounted = await mountEditor()
    try {
      const depth = mounted.host.querySelector<HTMLInputElement>('.fx-analysis .fx-switch input')
      assert.ok(depth, 'expected the depth switch')
      depth.click()
      await flush()
      button(mounted.host, /Analyse Scenes/).click()
      await flush()

      assert.deepEqual(mounted.writes(), [], 'queueing writes nothing')
      assert.ok(button(mounted.host, /Analyses on Apply|Analysing/), 'the queued run is labelled honestly')
      assert.ok(text(mounted.host).includes('held until you apply'), 'the switch says where it waits')

      const result = await mounted.panel.value.apply()
      assert.deepEqual(result, { ok: true })
      const writes = mounted.writes().map(c => `${c.method} ${c.path}`)
      assert.deepEqual(writes, [
        `PUT /projects/${SLUG}/effects-library/ep1`,
        `PUT /projects/${SLUG}/scene-analysis/switches`,
        `POST /projects/${SLUG}/effects-library/ep1/scene-analysis`,
      ], 'file first, then switches, then the analysis they gate')
      assert.equal(mounted.dirtyEvents.at(-1), false)
      assert.equal(mounted.presetSaves.length, 0)
    } finally {
      mounted.unmount()
    }
  })
})

// ── Late answers are fenced against the scope they were asked for ────────────
describe('the panel fences late answers', () => {
  test('the same episode on a new channel reads the new channel; the old channel’s late answer is dropped', async () => {
    const mounted = await mountEditor({ holdCall: { method: 'GET', path: `/projects/${SLUG}/effects-library/ep1` } })
    try {
      await mounted.setSlug('second-channel')
      assert.ok(
        mounted.calls.some(c => c.method === 'GET' && c.path === '/projects/second-channel/effects-library/ep1'),
        'the panel loads the episode from the new channel',
      )
      assert.ok(
        mounted.presetLoads.includes('second-channel'),
        'the preset list follows the live channel, not the one the panel was created with',
      )

      // The old channel's read answers now — the same episode id, so only the scope can tell them apart.
      await mounted.resolveHeld({ overlays: library, scenes, outlines: [], has_scene_plan: true, read_error: '', file: fileEp2() })
      assert.ok(stackText(mounted.host).includes(BASELINE_NAME), 'the new channel’s loaded file stands')
      assert.deepEqual(mounted.writes(), [], 'switching channel writes nothing')
    } finally {
      mounted.unmount()
    }
  })

  test('a channel switch during a preset save writes that preset to the captured channel', async () => {
    const mounted = await mountEditor({ holdPresetSave: true })
    try {
      button(mounted.host, /Save Stack as Preset/).click()
      await flush()
      const nameInput = mounted.host.querySelector<HTMLInputElement>('.fx-save-preset input')
      assert.ok(nameInput, 'expected the preset name field')
      nameInput.value = 'Night rain'
      nameInput.dispatchEvent(new Event('input'))
      await flush()
      button(mounted.host, /^Save$/).click()
      await flush()

      const applying = mounted.panel.value.apply()
      await flush()
      // The preset save is in flight when the channel changes.
      await mounted.setSlug('second-channel')
      await mounted.resolvePresetHeld()
      const result = await applying

      assert.equal(result.ok, false, 'the changed scope stops the rest of the run')
      assert.deepEqual(
        mounted.presetSaves,
        [{ name: 'Night rain', slug: SLUG }],
        'the preset stayed with the channel Apply captured, not the one open now',
      )
      assert.ok(mounted.presetLoads.includes('second-channel'), 'the preset list follows the live channel once Apply is over')
    } finally {
      mounted.unmount()
    }
  })

  test('an exact preview that lands after the preview scene changed is not shown', async () => {
    const mounted = await mountEditor({ holdCall: { method: 'POST', path: `/projects/${SLUG}/effects-library/ep1/exact-preview` } })
    try {
      await addSelectedEffect(mounted.host)
      button(mounted.host, /Render Exact 6 s Preview/).click()
      await flush()

      const preview = mounted.host.querySelectorAll<HTMLSelectElement>('.fx-context select')[1]!
      preview.value = 's2'
      preview.dispatchEvent(new Event('change'))
      await flush()

      await mounted.resolveHeld({ url: '/api/preview/x.webm', render_ms: 1200, width: 960, height: 540, duration_sec: 6, camera_engine: 'native', backdrop: 'gradient' })
      assert.equal(mounted.host.querySelector('.fx-exact video'), null, 'the old scene’s render is not shown as the new scene’s')
      assert.ok(button(mounted.host, /Render Exact 6 s Preview/), 'the button is free again, not stuck on “Rendering…”')
    } finally {
      mounted.unmount()
    }
  })

  test('a scope change mid-apply stops the run before any further write', async () => {
    const mounted = await mountEditor({ holdCall: { method: 'PUT', path: `/projects/${SLUG}/effects-library/ep1` } })
    try {
      await addSelectedEffect(mounted.host)
      const applying = mounted.panel.value.apply()
      await flush()

      await mounted.setEpisode('ep2')
      // The old run's write answers after the new scope owns the panel.
      await mounted.resolveHeld({})
      const result = await applying
      assert.equal(result.ok, false)
      assert.match(result.error || '', /episode changed/, 'the old run says why it stopped')
      assert.deepEqual(
        mounted.writes().filter(c => c.path.endsWith('/effects-library/ep2')),
        [],
        'nothing from the old run writes to the new episode',
      )
      assert.equal(mounted.dirtyEvents.at(-1), false, 'the new episode’s draft is clean')
    } finally {
      mounted.unmount()
    }
  })

  test('a failed apply retries only the writes that had not succeeded', async () => {
    const mounted = await mountEditor({
      presetList: [{ id: 'p-user', name: 'My night stack', data: { effects: [{ id: BASELINE_ID }] }, type: 'effect-stack' }],
      failRemoveOnce: true,
    })
    try {
      // Queue a preset save, then a preset delete that fails after the save succeeded.
      button(mounted.host, /Save Stack as Preset/).click()
      await flush()
      const nameInput = mounted.host.querySelector<HTMLInputElement>('.fx-save-preset input')
      assert.ok(nameInput, 'expected the preset name field')
      nameInput.value = 'Night rain'
      nameInput.dispatchEvent(new Event('input'))
      await flush()
      button(mounted.host, /^Save$/).click()
      await flush()
      button(mounted.host, /^Delete$/).click()
      await flush()
      assert.deepEqual(mounted.presetSaves, [], 'the save is only queued while drafting')

      const first = await mounted.panel.value.apply()
      assert.equal(first.ok, false, 'the failed side-write is reported to the host')
      assert.ok(text(mounted.host).includes('Apply incomplete'), 'the failure is visible in the panel')
      assert.ok(!text(mounted.host).includes('Not applied'), 'a failed Apply never claims nothing was written')
      assert.deepEqual(mounted.presetSaves, [{ name: 'Night rain', slug: SLUG }], 'the save before the failure ran once')

      const retry = await mounted.panel.value.apply()
      assert.deepEqual(retry, { ok: true })
      assert.deepEqual(mounted.presetSaves, [{ name: 'Night rain', slug: SLUG }], 'the succeeded save is not duplicated by the retry')
      assert.equal(mounted.dirtyEvents.at(-1), false, 'the retry leaves the draft clean')
    } finally {
      mounted.unmount()
    }
  })
})

// ── Outline uploads: queued while drafting, uploaded only inside apply ───────
describe('outline uploads run only inside apply', () => {
  type Mounted = Awaited<ReturnType<typeof mountEditor>>
  const outlinePosts = (mounted: Mounted) => mounted.writes().filter(c => c.method === 'POST' && c.path.endsWith('/outlines'))
  const filePuts = (mounted: Mounted) => mounted.writes().filter(c => c.method === 'PUT' && c.path === `/projects/${SLUG}/effects-library/ep1`)

  /** Pick an effect, target a scene, upload an outline and add the effect carrying its placeholder. */
  async function queueOutlineUpload(mounted: Mounted): Promise<void> {
    await pick(mounted.host)
    targetSelect(mounted.host).value = 'scene:s1'
    targetSelect(mounted.host).dispatchEvent(new Event('change'))
    await flush()
    const upload = mounted.host.querySelector<HTMLInputElement>('input[type=file]')
    assert.ok(upload, 'expected the outline upload control')
    Object.defineProperty(upload, 'files', { configurable: true, value: [{ name: 'porch.png' }] })
    upload.dispatchEvent(new Event('change'))
    await flush()
    button(mounted.host, /^Add to /).click()
    await flush()
  }

  test('queueing writes nothing; apply uploads the outline and the file PUT carries the returned mask', async () => {
    const mounted = await mountEditor()
    try {
      await queueOutlineUpload(mounted)
      assert.deepEqual(mounted.writes(), [], 'the upload is only queued while drafting')

      const result = await mounted.panel.value.apply()
      assert.deepEqual(result, { ok: true })
      assert.equal(outlinePosts(mounted).length, 1, 'apply uploads the queued outline once')
      assert.equal(outlinePosts(mounted)[0].body.label, 'porch')
      const put = filePuts(mounted)[0]
      assert.ok(put, 'the file is written after the upload')
      assert.equal(put.body.scenes[0].effects[0].params.region.mask, 'uploaded-porch.png', 'the saved file references the real mask')
      assert.ok(!JSON.stringify(put.body).includes('draft-outline-'), 'no placeholder survives into the saved file')
    } finally {
      mounted.unmount()
    }
  })

  test('cancel neither uploads the outline nor writes the file', async () => {
    const mounted = await mountEditor()
    try {
      await queueOutlineUpload(mounted)
      mounted.panel.value.cancel()
      await flush()
      assert.deepEqual(mounted.writes(), [], 'cancel is not a save')
      assert.equal(outlinePosts(mounted).length, 0, 'nothing was uploaded')
      assert.equal(mounted.dirtyEvents.at(-1), false, 'the draft is clean again')
    } finally {
      mounted.unmount()
    }
  })

  test('a failed file write is retried without uploading the outline again', async () => {
    const mounted = await mountEditor({ failPutOnce: `/projects/${SLUG}/effects-library/ep1` })
    try {
      await queueOutlineUpload(mounted)
      const first = await mounted.panel.value.apply()
      assert.equal(first.ok, false, 'the failed file write is reported')
      assert.equal(outlinePosts(mounted).length, 1, 'the upload succeeded before the file write')

      const retry = await mounted.panel.value.apply()
      assert.deepEqual(retry, { ok: true })
      assert.equal(outlinePosts(mounted).length, 1, 'an already-uploaded outline is never sent again')
      assert.equal(filePuts(mounted).length, 2, 'the file itself is retried')
      assert.equal(filePuts(mounted)[1].body.scenes[0].effects[0].params.region.mask, 'uploaded-porch.png', 'the retried file still carries the real mask')
    } finally {
      mounted.unmount()
    }
  })
})
