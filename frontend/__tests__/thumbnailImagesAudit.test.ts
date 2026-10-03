/**
 * Thumbnail prompts / generator / image pool audit fixes (2026-10).
 *
 * Runtime: ImageGeneratorPanel (one request builder from the page, operation id
 * on every explicit overwrite, ready-count, poll tolerance) and
 * PromptReviewPanel (stale-load guard, saves land on the episode they were made
 * on). Source checks for the page wiring that has no cheap runtime harness.
 * Cannot catch: layout, real confirm-dialog rendering, real server behaviour.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, h, nextTick, type Component } from 'vue'
import { useFreshGenerationAction } from '../composables/useFreshGenerationAction.js'
import { customerSafeJobText, jobRequestIds } from '../utils/job-presentation.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

function panelFixture(jobReads: Array<() => any>) {
  const fx: any = {
    useFreshGenerationAction, customerSafeJobText, jobRequestIds,
    toasts: [], posts: [] as any[], prepares: [] as any[],
    prepareResult: (force: boolean) => ({ episode_id: 'EP1', model: 'm', mode: 'thumbs', aspect_ratio: '16:9', resolution: '2K', extra_details: 'closer', force }),
    get: async (path: string) => {
      if (path.includes('/image-prompts')) return { thumbnails: [{ number: 1, title: 'a', prompt: 'p' }, { number: 2, title: 'b', prompt: 'q' }] }
      if (path.includes('/video-editor/scan/')) return { thumbnails: [{ filename: 'EP1_Thumb01_v1.png', path: '/x/1.png', number: 1 }, { filename: 'EP1_Thumb09_v1.png', path: '/x/9.png', number: 9 }] }
      if (path.includes('/jobs/')) return (jobReads.shift() || (() => ({ status: 'done' })))()
      throw new Error(`unexpected ${path}`)
    },
    post: async (_path: string, body: any) => { fx.posts.push(body); return { job_id: 'job-1' } },
  }
  ;(globalThis as any).__fx = fx
  return fx
}

async function mountPanel(fx: any, generationMode: 'skip' | 'regenerate' = 'skip') {
  const Panel = await loadSetup('../components/ImageGeneratorPanel.vue', PANEL_SUPPORT)
  const app = createApp({ render: () => h(Panel, {
    projectSlug: 'p', episodeId: 'EP1', title: 'T', generationMode,
    prepare: async (force: boolean, ask: boolean) => { fx.prepares.push([force, ask]); return fx.prepareResult(force) },
  }) })
  app.mount(document.body.appendChild(document.createElement('div')))
  await flush()
  return app
}

test('a row render uses the page builder and sends a UUID operation id with force', async () => {
  // First poll read fails (a blip), second reports done: the blip is not a failure.
  const fx = panelFixture([() => { throw new Error('network blip') }, () => ({ status: 'done' })])
  const app = await mountPanel(fx)
  try {
    assert.equal(fx.state.renderedCount.value, 1, 'an image with no prompt on this board is not "ready"')
    assert.equal(fx.state.missingCount.value, 1)
    await fx.state.runOne(2)
    assert.deepEqual(fx.prepares, [[true, false]], 'rows build from the page and skip the bulk confirmation')
    const body = fx.posts[0]
    assert.equal(body.thumb_number, 2)
    assert.equal(body.force, true)
    assert.match(body.operation_id, UUID, 'the server refuses force without a UUID operation_id')
    assert.equal(body.resolution, '2K', 'the published output row travels on row renders too')
    assert.equal(body.extra_details, 'closer')
    assert.equal(fx.state.errors.value[2], '', 'one failed poll did not mark the row failed')
  } finally { app.unmount() }
})

test('the board bulk button asks like the top button and sends no operation id when not overwriting', async () => {
  const fx = panelFixture([])
  const app = await mountPanel(fx)
  try {
    await fx.state.runBulk()
    assert.deepEqual(fx.prepares, [[false, true]], 'bulk shows the page confirmation')
    assert.equal(fx.posts[0].force, false)
    assert.equal('operation_id' in fx.posts[0], false)
    assert.equal('thumb_number' in fx.posts[0], false)

    fx.prepareResult = () => null // cancelled confirmation
    await fx.state.runBulk()
    assert.equal(fx.posts.length, 1, 'a cancelled confirmation submits nothing')
  } finally { app.unmount() }
})

test('a regenerate-all bulk render carries its own operation id', async () => {
  const fx = panelFixture([])
  const app = await mountPanel(fx, 'regenerate')
  try {
    await fx.state.runBulk()
    assert.deepEqual(fx.prepares, [[true, true]])
    assert.equal(fx.posts[0].force, true)
    assert.match(fx.posts[0].operation_id, UUID)
  } finally { app.unmount() }
})

test('a job error reaches the row through the customer-safe text', async () => {
  const fx = panelFixture([() => ({ status: 'error', job_id: 'job-abc123', error: 'failed for job job-abc123' })])
  const app = await mountPanel(fx)
  try {
    await fx.state.runOne(1)
    assert.doesNotMatch(fx.state.errors.value[1], /job-abc123/)
  } finally { app.unmount() }
})

const REVIEW_SUPPORT = `
  const PromptRow = {}
  const useApi = () => ({ get: fx.get, post: fx.post, put: fx.put })
  const useToast = () => ({ success: () => {}, error: () => {}, show: () => {} })
  const useFreshGenerationAction = fx.useFreshGenerationAction
  const defineEmits = () => (...args) => fx.emits.push(args)
`

test('Prompt review drops a slow load for an earlier episode and saves to the episode it was edited on', async () => {
  const pending: Record<string, (v: any) => void> = {}
  const fx: any = {
    useFreshGenerationAction, emits: [], puts: [] as string[],
    get: (path: string) => new Promise((resolve) => { pending[path.includes('EP-A') ? 'A' : 'B'] = resolve }),
    post: async () => ({}),
    put: (path: string) => { fx.puts.push(path); return new Promise(() => {}) },
  }
  ;(globalThis as any).__fx = fx
  const Review = await loadSetup('../components/PromptReviewPanel.vue', REVIEW_SUPPORT)
  const { reactive } = await import('vue')
  const props = reactive({ projectSlug: 'p', episodeId: 'EP-A', title: 'A', pool: 'thumbnails' })
  const app = createApp({ render: () => h(Review, { ...props }) })
  app.mount(document.body.appendChild(document.createElement('div')))
  await flush()
  try {
    void fx.state.saveOne('thumbnail', 1, { title: 't', prompt: 'p' })
    props.episodeId = 'EP-B'
    props.title = 'B'
    await flush()
    pending.B!({ thumbnails: [{ number: 1, title: 'B1', prompt: 'b' }] })
    await flush()
    pending.A!({ thumbnails: [{ number: 1, title: 'A1', prompt: 'a' }] })
    await flush()
    assert.equal(fx.state.thumbnails.value[0].title, 'B1', 'the late answer for EP-A was dropped')
    assert.match(fx.puts[0], /episodes\/EP-A\/image-prompts\/item\?title=A/)
    assert.equal(fx.state.saving.value.size, 0, 'per-row busy state reset for the new episode')
  } finally { app.unmount() }
})

test('Thumbnail Generator wiring: one builder, extra details per episode, honest notices', () => {
  const page = read('../pages/projects/[slug]/images.vue')
  assert.match(page, /:prepare="prepareGeneration"/)
  assert.doesNotMatch(page, /:aspect-ratio="form\.thumbnail\.aspect_ratio"/, 'the panel no longer rebuilds params from loose props')
  assert.match(page, /\.\.\.\(extraDetails\.value\.trim\(\) \? \{ extra_details: extraDetails\.value\.trim\(\) \} : \{\}\)/)
  assert.match(page, /if \(old\?\.\[1\] && extraDetails\.value\.trim\(\)\) \{\s*extraDetails\.value = ''\s*showInfo\(/)
  assert.doesNotMatch(page, /thumbnail:\s*\{[^}]*extra/, 'extra details are not part of the remembered/preset form')
  assert.match(page, /if \(aspectRatioRemembered \|\| thumbnailGeneratorPresets\.activeId\.value\) return/)
  assert.match(page, /thumbnailGeneratorPresets\.load\(\),[\s\S]{0,80}\]\)\s*await applyImageFormatDefaultsIfNoPreset\(\)/)
  assert.match(page, /function onOutputOptionSwitched\(notice: string\): void \{ showInfo\(notice\) \}/)
  assert.match(page, /realignOutputOption\(activeGenStudioModel\.value, outputOption\.value, ratio\)/)
  assert.match(page, /Stop using the reference/)
  assert.match(page, /thumbnail_reference_asset: null/)
  assert.match(page, /:disabled="submitting \|\| imageJobActiveForEpisode"/)
  for (const jargon of ['provider history', 'submits new provider work', 'silently truncated', 'No step setting']) {
    assert.equal(page.includes(jargon), false, jargon)
  }
  assert.match(page, /grid-template-columns: repeat\(2, 1fr\)/)
  const row = read('../components/ImageGeneratorRow.vue')
  assert.doesNotMatch(row, /Cheap one-off/)
  assert.match(row, /Uses credits for one image\./)
  const picker = read('../components/ImageModelPicker.vue')
  assert.match(picker, /switchNotice\.value = props\.imageMode === 'img2img'/)
  assert.match(picker, /<p v-if="switchNotice"/)
})

test('Thumbnail Prompts: explicit replace-all, honest toast, choices survive a revisit, brief stays with its episode', () => {
  const page = read('../pages/projects/[slug]/image-prompts.vue')
  assert.match(page, /fill_gaps: !replaceAll,\s*force: replaceAll,/)
  assert.match(page, /Replace all \{\{ existingThumbNumbers\.length \}\} prompts/)
  assert.match(page, /async function replaceAllThumbnailPrompts\(\)[\s\S]{0,200}useConfirm\(\)\.ask\(\{[\s\S]{0,300}danger: true/)
  assert.match(page, /All \$\{thumbCt\} prompts already exist — nothing new generated/)
  assert.match(page, /@loaded="existingThumbNumbers = \$event\.thumbnails"/)
  // Template seeding respects a remembered/preset "Thumbnail text".
  assert.match(page, /if \(!thumbnailPresets\.activeId\.value && !rememberedKeys\.thumbnail\.has\('thumb_headline_mode'\)\) \{\s*form\.thumbnail\.thumb_headline_mode =/)
  // Format defaults only seed keys nobody chose.
  assert.match(page, /if \(seedThumb\('aspect_ratio'\)\) form\.thumbnail\.aspect_ratio = ip\.recommendedAspect/)
  assert.match(page, /seedThumb\('thumb_count'\)/)
  assert.match(page, /if \(seedThumb\('style_tag'\)\) \{/)
  // The click brief: never restored, never in a preset, cleared + announced on switch.
  assert.match(page, /excludeKeys: \[\.\.\.DEFAULT_EXCLUDE_KEYS, 'thumb_creative_direction'\]/)
  assert.match(page, /useRememberedForm\('image-prompts'[\s\S]{0,400}form\.thumbnail\.thumb_creative_direction = ''/)
  assert.match(page, /if \(oldEp && form\.thumbnail\.thumb_creative_direction\.trim\(\)\) \{\s*form\.thumbnail\.thumb_creative_direction = ''\s*showInfo\(/)
  assert.match(page, /✨ Shuffle &amp; generate/)
  assert.equal((page.match(/Surprise me/g) || []).length, 0)
  assert.match(page, /while \(!pageDisposed\)/)
})

test('probeRememberedKeys reports only what the restore supplied', async () => {
  const page = read('../pages/projects/[slug]/image-prompts.vue')
  const start = page.indexOf('function probeRememberedKeys')
  const end = page.indexOf('\n}\n', start) + 2
  const { code } = await transform(`${page.slice(start, end)}\nexport { probeRememberedKeys }`, { loader: 'ts', format: 'esm' })
  const { probeRememberedKeys } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const form = { thumbnail: { aspect_ratio: '16:9', thumb_count: 3 } }
  const seen = probeRememberedKeys(form, { thumbnail: ['aspect_ratio', 'thumb_count'] }, () => {
    form.thumbnail.aspect_ratio = '16:9' // remembered value equal to the default still counts as remembered
  })
  assert.deepEqual([...seen.thumbnail], ['aspect_ratio'])
  assert.deepEqual(form.thumbnail, { aspect_ratio: '16:9', thumb_count: 3 }, 'unrestored keys get their default back')
})

test('Image Pool asks before overwriting or spending, refreshes, and names a failed load', () => {
  const page = read('../pages/projects/[slug]/image-pool.vue')
  assert.match(page, /async function pickImagesForEpisode\(\)[\s\S]{0,200}await ask\(\{/)
  assert.match(page, /async function generateIntoPool\(\)[\s\S]{0,300}await ask\(\{/)
  assert.match(page, /growJobId\.value = job\?\.job_id/)
  assert.match(page, /await refreshConfig\(slug\.value\)/)
  assert.doesNotMatch(page, /reload: reloadConfig/)
  assert.match(page, /Could not load your image pools/)
  assert.doesNotMatch(page, /loadPools\(\)\.catch\(\(\) => \{\}\)/)
  assert.match(page, /<h1 class="page-title">Image Pool<\/h1>/)
  assert.match(page, /useAppTitle\('Image Pool'\)/)
})

test('Thumbnail templates: plain wording, failed load with Retry, unsaved-changes guard', () => {
  const picker = read('../components/ThumbnailTemplatePicker.vue')
  assert.doesNotMatch(picker, /PROJECTS_ROOT|electron\/server|forks to user library/)
  assert.match(picker, /Could not load thumbnail templates/)
  assert.match(picker, /@click="load">Retry/)
  const editor = read('../components/ThumbnailTemplateEditor.vue')
  assert.doesNotMatch(editor.slice(0, editor.indexOf('<script')), /~\/Documents|fork a copy|pristine/)
  assert.match(editor, /onBeforeRouteLeave\(/)
  // Live preview of UNSAVED edits: drawn in the browser from the same overlay
  // builder the server uses, never a server preview of the saved file.
  assert.match(editor, /from '@shared\/thumbnail-overlay'/)
  assert.match(editor, /buildOverlaySvg\(workingTemplate\.value, previewText\.value\)/)
  assert.match(editor, /layoutTextZone\(zone, canvas, previewText\.value\)/, 'drag boxes use the shared layout')
  assert.doesNotMatch(editor, /preview\.png/, 'no server round-trip for the editor preview')
  assert.doesNotMatch(editor, /v-html/, 'overlay is an <img> data URL, never injected markup')
  assert.match(editor, /gallery card may differ slightly/)
  // The editor's text settings only draw the gallery preview card (composeThumbnail is
  // called only from the template preview route); real headlines come from the image model.
  assert.match(editor, /data-testid="tte-text-scope-note"[\s\S]{0,300}only shape this template's gallery preview card[\s\S]{0,120}Real thumbnails get their headline from the image model/)
  assert.doesNotMatch(editor, /final render may differ|saved thumbnail does/)
  const catalogPage = read('../pages/projects/[slug]/thumbnail-templates.vue')
  assert.doesNotMatch(catalogPage, /text-free and add a crisp headline|composite the final headline/)
  assert.match(catalogPage, /image model draws each thumbnail's headline[\s\S]{0,80}gallery preview card/)
  assert.match(editor, /Sample title[\s\S]{0,300}Preview only — each episode puts its own title here\./)
})
