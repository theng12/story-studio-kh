/**
 * Per-scene reveal pins in Motion Review (owner, 2026-10-27).
 *
 * A scene may be pinned to one reveal style; the pin wins over the episode's Mix and is cleared by
 * choosing "Follow the episode". This drives the real page: the selector it renders, the request it
 * sends, and what the row says about the style the scene will actually draw with — including that an
 * episode change never shows the previous episode's pins (AGENTS.md §4).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url))
const pageSource = readFileSync(pagePath, 'utf8')
// Nuxt auto-imports these into the page; this harness compiles the SFC outside Nuxt.
const { DEFAULT_EXCLUDE_KEYS } = await import('../composables/usePresets.js')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(pageSource, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'motion-review-pins' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'motion-review-pins',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const support = `
    import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
    const definePageMeta = () => {}
    const useAppTitle = () => {}
    const useRoute = () => globalThis.__mrRoute
    const useProject = () => ({ config: {} })
    const useApi = () => globalThis.__mrApi
    const useToast = () => globalThis.__mrToast
    const useConfirm = () => ({ ask: async () => true })
    const useJobs = () => ({ isJobActiveFor: () => false, jobs: { value: [] } })
    const useGenStudioMediaModels = () => ({ videoModels: globalThis.__mrModels, loaded: ref(true), refresh: async () => {} })
    const usePresets = options => ({ load: async () => undefined, presets: { value: [] }, activeId: { value: '' }, isDirty: { value: false } })
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  const vueUrl = await import.meta.resolve('vue')
  const componentUrl = `data:text/javascript;base64,${Buffer.from(
    out.code
      .replaceAll('"vue"', JSON.stringify(vueUrl))
      .replace(/"~\/utils\/([\w-]+)"/g, (_match, name: string) => (
        JSON.stringify(new URL(`../utils/${name}.ts`, import.meta.url).href)
      )),
  ).toString('base64')}`
  return (await import(componentUrl)).default
}

const SurfaceStub = defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) })
const NuxtLinkStub = defineComponent({
  props: { to: { type: String, required: true } },
  setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
})
const ModelMenuStub = defineComponent({ props: { modelValue: String }, setup: () => () => h('div') })
const TopActionBarStub = defineComponent({
  props: { episodeId: String, generateDisabled: Boolean },
  emits: ['update:episodeId', 'generate'],
  setup(props, { emit }) {
    return () => h('div', [
      h('span', { class: 'active-episode' }, props.episodeId || ''),
      h('button', {
        class: 'switch-episode',
        onClick: () => emit('update:episodeId', (globalThis as any).__mrNextEpisode),
      }, 'Switch'),
    ])
  },
})

const MIX = { style: 'mix', mix: ['line', 'buildup', 'swipes'] }

function scene(index: number, extra: Record<string, unknown> = {}) {
  return {
    id: `scene-${index}`, scene_index: index, start_sec: (index - 1) * 4, end_sec: index * 4,
    transcript_segment: `Narration ${index}`, approved: true, image_filename: `scene-${index}.png`,
    clip_exists: false, clip_stale: false, motion_choice: 'pending',
    clip_renderer: 'sketch_draw', ...extra,
  }
}

async function settle(times = 10): Promise<void> {
  for (let index = 0; index < times; index += 1) await nextTick()
}

const mountedApps: Array<() => void> = []
afterEach(() => {
  while (mountedApps.length) mountedApps.pop()!()
  document.body.innerHTML = ''
})

async function mount(input: {
  /** Per-episode scene rows, as the review read answers for that episode. */
  scenes: Record<string, any[]>
  /** Per-episode own reveal; absent means it follows the channel. */
  episodeReveal?: Record<string, any>
  channelReveal?: any
}) {
  const puts: Array<{ path: string; body: any }> = []
  const toasts: string[] = []
  const episodeReveal = { ...(input.episodeReveal ?? {}) }
  ;(globalThis as any).__mrModels = ref([])
  ;(globalThis as any).__mrRoute = reactive({ params: { slug: 'demo' }, query: { episode_id: 'EP0001' } })
  ;(globalThis as any).__mrNextEpisode = 'EP0001'
  ;(globalThis as any).__mrToast = {
    success: (message: string) => { toasts.push(message) },
    error: (message: string) => { toasts.push(message) },
    info: () => {},
  }
  ;(globalThis as any).__mrApi = {
    get: async (path: string) => {
      if (path.endsWith('/motion-presentation')) {
        return { renderer: 'sketch_draw', pen: 'none', channel_name: 'Demo', has_logo: false, reveal: input.channelReveal ?? null }
      }
      const revealMatch = path.match(/\/scene-review\/([^/]+)\/motion-reveal$/)
      if (revealMatch) {
        const code = decodeURIComponent(revealMatch[1])
        return { episode_reveal: episodeReveal[code] ?? null, channel_reveal: input.channelReveal ?? null }
      }
      if (/\/scene-review\/[^/]+\/motion-pen$/.test(path)) return { pen: 'none', pen_source: 'channel', episode_pen: null, channel_pen: 'none' }
      if (/\/scene-review\/[^/]+\/motion-hold$/.test(path)) return { hold: { mode: 'auto' }, hold_source: 'channel', episode_hold: null, channel_hold: { mode: 'auto' } }
      const episodeMatch = path.match(/\/scene-review\/([^/]+)$/)
      if (episodeMatch) {
        const code = decodeURIComponent(episodeMatch[1])
        const rows = input.scenes[code] ?? []
        return {
          scenes: rows,
          stats: { total_scenes: rows.length, approved: rows.length, with_image: rows.length, with_clip: 0, motion_reviewed: 0, all_motion_reviewed: false },
          motion_scope: { mode: 'all' },
          motion_scene_ids: rows.map((row: any) => row.id),
          visual_source: 'scene_plan',
        }
      }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async () => ({}),
    put: async (path: string, body: any) => {
      puts.push({ path, body })
      const match = path.match(/\/scene-review\/([^/]+)\/motion-reveal$/)
      if (match) episodeReveal[decodeURIComponent(match[1])] = body?.reveal ?? null
      return {}
    },
  }
  const el = document.body.appendChild(document.createElement('div'))
  const app = createApp(await loadPage())
  app.component('WorkspaceHero', SurfaceStub)
  app.component('WorkspaceNotice', SurfaceStub)
  app.component('WorkspaceSection', SurfaceStub)
  app.component('NuxtLink', NuxtLinkStub)
  app.component('MenuMenu', ModelMenuStub)
  app.component('ModelMenu', ModelMenuStub)
  app.component('TopActionBar', TopActionBarStub)
  app.mount(el)
  let active = true
  const destroy = () => {
    if (!active) return
    active = false
    app.unmount()
    el.remove()
  }
  mountedApps.push(destroy)
  await settle()
  const revealPuts = () => puts.filter(put => /\/motion-reveal$/.test(put.path))
  return {
    el,
    puts,
    revealPuts,
    toasts,
    text: () => el.textContent || '',
    pinSelect: (index: number) => el.querySelector<HTMLSelectElement>(`select[aria-label="Reveal style for scene ${index}"]`),
    rowNote: (index: number) => el.querySelector(`#scene-reveal-help-scene-${index}`)?.textContent?.replace(/\s+/g, ' ').trim() || '',
    switchEpisode: async (code: string) => {
      ;(globalThis as any).__mrNextEpisode = code
      el.querySelector<HTMLButtonElement>('.switch-episode')!.click()
      await settle()
    },
    destroy,
  }
}

function change(select: HTMLSelectElement, value: string): void {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('Motion Review per-scene reveal pins', () => {
  test('a scene can be pinned to a style and returned to "Follow the episode"', async () => {
    const mounted = await mount({
      scenes: { EP0001: [scene(1), scene(2)] },
      channelReveal: MIX,
    })
    const select = mounted.pinSelect(2)!
    assert.ok(select, 'each Sketch Draw scene row has a reveal selector')
    assert.equal(select.value, '', 'a scene with no pin follows the episode')
    assert.deepEqual(
      [...select.querySelectorAll('option')].map(option => option.value),
      ['', 'line', 'buildup', 'swipes', 'patches', 'bloom', 'colour'],
    )

    change(select, 'bloom')
    await settle()
    const saved = mounted.revealPuts().at(-1)!
    assert.match(saved.path, /\/scene-review\/EP0001\/motion-reveal$/, 'the pin goes to THIS episode')
    assert.deepEqual(saved.body.reveal.overrides, { 'scene-2': 'bloom' })
    assert.deepEqual({ style: saved.body.reveal.style, mix: saved.body.reveal.mix }, { style: MIX.style, mix: MIX.mix },
      'pinning a scene keeps the look the episode had')
    assert.equal(mounted.pinSelect(2)!.value, 'bloom')
    assert.match(mounted.toasts.at(-1)!, /pinned to Bloom/)

    change(mounted.pinSelect(2)!, '')
    await settle()
    const cleared = mounted.revealPuts().at(-1)!
    assert.equal(cleared.body.reveal, null, 'clearing the last pin from the channel look hands the episode back to the channel')
    assert.equal(mounted.pinSelect(2)!.value, '')
    assert.match(mounted.toasts.at(-1)!, /follows EP0001's reveal again/)
    mounted.destroy()
  })

  test('a pin wins over the Mix, and each row says which style it will draw with', async () => {
    const mounted = await mount({
      scenes: {
        EP0001: [
          scene(1, { reveal_type: 'line', reveal_pin: null }),
          scene(2, { reveal_type: 'patches', reveal_pin: 'patches' }),
        ],
      },
      episodeReveal: { EP0001: { ...MIX, overrides: { 'scene-2': 'patches' } } },
      channelReveal: null,
    })
    assert.match(mounted.rowNote(1), /Draws: Line — picked by the Mix for this scene/)
    assert.match(mounted.rowNote(2), /Pinned: Patches — this pin wins over the Mix/)
    assert.equal(mounted.pinSelect(2)!.value, 'patches')
    assert.equal(mounted.pinSelect(1)!.value, '', 'the unpinned row says it follows the episode')
    mounted.destroy()
  })

  test('switching episodes never shows the previous episode\'s pins', async () => {
    const mounted = await mount({
      scenes: {
        EP0001: [scene(1, { reveal_type: 'bloom', reveal_pin: 'bloom' })],
        EP0002: [scene(1, { reveal_type: 'line', reveal_pin: null })],
      },
      episodeReveal: { EP0001: { ...MIX, overrides: { 'scene-1': 'bloom' } } },
      channelReveal: MIX,
    })
    assert.equal(mounted.pinSelect(1)!.value, 'bloom', 'EP0001 pins scene 1')
    assert.match(mounted.rowNote(1), /Pinned: Bloom/)

    await mounted.switchEpisode('EP0002')
    assert.equal(mounted.pinSelect(1)!.value, '', 'EP0002 has no pins of its own')
    assert.doesNotMatch(mounted.rowNote(1), /Pinned/)
    assert.match(mounted.rowNote(1), /Draws: Line/)
    // And a pin set now belongs to EP0002, never EP0001.
    change(mounted.pinSelect(1)!, 'swipes')
    await settle()
    assert.match(mounted.revealPuts().at(-1)!.path, /\/scene-review\/EP0002\/motion-reveal$/)
    assert.deepEqual(mounted.revealPuts().at(-1)!.body.reveal.overrides, { 'scene-1': 'swipes' })
    mounted.destroy()
  })

  test('an episode that follows the channel gains its own look when a scene is pinned, and says so', async () => {
    const mounted = await mount({ scenes: { EP0001: [scene(1)] }, channelReveal: MIX })
    change(mounted.pinSelect(1)!, 'line')
    await settle()
    const saved = mounted.revealPuts().at(-1)!
    assert.deepEqual(saved.body.reveal, { style: MIX.style, mix: MIX.mix, overrides: { 'scene-1': 'line' } },
      'the pin needs a reveal of its own to belong to, so the episode takes a copy of the channel look')
    assert.match(mounted.toasts.at(-1)!, /EP0001 now has its own reveal/)
    mounted.destroy()
  })
})
