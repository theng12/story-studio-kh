import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, reactive, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/publish.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-publish' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-publish',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, reactive, computed, watch, nextTick } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => globalThis.__ucRoute
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
    const useJobs = () => ({ jobs: globalThis.__ucJobsRef, jobsStale: globalThis.__ucJobsStaleRef })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

interface Recorded { method: string; path: string; body?: any }

async function mount(input: {
  /** Upload RECORDS. Each becomes a rendered episode carrying that record. */
  operations?: any[]
  /** Publishable episodes, stated directly. Use this for the never-uploaded case. */
  episodes?: any[]
  preview?: any
  previewOverride?: (body: any) => Promise<any> | any
  refresh?: any
  channelStatus?: string | null
  quotaRemaining?: number
  uploadQuotaRemaining?: number
  quotaUnavailableReason?: string | null
  total?: number
  /** Fail every preview after this many successful ones. */
  previewFailAfter?: number
  /** What POST /youtube/upload answers, or throws when `uploadError` is set. */
  uploadResponse?: any
  uploadError?: any
  /** What the confirm dialog answers. Defaults to yes. */
  confirmAnswer?: boolean
  confirmOverride?: (options: any) => Promise<boolean>
  initialSlug?: string
  initialEpisode?: string
  getOverride?: (path: string) => Promise<any> | any
  postOverride?: (path: string, body: any) => Promise<any> | any
  jobs?: any[]
  jobsStale?: boolean
  plans?: any
  planPreview?: any
  planApply?: any
  scheduleResponse?: any
}): Promise<{
  el: HTMLElement; text: () => string; calls: Recorded[]
  setEpisode: (episode: string) => Promise<void>
  confirms: any[]; setSlug: (slug: string) => Promise<void>; setJobs: (jobs: any[]) => Promise<void>; destroy: () => void
}> {
  const calls: Recorded[] = []
  const confirms: any[] = []
  let previewCalls = 0
  ;(globalThis as any).__ucConfirm = async (options: any) => {
    confirms.push(options)
    if (input.confirmOverride) return input.confirmOverride(options)
    return input.confirmAnswer !== false
  }
  const routeState = reactive({ params: { slug: input.initialSlug ?? 'demo-project' }, query: { episode_id: input.initialEpisode ?? '' } })
  ;(globalThis as any).__ucRoute = routeState
  const jobsRef = ref(input.jobs ?? [])
  ;(globalThis as any).__ucJobsRef = jobsRef
  ;(globalThis as any).__ucJobsStaleRef = ref(input.jobsStale ?? false)
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (input.getOverride) return input.getOverride(path)
      if (path.endsWith('/publishable')) {
        // The server returns EPISODES with an operation overlaid where one
        // exists. `operations` is the shorthand for "a rendered episode that
        // has been uploaded"; `episodes` states the row outright.
        const rows = input.episodes ?? (input.operations ?? []).map((op: any) => ({
          episode_code: op.episode_code, title: 'Some Episode', has_video: true, operation: op,
          ...(op.lifecycle === 'rejected'
            ? { publication: { state: 'rejected', reason: op.processing?.rejection_reason } }
            : {}),
          // The server decides "already on YouTube" and hands the page the
          // REASON; the shim has to produce what the server produces, or these
          // tests describe a response that does not exist (tell 7).
          ...(op.video_id
            ? {
                has_remote_video: true,
                remote_video_id: op.video_id,
                remote_source: 'operation_record',
                blocked_reason: `${op.episode_code} is already on YouTube as ${op.video_id}.`,
              }
            : {}),
        }))
        return { episodes: rows, total: input.total ?? rows.length }
      }
      if (path.endsWith('/overview')) return {
        assigned_channel: input.channelStatus === null
          ? null
          : { channel_id: 'UC-x', title: 'Ch', status: input.channelStatus ?? 'connected' },
        quota_unavailable_reason: input.quotaUnavailableReason ?? null,
        quota: {
          buckets: {
            other_endpoints: { remaining: input.quotaRemaining ?? 5000 },
            // Upload is gated on THIS bucket, not other_endpoints. Without it
            // the new branch defaulted its way to green and could not fail.
            video_uploads: { remaining: input.uploadQuotaRemaining ?? 100 },
          },
        },
      }
      if (path.endsWith('/upload/plans')) return input.plans ?? { plans: [], active: {} }
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (input.postOverride) {
        const overridden = await input.postOverride(path, body)
        if (overridden !== undefined) return overridden
      }
      if (path.endsWith('/youtube/preview')) {
        previewCalls += 1
        if (input.previewFailAfter !== undefined && previewCalls > input.previewFailAfter) {
          throw new Error('preview exploded')
        }
        if (input.previewOverride) return input.previewOverride(body)
        return input.preview
      }
      if (path.endsWith('/youtube/plan/preview')) return input.planPreview
      if (path.endsWith('/youtube/plan/apply')) return input.planApply
      if (/\/youtube\/episodes\/[^/]+\/schedule$/.test(path)) return input.scheduleResponse
      if (path.endsWith('/refresh')) return input.refresh
      if (path.endsWith('/youtube/upload')) {
        if (input.uploadError) throw input.uploadError
        return input.uploadResponse ?? { job_id: 'job-1', channel_id: 'UC-x' }
      }
      throw new Error(`unexpected POST ${path}`)
    },
  }
  const Page = await loadPage()
  const el = document.createElement('div')
  document.body.appendChild(el)
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.component('Modal', defineComponent({
    props: { visible: Boolean, labelledby: String },
    emits: ['close'],
    setup(props, { slots }) { return () => props.visible ? h('div', { role: 'dialog', 'aria-labelledby': props.labelledby }, slots.default?.()) : null },
  }))
  app.component('NuxtLink', defineComponent({
    props: { to: String },
    setup(props, { slots }) { return () => h('a', { href: props.to }, slots.default?.()) },
  }))
  app.component('ProgressBar', defineComponent({
    props: {
      progress: Number, bytesDone: Number, bytesTotal: Number, speedBps: Number,
      etaSeconds: Number, indeterminate: Boolean, label: String,
    },
    setup(props) {
      return () => h('div', {
        role: 'progressbar',
        'aria-label': props.label,
        'aria-valuenow': props.indeterminate ? undefined : props.progress,
      }, `${props.label || ''} ${props.progress ?? ''}% ${props.bytesDone ?? ''}/${props.bytesTotal ?? ''}`)
    },
  }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return {
    el, text: () => el.textContent || '', calls, confirms,
    setEpisode: async (episode: string) => { routeState.query.episode_id = episode; for (let i = 0; i < 4; i++) await nextTick() },
    setSlug: async (nextSlug: string) => { routeState.params.slug = nextSlug; for (let i = 0; i < 4; i++) await nextTick() },
    setJobs: async (nextJobs: any[]) => { jobsRef.value = nextJobs; for (let i = 0; i < 6; i++) await nextTick() },
    destroy: () => { app.unmount(); el.remove() },
  }
}

const READY_OP = { operation_id: 'op-1', episode_code: 'EP0001', lifecycle: 'ready', video_id: 'vid-1', processing: { checked_at: '2026-09-02T10:00:00.000Z', provider_status: 'processed' } }

describe('Upload Center Publish', () => {
  test('shows YouTube’s own refusal reason rather than a generic failure', async () => {
    const mounted = await mount({
      operations: [{
        operation_id: 'op-2', episode_code: 'EP0002', lifecycle: 'rejected', video_id: 'vid-2',
        processing: { checked_at: '2026-09-02T10:00:00.000Z', provider_status: 'rejected', rejection_reason: 'copyright' },
      }],
    })
    assert.equal(mounted.el.querySelector('.publication-fact .state-text')?.textContent?.trim(), 'Rejected')
    assert.match(mounted.text(), /copyright/)
    mounted.destroy()
  })

  test('an unchecked video is not described as checked', async () => {
    const mounted = await mount({
      operations: [{ operation_id: 'op-3', episode_code: 'EP0003', lifecycle: 'accepted', video_id: 'vid-3' }],
    })
    assert.match(mounted.text(), /Not checked with YouTube yet/)
    mounted.destroy()
  })

  test('nothing checks YouTube on load — only the explicit action does', async () => {
    const mounted = await mount({ operations: [READY_OP] })
    assert.equal(mounted.calls.some(c => c.path.includes('/refresh')), false)
    assert.match(mounted.text(), /Nothing here checks on its own/)
    assert.match(mounted.text(), /YouTube checked .*cleanup verifies again/)
    assert.doesNotMatch(mounted.text(), /safe to clear/i)
    mounted.destroy()
  })

  test('a status YouTube would not return is reported as unknown, not as a verdict', async () => {
    const mounted = await mount({
      operations: [READY_OP],
      refresh: { state: { lifecycle: 'status_unavailable' }, persisted: false },
    })
    const check = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Check on YouTube'))!
    check.click()
    for (let i = 0; i < 6; i++) await nextTick()

    assert.match(mounted.text(), /did not return this video/)
    assert.match(mounted.text(), /last known state is kept/)
    mounted.destroy()
  })

  test('the preview shows the exact payload and itemizes every change applied', async () => {
    const mounted = await mount({
      operations: [READY_OP],
      preview: {
        snippet: { title: 'Final Title', description: 'Final description', tags: ['a', 'b'], categoryId: '24' },
        status: { privacyStatus: 'private', publishAt: '2026-09-10T09:00:00.000Z', containsSyntheticMedia: true },
        modifications: [{ field: 'title', reason: 'title truncated 172 → 100 chars' }],
        warnings: ['the scheduled publish time is in the past and YouTube will reject it'],
      },
    })
    const preview = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details')!
    preview.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const text = mounted.text()
    assert.match(text, /1 change applied/)
    assert.match(text, /title truncated 172 → 100 chars/)
    assert.match(text, /the scheduled publish time is in the past/)
    assert.match(text, /Final Title/)
    assert.match(text, /Final description/)
    assert.match(text, /a, b/)
    assert.match(text, /private/)
    assert.match(text, /Nothing is changed after this point/)
    mounted.destroy()
  })

  test('review shows the selected thumbnail and carries a changed choice into the queued upload', async () => {
    const selected = (filename: string) => ({
      ...PREVIEWED,
      thumbnail: {
        state: 'selected',
        filename,
        url: `/api/projects/demo-project/video-editor/preview-image?path=${encodeURIComponent(`/tmp/${filename}`)}&v=1`,
        options: [
          { filename: 'EP0001_Thumb01_v2.png', url: '/api/thumb-v2.png' },
          { filename: 'EP0001_Thumb01_v1.png', url: '/api/thumb-v1.png' },
        ],
      },
    })
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      previewOverride: (body) => selected(body.thumbnail_filename || 'EP0001_Thumb01_v2.png'),
    })
    await previewThen(mounted)

    const dialog = mounted.el.querySelector('[role="dialog"]')!
    assert.equal(dialog.querySelector('img')?.getAttribute('src'), '/api/projects/demo-project/video-editor/preview-image?path=%2Ftmp%2FEP0001_Thumb01_v2.png&v=1')
    assert.match(dialog.textContent || '', /EP0001_Thumb01_v2\.png/)
    const older = [...dialog.querySelectorAll('button')]
      .find(button => button.textContent?.includes('EP0001_Thumb01_v1.png')) as HTMLButtonElement
    assert.equal(older.getAttribute('aria-pressed'), 'false')
    older.focus()
    older.click()
    for (let i = 0; i < 6; i++) await nextTick()
    const chosen = [...dialog.querySelectorAll('button')]
      .find(button => button.textContent?.includes('EP0001_Thumb01_v1.png')) as HTMLButtonElement
    assert.equal(chosen.getAttribute('aria-pressed'), 'true')
    assert.match(chosen.textContent || '', /Selected/)
    assert.equal(document.activeElement, chosen, 'keyboard focus follows the selected thumbnail through preview refresh')

    const upload = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes('Upload to YouTube')) as HTMLButtonElement
    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()
    const previewCalls = mounted.calls.filter(call => call.path.endsWith('/preview'))
    assert.equal(previewCalls.length, 2)
    assert.equal(previewCalls[1]?.body.thumbnail_filename, 'EP0001_Thumb01_v1.png')
    const posted = mounted.calls.find(call => call.path.endsWith('/youtube/upload'))
    assert.equal(posted?.body.thumbnail_filename, 'EP0001_Thumb01_v1.png')
    assert.match(mounted.confirms[0].message, /EP0001_Thumb01_v1\.png/)
    assert.equal(
      dialog.querySelector('a[href*="images?tab=thumbnails"]')?.getAttribute('href'),
      '/projects/demo-project/images?tab=thumbnails&episode_id=EP0001',
    )
    mounted.destroy()
  })

  test('review distinguishes no thumbnail from an image that cannot be displayed', async () => {
    const none = await mount({
      episodes: [NEVER_UPLOADED],
      preview: { ...PREVIEWED, thumbnail: { state: 'none', options: [] } },
    })
    await previewThen(none)
    assert.match(none.text(), /No thumbnail is selected for this upload/)
    none.destroy()

    const unavailable = await mount({
      episodes: [NEVER_UPLOADED],
      preview: {
        ...PREVIEWED,
        thumbnail: {
          state: 'selected', filename: 'EP0001_Thumb01_v1.png', url: '/api/broken.png',
          options: [{ filename: 'EP0001_Thumb01_v1.png', url: '/api/broken.png' }],
        },
      },
    })
    await previewThen(unavailable)
    unavailable.el.querySelector('img')!.dispatchEvent(new Event('error'))
    await nextTick()
    assert.match(unavailable.text(), /thumbnail file is selected, but its preview is unavailable/i)
    assert.equal(
      [...unavailable.el.querySelectorAll('button')].some(button => button.textContent!.includes('Upload to YouTube')),
      false,
      'a thumbnail the owner could not review cannot silently become an explicit no-thumbnail upload',
    )
    const retry = unavailable.el.querySelector<HTMLButtonElement>('.thumbnail-option')!
    assert.equal(retry.title, 'Retry thumbnail preview')
    retry.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(unavailable.calls.filter(call => call.path.endsWith('/preview')).length, 2)
    unavailable.destroy()
  })

  test('a disappeared thumbnail exposes alternatives and remains blocked until one is reviewed', async () => {
    const available = 'EP0001_Thumb02_v1.png'
    const unavailable = 'EP0001_Thumb01_v1.png'
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      previewOverride: (body) => body.thumbnail_filename === available
        ? {
            ...PREVIEWED,
            thumbnail: { state: 'selected', filename: available, url: '/api/available.png', options: [{ filename: available, url: '/api/available.png' }] },
          }
        : {
            ...PREVIEWED,
            thumbnail: {
              state: 'unavailable', filename: unavailable, reason: 'The selected thumbnail is no longer available.',
              options: [{ filename: available, url: '/api/available.png' }],
            },
          },
    })
    await previewThen(mounted)
    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(button => button.textContent!.includes('Upload to YouTube')),
      false,
    )
    const alternative = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes(available)) as HTMLButtonElement
    assert.ok(alternative)
    alternative.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.ok([...mounted.el.querySelectorAll('button')].some(button => button.textContent!.includes('Upload to YouTube')))
    mounted.destroy()
  })

  // ── Clicking Upload ─────────────────────────────────────────────────────
  //
  // The page-level tests. The backend suite proves the route; these prove a
  // person can REACH it, which is where two separate blockers lived:
  //
  //   - the control was guarded by `v-if="channelStatus"`, so a healthy project
  //     ('connected') took the blocked branch and the button never rendered;
  //   - the row list came from `/youtube/operations`, which only exists once an
  //     upload has happened, so a project that had never uploaded had no row,
  //     no Preview, and no Upload.
  //
  // The first version of these tests used a `ready` record with a video id -
  // a state the real route refuses with 409 ALREADY_IN_FLIGHT. They passed
  // against a stub while the product could not do the thing they described
  // (tell 7). The fixture is now the state that CAN be uploaded: accepted,
  // rendered, never uploaded.
  const NEVER_UPLOADED = {
    episode_code: 'EP0001', title: 'The Lighthouse at Dawn', has_video: true,
  }
  const PREVIEWED = {
    package_revision: 'pack-42',
    source_sha256: 'metadata-source-42',
    source: { filename: 'EP0001_final_video.mp4', revision: 'video-source-42' },
    snippet: { title: 'The Lighthouse at Dawn', description: 'd', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private', containsSyntheticMedia: true },
    modifications: [], warnings: [],
  }

  async function previewThen(mounted: Awaited<ReturnType<typeof mount>>): Promise<HTMLButtonElement> {
    const preview = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details')!
    preview.click()
    for (let i = 0; i < 6; i++) await nextTick()
    return [...mounted.el.querySelectorAll('button')]
      .find(b => b.textContent!.includes('Upload to YouTube')) as HTMLButtonElement
  }

  test('an episode that has never been uploaded is offered, previewed and uploaded', async () => {
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview: PREVIEWED })

    // The row itself. Before the fix this project rendered "Nothing uploaded
    // yet" and no controls at all.
    assert.match(mounted.text(), /EP0001/)
    assert.match(mounted.text(), /Not uploaded/)

    const upload = await previewThen(mounted)
    assert.ok(upload, 'a rendered, never-uploaded episode can be uploaded')

    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()

    assert.equal(mounted.confirms.length, 1)
    assert.match(mounted.confirms[0].title, /Upload EP0001 to YouTube\?/)
    assert.match(mounted.confirms[0].message, /cannot be replaced once uploaded/)

    const posted = mounted.calls.find(c => c.path.endsWith('/youtube/upload'))
    assert.ok(posted, 'the click reaches the route')
    assert.deepEqual(posted!.body, {
      episode_code: 'EP0001', confirm: true, expected_channel_id: 'UC-x',
      expected_package_revision: 'pack-42', expected_source_revision: 'video-source-42',
      thumbnail_filename: null, privacy_status: 'private',
    })
    assert.match(mounted.confirms[0].message, /Ch \(UC-x\)/)

    assert.match(mounted.text(), /Uploading EP0001 to UC-x/)
    mounted.destroy()
  })

  test('a future planned date is the default and stays inside exact preview and upload confirmation', async () => {
    const publishAt = '2099-09-10T09:00:00.000Z'
    const mounted = await mount({
      episodes: [{ ...NEVER_UPLOADED, plan: { scheduled_at: publishAt, timezone: 'Asia/Phnom_Penh' } }],
      previewOverride: (body) => ({
        ...PREVIEWED,
        status: { ...PREVIEWED.status, ...(body.publish_at ? { publishAt: body.publish_at } : {}) },
      }),
    })

    const upload = await previewThen(mounted)
    const previewCall = mounted.calls.find(call => call.path.endsWith('/youtube/preview'))!
    assert.deepEqual(previewCall.body, { episode_code: 'EP0001', privacy_status: 'private', publish_at: publishAt })
    assert.equal((mounted.el.querySelector('input[value="planned"]') as HTMLInputElement).checked, true)
    assert.match(mounted.text(), new RegExp(publishAt.replaceAll('.', '\\.')))

    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()
    assert.match(mounted.confirms[0].message, new RegExp(publishAt.replaceAll('.', '\\.')))
    assert.deepEqual(mounted.calls.find(call => call.path.endsWith('/youtube/upload'))?.body, {
      episode_code: 'EP0001', confirm: true, expected_channel_id: 'UC-x', expected_package_revision: 'pack-42',
      expected_source_revision: 'video-source-42', thumbnail_filename: null, privacy_status: 'private', publish_at: publishAt,
    })
    mounted.destroy()
  })

  test('a past planned date is never converted into an immediate public upload', async () => {
    const mounted = await mount({
      episodes: [{ ...NEVER_UPLOADED, plan: { scheduled_at: '2020-01-01T00:00:00.000Z', timezone: 'UTC' } }],
      preview: PREVIEWED,
    })
    await previewThen(mounted)
    assert.deepEqual(mounted.calls.find(call => call.path.endsWith('/youtube/preview'))?.body, {
      episode_code: 'EP0001', privacy_status: 'private',
    })
    assert.equal((mounted.el.querySelector('input[value="private"]') as HTMLInputElement).checked, true)
    assert.match(mounted.text(), /No future planned date is saved/)

    ;(mounted.el.querySelector('input[value="custom"]') as HTMLInputElement).click()
    await nextTick()
    const field = mounted.el.querySelector('input[type="datetime-local"]') as HTMLInputElement
    field.value = '2020-01-01T00:00'
    field.dispatchEvent(new Event('input'))
    await nextTick()
    const previewsBefore = mounted.calls.filter(call => call.path.endsWith('/youtube/preview')).length
    ;([...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Review this time')) as HTMLButtonElement).click()
    await nextTick()
    assert.match(mounted.text(), /will not turn a past schedule into an immediate publish/)
    assert.equal(mounted.calls.filter(call => call.path.endsWith('/youtube/preview')).length, previewsBefore)
    mounted.destroy()
  })

  test('a custom local time must be reviewed, then its exact ISO is confirmed and submitted', async () => {
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      previewOverride: (body) => ({
        ...PREVIEWED,
        status: { ...PREVIEWED.status, ...(body.publish_at ? { publishAt: body.publish_at } : {}) },
      }),
    })
    await previewThen(mounted)
    const custom = mounted.el.querySelector('input[value="custom"]') as HTMLInputElement
    custom.click()
    custom.dispatchEvent(new Event('change'))
    await nextTick()
    assert.match(mounted.text(), /Review this timing choice/)

    const localValue = '2099-10-11T08:30'
    const exactIso = new Date(localValue).toISOString()
    const field = mounted.el.querySelector('input[type="datetime-local"]') as HTMLInputElement
    field.value = localValue
    field.dispatchEvent(new Event('input'))
    await nextTick()
    const review = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Review this time'))!
    review.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.filter(call => call.path.endsWith('/youtube/preview')).at(-1)?.body.publish_at, exactIso)

    const upload = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Upload to YouTube'))!
    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()
    assert.match(mounted.confirms[0].message, new RegExp(exactIso.replaceAll('.', '\\.')))
    assert.equal(mounted.calls.find(call => call.path.endsWith('/youtube/upload'))?.body.publish_at, exactIso)
    mounted.destroy()
  })

  test('plans unscheduled videos locally through preview and freshness-fenced apply only after confirmation', async () => {
    const assignments = [
      { episode_code: 'EP0001', publishAt: '2099-11-01T09:00:00.000Z' },
      { episode_code: 'EP0002', publishAt: '2099-11-03T09:00:00.000Z' },
    ]
    const mounted = await mount({
      episodes: [NEVER_UPLOADED, { ...NEVER_UPLOADED, episode_code: 'EP0002', title: 'Second' }],
      plans: {
        plans: [{ id: 'plan-1', name: 'Weekdays', platform: 'youtube', account_id: 'registry:UC-x', schedule: { timezone: 'Asia/Phnom_Penh' } }],
        active: { 'youtube:registry:UC-x': 'plan-1' },
      },
      planPreview: { assignments, skipped_existing: [], latest_existing_claim: null },
      planApply: { assignments, skipped_existing: [], latest_existing_claim: null },
    })
    assert.equal(mounted.calls.some(call => call.path.includes('/youtube/plan/')), false, 'mount is read-only')
    const plan = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Plan unscheduled videos (2)'))!
    plan.click()
    for (let i = 0; i < 8; i++) await nextTick()
    await new Promise(resolve => setTimeout(resolve, 0))
    for (let i = 0; i < 4; i++) await nextTick()

    const previewCall = mounted.calls.find(call => call.path.endsWith('/youtube/plan/preview'))!
    assert.deepEqual(previewCall.body, {
      plan_id: 'plan-1', expected_channel_id: 'UC-x', episode_codes: ['EP0001', 'EP0002'],
    })
    const applyCall = mounted.calls.find(call => call.path.endsWith('/youtube/plan/apply'))!
    assert.deepEqual(applyCall.body, {
      plan_id: 'plan-1', expected_channel_id: 'UC-x', episode_codes: ['EP0001', 'EP0002'],
      confirm: true, expected_assignments: assignments,
    })
    assert.equal(mounted.calls.some(call => call.path.endsWith('/youtube/upload')), false)
    assert.match(mounted.confirms[0].message, /local planned dates/)
    assert.match(mounted.text(), /YouTube has not been changed/)
    mounted.destroy()
  })

  test('checks unknown remote visibility only after confirmation, then schedules by episode without reuploading', async () => {
    const publishAt = '2099-12-05T08:00:00.000Z'
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0042', title: 'Already private', has_video: true,
        has_remote_video: true, remote_video_id: 'video-42',
        can_schedule_existing: true,
        operation: { operation_id: 'op-42', episode_code: 'EP0042', lifecycle: 'ready', video_id: 'video-42' },
        local: { render: { state: 'ready' }, upload: { state: 'succeeded' } },
        publication: { state: 'uploaded' },
        plan: { scheduled_at: publishAt, timezone: 'UTC' },
      }],
      previewOverride: (body) => ({
        ...PREVIEWED,
        status: { ...PREVIEWED.status, ...(body.publish_at ? { publishAt: body.publish_at } : {}) },
      }),
      scheduleResponse: { episode_code: 'EP0042', video_id: 'video-42', privacy_status: 'private', scheduled_at: publishAt },
    })
    const open = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Schedule publication')!
    open.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /has not confirmed this video’s visibility/)
    const schedule = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Schedule on YouTube')!
    schedule.click()
    for (let i = 0; i < 8; i++) await nextTick()

    const call = mounted.calls.find(item => item.path.endsWith('/youtube/episodes/EP0042/schedule'))!
    assert.deepEqual(call.body, { confirm: true, expected_channel_id: 'UC-x', publish_at: publishAt })
    assert.equal(mounted.calls.some(item => item.path.endsWith('/youtube/upload')), false)
    assert.match(mounted.confirms[0].message, /does not upload the video again/)
    mounted.destroy()
  })

  test('shows live local upload transfer progress with a Jobs link', async () => {
    const mounted = await mount({
      episodes: [{
        ...NEVER_UPLOADED,
        local: { render: { state: 'ready' }, upload: { state: 'running', job_id: 'job-42' } },
      }],
      jobs: [{ job_id: 'job-42', status: 'running', type: 'youtube_upload', progress: 38, bytes_done: 380, bytes_total: 1000, speed_bps: 20, eta_seconds: 31 }],
    })
    const progress = mounted.el.querySelector('[role="progressbar"]')!
    assert.equal(progress.getAttribute('aria-valuenow'), '38')
    assert.equal(progress.getAttribute('aria-label'), 'Uploading to YouTube')
    assert.equal([...mounted.el.querySelectorAll('a')].find(link => link.textContent!.includes('View in Jobs'))?.getAttribute('href'), '/projects/demo-project/jobs')
    mounted.destroy()
  })

  test('refreshes provider-free publishable state when a known upload job finishes', async () => {
    const episode = {
      ...NEVER_UPLOADED,
      local: { render: { state: 'ready' }, upload: { state: 'running', job_id: 'job-42' } },
    }
    const running = { job_id: 'job-42', status: 'running', type: 'youtube_upload', progress: 90 }
    const mounted = await mount({ episodes: [episode], jobs: [running] })
    const before = mounted.calls.filter(call => call.path.endsWith('/youtube/publishable')).length

    await mounted.setJobs([{ ...running, status: 'done', progress: 100 }])

    assert.equal(mounted.calls.filter(call => call.path.endsWith('/youtube/publishable')).length, before + 1)
    assert.match(mounted.text(), /Uploaded/)
    assert.equal(mounted.el.querySelector('[role="progressbar"]'), null)
    assert.equal(mounted.calls.some(call => call.path.includes('/refresh')), false)
    mounted.destroy()
  })

  test('an unreadable allowance ledger leaves preview available but blocks upload', async () => {
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview: PREVIEWED, quotaUnavailableReason: 'ledger_unreadable' })
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined)
    assert.match(mounted.text(), /Uploads and other provider writes are paused until the local allowance record is repaired/)
    assert.equal(mounted.calls.some(c => c.path.endsWith('/youtube/upload')), false)
    mounted.destroy()
  })

  test('an accepted episode with no rendered video is listed but cannot be previewed', async () => {
    const mounted = await mount({ episodes: [{ ...NEVER_UPLOADED, has_video: false }] })
    assert.match(mounted.text(), /EP0001/)
    assert.match(mounted.text(), /No rendered video yet/)
    assert.equal(
      [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details'),
      undefined,
      'nothing to preview, so nothing offering to',
    )
    mounted.destroy()
  })

  test('an episode already on YouTube gets its record, never a second upload', async () => {
    // The state the route refuses with 409. The page must not invite it.
    const mounted = await mount({ operations: [READY_OP], preview: PREVIEWED })
    assert.match(mounted.text(), /vid-1/)
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'no Upload button for a video that already exists')
    mounted.destroy()
  })

  test('declining the confirm posts nothing at all', async () => {
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview: PREVIEWED, confirmAnswer: false })
    const upload = await previewThen(mounted)
    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()

    assert.equal(mounted.confirms.length, 1, 'it did ask')
    assert.equal(mounted.calls.find(c => c.path.endsWith('/youtube/upload')), undefined,
      'and it took no for an answer')
    mounted.destroy()
  })

  test('thumbnail choice is locked while upload confirmation is unresolved', async () => {
    let resolveConfirm!: (value: boolean) => void
    const confirm = new Promise<boolean>(resolve => { resolveConfirm = resolve })
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      preview: {
        ...PREVIEWED,
        thumbnail: {
          state: 'selected', filename: 'EP0001_Thumb01_v2.png', url: '/api/v2.png',
          options: [
            { filename: 'EP0001_Thumb01_v2.png', url: '/api/v2.png' },
            { filename: 'EP0001_Thumb01_v1.png', url: '/api/v1.png' },
          ],
        },
      },
      confirmOverride: async () => confirm,
    })
    const upload = await previewThen(mounted)
    upload.click()
    await nextTick()
    const choices = [...mounted.el.querySelectorAll<HTMLButtonElement>('.thumbnail-option')]
    assert.equal(choices.every(button => button.disabled), true)
    resolveConfirm(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    for (let i = 0; i < 4; i++) await nextTick()
    assert.equal(
      [...mounted.el.querySelectorAll<HTMLButtonElement>('.thumbnail-option')].every(button => !button.disabled),
      true,
    )
    mounted.destroy()
  })

  test('a refused upload shows the reason the route gave, not the status line', async () => {
    // Pins blocker 6 at the page level. `error.message` on a $fetch rejection is
    // "409 Conflict" - true, and useless. The reason lives in `error.data.detail`.
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      preview: PREVIEWED,
      uploadError: Object.assign(new Error('409 Conflict'), {
        data: { code: 'YOUTUBE_UPLOAD_ALREADY_IN_FLIGHT', detail: 'EP0001 is already uploading on this channel.' },
      }),
    })
    const upload = await previewThen(mounted)
    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()

    assert.match(mounted.text(), /EP0001 is already uploading on this channel\./)
    assert.doesNotMatch(mounted.text(), /409 Conflict/)
    mounted.destroy()
  })

  test('an exhausted UPLOAD allowance blocks Upload, even with checking allowance to spare', async () => {
    // The two buckets are different sizes and are spent separately. Gating
    // Upload on `other_endpoints` meant the page offered an upload the route
    // was about to refuse. This fixture has plenty of the checking bucket and
    // none of the uploading one, so it can only pass if the page reads the
    // right one.
    const mounted = await mount({
      episodes: [NEVER_UPLOADED], preview: PREVIEWED,
      quotaRemaining: 5000, uploadQuotaRemaining: 0,
    })
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'no Upload button')
    assert.match(mounted.text(), /upload allowance for this Google Cloud project is used up/)
    mounted.destroy()
  })

  test('an episode published by an older Story Studio shows its video and offers no upload', async () => {
    // The legacy-sidecar row. The server reports it as already on YouTube and
    // supplies the sentence; the page must render that rather than deciding
    // for itself from the (absent) operation record.
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0007', title: 'An Older Episode', has_video: true,
        has_remote_video: true, remote_video_id: 'legacy-video-77', remote_source: 'legacy_sidecar',
        blocked_reason: 'EP0007 is already on YouTube as legacy-video-77, published before this version of Story Studio.',
      }],
      preview: PREVIEWED,
    })
    assert.match(mounted.text(), /legacy-video-77/)
    assert.match(mounted.text(), /Uploaded/)

    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'never offered a second upload of a video that exists')
    assert.match(mounted.text(), /published before this version of Story Studio/)
    mounted.destroy()
  })

  test('the filter finds an episode without ever changing the count', async () => {
    // The filter box shipped with no tests at all. It exists because the list
    // is uncapped — a 50-cap made 800 episodes unreachable — so the one thing
    // it must never do is behave like a cap.
    const many = Array.from({ length: 14 }, (_, i) => ({
      episode_code: `EP00${String(i + 1).padStart(2, '0')}`,
      title: i === 3 ? 'The Lighthouse at Dawn' : `Episode ${i + 1}`,
      has_video: true,
    }))
    const mounted = await mount({ episodes: many, total: 14, preview: PREVIEWED })
    assert.match(mounted.text(), /14 episodes/)

    const box = mounted.el.querySelector('input[type="search"]') as HTMLInputElement
    assert.ok(box, 'the filter appears once there are enough episodes to need it')
    box.value = 'Lighthouse'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()

    assert.match(mounted.text(), /EP0004/)
    assert.doesNotMatch(mounted.text(), /EP0001\b/)
    assert.match(mounted.text(), /14 episodes/, 'the total still names every episode, not the matches')
    mounted.destroy()
  })

  test('separates local video, upload, and publication facts and formats the channel timezone', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0042', title: 'The River at Midnight', has_video: true,
        local: {
          render: { state: 'ready', video_url: '/api/projects/demo-project/episodes/EP0042/final-video' },
          upload: { state: 'succeeded', job_id: 'job-42' },
        },
        publication: {
          state: 'scheduled', visibility: 'private', scheduled_at: '2026-09-12T02:00:00.000Z',
          last_checked_at: '2026-09-08T01:00:00.000Z',
        },
        plan: { scheduled_at: '2026-09-12T02:00:00.000Z', timezone: 'Asia/Phnom_Penh' },
      }],
      total: 1,
    })

    const text = mounted.text()
    assert.match(text, /Local video/)
    assert.match(text, /Ready/)
    assert.match(text, /Upload/)
    assert.match(text, /Uploaded/)
    assert.match(text, /Publication/)
    assert.match(text, /Scheduled/)
    assert.match(text, /Asia\/Phnom_Penh/)
    const play = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Play local video')!
    play.click()
    await nextTick()
    assert.equal(mounted.el.querySelector('video')?.getAttribute('src'), '/api/projects/demo-project/episodes/EP0042/final-video')
    mounted.destroy()
  })

  test('labels device time when no valid plan timezone is available', async () => {
    const mounted = await mount({
      episodes: [
        { episode_code: 'EP0043', title: 'No zone', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'none' } }, publication: { state: 'unpublished' }, plan: { scheduled_at: '2026-09-12T02:00:00.000Z' } },
        { episode_code: 'EP0042', title: 'Bad zone', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'none' } }, publication: { state: 'unpublished' }, plan: { scheduled_at: '2026-09-12T02:00:00.000Z', timezone: 'Mars/Base' } },
      ],
    })
    assert.match(mounted.text(), /Device time/)
    assert.match(mounted.text(), /plan timezone unavailable/)
    assert.doesNotMatch(mounted.text(), /· Mars\/Base/)
    const planned = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim().startsWith('Planned'))!
    const scheduled = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim().startsWith('Scheduled'))!
    assert.match(planned.textContent || '', /2/)
    assert.match(scheduled.textContent || '', /0/, 'a local plan is not presented as confirmed on YouTube')
    mounted.destroy()
  })

  test('filters by operational state with honest counts and sorts oldest first', async () => {
    const mounted = await mount({
      total: 5,
      episodes: [
        { episode_code: 'EP0005', title: 'Private on YouTube', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'succeeded' } }, publication: { state: 'uploaded', visibility: 'private' } },
        { episode_code: 'EP0004', title: 'Failed', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'failed', reason: 'Connection lost' } }, publication: { state: 'failed', reason: 'Connection lost' } },
        { episode_code: 'EP0003', title: 'Published', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'succeeded' } }, publication: { state: 'published', published_at: '2026-09-07T00:00:00.000Z' } },
        { episode_code: 'EP0002', title: 'Ready', has_video: true, local: { render: { state: 'ready' }, upload: { state: 'none' } }, publication: { state: 'unpublished' } },
        { episode_code: 'EP0001', title: 'Missing', has_video: false, local: { render: { state: 'missing' }, upload: { state: 'none' } }, publication: { state: 'unpublished' } },
      ],
    })

    const ready = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Ready to upload'))!
    assert.match(ready.textContent || '', /2/)
    const uploaded = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim().startsWith('Uploaded'))!
    assert.match(uploaded.textContent || '', /1/)
    const progress = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('In progress'))!
    assert.match(progress.textContent || '', /0/, 'a completed private upload is not permanently in progress')
    ready.click()
    await nextTick()
    assert.match(mounted.text(), /EP0002/)
    assert.match(mounted.text(), /EP0004/, 'a failed upload before acceptance remains retryable')
    assert.doesNotMatch(mounted.text(), /EP0001\b/)

    const all = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('All'))!
    all.click()
    const sort = mounted.el.querySelector('select[aria-label="Sort episodes"]') as HTMLSelectElement
    sort.value = 'episode_oldest'
    sort.dispatchEvent(new Event('change'))
    await nextTick()
    const rows = [...mounted.el.querySelectorAll('[data-episode-code]')]
    assert.equal(rows[0]?.getAttribute('data-episode-code'), 'EP0001')
    mounted.destroy()
  })

  test('selects only visible episodes that are ready for this connected channel', async () => {
    const mounted = await mount({
      episodes: [
        { ...NEVER_UPLOADED, episode_code: 'EP0003', title: 'Visible and ready' },
        { ...NEVER_UPLOADED, episode_code: 'EP0002', title: 'Also ready' },
        { episode_code: 'EP0001', title: 'Missing render', has_video: false, local: { render: { state: 'missing' }, upload: { state: 'none' } }, publication: { state: 'unpublished' } },
      ],
      preview: PREVIEWED,
    })
    const search = mounted.el.querySelector<HTMLInputElement>('input[aria-label="Filter episodes by code or title"]')!
    search.value = 'EP0003'
    search.dispatchEvent(new Event('input'))
    await nextTick()

    const selectVisible = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Select visible eligible'))!
    assert.match(selectVisible.textContent || '', /\(1\)/)
    selectVisible.click()
    await nextTick()

    assert.equal(mounted.el.querySelectorAll<HTMLInputElement>('.episode-select input:checked').length, 1)
    assert.match(
      [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
        .find(button => button.textContent!.includes('Review selected uploads'))?.textContent || '',
      /\(1\)/,
    )
    mounted.destroy()
  })

  test('bulk review shows exact files thumbnails metadata channel and timing, then queues each reviewed fence once', async () => {
    const plannedAt = '2099-10-11T02:30:00.000Z'
    const mounted = await mount({
      episodes: [
        { ...NEVER_UPLOADED, episode_code: 'EP0002', title: 'Private upload' },
        { ...NEVER_UPLOADED, episode_code: 'EP0001', title: 'Planned upload', plan: { scheduled_at: plannedAt, timezone: 'Asia/Phnom_Penh' } },
      ],
      previewOverride: (body) => ({
        ...PREVIEWED,
        package_revision: `package-${body.episode_code}`,
        source: { filename: `${body.episode_code}_final_video.mp4`, revision: `source-${body.episode_code}` },
        snippet: {
          ...PREVIEWED.snippet,
          title: `YouTube title ${body.episode_code}`,
          description: `Exact description for ${body.episode_code}`,
          tags: [`tag-${body.episode_code}`, 'shared-tag'],
        },
        status: { ...PREVIEWED.status, ...(body.publish_at ? { publishAt: body.publish_at } : {}) },
        thumbnail: {
          state: 'selected', filename: `${body.episode_code}_Thumb01.png`, url: `/api/${body.episode_code}.png`,
          options: [{ filename: `${body.episode_code}_Thumb01.png`, url: `/api/${body.episode_code}.png` }],
        },
      }),
    })
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Select visible eligible'))!.click()
    await nextTick()
    const review = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Review selected uploads'))!
    review.focus()
    review.click()
    for (let i = 0; i < 10; i++) await nextTick()

    const dialog = mounted.el.querySelector('[aria-labelledby="bulk-upload-review-title"]')!
    assert.equal(document.activeElement?.id, 'bulk-upload-review-title', 'keyboard focus moves into the bulk review')
    assert.match(dialog.textContent || '', /EP0001_final_video\.mp4/)
    assert.match(dialog.textContent || '', /EP0002_Thumb01\.png/)
    assert.match(dialog.textContent || '', /YouTube title EP0001/)
    assert.match(dialog.textContent || '', /Ch · UC-x/)
    assert.match(dialog.textContent || '', new RegExp(plannedAt.replaceAll('.', '\\.')))
    assert.match(dialog.textContent || '', /Asia\/Phnom_Penh/)
    assert.match(dialog.textContent || '', /Keep private/)
    assert.doesNotMatch(dialog.textContent || '', /Reviewed version|package-EP0001/)

    const metadataReview = [...dialog.querySelectorAll<HTMLDetailsElement>('details')]
      .find(details => details.querySelector('summary')?.textContent?.includes('Review metadata'))!
    metadataReview.open = true
    metadataReview.dispatchEvent(new Event('toggle'))
    await nextTick()
    assert.match(metadataReview.textContent || '', /Exact description for EP0001/)
    assert.match(metadataReview.textContent || '', /tag-EP0001, shared-tag/)

    const thumbnails = [...dialog.querySelectorAll<HTMLImageElement>('.bulk-thumbnail img')]
    assert.equal(thumbnails.length, 2)
    thumbnails.forEach(image => image.dispatchEvent(new Event('load')))
    await nextTick()

    const queue = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Queue reviewed uploads'))!
    assert.match(queue.textContent || '', /\(2\)/)
    queue.click()
    for (let i = 0; i < 14; i++) await nextTick()

    const uploads = mounted.calls.filter(call => call.path.endsWith('/youtube/upload'))
    assert.deepEqual(uploads.map(call => call.body), [
      {
        episode_code: 'EP0001', confirm: true, expected_channel_id: 'UC-x',
        expected_package_revision: 'package-EP0001', expected_source_revision: 'source-EP0001',
        thumbnail_filename: 'EP0001_Thumb01.png', privacy_status: 'private', publish_at: plannedAt,
      },
      {
        episode_code: 'EP0002', confirm: true, expected_channel_id: 'UC-x',
        expected_package_revision: 'package-EP0002', expected_source_revision: 'source-EP0002',
        thumbnail_filename: 'EP0002_Thumb01.png', privacy_status: 'private',
      },
    ])
    assert.equal(mounted.confirms.length, 0, 'the exact bulk review has one explicit queue action, not a second generic dialog')
    assert.match(dialog.textContent || '', /Queued/)
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.trim() === 'Close')!.click()
    await nextTick()
    assert.equal(document.activeElement?.id, 'upload-list-title', 'closing after queue returns focus to the stable upload list heading')
    mounted.destroy()
  })

  test('a broken thumbnail preview keeps that bulk row out of the upload queue', async () => {
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      preview: {
        ...PREVIEWED,
        thumbnail: {
          state: 'selected', filename: 'EP0001_Thumb01.png', url: '/api/broken-thumbnail.png',
          options: [{ filename: 'EP0001_Thumb01.png', url: '/api/broken-thumbnail.png' }],
        },
      },
    })
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Select visible eligible'))!.click()
    await nextTick()
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Review selected uploads'))!.click()
    for (let i = 0; i < 10; i++) await nextTick()

    const dialog = mounted.el.querySelector('[aria-labelledby="bulk-upload-review-title"]')!
    dialog.querySelector<HTMLImageElement>('.bulk-thumbnail img')!.dispatchEvent(new Event('error'))
    await nextTick()

    assert.match(dialog.textContent || '', /Needs attention/)
    assert.match(dialog.textContent || '', /thumbnail is selected, but its preview is unavailable/i)
    const queue = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Queue reviewed uploads'))!
    assert.match(queue.textContent || '', /\(0\)/)
    assert.equal(queue.disabled, true)
    assert.equal(mounted.calls.filter(call => call.path.endsWith('/youtube/upload')).length, 0)
    mounted.destroy()
  })

  test('bulk preview and queue failures stay on their own rows and never retry automatically', async () => {
    let uploadAttempts = 0
    const mounted = await mount({
      episodes: [
        { ...NEVER_UPLOADED, episode_code: 'EP0002', title: 'Preview refusal' },
        { ...NEVER_UPLOADED, episode_code: 'EP0001', title: 'Queue refusal' },
      ],
      previewFailAfter: 1,
      preview: PREVIEWED,
      postOverride: (path) => {
        if (path.endsWith('/youtube/upload')) {
          uploadAttempts += 1
          throw Object.assign(new Error('file changed after review'), { data: { detail: 'The rendered video changed after review.' } })
        }
      },
    })
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Select visible eligible'))!.click()
    await nextTick()
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Review selected uploads'))!.click()
    for (let i = 0; i < 10; i++) await nextTick()
    assert.match(mounted.text(), /preview exploded/)

    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Queue reviewed uploads'))!.click()
    for (let i = 0; i < 10; i++) await nextTick()
    assert.equal(uploadAttempts, 1)
    assert.match(mounted.text(), /rendered video changed after review/)
    mounted.destroy()
  })

  test('stop queueing finishes the current request and leaves later reviewed rows ready to continue', async () => {
    let uploadAttempts = 0
    let finishFirstUpload!: (value: { job_id: string; channel_id: string }) => void
    const firstUpload = new Promise<{ job_id: string; channel_id: string }>((resolve) => { finishFirstUpload = resolve })
    const mounted = await mount({
      episodes: [
        { ...NEVER_UPLOADED, episode_code: 'EP0002', title: 'Second reviewed upload' },
        { ...NEVER_UPLOADED, episode_code: 'EP0001', title: 'First reviewed upload' },
      ],
      preview: PREVIEWED,
      postOverride: (path) => {
        if (!path.endsWith('/youtube/upload')) return undefined
        uploadAttempts += 1
        return uploadAttempts === 1 ? firstUpload : { job_id: `job-${uploadAttempts}`, channel_id: 'UC-x' }
      },
    })
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Select visible eligible'))!.click()
    await nextTick()
    ;[...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Review selected uploads'))!.click()
    for (let i = 0; i < 10; i++) await nextTick()

    const dialog = mounted.el.querySelector('[aria-labelledby="bulk-upload-review-title"]')!
    ;[...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Queue reviewed uploads'))!.click()
    await nextTick()
    const stop = [...dialog.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.trim() === 'Stop queueing')!
    assert.equal(stop.disabled, false)
    stop.click()
    await nextTick()
    assert.match(dialog.textContent || '', /Stopping after current/)

    finishFirstUpload({ job_id: 'job-1', channel_id: 'UC-x' })
    for (let i = 0; i < 12; i++) await nextTick()

    assert.equal(uploadAttempts, 1, 'stopping does not start the next reviewed admission')
    assert.match(dialog.textContent || '', /Already queued uploads continue/)
    assert.match(dialog.textContent || '', /Queue reviewed uploads \(1\)/)
    assert.equal([...dialog.querySelectorAll('.state-text')].filter(node => node.textContent?.trim() === 'Queued').length, 1)
    assert.equal([...dialog.querySelectorAll('.state-text')].filter(node => node.textContent?.trim() === 'Reviewed').length, 1)
    mounted.destroy()
  })

  test('opens YouTube metadata review in a focused dialog and keeps preview errors on the episode row', async () => {
    const mounted = await mount({
      episodes: [NEVER_UPLOADED],
      preview: PREVIEWED,
    })
    const review = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details')!
    review.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const dialog = mounted.el.querySelector('[role="dialog"]')!
    assert.ok(dialog)
    assert.match(dialog.textContent || '', /What YouTube will receive/)
    assert.equal((document.activeElement as HTMLElement)?.id, 'upload-review-title')
    const close = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Close') as HTMLButtonElement
    close.click()
    for (let i = 0; i < 3; i++) await nextTick()
    assert.equal(document.activeElement, review, 'closing review restores its episode trigger')
    mounted.destroy()

    const failed = await mount({ episodes: [NEVER_UPLOADED], previewFailAfter: 0 })
    const failedReview = [...failed.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details')!
    failedReview.click()
    for (let i = 0; i < 6; i++) await nextTick()
    const row = failed.el.querySelector('[data-episode-code="EP0001"]')!
    assert.match(row.textContent || '', /preview exploded/)
    assert.equal(failed.el.querySelector('[role="dialog"]'), null)
    failed.destroy()
  })

  test('a missing local video links to Video Assembly for that exact episode', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0081', title: 'Needs a render', has_video: false,
        local: { render: { state: 'missing' }, upload: { state: 'none' } },
        publication: { state: 'unpublished' },
      }],
    })
    const link = [...mounted.el.querySelectorAll('a')].find(a => a.textContent!.trim() === 'Open Video Assembly')!
    assert.equal(link.getAttribute('href'), '/projects/demo-project/video-assembly?episode_id=EP0081')
    assert.equal([...mounted.el.querySelectorAll('button')].some(button => button.textContent!.includes('Play local video')), false)
    mounted.destroy()
  })

  test('a late response from the previous project cannot replace the current episode list', async () => {
    let resolveOldEpisodes!: (value: any) => void
    let resolveOldOverview!: (value: any) => void
    const oldEpisodes = new Promise(resolve => { resolveOldEpisodes = resolve })
    const oldOverview = new Promise(resolve => { resolveOldOverview = resolve })
    const mounted = await mount({
      initialSlug: 'old-project',
      getOverride: (path) => {
        if (path.includes('/old-project/') && path.endsWith('/publishable')) return oldEpisodes
        if (path.includes('/old-project/') && path.endsWith('/overview')) return oldOverview
        if (path.includes('/new-project/') && path.endsWith('/publishable')) return {
          episodes: [{ episode_code: 'EP0099', title: 'Current Project', has_video: true }], total: 1,
        }
        if (path.includes('/new-project/') && path.endsWith('/overview')) return {
          assigned_channel: { channel_id: 'UC-new', title: 'New', status: 'connected' },
          quota: { buckets: { other_endpoints: { remaining: 10 }, video_uploads: { remaining: 1 } } },
        }
        throw new Error(`unexpected GET ${path}`)
      },
    })

    await mounted.setSlug('new-project')
    for (let i = 0; i < 4; i++) await nextTick()
    assert.match(mounted.text(), /Current Project/)

    resolveOldEpisodes({ episodes: [{ episode_code: 'EP0001', title: 'Old Project', has_video: true }], total: 1 })
    resolveOldOverview({ assigned_channel: null, quota: { buckets: {} } })
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /Current Project/)
    assert.doesNotMatch(mounted.text(), /Old Project/)
    mounted.destroy()
  })

  test('project navigation removes old rows while the new project is still loading', async () => {
    let resolveNewEpisodes!: (value: any) => void
    let resolveNewOverview!: (value: any) => void
    const newEpisodes = new Promise(resolve => { resolveNewEpisodes = resolve })
    const newOverview = new Promise(resolve => { resolveNewOverview = resolve })
    const mounted = await mount({
      initialSlug: 'old-project',
      getOverride: (path) => {
        if (path.includes('/old-project/') && path.endsWith('/publishable')) return {
          episodes: [{ episode_code: 'EP0001', title: 'Old Project', has_video: true }], total: 1,
        }
        if (path.includes('/old-project/') && path.endsWith('/overview')) return {
          assigned_channel: { channel_id: 'UC-old', title: 'Old', status: 'connected' }, quota: { buckets: {} },
        }
        if (path.includes('/new-project/') && path.endsWith('/publishable')) return newEpisodes
        if (path.includes('/new-project/') && path.endsWith('/overview')) return newOverview
        throw new Error(`unexpected GET ${path}`)
      },
    })
    assert.match(mounted.text(), /Old Project/)
    await mounted.setSlug('new-project')
    assert.doesNotMatch(mounted.text(), /Old Project/)
    assert.match(mounted.text(), /Loading this project’s uploads/)

    resolveNewEpisodes({ episodes: [{ episode_code: 'EP0002', title: 'New Project', has_video: true }], total: 1 })
    resolveNewOverview({ assigned_channel: null, quota: { buckets: {} } })
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /New Project/)
    mounted.destroy()
  })

  test('a late metadata review from the previous project cannot open on the current project', async () => {
    let resolvePreview!: (value: any) => void
    const preview = new Promise(resolve => { resolvePreview = resolve })
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview, initialSlug: 'old-project' })
    const review = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Review upload details')!
    review.click()
    await nextTick()
    await mounted.setSlug('new-project')
    resolvePreview(PREVIEWED)
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.el.querySelector('[role="dialog"]'), null)
    assert.doesNotMatch(mounted.text(), /What YouTube will receive/)
    mounted.destroy()
  })

  test('changing projects while upload confirmation is open cannot submit under the new project', async () => {
    let resolveConfirm!: (value: boolean) => void
    const confirm = new Promise<boolean>(resolve => { resolveConfirm = resolve })
    const mounted = await mount({
      episodes: [NEVER_UPLOADED], preview: PREVIEWED, initialSlug: 'old-project',
      confirmOverride: async () => confirm,
    })
    const upload = await previewThen(mounted)
    upload.click()
    await nextTick()
    await mounted.setSlug('new-project')
    resolveConfirm(true)
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.some(call => call.path.endsWith('/youtube/upload')), false)
    mounted.destroy()
  })

  test('a broken YouTube overview does not hide local video inventory', async () => {
    const mounted = await mount({
      getOverride: (path) => {
        if (path.endsWith('/publishable')) return {
          episodes: [{ episode_code: 'EP0044', title: 'Local work survives', has_video: true, local: { render: { state: 'ready', video_url: '/api/local.mp4' }, upload: { state: 'none' } }, publication: { state: 'unpublished' } }],
          total: 1,
        }
        if (path.endsWith('/overview')) throw new Error('Publishing analytics is unreadable')
        throw new Error(`unexpected GET ${path}`)
      },
    })
    assert.match(mounted.text(), /Local work survives/)
    assert.match(mounted.text(), /Publishing analytics is unreadable/)
    const review = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Review upload details')!
    assert.equal(review.disabled, false, 'local metadata review stays available')
    mounted.destroy()
  })

  test('a failed local inventory load has an in-place retry', async () => {
    let attempts = 0
    const mounted = await mount({
      getOverride: (path) => {
        if (path.endsWith('/publishable')) {
          attempts += 1
          if (attempts === 1) throw new Error('Local inventory is temporarily unavailable')
          return { episodes: [NEVER_UPLOADED], total: 1 }
        }
        if (path.endsWith('/overview')) return {
          assigned_channel: { channel_id: 'UC-x', title: 'Ch', status: 'connected' }, quota: { buckets: {} },
        }
        throw new Error(`unexpected GET ${path}`)
      },
    })
    assert.match(mounted.text(), /Local inventory is temporarily unavailable/)
    const retry = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Retry loading')!
    retry.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /The Lighthouse at Dawn/)
    mounted.destroy()
  })

  test('video playback errors stay in the player and offer the same episode in Video Assembly', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0042', title: 'Playback problem', has_video: true,
        local: { render: { state: 'ready', video_url: '/api/local.mp4' }, upload: { state: 'none' } },
        publication: { state: 'unpublished' },
      }],
    })
    const play = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Play local video')!
    play.click()
    await nextTick()
    mounted.el.querySelector('video')!.dispatchEvent(new Event('error'))
    await nextTick()
    const dialog = mounted.el.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent || '', /could not play this local video/)
    assert.equal(dialog.querySelector('a')?.getAttribute('href'), '/projects/demo-project/video-assembly?episode_id=EP0042')
    mounted.destroy()
  })

  test('search stays available on a short list, and a no-match filter keeps the total visible', async () => {
    const few = await mount({ episodes: [NEVER_UPLOADED], total: 1 })
    assert.ok(few.el.querySelector('input[type="search"]'), 'the operational toolbar stays in one predictable place')
    few.destroy()

    const many = Array.from({ length: 14 }, (_, i) => ({
      episode_code: `EP00${String(i + 1).padStart(2, '0')}`, title: `Episode ${i + 1}`, has_video: true,
    }))
    const mounted = await mount({ episodes: many, total: 14 })
    const box = mounted.el.querySelector('input[type="search"]') as HTMLInputElement
    box.value = 'nothing matches this'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()
    assert.match(mounted.text(), /No episodes match these filters/)
    assert.match(mounted.text(), /14 episodes/)
    mounted.destroy()
  })

  test('a row whose record could not be read shows the reason and offers no upload', async () => {
    // B-5. `/publishable` catches a per-row read failure and returns the refusal
    // as `blocked_reason` with `has_remote_video` absent — so the page must
    // render that string. Before this the row fell through to "Not uploaded
    // yet", which is an invitation to upload an episode we cannot vouch for.
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0007', title: 'An Unreadable Episode', has_video: true,
        has_remote_video: false,
        blocked_reason: 'Story Studio cannot read its upload record for EP0007, so it cannot tell whether the episode is already on YouTube.',
      }],
      preview: PREVIEWED,
    })
    assert.match(mounted.text(), /cannot read its upload record for EP0007/)
    assert.doesNotMatch(mounted.text(), /Not uploaded yet/)

    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'no Upload button for a record we could not read')
    mounted.destroy()
  })

  test('review stays available but another upload is withheld while local ownership is active or unknown', async () => {
    for (const [state, reason] of [
      ['running', /already uploading/],
      ['unknown', /cannot verify .* local upload state/],
    ] as const) {
      const mounted = await mount({
        episodes: [{
          episode_code: 'EP0021', title: 'Upload in doubt', has_video: true,
          local: { render: { state: 'ready' }, upload: { state } },
          publication: { state: 'unpublished' },
        }],
        preview: {
          ...PREVIEWED,
          thumbnail: {
            state: 'selected', filename: 'EP0021_Thumb01_v1.png', url: '/api/current.png',
            options: [
              { filename: 'EP0021_Thumb01_v1.png', url: '/api/current.png' },
              { filename: 'EP0021_Thumb02_v1.png', url: '/api/other.png' },
            ],
          },
        },
      })
      const upload = await previewThen(mounted)
      assert.equal(upload, undefined)
      assert.match(mounted.text(), reason)
      assert.match(mounted.text(), /Current local thumbnail/)
      assert.match(mounted.text(), /does not change the upload already queued or on YouTube/)
      assert.equal(
        [...mounted.el.querySelectorAll<HTMLButtonElement>('.thumbnail-option')].every(button => button.disabled),
        true,
      )
      mounted.el.querySelector('img')!.dispatchEvent(new Event('error'))
      await nextTick()
      assert.match(mounted.text(), reason, 'the active upload reason stays authoritative if the local preview fails')
      assert.doesNotMatch(mounted.text(), /Choose an available thumbnail before uploading/)
      mounted.destroy()
    }
  })

  test('a failed upload before acceptance can be submitted again after review', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0022', title: 'Publication failed', has_video: true,
        local: { render: { state: 'ready' }, upload: { state: 'failed' } },
        publication: { state: 'failed' },
      }],
      preview: PREVIEWED,
    })
    assert.match(
      [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Ready to upload'))?.textContent || '',
      /1/,
    )
    assert.match(
      [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Needs attention'))?.textContent || '',
      /1/,
    )
    const upload = await previewThen(mounted)
    assert.ok(upload)
    mounted.destroy()
  })

  test('a failed publication with remote identity is held for status refresh', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0023', title: 'Remote failure', has_video: true, has_remote_video: true, remote_video_id: 'video-23',
        local: { render: { state: 'ready' }, upload: { state: 'failed' } },
        publication: { state: 'failed' },
      }],
      preview: PREVIEWED,
    })
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined)
    assert.match(mounted.text(), /failed YouTube record for video-23/)
    assert.doesNotMatch(mounted.text(), /already on YouTube \(failed\)/)
    mounted.destroy()
  })

  test('a project whose channel is not connected gets the reason, never the button', async () => {
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview: PREVIEWED, channelStatus: null })
    assert.match(mounted.text(), /No YouTube channel assigned/)
    assert.match(mounted.text(), /ready locally/)
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'no button to press')
    assert.match(mounted.text(), /no assigned YouTube channel/)
    const ready = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('Ready to upload'))!
    assert.match(ready.textContent || '', /0/, 'local readiness alone is not readiness for a missing channel')
    assert.ok([...mounted.el.querySelectorAll<HTMLAnchorElement>('a')]
      .some(link => link.textContent!.includes('Assign channel') && link.href.includes('/settings#youtube')))
    mounted.destroy()
  })

  test('removing a deleted operation association is explicit, fenced, and never claims to delete on YouTube', async () => {
    const mounted = await mount({
      operations: [READY_OP],
      postOverride: (path) => path.endsWith('/forget-upload')
        ? { episode_code: 'EP0001', video_id: 'vid-1', association_removed: true }
        : undefined,
    })
    const forget = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('I deleted this video on YouTube'))!
    forget.click()
    for (let i = 0; i < 8; i++) await nextTick()

    assert.match(mounted.confirms[0].message, /only after you deleted vid-1 on YouTube and verified it is gone/i)
    assert.match(mounted.confirms[0].message, /will not check or delete anything on YouTube/i)
    const call = mounted.calls.find(entry => entry.path.endsWith('/youtube/episodes/EP0001/forget-upload'))!
    assert.deepEqual(call.body, {
      confirm: true,
      expected_channel_id: 'UC-x',
      expected_video_id: 'vid-1',
    })
    assert.match(mounted.text(), /YouTube was not changed/)
    mounted.destroy()
  })

  test('a legacy remote id can reach the same exact association-removal boundary', async () => {
    const mounted = await mount({
      episodes: [{
        episode_code: 'EP0007', title: 'Legacy upload', has_video: true,
        has_remote_video: true, remote_video_id: 'legacy-video-77', remote_source: 'legacy_sidecar',
        blocked_reason: 'EP0007 is already on YouTube as legacy-video-77.',
      }],
      postOverride: (path) => path.endsWith('/forget-upload')
        ? { episode_code: 'EP0007', video_id: 'legacy-video-77', association_removed: true }
        : undefined,
    })
    const forget = [...mounted.el.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent!.includes('I deleted this video on YouTube'))!
    assert.ok(forget)
    forget.click()
    for (let i = 0; i < 8; i++) await nextTick()
    assert.deepEqual(
      mounted.calls.find(entry => entry.path.endsWith('/youtube/episodes/EP0007/forget-upload'))?.body,
      { confirm: true, expected_channel_id: 'UC-x', expected_video_id: 'legacy-video-77' },
    )
    mounted.destroy()
  })

  test('a failed preview does not leave the previous episode’s payload on screen', async () => {
    const mounted = await mount({
      operations: [READY_OP],
      previewFailAfter: 1,
      preview: {
        snippet: { title: 'First Episode Title', description: 'd', tags: [], categoryId: '24' },
        status: { privacyStatus: 'private', containsSyntheticMedia: true },
        modifications: [], warnings: [],
      },
    })
    const previewButton = () => [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review upload details')!
    previewButton().click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /First Episode Title/)

    // The second request fails. The old payload must go, or the reader
    // believes they are looking at the episode they just asked about.
    previewButton().click()
    for (let i = 0; i < 6; i++) await nextTick()

    assert.doesNotMatch(mounted.text(), /First Episode Title/)
    assert.match(mounted.text(), /preview exploded/)
    mounted.destroy()
  })

  test('remote checks are disabled, with a reason, when the channel needs reconnecting', async () => {
    const mounted = await mount({ operations: [READY_OP], channelStatus: 'reconnect_required' })
    const check = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Check on YouTube'))!
    assert.equal(check.disabled, true)
    assert.match(mounted.text(), /Reconnect this channel in Settings/)
    // Local records stay readable — losing YouTube costs freshness, not access.
    assert.match(mounted.text(), /EP0001/)
    mounted.destroy()
  })

  test('remote checks are disabled when today’s allowance is used up', async () => {
    const mounted = await mount({ operations: [READY_OP], quotaRemaining: 0 })
    const check = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Check on YouTube'))!
    assert.equal(check.disabled, true)
    assert.match(mounted.text(), /allowance for this Google Cloud project is used up/)
    mounted.destroy()
  })

  test('a healthy channel with allowance left can check', async () => {
    const mounted = await mount({ operations: [READY_OP] })
    const check = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Check on YouTube'))!
    assert.equal(check.disabled, false)
    mounted.destroy()
  })

  test('an empty project says what makes an episode appear, not just that nothing is here', async () => {
    // The copy used to be "Nothing uploaded yet", which was true and useless:
    // the rows are episodes now, so the reason a project is empty is that no
    // episode is finished — and the page says which two things finish one.
    const mounted = await mount({ episodes: [] })
    assert.match(mounted.text(), /Nothing ready to publish yet/)
    assert.match(mounted.text(), /accepted/)
    assert.match(mounted.text(), /Video Assembly/)
    mounted.destroy()
  })
})

describe('Upload Center Publish boundaries', () => {
  test('links every planning entry point to the actual plan editor', () => {
    const shell = readFileSync(new URL('../pages/projects/[slug]/upload.vue', import.meta.url), 'utf8')
    const settings = readFileSync(new URL('../pages/projects/[slug]/settings.vue', import.meta.url), 'utf8')
    assert.match(shell, /upload\/plans/)
    assert.match(settings, /upload\/plans/)
    assert.match(source, /upload\/plans`[\s\S]*Manage upload plans/)
    assert.doesNotMatch(source, /Create or activate one in Settings/)
  })
  test('the only path to another upload is the confirmed exact-video association removal', () => {
    assert.match(source, /\/youtube\/episodes\/\$\{encodeURIComponent\(ep\.episode_code\)\}\/forget-upload/)
    assert.match(source, /confirm: true[\s\S]*expected_channel_id: expectedChannelId[\s\S]*expected_video_id: expectedVideoId/)
    assert.doesNotMatch(source, /retryUpload|uploadAgain/i)
  })

  test('has no retired automatic-upload control or qualification request', () => {
    assert.doesNotMatch(source, /automatic_upload|publishing-state|manual_upload_qualified|upload_plans/)
  })

  test('does not touch upload mode or auto-slot semantics', () => {
    assert.doesNotMatch(source, /upload_mode|auto_schedule_on_render/)
  })

  test('never renders a token, secret, or session url', () => {
    assert.doesNotMatch(source, /access_token|refresh_token|client_secret|session_url/)
  })
})


test('Jobs deep links reveal the requested upload episode without starting work', async () => {
  const mounted = await mount({ initialEpisode: 'EP0002', episodes: [
    { episode_code: 'EP0001', title: 'First', has_video: true },
    { episode_code: 'EP0002', title: 'Second', has_video: true },
  ] })
  try {
    assert.match(mounted.text(), /EP0002/)
    assert.doesNotMatch(mounted.text(), /EP0001/)
    await mounted.setEpisode('EP0001')
    assert.match(mounted.text(), /EP0001/)
    assert.doesNotMatch(mounted.text(), /EP0002/)
    await mounted.setSlug('other-project')
    assert.match(mounted.text(), /EP0001/)
    assert.doesNotMatch(mounted.text(), /EP0002/)
    assert.equal(mounted.calls.filter(call => call.method === 'POST').length, 0)
  } finally { mounted.destroy() }
})
