import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parseVisualSource } from '../composables/useProjectFlow.js'

const read = (relativePath: string) => readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
const pipeline = read('../pages/projects/[slug]/pipeline.vue')
const board = read('../pages/projects/[slug]/board.vue')
const dashboard = read('../layouts/dashboard.vue')
const projectDashboard = read('../pages/projects/[slug]/index.vue')
const actionBar = read('../components/TopActionBar.vue')
const selector = read('../components/EpisodeSelector.vue')

async function loadActionBar(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/TopActionBar.vue', import.meta.url))
  const { descriptor } = parse(actionBar, { filename })
  const script = compileScript(descriptor, { id: 'top-action-bar-clear-runtime' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'top-action-bar-clear-runtime',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { computed, defineComponent as _defineComponent, h, nextTick, onUnmounted, ref, watch } from ${JSON.stringify(vueUrl)}
    const EpisodeSelector = _defineComponent({
      emits: ['episode-selected', 'update:modelValue'],
      setup(_, { emit }) {
        return () => h('button', {
          class: 'select-episode',
          onClick: () => emit('episode-selected', {
            episode_code: 'EP_A', title: 'First episode', visual_source: 'scene_plan',
            status: { script: true, audio: true, merged_audio: true, scene_plan: true, scene_review: true, video_assembly: true },
          }),
        }, 'select')
      },
    })
    const Modal = _defineComponent({ template: '<div><slot /></div>' })
    const LoadingSpinner = _defineComponent({ template: '<span />' })
    const Popover = _defineComponent({ template: '<div><slot /><slot name="content" /></div>' })
    const useDismissableDetails = () => undefined
    const useToast = () => ({ success: () => undefined, error: () => undefined })
    const useConfirm = () => ({ ask: async () => true })
    const STEP_STATUS_FIELD = { script: 'script', audio: 'audio', 'audio-merge': 'merged_audio', 'image-pool': 'broll_picked', 'scene-plan': 'scene_plan', 'scene-review': 'scene_review', 'video-assembly': 'video_assembly' }
  `
  const content = script.content
    .replace(/^import[^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const built = await transform(`${support}\n${content}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`, {
    loader: 'ts', format: 'esm',
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    built.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

test('authoritative format reads reject unknown values instead of selecting a plausible flow', () => {
  assert.equal(parseVisualSource('continuity-chain'), 'continuity-chain')
  assert.equal(parseVisualSource('timestamp-driven'), 'timestamp-driven')
  assert.equal(parseVisualSource('narrated-scenes'), 'narrated-scenes')
  assert.equal(parseVisualSource(undefined), null)
  assert.equal(parseVisualSource('future-chain'), null)
  for (const page of [pipeline, board, dashboard, projectDashboard]) {
    assert.match(page, /parseVisualSource\(/)
    assert.match(page, /visualSource\.value = null/)
    assert.match(page, /formatError\.value/)
    assert.doesNotMatch(page, /visualSource\.value = 'narrated-scenes'/)
  }
  assert.match(projectDashboard, /definePageMeta\(\{ layout: 'dashboard', key: route => String\(route\.params\.slug \|\| ''\) \}\)/)
})

test('the shared episode summary uses canonical visual status fields and clears route snapshots', () => {
  assert.match(actionBar, /STEP_STATUS_FIELD/)
  assert.match(actionBar, /Scene Plan/)
  assert.match(actionBar, /Scene Review/)
  assert.match(actionBar, /Image Pool/)
  assert.match(actionBar, /Final video/)
  assert.doesNotMatch(actionBar, />images \{\{ episodeStatusIcon/)
  assert.doesNotMatch(actionBar, />video \{\{ episodeStatusIcon/)
  assert.match(actionBar, /watch\(\(\) => props\.episodeId/)
  assert.doesNotMatch(selector, /emit\('episode-selected', null\)/)
})

test('clearing a bound episode removes the active TopActionBar snapshot', async () => {
  const ActionBar = await loadActionBar()
  const episodeId = ref('EP_A')
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(ActionBar as any, {
      projectSlug: 'fixture',
      episodeId: episodeId.value,
      generateLabel: 'Generate',
    }),
  }))
  app.mount(host)
  try {
    await flush()
    ;(host.querySelector('.select-episode') as HTMLButtonElement).click()
    await flush()
    assert.match(host.textContent || '', /First episode/)
    episodeId.value = ''
    await flush()
    assert.doesNotMatch(host.textContent || '', /First episode/)
    assert.match(host.textContent || '', /No episode selected/)
  } finally {
    app.unmount()
    host.remove()
  }
})

test('switching projects clears a same-code TopActionBar snapshot', async () => {
  const ActionBar = await loadActionBar()
  const projectSlug = ref('project-a')
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({
    setup: () => () => h(ActionBar as any, {
      projectSlug: projectSlug.value,
      episodeId: 'EP_A',
      generateLabel: 'Generate',
    }),
  }))
  app.mount(host)
  try {
    await flush()
    ;(host.querySelector('.select-episode') as HTMLButtonElement).click()
    await flush()
    assert.match(host.textContent || '', /First episode/)
    projectSlug.value = 'project-b'
    await flush()
    assert.doesNotMatch(host.textContent || '', /First episode/)
    assert.match(host.textContent || '', /No episode selected/)
  } finally {
    app.unmount()
    host.remove()
  }
})
