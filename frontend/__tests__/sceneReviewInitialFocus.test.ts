import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { waitFor } from '../../electron/server/__tests__/_timing.js'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/scene-review.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'scene-review-initial-focus' })
  const template = compileTemplate({
    id: 'scene-review-initial-focus',
    filename: pagePath,
    source: descriptor.template!.content,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.equal(template.errors.length, 0)
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const CREDIT_BASIS_LABEL = { fixed: 'Fixed' }
    const describeImageUnitCost = () => ({ basis: 'fixed', text: '' })
    const findGenStudioProduct = () => null
    const findOutputOption = () => null
    const publishedOutputOptions = () => []
    const resolveActiveSceneRenderJob = () => null
    const definePageMeta = () => undefined
    const useAppTitle = () => undefined
    const useRoute = () => ({ params: { slug: 'task15-fixture' }, query: { episode_id: 'EP0081', scene_id: 'ep0081-scene-0392' } })
    const useRouter = () => ({ replace: async location => globalThis.__sceneReviewInitialRouterReplace(location) })
    const useProject = () => ({ config: ref({}) })
    const useApi = () => globalThis.__sceneReviewInitialApi
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useConfirm = () => ({ ask: async () => false })
    const useEpisodes = () => ({ updateEpisode: () => undefined, revalidateAfterMutation: async () => undefined })
    const useRememberedForm = () => undefined
    const usePresets = () => ({ load: async () => undefined })
    const useGenStudioImageModels = () => ({ models: ref([]), refresh: async () => undefined })
    const useJobs = () => ({ jobs: ref([]), isJobActiveFor: () => false })
  `
  const scriptCode = script.content
    .replace(/^import[\s\S]*?from ['"][^'"]+['"];?\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const templateCode = template.code.replace('export function render', 'function render')
  const out = await transform(`${support}\n${scriptCode}\n${templateCode}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

test('an initial Scene Review deep link retains focus after query cleanup', async () => {
  const sceneId = 'ep0081-scene-0392'
  const scenes = Array.from({ length: 41 }, (_, index) => ({
    id: index === 40 ? sceneId : `ep0081-scene-${String(index + 1).padStart(4, '0')}`,
    scene_index: index === 40 ? 392 : index + 1,
    start_sec: index * 8,
    end_sec: index * 8 + 8,
    transcript_segment: 'Narration',
    visual_prompt: 'Moonlit harbor',
    approved: false,
    image_filename: null,
  }))
  ;(globalThis as any).__sceneReviewInitialRouterReplace = () => {
    ;(document.activeElement as HTMLElement | null)?.blur()
  }
  ;(globalThis as any).__sceneReviewInitialApi = {
    get: async (path: string) => path.endsWith('/scene-review/EP0081')
      ? {
          scene_plan: { schema_version: 1, generated_at: '', total_duration_sec: 8, research_used: false },
          scenes,
          audio_path: null,
          stats: { total_scenes: scenes.length, approved: 0, with_image: 0, all_approved: false },
          render_status: null,
          active_render_job: null,
          prompt_integrity: { complete: true, empty_ids: [], duplicate_ids: [] },
          subtitle_integrity: { complete: true, missing_sections: [] },
        }
      : { exists: true, config: { pacing: { min_sec: 4, max_sec: 12 } } },
    post: async () => ({}),
    put: async () => ({}),
  }

  HTMLElement.prototype.scrollIntoView = () => undefined
  const app = createApp(await loadPage())
  app.config.warnHandler = () => undefined
  const container = document.createElement('div')
  document.body.append(container)
  app.mount(container)
  await waitFor(
    () => document.activeElement?.id === `sr-scene-${sceneId}`,
    { label: 'the initial Scene Review deep link to receive focus' },
  )

  const row = document.getElementById(`sr-scene-${sceneId}`)
  assert.ok(row)
  assert.equal(document.activeElement?.id, `sr-scene-${sceneId}`)
  app.unmount()
  container.remove()
})
