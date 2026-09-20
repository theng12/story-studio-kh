/**
 * The channel default Style Bible's ceiling — owner decision #2, v1.4.207
 *
 * WHAT WAS WRONG. `saveDefaultStyleBible()` did `defaultStyleBible.trim()
 * .slice(0, 2000)` and toasted "Saved". AGENTS.md §1: a limit that is enforced
 * must also be shown, and Story Studio never substitutes a number of its own
 * for one GenStudio publishes.
 *
 * THE RULE NOW. The ceiling is the SELECTED image model's published
 * `max_prompt_characters`, read live: shown beside the box as a counter, and a
 * save that clips says so and by how much. A model that publishes nothing means
 * no ceiling, so the text is stored whole rather than cut to an invented figure.
 *
 * These tests mount the REAL page, so they assert what reaches the server and
 * what the customer is told — not that a string appears in the source. Under the
 * old `.slice(0, 2000)` all three fail for the right reason: the stored value is
 * 2,000 characters long whatever the selected model publishes.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

import { DEFAULT_EXCLUDE_KEYS } from '../composables/usePresets.js'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/scene-plan.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

async function loadScenePlan(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'scene-plan-style-bible' })
  const template = compileTemplate({
    id: 'scene-plan-style-bible',
    filename: pagePath,
    source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.equal(template.errors.length, 0)
  const vueUrl = await import.meta.resolve('vue')
  // The prompt-cap module is the REAL one, imported by absolute URL: the whole
  // point of this file is that the ceiling comes from the model catalogue, so
  // stubbing `publishedPromptCharCap` would test a fixture instead of the rule.
  const capUrl = await import.meta.resolve('../utils/prompt-char-cap.js')
  // Every other import the page makes, supplied by hand — the same convention as
  // scenePlanLoading.test.ts. Only the three the Style Bible save touches
  // (useToast, useApi, useGenStudioImageModels) are wired to the test.
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onMounted, onUnmounted, ref, unref, watch } from ${JSON.stringify(vueUrl)}
    import { normalizePromptCharCapSetting, promptCharCapAboveModel, promptCharCapOptions, promptLengthLabel, promptLengthState, promptLengthTone, publishedPromptCharCap, resolvePromptCharCap } from ${JSON.stringify(capUrl)}
    const availableInputTokens = () => 0
    const batchTimeoutWarning = () => ''
    const clampOutputAllowance = (_value, maximum) => maximum
    const contextWindowTokens = () => 0
    const formatTokenCount = value => String(value || 0)
    const isModelTokenLimitError = () => false
    const publishedMaxOutputTokens = () => 0
    const outputAllowanceOptions = () => []
    const readRememberedImageModelId = () => ''
    const pacingBandAt = () => ({ max_sec: Infinity })
    const resolveMotionScope = () => ({ scene_ids: [] })
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => globalThis.__scenePlanRoute
    const useApi = () => globalThis.__scenePlanApi
    const useFreshGenerationAction = () => ({ begin: () => 'operation', complete: () => undefined })
    const useToast = () => globalThis.__scenePlanToast
    const useConfirm = () => ({ ask: async () => false })
    const useEpisodes = () => ({ episodes: globalThis.__scenePlanEpisodes, revalidate: async () => undefined })
    const useProject = () => ({ config: ref({}) })
    const useRememberedForm = () => undefined
    const usePresets = () => ({ load: async () => undefined, presets: ref([]), activeId: ref('') })
    const DEFAULT_EXCLUDE_KEYS = ${JSON.stringify(DEFAULT_EXCLUDE_KEYS)}
    const useGenStudioImageModels = () => ({ models: globalThis.__scenePlanImageModels, refresh: async () => undefined })
    const useJobs = () => ({ isJobActiveFor: () => false })
    const useVisualStyleCatalog = () => ({ styles: ref([]), loading: ref(false), error: ref(null), refresh: async () => undefined })
  `
  const content = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const templateCode = template.code.replace('export function render', 'function render')
  const out = await transform(`${support}\n${content}\n${templateCode}\nconst __setup = __sfc__.setup
    __sfc__.setup = function (props, context) {
      const state = __setup(props, context)
      globalThis.__scenePlanState = state
      return state
    }
    __sfc__.render = render
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

type PutCall = { path: string; body: any }

async function mountScenePlan(models: any[]) {
  const route = reactive({ params: { slug: 'project-a' }, query: { episode_id: 'EP_A' } })
  const puts: PutCall[] = []
  const successes: string[] = []
  ;(globalThis as any).__scenePlanRoute = route
  ;(globalThis as any).__scenePlanEpisodes = ref([])
  ;(globalThis as any).__scenePlanImageModels = ref(models)
  ;(globalThis as any).__scenePlanToast = {
    success: (message: string) => successes.push(message),
    error: (message: string) => successes.push(`ERROR: ${message}`),
  }
  ;(globalThis as any).__scenePlanApi = {
    get: (path: string) => {
      if (path.includes('/scene-plan/')) return Promise.resolve(null)
      if (path.includes('/continuity/')) return Promise.resolve({ exists: true, config: { pacing: { min_sec: 4, max_sec: 12 }, motion_scope: { mode: 'off' }, motion_level: 2 } })
      if (path.includes('/video-editor/visual-source/')) return Promise.resolve({ source: 'scene_plan' })
      return Promise.resolve({})
    },
    post: async () => ({}),
    put: async (path: string, body: any) => { puts.push({ path, body }); return {} },
    del: async () => ({}),
  }
  const Page = await loadScenePlan()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Page)
  const passthrough = defineComponent({
    inheritAttrs: false,
    setup: (_props, { slots }) => () => h('div', slots.default?.()),
  })
  for (const name of [
    'WorkspaceHero', 'TopActionBar', 'EpisodeVisualSource', 'VisualTimingMotion',
    'WorkspaceSection', 'SubtitleQualityWarning', 'ModelSelector', 'NuxtLink',
    'Popover', 'LoadingSpinner',
  ]) app.component(name, passthrough)
  app.config.warnHandler = () => undefined
  app.mount(host)
  await flush()
  const state = (globalThis as any).__scenePlanState
  // The page seeds the intended image model from localStorage; the stub returns
  // '', so the test sets it explicitly to the model under test.
  return {
    state,
    puts,
    successes,
    host,
    chooseModel: async (id: string) => { state.form.value.intended_image_model = id; await flush() },
    unmount: () => { app.unmount(); host.remove() },
  }
}

const BUDGET_MODEL = {
  id: 'image-big',
  display_name: 'Big Canvas',
  available: true,
  max_prompt_characters: 4800,
}

function settingsPut(mounted: Awaited<ReturnType<typeof mountScenePlan>>): PutCall | undefined {
  return mounted.puts.filter(call => call.path.endsWith('/settings/config')).at(-1)
}

test('a Style Bible shorter than the model publishes is stored whole and not called clipped', async () => {
  const mounted = await mountScenePlan([BUDGET_MODEL])
  await mounted.chooseModel(BUDGET_MODEL.id)
  mounted.state.defaultStyleBible.value = 'x'.repeat(3000)
  await flush()
  // The counter SHOWS the ceiling that is in force (§1).
  assert.equal(mounted.state.defaultStyleBibleLength.value.cap, 4800)
  assert.equal(mounted.state.defaultStyleBibleLength.value.characters, 3000)

  await mounted.state.saveDefaultStyleBible()
  const put = settingsPut(mounted)
  assert.ok(put, 'the save must reach /settings/config')
  assert.equal((put!.body.default_style_bible || '').length, 3000,
    'the model accepts 4,800 characters, so 3,000 must not be trimmed to a Story Studio constant')
  assert.ok(
    !/trimmed/i.test(mounted.successes.at(-1) || ''),
    'nothing was clipped, so the save must not claim it was',
  )
  mounted.unmount()
})

test('a Style Bible past the model\'s published budget is trimmed to exactly that budget and says so', async () => {
  const mounted = await mountScenePlan([BUDGET_MODEL])
  await mounted.chooseModel(BUDGET_MODEL.id)
  mounted.state.defaultStyleBible.value = 'x'.repeat(5000)
  await flush()

  await mounted.state.saveDefaultStyleBible()
  const put = settingsPut(mounted)
  assert.ok(put, 'the save must reach /settings/config')
  assert.equal((put!.body.default_style_bible || '').length, 4800,
    'the trim must be the model\'s published limit, not 2,000')
  const message = mounted.successes.at(-1) || ''
  assert.match(message, /trimmed/i, 'a clipping save must say it clipped — §1')
  assert.match(message, /4,800/, 'the message must name the ceiling that did the clipping')
  assert.match(message, /200 characters/, 'the message must say how much was dropped (5,000 - 4,800)')
  mounted.unmount()
})

test('a model that publishes no prompt limit yields no ceiling, so the text is saved in full', async () => {
  const mounted = await mountScenePlan([{ id: 'image-quiet', display_name: 'Quiet Model', available: true }])
  await mounted.chooseModel('image-quiet')
  mounted.state.defaultStyleBible.value = 'x'.repeat(5000)
  await flush()
  assert.equal(mounted.state.defaultStyleBibleLength.value.cap, 0,
    'an unpublished limit must show no ceiling rather than an invented one')

  await mounted.state.saveDefaultStyleBible()
  const put = settingsPut(mounted)
  assert.ok(put, 'the save must reach /settings/config')
  assert.equal((put!.body.default_style_bible || '').length, 5000,
    'no published limit means no trim — never a number the customer would mistake for the model\'s')
  assert.ok(
    !/trimmed/i.test(mounted.successes.at(-1) || ''),
    'nothing was clipped, so the save must not claim it was',
  )
  mounted.unmount()
})
