import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const panelPath = fileURLToPath(new URL('../components/VisualTimingMotion.vue', import.meta.url))
const panelSource = readFileSync(panelPath, 'utf8')
const continuityConfig = source('../composables/useContinuityConfig.ts')
const characterSheet = source('../pages/projects/[slug]/character-sheet.vue')

type Config = {
  schema_version: 1
  pacing: { min_sec: number; max_sec: number; mode?: 'uniform' }
  motion_scope: { mode: 'off' | 'all' } | { mode: 'opening'; end_sec: number } | { mode: 'selected'; scene_ids: string[] }
  motion_level: number
  anchor_character_ids: string[]
  use_episode_sheet: boolean
  references: { prev_render: boolean; sheet: boolean; characters: boolean; style: boolean; composition: boolean }
  denoise_strength: number
}

type Api = {
  get<T>(path: string): Promise<T>
  put<T>(path: string, body: unknown): Promise<T>
}

const globals = globalThis as typeof globalThis & {
  __visualTimingMotionApi?: Api
  __visualTimingMotionRoute?: { params: { slug: string } }
  __visualTimingMotionToasts?: string[]
}

function config(min_sec: number, max_sec: number): Config {
  return {
    schema_version: 1,
    pacing: { min_sec, max_sec },
    motion_scope: { mode: 'off' },
    motion_level: 2,
    anchor_character_ids: [],
    use_episode_sheet: false,
    references: { prev_render: false, sheet: false, characters: false, style: false, composition: false },
    denoise_strength: 0.5,
  }
}

async function loadPanel(): Promise<Component> {
  const { descriptor } = parse(panelSource, { filename: panelPath })
  const script = compileScript(descriptor, { id: 'visual-timing-motion-runtime' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: panelPath,
    id: 'visual-timing-motion-runtime',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, ref, watch } from ${JSON.stringify(vueUrl)}
    const defaults = () => ({ schema_version: 1, anchor_character_ids: [], use_episode_sheet: false, pacing: { min_sec: 1, max_sec: 3 }, motion_scope: { mode: 'off' }, motion_level: 2, references: { prev_render: false, sheet: false, characters: false, style: false, composition: false }, denoise_strength: 0.5 })
    const continuityDefaults = defaults
    const normalizeContinuityConfig = value => ({ ...defaults(), ...value, pacing: value?.pacing || defaults().pacing, motion_scope: value?.motion_scope || defaults().motion_scope, references: { ...defaults().references, ...(value?.references || {}) } })
    const storedPresetPacing = data => {
      const pacing = data?.pacing
      return pacing && typeof pacing === 'object' && !Array.isArray(pacing)
        && Number.isFinite(pacing.min_sec) && Number.isFinite(pacing.max_sec) ? pacing : null
    }
    import { parseScenePacing } from ${JSON.stringify(new URL('../../electron/server/contracts/pacing.ts', import.meta.url).href)}
    import { DEFAULT_MOTION_SCOPE, normalizeMotionScope, resolveMotionScope } from ${JSON.stringify(new URL('../../electron/server/contracts/motion-scope.ts', import.meta.url).href)}
    const useRoute = () => globalThis.__visualTimingMotionRoute
    const useApi = () => globalThis.__visualTimingMotionApi
    const useToast = () => ({ success: message => globalThis.__visualTimingMotionToasts.push(message), error: message => globalThis.__visualTimingMotionToasts.push(message) })
  `
  const content = script.content
    .replace(/^import \{ computed, ref, watch \} from 'vue'\n/m, '')
    .replace(/^import .* from '@shared\/motion-scope'\n/m, '')
    .replace(/^import .* from '@shared\/pacing'\n/m, '')
    .replace(/import \{[\s\S]*?\} from '~\/composables\/useContinuityConfig'\n/m, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountPanel(episode = 'EP0001', scenes: Array<{ id: string; start_sec: number; end_sec: number }> = []) {
  const Component = await loadPanel()
  const episodeId = ref(episode)
  const panel = ref<{
    snapshotPreset: () => { pacing: Config['pacing']; motion_scope?: Config['motion_scope']; motion_level: number }
    snapshotPresetForComparison: () => { pacing: Config['pacing']; motion_scope?: Config['motion_scope']; motion_level: number } | null
    applyPreset: (data: unknown) => void
  }>()
  const saved: Config[] = []
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(Component as any, {
      ref: panel,
      episodeId: episodeId.value,
      scenes,
      onSaved: (value: Config) => saved.push(value),
    }),
  }))
  app.mount(host)
  await flush()
  return {
    host,
    episodeId,
    panel,
    saved,
    unmount: () => { app.unmount(); host.remove() },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('Visual timing and motion', () => {
  test('keeps timing and motion at the per-episode continuity boundary', () => {
    assert.match(continuityConfig, /parseScenePacing\(value\?\.pacing\)/)
    assert.match(continuityConfig, /normalizeMotionScope\(value\?\.motion_scope\)/)
    assert.match(continuityConfig, /'motion_scope'/)
    assert.match(continuityConfig, /motion_scope: current\.motion_scope/)
  })

  test('sentence choice is saved with a pacing claim and carried by Scene Plan presets', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    let body: any
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: config(4, 8) } as T },
      async put<T>(_path: string, value: any) { body = value; return { ok: true, config: value } as T },
    }
    const mounted = await mountPanel()
    try {
      const checkbox = mounted.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
      assert.equal(checkbox.checked, false)
      checkbox.click()
      await flush()
      assert.equal((mounted.panel.value!.snapshotPreset().pacing as any).one_scene_per_sentence, true)
      mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!.click()
      await flush()
      assert.equal(body.claim_pacing, true)
      assert.equal(body.pacing.one_scene_per_sentence, true)
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('saves the actual continuity response config rather than its wrapper', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const savedConfig = config(4, 8)
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: config(1, 3) } as T },
      async put<T>() { return { ok: true, config: savedConfig } as T },
    }
    const mounted = await mountPanel()
    try {
      mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!.click()
      await flush()
      const inputs = mounted.host.querySelectorAll<HTMLInputElement>('.vtm-band input')
      assert.equal(inputs[0]?.value, '4')
      assert.equal(inputs[1]?.value, '8')
      assert.equal(mounted.saved[0]?.pacing.min_sec, 4)
    } finally {
      mounted.unmount()
      delete globals.__visualTimingMotionApi
    }
  })

  test('disables saving an invalid duration band and recovers after correction', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    let writes = 0
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: config(1, 3) } as T },
      async put<T>() { writes++; return { ok: true, config: config(1, 3) } as T },
    }
    const mounted = await mountPanel()
    try {
      const shortest = mounted.host.querySelector<HTMLInputElement>('.vtm-band input')!
      shortest.value = '8'
      shortest.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      const save = mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!
      assert.equal(save.disabled, true)
      assert.match(mounted.host.textContent || '', /greater than or equal/)
      save.click()
      await flush()
      assert.equal(writes, 0)
      shortest.value = '1'
      shortest.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      assert.equal(save.disabled, false)
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('ignores stale GET and save responses after selecting a different episode', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const gets: Array<ReturnType<typeof deferred<{ exists: boolean; config: Config }>>> = []
    const staleSave = deferred<{ ok: true; config: Config }>()
    globals.__visualTimingMotionApi = {
      get<T>() {
        const pending = deferred<{ exists: boolean; config: Config }>()
        gets.push(pending)
        return pending.promise as Promise<T>
      },
      put<T>() { return staleSave.promise as Promise<T> },
    }
    const mounted = await mountPanel('EP0001')
    try {
      assert.equal(gets.length, 1)
      mounted.episodeId.value = 'EP0002'
      await flush()
      assert.equal(gets.length, 2)
      gets[1]!.resolve({ exists: true, config: config(2, 5) })
      await flush()
      gets[0]!.resolve({ exists: true, config: config(9, 12) })
      await flush()
      assert.equal(mounted.host.querySelector<HTMLInputElement>('.vtm-band input')?.value, '2')

      mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!.click()
      await flush()
      mounted.episodeId.value = 'EP0003'
      await flush()
      assert.equal(gets.length, 3)
      staleSave.resolve({ ok: true, config: config(9, 12) })
      gets[2]!.resolve({ exists: true, config: config(5, 7) })
      await flush()
      assert.equal(mounted.host.querySelector<HTMLInputElement>('.vtm-band input')?.value, '5')
      assert.equal(mounted.saved.length, 0, 'the old episode save must not emit into the newly selected episode')
    } finally {
      mounted.unmount()
      delete globals.__visualTimingMotionApi
    }
  })

  test('snapshots cloned reusable timing and omits selected scene IDs', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const saved = { ...config(4, 8), motion_scope: { mode: 'selected' as const, scene_ids: ['scene-a'] }, motion_level: 3 }
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: saved } as T },
      async put<T>() { throw new Error('not used') },
    }
    const mounted = await mountPanel()
    try {
      const preset = mounted.panel.value!.snapshotPreset()
      assert.deepEqual(preset, { pacing: { min_sec: 4, max_sec: 8 }, motion_level: 3 })
      preset.pacing.min_sec = 1
      assert.equal(mounted.panel.value!.snapshotPreset().pacing.min_sec, 4)
      await flush()
      assert.match(mounted.host.textContent || '', /Selected-scene motion stays with this episode/)
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('applies valid timing without importing selected scene IDs or aliases', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const saved = { ...config(4, 8), motion_scope: { mode: 'all' as const }, motion_level: 2 }
    let writes = 0
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: saved } as T },
      async put<T>() { writes++; return { ok: true, config: saved } as T },
    }
    const mounted = await mountPanel()
    try {
      const preset = { pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'selected', scene_ids: ['foreign-scene'] }, motion_level: 4 }
      mounted.panel.value!.applyPreset(preset)
      assert.equal(writes, 0, 'applying a preset only changes this panel draft')
      preset.pacing.min_sec = 1
      preset.motion_scope.scene_ids[0] = 'mutated'
      preset.motion_level = 1
      assert.deepEqual(mounted.panel.value!.snapshotPreset(), {
        pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'all' }, motion_level: 4,
      })
      await flush()
      assert.match(mounted.host.textContent || '', /Selected-scene motion stays with this episode/)
      assert.match(mounted.host.textContent || '', /Save timing & motion/)
      mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!.click()
      await flush()
      assert.equal(writes, 1, 'the existing Save timing & motion action owns persistence')
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('keeps current timing and scope for legacy absent or partial preset fields', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const saved = { ...config(4, 8), motion_scope: { mode: 'opening' as const, end_sec: 20 }, motion_level: 2 }
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: saved } as T },
      async put<T>() { throw new Error('not used') },
    }
    const mounted = await mountPanel()
    try {
      mounted.panel.value!.applyPreset({ pacing: { min_sec: 6 }, motion_scope: null })
      assert.deepEqual(mounted.panel.value!.snapshotPreset(), {
        pacing: { min_sec: 4, max_sec: 8 }, motion_scope: { mode: 'opening', end_sec: 20 }, motion_level: 2,
      })
      await flush()
      assert.match(mounted.host.textContent || '', /no saved timing/)
      assert.match(mounted.host.textContent || '', /no saved motion scope/i)
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('sparse B restores omitted portable fields from saved episode continuity after unsaved A', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const saved = {
      ...config(4, 8),
      motion_scope: { mode: 'selected' as const, scene_ids: ['episode-scene'] },
      motion_level: 2,
    }
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: true, config: saved } as T },
      async put<T>() { throw new Error('not used') },
    }
    const mounted = await mountPanel('EP0001', [
      { id: 'episode-scene', start_sec: 0, end_sec: 4 },
      { id: 'other-scene', start_sec: 4, end_sec: 8 },
    ])
    try {
      mounted.panel.value!.applyPreset({
        pacing: { min_sec: 9, max_sec: 12 }, motion_scope: { mode: 'all' }, motion_level: 4,
      })
      mounted.panel.value!.applyPreset({})
      assert.deepEqual(mounted.panel.value!.snapshotPresetForComparison(), {
        pacing: { min_sec: 4, max_sec: 8 }, motion_level: 2,
      }, 'sparse B falls back to saved episode continuity rather than unsaved A')
      const scopeChoices = mounted.host.querySelectorAll<HTMLInputElement>('input[name="motion-scope"]')
      assert.equal(scopeChoices[2]?.checked, true)
      const sceneChecks = mounted.host.querySelectorAll<HTMLInputElement>('.vtm-scene-choice input')
      assert.equal(sceneChecks[0]?.checked, true, 'the saved current-episode scene selection survives')
      assert.equal(sceneChecks[1]?.checked, false)
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('applies timing to a fresh episode draft', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    globals.__visualTimingMotionApi = {
      async get<T>() { return { exists: false, config: config(9, 12) } as T },
      async put<T>() { throw new Error('not used') },
    }
    const mounted = await mountPanel('EP0002')
    try {
      const preset = { pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'opening', end_sec: 15 }, motion_level: 3 }
      mounted.panel.value!.applyPreset(preset)
      preset.motion_scope.end_sec = 999
      const snapshot = mounted.panel.value!.snapshotPreset()
      snapshot.motion_scope!.end_sec = 888
      assert.deepEqual(mounted.panel.value!.snapshotPreset(), {
        pacing: { min_sec: 6, max_sec: 12 }, motion_scope: { mode: 'opening', end_sec: 15 }, motion_level: 3,
      })
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('rejects preset access while loading and leaves a stale episode draft alone', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const gets: Array<ReturnType<typeof deferred<{ exists: boolean; config: Config }>>> = []
    globals.__visualTimingMotionApi = {
      get<T>() {
        const pending = deferred<{ exists: boolean; config: Config }>()
        gets.push(pending)
        return pending.promise as Promise<T>
      },
      async put<T>() { throw new Error('not used') },
    }
    const mounted = await mountPanel('EP0001')
    try {
      assert.throws(() => mounted.panel.value!.snapshotPreset(), /loading/i)
      mounted.episodeId.value = 'EP0002'
      await flush()
      gets[1]!.resolve({ exists: true, config: config(5, 7) })
      await flush()
      gets[0]!.resolve({ exists: true, config: config(9, 12) })
      await flush()
      assert.deepEqual(mounted.panel.value!.snapshotPreset(), {
        pacing: { min_sec: 5, max_sec: 7 }, motion_scope: { mode: 'off' }, motion_level: 2,
      })
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('render-time preset comparison is nonthrowing and side-effect-free while loading, saving, or invalid', async () => {
    globals.__visualTimingMotionRoute = { params: { slug: 'project-one' } }
    globals.__visualTimingMotionToasts = []
    const loading = deferred<{ exists: boolean; config: Config }>()
    const saving = deferred<{ ok: true; config: Config }>()
    globals.__visualTimingMotionApi = {
      get<T>() { return loading.promise as Promise<T> },
      put<T>() { return saving.promise as Promise<T> },
    }
    const mounted = await mountPanel('EP0001')
    try {
      assert.equal(mounted.panel.value!.snapshotPresetForComparison(), null)
      assert.doesNotMatch(mounted.host.textContent || '', /Selected-scene motion stays/)
      loading.resolve({ exists: true, config: {
        ...config(4, 8), motion_scope: { mode: 'selected', scene_ids: ['episode-scene'] }, motion_level: 3,
      } })
      await flush()
      assert.deepEqual(mounted.panel.value!.snapshotPresetForComparison(), {
        pacing: { min_sec: 4, max_sec: 8 }, motion_level: 3,
      })
      assert.doesNotMatch(mounted.host.textContent || '', /Selected-scene motion stays/,
        'comparison reads do not write the explicit Save notice')

      const shortest = mounted.host.querySelector<HTMLInputElement>('.vtm-band input')!
      shortest.value = '12'
      shortest.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      assert.equal(mounted.panel.value!.snapshotPresetForComparison(), null)
      shortest.value = '4'
      shortest.dispatchEvent(new Event('input', { bubbles: true }))
      await flush()
      mounted.host.querySelector<HTMLButtonElement>('button.btn-primary')!.click()
      await flush()
      assert.equal(mounted.panel.value!.snapshotPresetForComparison(), null)
      saving.resolve({ ok: true, config: config(4, 8) })
      await flush()
    } finally { mounted.unmount(); delete globals.__visualTimingMotionApi }
  })

  test('explains whole-scene eligibility and preserves approved clips', () => {
    assert.match(panelSource, /Opening/)
    assert.match(panelSource, /Selected scenes/)
    assert.match(panelSource, /All scenes/)
    assert.match(panelSource, /resolveMotionScope\(props\.scenes, draft\.value\.motion_scope\)/)
    assert.match(panelSource, /eligible for motion/)
    assert.match(panelSource, /Motion applies only to whole scenes/)
    assert.match(panelSource, /does not alter clips already approved or generated/)
    assert.match(panelSource, /:disabled="loading \|\| saving \|\| !!loadError"/)
    for (const label of ['Minimal', 'Gentle', 'Moderate', 'Lively']) {
      assert.match(panelSource, new RegExp(`label: '${label}'`))
    }
  })

  test('Character Sheet omits the retired timing card', () => {
    assert.doesNotMatch(characterSheet, /<h3>Visual timing & motion<\/h3>/)
    assert.doesNotMatch(characterSheet, /Open Scene Plan/)
    // The pacing notice and its state were deleted with the preset boundary
    // change, not reworded — this page no longer owns scene rhythm.
    assert.doesNotMatch(characterSheet, /pacingPresetNotice/, 'the pacing notice state must be deleted')
    assert.doesNotMatch(characterSheet, /<select id="cs-visual-pacing"/)
    assert.doesNotMatch(characterSheet, /formulaPacingProfile/)
  })
})
