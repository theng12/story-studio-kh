import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/publish.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-publish-thumb-test' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-publish-thumb-test',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, reactive, computed, watch, nextTick, onMounted, onUnmounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => globalThis.__ucRoute
    const useRouter = () => ({ currentRoute: { value: globalThis.__ucRoute }, replace: async (to) => { globalThis.__ucRoute.query = { ...to.query } } })
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
    const useJobs = () => ({ jobs: globalThis.__ucJobsRef, jobsStale: globalThis.__ucJobsStaleRef })
    const useProject = () => ({ config: ref(globalThis.__projectConfig ?? null) })
  `
  const code = `${support}\n${script.content
    .replace('export default', 'const __sfc__ =')
    .replace("'~/utils/upload-bulk'", JSON.stringify(new URL('../utils/upload-bulk.ts', import.meta.url).href))
    .replace("'~/composables/useFreshGenerationAction'", JSON.stringify(new URL('../composables/useFreshGenerationAction.ts', import.meta.url).href))
    .replace("'~/utils/publish-view'", JSON.stringify(new URL('../utils/publish-view.ts', import.meta.url).href))
    .replace("'~/utils/route-query-state'", JSON.stringify(new URL('../utils/route-query-state.ts', import.meta.url).href))
    .replace("'~/utils/thumbnail-text'", JSON.stringify(new URL('../utils/thumbnail-text.ts', import.meta.url).href))}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

interface RecordedCall { method: string; path: string; body?: any }

test('Thumbnail test link and candidates display on upload/publish page after upload', async (t) => {
  // 1. Source verification: publish.vue contains post-upload thumbnail candidates and Studio test link
  assert.match(source, /isPostUpload/)
  assert.match(source, /otherThumbnailCandidates/)
  assert.match(source, /studio\.youtube\.com\/video/)
  assert.match(source, /Start a thumbnail test in YouTube Studio/)

  // 2. Component mount test
  const calls: RecordedCall[] = []
  ;(globalThis as any).__ucConfirm = async () => true
  const routeState = reactive({
    params: { slug: 'demo-project' },
    query: { episode_id: '' } as Record<string, unknown>,
    path: '/projects/demo-project/upload/publish',
  })
  ;(globalThis as any).__ucRoute = routeState
  ;(globalThis as any).__ucJobsRef = ref([])
  ;(globalThis as any).__ucJobsStaleRef = ref(false)

  const PREVIEW_DATA = {
    snippet: { title: 'Episode One' },
    status: { privacyStatus: 'private' },
    video_id: 'test_vid_xyz',
    package_revision: 'rev-1',
    source: { filename: 'EP0001_1080p.mp4', revision: 'src-1' },
    modifications: [],
    warnings: [],
    thumbnail: {
      state: 'selected',
      filename: 'EP0001_Thumb01_v1.png',
      url: '/api/EP0001_Thumb01_v1.png',
      options: [
        { filename: 'EP0001_Thumb01_v1.png', url: '/api/EP0001_Thumb01_v1.png' },
        { filename: 'EP0001_Thumb02_v1.png', url: '/api/EP0001_Thumb02_v1.png' },
        { filename: 'EP0001_Thumb03_v1.png', url: '/api/EP0001_Thumb03_v1.png' },
      ],
    },
  }

  ;(globalThis as any).__ucApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (path.endsWith('/publishable')) {
        return {
          episodes: [
            {
              episode_code: 'EP0001',
              title: 'Episode One',
              has_video: true,
              remote_video_id: 'test_vid_xyz',
              operation: { operation_id: 'op-1', video_id: 'test_vid_xyz', lifecycle: 'succeeded' },
              local: { render: { state: 'ready' }, upload: { state: 'succeeded' } },
              publication: { state: 'uploaded' },
            },
          ],
          total: 1,
        }
      }
      if (path.endsWith('/overview')) {
        return {
          assigned_channel: { title: 'My Channel', channel_id: 'UC123' },
          quota: { buckets: { video_uploads: { remaining: 100 } } },
        }
      }
      if (path.endsWith('/library/op-1/thumbnail')) return { current: { url: 'https://i.ytimg.com/vi/test_vid_xyz/hqdefault.jpg', checked_at: '2026-11-04T14:00:00Z' }, previous: { filename: `${'a'.repeat(64)}.jpg`, url: '/api/previous.jpg' } }
      if (path.endsWith('/safety-checks')) return { checks: [] }
      if (path.endsWith('/upload/plans')) return { plans: [], active: {} }
      return {}
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/youtube/preview')) {
        return PREVIEW_DATA
      }
      if (path.endsWith('/library/op-1/thumbnail')) return { job_id: 'thumbnail-job' }
      return {}
    },
  }

  const Page = await loadPage()
  const el = document.createElement('div')
  document.body.appendChild(el)
  let destroyed = false
  const destroy = () => {
    if (destroyed) return
    destroyed = true
    app.unmount()
    el.remove()
  }
  t.after(destroy)
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.component('Modal', defineComponent({
    props: { visible: Boolean, labelledby: String },
    setup(props, { slots }) {
      return () => props.visible ? h('div', { role: 'dialog', 'aria-labelledby': props.labelledby }, slots.default?.()) : null
    },
  }))
  app.component('NuxtLink', defineComponent({
    props: { to: String },
    setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
  }))
  app.component('ProgressBar', defineComponent({
    props: { progress: Number, label: String },
    setup(props) { return () => h('div', { role: 'progressbar' }, props.label) },
  }))

  try {
    app.mount(el)
    for (let i = 0; i < 6; i++) await nextTick()
    // Row-level action link exists on the uploaded episode
    const rowLink = el.querySelector<HTMLAnchorElement>('.op-actions a[href*="studio.youtube.com"]')
    assert.ok(rowLink, 'Action link to YouTube Studio should exist in row actions')
    assert.equal(rowLink.href, 'https://studio.youtube.com/video/test_vid_xyz/edit')
    assert.match(rowLink.textContent || '', /Start a thumbnail test in YouTube Studio/)

    // Now open review dialog
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.op-actions button')]
    const prepBtn = buttons.find(b => (b.textContent || '').includes('Review Upload Details'))
    assert.ok(prepBtn, 'Review Upload Details button should exist')
    prepBtn.click()

    for (let i = 0; i < 6; i++) await nextTick()

    // Dialog is visible
    const dialog = el.querySelector('[role="dialog"]')
    assert.ok(dialog, 'Upload review dialog should be visible')

    // The other 2 candidate thumbnails are shown beside the chosen one
    const otherCandidates = dialog.querySelectorAll('.other-candidates-wrap .candidate-thumb-card')
    assert.equal(otherCandidates.length, 2, 'Should show the other 2 candidate thumbnails beside chosen one')
    const candidateTexts = [...otherCandidates].map(c => c.textContent || '')
    assert.ok(candidateTexts.some(t => t.includes('EP0001_Thumb02_v1.png')))
    assert.ok(candidateTexts.some(t => t.includes('EP0001_Thumb03_v1.png')))

    // The chosen thumbnail is marked
    const chosenWrap = dialog.querySelector('.chosen-thumbnail-wrap')
    assert.ok(chosenWrap, 'Chosen thumbnail wrapper should exist')
    assert.match(chosenWrap.textContent || '', /Chosen thumbnail/)
    assert.match(chosenWrap.textContent || '', /EP0001_Thumb01_v1\.png/)

    // The Studio test link is present in the review dialog
    const studioLink = dialog.querySelector<HTMLAnchorElement>('.thumbnail-test-cta a.thumbnail-test-link')
    assert.ok(studioLink, 'Studio test link should exist in review dialog')
    assert.equal(studioLink.href, 'https://studio.youtube.com/video/test_vid_xyz/edit')
    assert.match(studioLink.textContent || '', /Start a thumbnail test in YouTube Studio/)

    // Confirm NO YouTube API call was made for testing: the page only previews
    // and lists; it never asks YouTube to create or run a test.
    const testCalls = calls.filter(c => /ab[_/-]?test|thumbnail[_/-]?test/i.test(c.path))
    assert.equal(testCalls.length, 0, 'No YouTube API call should be made for starting the test')

    const replacements = [...dialog.querySelectorAll<HTMLButtonElement>('.youtube-thumbnail-replace')]
    assert.equal(replacements.length, 3, 'Every candidate, including the selected one, can replace the remote thumbnail')
    assert.ok(dialog.querySelector('img[alt="Current thumbnail read from YouTube"]'))
    assert.ok(dialog.querySelector('img[alt="Previous YouTube thumbnail retained for restoration"]'))
    ;(globalThis as any).__ucJobsRef.value = [{ job_id: 'older-operation-job', project_slug: 'demo-project', episode_id: 'EP0001', type: 'youtube_thumbnail_refresh', status: 'running', progress: 30 }]
    for (let i = 0; i < 6; i++) await nextTick()
    assert.ok(replacements.every(button => !button.disabled), 'A different operation job must not supply replacement progress')
    assert.doesNotMatch(dialog.textContent || '', /running · 30%/)
    let confirmation: any
    ;(globalThis as any).__ucConfirm = async (options: any) => { confirmation = options; return false }
    replacements[1]!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(confirmation.message, /friend added a titled Khmer thumbnail/)
    assert.equal(calls.filter(call => call.path.endsWith('/library/op-1/thumbnail') && call.method === 'POST').length, 0, 'Cancelling must send nothing')
    ;(globalThis as any).__ucConfirm = async () => true
    replacements[1]!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    const replace = calls.find(call => call.path.endsWith('/library/op-1/thumbnail') && call.method === 'POST')!
    assert.deepEqual(replace.body, { confirm: true, thumbnail_filename: 'EP0001_Thumb02_v1.png' }, 'Thumbnail replacement carries no metadata, visibility or schedule')
    ;(globalThis as any).__ucJobsRef.value = [{ job_id: 'thumbnail-job', project_slug: 'demo-project', episode_id: 'EP0001', type: 'youtube_thumbnail_refresh', status: 'running', progress: 75 }]
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(dialog.textContent || '', /running · 75%/)
    assert.ok(replacements.every(button => button.disabled))
    ;(globalThis as any).__ucJobsRef.value = [{ job_id: 'thumbnail-job', project_slug: 'demo-project', episode_id: 'EP0001', type: 'youtube_thumbnail_refresh', status: 'done', progress: 100 }]
    for (let i = 0; i < 10; i++) await nextTick()
    assert.ok(calls.filter(call => call.path.endsWith('/library/op-1/thumbnail') && call.method === 'GET').length >= 2, 'Completion requires fresh YouTube readback')
    dialog.querySelector<HTMLButtonElement>('.youtube-thumbnail-restore')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.deepEqual(calls.filter(call => call.method === 'POST' && call.path.endsWith('/library/op-1/thumbnail')).at(-1)?.body, { confirm: true, thumbnail_filename: `${'a'.repeat(64)}.jpg` })
  } finally {
    destroy()
    await nextTick()
  }
})
