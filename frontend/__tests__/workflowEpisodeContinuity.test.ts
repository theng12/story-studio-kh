/**
 * Workflow navigation must carry the episode the operator is actually editing.
 *
 * A missing `episode_id` on the FlowRibbon's next/previous links silently
 * swapped an imported, completed introduction for a blank Pending-only picker.
 * These tests exercise the real route helper and EpisodeSelector component so a
 * route that merely looks right in source cannot satisfy the contract.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'

const here = fileURLToPath(new URL('.', import.meta.url))

async function loadProjectFlow(route: Record<string, any>) {
  const filename = fileURLToPath(new URL('../composables/useProjectFlow.ts', import.meta.url))
  const vueUrl = await import.meta.resolve('vue')
  const routerUrl = `data:text/javascript;base64,${Buffer.from('export const useRoute = () => globalThis.__workflowRoute').toString('base64')}`
  ;(globalThis as any).__workflowRoute = route
  const source = readFileSync(filename, 'utf8')
    .replace("from 'vue'", `from ${JSON.stringify(vueUrl)}`)
    .replace("from 'vue-router'", `from ${JSON.stringify(routerUrl)}`)
  const transformed = await transform(source, { loader: 'ts', format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`)
}

async function loadEpisodeSelector(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/EpisodeSelector.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'workflow-episode-selector' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'workflow-episode-selector',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, onBeforeUnmount, onMounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const useRoute = () => globalThis.__workflowSelectorRoute
    const useRouter = () => globalThis.__workflowSelectorRouter
    const useEpisodes = () => globalThis.__workflowSelectorEpisodes
    const useApi = () => ({ patch: async () => ({ ok: true, status_overrides: null }) })
    const useToast = () => ({ success: () => undefined, error: () => undefined, info: () => undefined })
    const useJobs = () => ({ jobs: ref([]) })
    const useConfirm = () => ({ ask: async () => true })
    const STEP_STATUS_FIELD = { research: 'research', script: 'script', introduction: 'introduction', metadata: 'metadata', 'thumb-prompts': 'thumb_prompts', thumbnails: 'thumbnails', audio: 'audio', 'audio-merge': 'merged_audio', subtitles: 'subtitles', 'character-sheet': 'character_sheet', 'scene-plan': 'scene_plan', 'scene-review': 'scene_review', 'motion-review': 'motion_review', 'video-assembly': 'video_assembly' }
  `
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const transformed = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('episode-aware workflow continuity', () => {
  test('the FlowRibbon keeps the current episode across next, previous, selection changes, blanks, and project boundaries', async () => {
    const route = {
      params: { slug: 'ux-review-sandbox' },
      path: '/projects/ux-review-sandbox/scripts',
      query: { episode_id: 'EP0001' },
    }
    const { useProjectFlow } = await loadProjectFlow(route)
    const { steps, routeFor } = useProjectFlow(ref('ux-review-sandbox'), ref('continuity-chain'))
    const introduction = steps.value.find((step: any) => step.key === 'introduction')
    const script = steps.value.find((step: any) => step.key === 'script')
    assert.ok(introduction)
    assert.ok(script)
    assert.equal(routeFor(introduction), '/projects/ux-review-sandbox/introduction?episode_id=EP0001')
    assert.equal(routeFor(script), '/projects/ux-review-sandbox/scripts?episode_id=EP0001')

    route.query.episode_id = 'EP0002'
    assert.equal(routeFor(introduction), '/projects/ux-review-sandbox/introduction?episode_id=EP0002',
      'the next ribbon target follows the changed dropdown selection, never an earlier deep link')

    delete route.query.episode_id
    assert.equal(routeFor(introduction), '/projects/ux-review-sandbox/introduction',
      'a blank picker does not fabricate an episode id')

    route.params.slug = 'another-project'
    route.query.episode_id = 'EP9999'
    assert.equal(routeFor(introduction), '/projects/ux-review-sandbox/introduction',
      'a query belonging to another project cannot leak into this project\'s workflow links')
  })

  test('EpisodeSelector makes a completed deep-link target visible and writes a changed selection back to the current query', async () => {
    const episodes = ref([
      { episode_code: 'EP0001', title: 'Imported opening', status: { introduction: true } },
      { episode_code: 'EP0002', title: 'New draft', status: { introduction: false } },
    ])
    const route = {
      params: { slug: 'ux-review-sandbox' },
      path: '/projects/ux-review-sandbox/introduction',
      query: { episode_id: 'EP0001', tab: 'script' },
    }
    const replaces: any[] = []
    ;(globalThis as any).__workflowSelectorRoute = route
    ;(globalThis as any).__workflowSelectorRouter = { replace: (location: any) => { replaces.push(location); return Promise.resolve() } }
    ;(globalThis as any).__workflowSelectorEpisodes = {
      episodes, isLoading: ref(false), isRevalidating: ref(false), error: ref(null),
      load: async () => undefined, refresh: async () => undefined, rescan: async () => undefined,
      revalidateAfterMutation: async () => episodes.value, updateEpisode: () => undefined,
    }

    const Selector = await loadEpisodeSelector()
    const selected = ref('')
    const Root = defineComponent({
      setup: () => () => h(Selector, {
        modelValue: selected.value,
        projectSlug: 'ux-review-sandbox',
        filterField: 'introduction',
        'onUpdate:modelValue': (value: string) => { selected.value = value },
      }),
    })
    const host = document.body.appendChild(document.createElement('div'))
    const app = createApp(Root)
    app.component('WorkspaceNotice', { template: '<div><slot /><slot name="actions" /></div>' })
    app.mount(host)
    await flush()

    const select = host.querySelector('select') as HTMLSelectElement
    assert.equal(selected.value, 'EP0001', 'the incoming deep link selects its completed episode')
    assert.ok([...select.options].some(option => option.value === 'EP0001'),
      'Pending only still shows the selected completed deep-link target')

    select.value = 'EP0002'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    assert.equal(selected.value, 'EP0002')
    assert.deepEqual(replaces, [{ query: { episode_id: 'EP0002', tab: 'script' } }],
      'a user selection replaces only episode_id and preserves the active tab')

    app.unmount()
    host.remove()
    delete (globalThis as any).__workflowSelectorRoute
    delete (globalThis as any).__workflowSelectorRouter
    delete (globalThis as any).__workflowSelectorEpisodes
  })

  test('Introduction keeps an imported opening preview and editor available while its channel policy is off', () => {
    const filename = fileURLToPath(new URL('../pages/projects/[slug]/introduction.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const template = descriptor.template!.content
    assert.match(template, /<IntroductionPreview\s+v-if="episodeId"/,
      'an existing opening remains inspectable/editable for a selected episode even when generation is off')
    assert.match(template, /:generate-disabled="!segment\.enabled \|\| !episodeId/,
      'the policy still disables generation; visibility must not switch generation back on')
  })
})
