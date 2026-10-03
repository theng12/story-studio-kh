import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { nextTick, ref } from 'vue'
import { transform } from 'esbuild'

const pagePath = new URL('../pages/projects/[slug]/images.vue', import.meta.url)
const source = readFileSync(pagePath, 'utf8')

async function setupWith(models: ReturnType<typeof ref<any[]>>) {
  const { descriptor } = parse(source, { filename: pagePath.pathname })
  const setup = descriptor.scriptSetup!.content
  const capBlockEnd = setup.indexOf('const activeGenStudioModel')
  assert.ok(capBlockEnd > 0, 'cap block end marker exists')
  const partial = `<script setup lang="ts">${setup.slice(0, capBlockEnd)}</script>`
  const script = compileScript(parse(partial, { filename: pagePath.pathname }).descriptor, { id: 'task13-live-image-cap' })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, reactive, ref } from ${JSON.stringify(vueUrl)}
    const definePageMeta = () => undefined
    const useRoute = () => ({ params: { slug: 'task13-project' }, query: {} })
    const useApi = () => ({ get: async () => ({}), post: async () => ({}) })
    const useFreshGenerationAction = () => ({})
    const useProject = () => ({ config: globalThis.__task13ImageConfig })
    const useGenStudioImageModels = () => ({ models: globalThis.__task13ImageModels, refresh: async () => undefined })
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useGenerating = () => ({ imageGenerating: ref(false), thumbImageGenerating: ref(false) })
    const useConfirmation = () => ({ confirmGeneration: async () => true })
    const useJobs = () => ({ isJobActiveFor: () => false, jobs: ref([]) })
    const useAppTitle = () => undefined
    const useRememberedForm = () => undefined
    const useEpisodeStatus = () => ({ selectedEpisode: ref(null) })
  `
  const stripped = script.content.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
  const code = `${support}\n${stripped.replace('export default', 'const __sfc__ =')}\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  ;(globalThis as any).__task13ImageModels = models
  ;(globalThis as any).__task13ImageConfig = ref({ image_models: {
    thumbnail: { prompt_char_cap: 17, label: 'Stale thumbnail config' },
  } })
  const Component = (await import(`data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  return Component.setup({}, { expose: () => undefined })
}

test('Images prompt caps follow the selected live image model, never stale project config', async () => {
  const models = ref([
    { id: 'thumbnail', display_name: 'Live thumbnail', max_prompt_characters: 1_200 },
  ])
  const state: any = await setupWith(models)

  state.form.thumbnail.model = 'thumbnail'
  assert.equal(state.thumbnailModelInfo.value.cap, 1_200)
  assert.equal(state.thumbnailModelInfo.value.label, 'Live thumbnail')
  assert.equal(state.activeModelCap.value, 1_200, 'the active thumbnail badge ignores the stale 17-character config cap')

  models.value[0].max_prompt_characters = 3_600
  await nextTick()
  assert.equal(state.activeModelCap.value, 3_600, 'a catalogue cap refresh updates the selected model badge')
})
