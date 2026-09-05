import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
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
    import { ref, computed, onMounted, h as __h } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => ({ params: { slug: 'demo-project' } })
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
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
}): Promise<{
  el: HTMLElement; text: () => string; calls: Recorded[]
  confirms: any[]; destroy: () => void
}> {
  const calls: Recorded[] = []
  const confirms: any[] = []
  let previewCalls = 0
  ;(globalThis as any).__ucConfirm = async (options: any) => {
    confirms.push(options)
    return input.confirmAnswer !== false
  }
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (path.endsWith('/publishable')) {
        // The server returns EPISODES with an operation overlaid where one
        // exists. `operations` is the shorthand for "a rendered episode that
        // has been uploaded"; `episodes` states the row outright.
        const rows = input.episodes ?? (input.operations ?? []).map((op: any) => ({
          episode_code: op.episode_code, title: 'Some Episode', has_video: true, operation: op,
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
      throw new Error(`unexpected GET ${path}`)
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/preview')) {
        previewCalls += 1
        if (input.previewFailAfter !== undefined && previewCalls > input.previewFailAfter) {
          throw new Error('preview exploded')
        }
        return input.preview
      }
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
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', calls, confirms, destroy: () => app.unmount() }
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
    assert.match(mounted.text(), /Rejected by YouTube/)
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
    const preview = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Preview')!
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
    snippet: { title: 'The Lighthouse at Dawn', description: 'd', tags: [], categoryId: '24' },
    status: { privacyStatus: 'private', containsSyntheticMedia: true },
    modifications: [], warnings: [],
  }

  async function previewThen(mounted: Awaited<ReturnType<typeof mount>>): Promise<HTMLButtonElement> {
    const preview = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Preview')!
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
    assert.match(mounted.text(), /Not uploaded yet/)

    const upload = await previewThen(mounted)
    assert.ok(upload, 'a rendered, never-uploaded episode can be uploaded')

    upload.click()
    for (let i = 0; i < 8; i++) await nextTick()

    assert.equal(mounted.confirms.length, 1)
    assert.match(mounted.confirms[0].title, /Upload EP0001 to YouTube\?/)
    assert.match(mounted.confirms[0].message, /cannot be replaced once uploaded/)

    const posted = mounted.calls.find(c => c.path.endsWith('/youtube/upload'))
    assert.ok(posted, 'the click reaches the route')
    assert.deepEqual(posted!.body, { episode_code: 'EP0001', confirm: true, expected_channel_id: 'UC-x', expected_package_revision: 'pack-42' })
    assert.match(mounted.confirms[0].message, /Ch \(UC-x\)/)

    assert.match(mounted.text(), /Uploading EP0001 to UC-x/)
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
      [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Preview'),
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
    assert.match(mounted.text(), /On YouTube/)

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

  test('a short list gets no filter box, and a no-match filter says how many exist', async () => {
    const few = await mount({ episodes: [NEVER_UPLOADED], total: 1 })
    assert.equal(few.el.querySelector('input[type="search"]'), null,
      'one episode needs no search box')
    few.destroy()

    const many = Array.from({ length: 14 }, (_, i) => ({
      episode_code: `EP00${String(i + 1).padStart(2, '0')}`, title: `Episode ${i + 1}`, has_video: true,
    }))
    const mounted = await mount({ episodes: many, total: 14 })
    const box = mounted.el.querySelector('input[type="search"]') as HTMLInputElement
    box.value = 'nothing matches this'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()
    assert.match(mounted.text(), /No episode matches/)
    assert.match(mounted.text(), /14 episodes in total/)
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

  test('a project whose channel is not connected gets the reason, never the button', async () => {
    const mounted = await mount({ episodes: [NEVER_UPLOADED], preview: PREVIEWED, channelStatus: null })
    const upload = await previewThen(mounted)
    assert.equal(upload, undefined, 'no button to press')
    assert.match(mounted.text(), /no assigned YouTube channel/)
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
    const previewButton = () => [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Preview')!
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
    assert.match(mounted.text(), /accepted and its final video has been rendered/)
    mounted.destroy()
  })
})

describe('Upload Center Publish boundaries', () => {
  test('offers no retry that could re-upload an accepted video', () => {
    assert.doesNotMatch(source, /re-?upload|retryUpload|uploadAgain/i)
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
