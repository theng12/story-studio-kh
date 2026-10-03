import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/library.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')
const shellSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/upload.vue', import.meta.url)),
  'utf8',
)

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-library' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-library',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, onMounted } from ${JSON.stringify(vueUrl)}
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

function field(name: string, state: string, extra: Record<string, unknown> = {}) {
  return { field: name, state, local: null, last_synced: null, live: null, ...extra }
}

function video(overrides: Record<string, any> = {}) {
  return {
    operation_id: 'op-1',
    episode_code: 'EP0001',
    video_id: 'video-1',
    comparison: {
      fields: [field('title', 'in_sync'), field('description', 'in_sync')],
      needs_attention: false,
      live_fetched_at: '2026-09-03T10:00:00.000Z',
      thumbnail_changed_since_last_sync: null,
    },
    playlists: {},
    caption: null,
    ...overrides,
  }
}

async function mount(input: {
  videos?: any[]
  empty_reason?: string | null
  fail?: string
  confirm?: boolean
  thumbnailResponse?: any
  thumbnailError?: any
  playlistPreview?: any
  playlistApply?: any
}): Promise<{ el: HTMLElement; text: () => string; calls: any[]; confirms: any[]; destroy: () => void }> {
  const calls: any[] = []
  const confirms: any[] = []
  ;(globalThis as any).__ucConfirm = async (options: any) => {
    confirms.push(options)
    return input.confirm !== false
  }
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (input.fail) throw new Error(input.fail)
      return { videos: input.videos ?? [], empty_reason: input.empty_reason ?? null }
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (path.endsWith('/playlists/preview')) {
        return input.playlistPreview ?? {
          additions: ['op-1'], already_present: [], no_video_id: [], unknown_operation_ids: [], estimated_quota_units: 50,
        }
      }
      if (path.endsWith('/playlists/apply')) return input.playlistApply ?? { added: 1, failed: 0, skipped: 0 }
      if (path.endsWith('/thumbnail')) {
        if (input.thumbnailError) throw input.thumbnailError
        return input.thumbnailResponse ?? { job_id: 'job-thumb-1', episode_code: 'EP0001' }
      }
      return {}
    },
  }
  const Page = await loadPage()
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', calls, confirms, destroy: () => app.unmount() }
}

describe('Upload Center Library', () => {
  test('each empty reason gets its own sentence, never one generic blank', async () => {
    const cases: Array<[string, RegExp]> = [
      ['no_channel_assigned', /no YouTube channel/],
      ['nothing_uploaded', /Nothing has been uploaded/],
      ['nothing_published_yet', /YouTube has not accepted a video/],
    ]
    for (const [reason, expected] of cases) {
      const mounted = await mount({ videos: [], empty_reason: reason })
      assert.match(mounted.text(), expected, reason)
      for (const [other, otherCopy] of cases) {
        if (other !== reason) assert.doesNotMatch(mounted.text(), otherCopy, `${reason} vs ${other}`)
      }
      mounted.destroy()
    }
  })

  test('a never-checked video says so instead of reading as verified', async () => {
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'unknown')],
          needs_attention: false,
          live_fetched_at: null,
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    assert.match(mounted.text(), /Not checked with YouTube yet/)
    assert.match(mounted.text(), /Not checked yet/)
    assert.doesNotMatch(mounted.text(), /In sync/)
    mounted.destroy()
  })

  test('a conflict shows both sides and offers all three decisions', async () => {
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'conflict', { local: 'Our Title', live: 'Their Title' })],
          needs_attention: true,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    const text = mounted.text()
    assert.match(text, /Needs a decision/)
    assert.match(text, /Our Title/)
    assert.match(text, /Their Title/)
    for (const label of ['Update YouTube to Story Studio’s Version', 'Keep YouTube', 'Review Later']) {
      assert.equal(
        [...mounted.el.querySelectorAll('button')].some(b => b.textContent!.trim() === label),
        true,
        label,
      )
    }
    mounted.destroy()
  })

  test('a settled field offers no decision to make', async () => {
    const mounted = await mount({ videos: [video()] })
    assert.match(mounted.text(), /Settled/)
    assert.equal([...mounted.el.querySelectorAll('.decisions button')].length, 0, 'a settled field needs no drift decision')
    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(button => button.textContent!.trim() === 'Refresh Thumbnail'),
      true,
      'the separate, explicit thumbnail maintenance action remains reachable',
    )
    mounted.destroy()
  })

  test('choosing Keep YouTube sends that exact decision for that exact field', async () => {
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'conflict', { local: 'Ours', live: 'Theirs' })],
          needs_attention: true,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    const keep = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Keep YouTube')!
    keep.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const posted = mounted.calls.find(call => call.method === 'POST')
    assert.equal(posted.path, '/projects/demo-project/youtube/library/op-1/drift')
    assert.deepEqual(posted.body, { field: 'title', decision: 'keep_youtube' })
    mounted.destroy()
  })

  test('choosing Use Story Studio sends that decision, which the server performs', async () => {
    // Previously only its presence was tested, which is exactly how a control
    // that recorded a decision without performing it stayed invisible.
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'conflict', { local: 'Ours', live: 'Theirs' })],
          needs_attention: true,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    const use = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Update YouTube to Story Studio’s Version')!
    use.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const posted = mounted.calls.find(call => call.method === 'POST')
    assert.deepEqual(posted.body, { field: 'title', decision: 'use_story_studio' })
    // And the page re-reads, so what it shows next comes from the server.
    assert.equal(mounted.calls.filter(call => call.method === 'GET').length, 2)
    mounted.destroy()
  })

  test('two long values that differ late are not shown as identical text', async () => {
    // The moment the owner is asked to judge a difference is the moment the
    // screen must not hide it. Truncating both at the same offset did exactly
    // that for descriptions sharing a long opening.
    const shared = 'x'.repeat(300)
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('description', 'conflict', { local: `${shared}OURS`, live: `${shared}THEIRS` })],
          needs_attention: true,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    const text = mounted.text()
    assert.match(text, /OURS/)
    assert.match(text, /THEIRS/)
    mounted.destroy()
  })

  test('a review-later decision says the difference is still there', async () => {
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'youtube_changed', { local: 'Ours', live: 'Theirs' })],
          needs_attention: true,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: null,
        },
      })],
    })
    const later = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Review Later')!
    later.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /stays visible/)
    mounted.destroy()
  })

  test('a changed thumbnail is reported as changed, never as identical', async () => {
    const mounted = await mount({
      videos: [video({
        comparison: {
          fields: [field('title', 'in_sync')],
          needs_attention: false,
          live_fetched_at: '2026-09-03T10:00:00.000Z',
          thumbnail_changed_since_last_sync: true,
        },
      })],
    })
    assert.match(mounted.text(), /Thumbnail changed on YouTube/)
    mounted.destroy()
  })

  test('thumbnail refresh is explicit, operation-bound, and never runs on page load', async () => {
    const mounted = await mount({ videos: [video()] })
    const refresh = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Refresh Thumbnail')!
    assert.ok(refresh)
    assert.deepEqual(mounted.calls.map(call => call.path), ['/projects/demo-project/youtube/library'])

    refresh.click()
    for (let i = 0; i < 6; i++) await nextTick()

    assert.equal(mounted.confirms.length, 1)
    assert.equal(mounted.confirms[0].confirmLabel, 'Refresh Thumbnail')
    const request = mounted.calls.find(call => call.path.endsWith('/thumbnail'))
    assert.deepEqual(request, {
      method: 'POST',
      path: '/projects/demo-project/youtube/library/op-1/thumbnail',
      body: { confirm: true },
    })
    assert.match(mounted.text(), /thumbnail refresh queued/i)
    mounted.destroy()
  })

  test('declining thumbnail refresh sends no write and a backend conflict stays visible', async () => {
    const declined = await mount({ videos: [video()], confirm: false })
    ;[...declined.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Refresh Thumbnail')!.click()
    for (let i = 0; i < 4; i++) await nextTick()
    assert.equal(declined.calls.some(call => call.path.endsWith('/thumbnail')), false)
    declined.destroy()

    const conflicted = await mount({
      videos: [video()],
      thumbnailError: { data: { detail: 'This video belongs to a different assigned channel.' } },
    })
    ;[...conflicted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Refresh Thumbnail')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(conflicted.text(), /different assigned channel/)
    conflicted.destroy()
  })

  test('playlist and caption state read honestly when there is none', async () => {
    const mounted = await mount({ videos: [video()] })
    assert.match(mounted.text(), /Not in any playlist Story Studio knows about/)
    assert.match(mounted.text(), /No caption track has been recorded/)
    mounted.destroy()
  })

  test('a failed playlist add is shown as separately retryable', async () => {
    const mounted = await mount({
      videos: [video({ playlists: { 'PL-a': { state: 'present' }, 'PL-b': { state: 'failed' } } })],
    })
    assert.match(mounted.text(), /In 1 playlist/)
    assert.match(mounted.text(), /1 playlist add failed and can be retried on its own/)
    mounted.destroy()
  })

  test('a playlist retry previews one exact operation and confirms its quota before applying', async () => {
    const mounted = await mount({ videos: [video({ playlists: { 'PL-b': { state: 'failed' } } })] })
    const retry = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Retry PL-b')!
    retry.click()
    for (let i = 0; i < 6; i++) await nextTick()

    assert.deepEqual(mounted.calls.slice(1), [
      { method: 'POST', path: '/projects/demo-project/youtube/playlists/preview', body: { playlist_id: 'PL-b', operation_ids: ['op-1'] } },
      { method: 'POST', path: '/projects/demo-project/youtube/playlists/apply', body: { playlist_id: 'PL-b', operation_ids: ['op-1'] } },
      { method: 'GET', path: '/projects/demo-project/youtube/library' },
    ])
    assert.equal(mounted.confirms.length, 1)
    assert.match(mounted.confirms[0].message, /one accepted video/)
    assert.match(mounted.confirms[0].message, /50 units/)
    mounted.destroy()
  })

  test('an unrecorded provider-success result requires a YouTube Studio check, never a blind retry', async () => {
    const mounted = await mount({
      videos: [video({ playlists: { 'PL-b': { state: 'failed' } } })],
      playlistApply: { added: 1, failed: 0, skipped: 0, unrecorded: 1, receipts: [{ unrecorded: true }] },
    })
    ;[...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Retry PL-b')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /may have accepted/)
    assert.match(mounted.text(), /Check YouTube Studio before retrying/)
    assert.equal(mounted.calls.filter(call => call.path.endsWith('/playlists/apply')).length, 1)
    mounted.destroy()
  })

  test('declining playlist retry sends no apply after the harmless local preview', async () => {
    const mounted = await mount({ videos: [video({ playlists: { 'PL-b': { state: 'failed' } } })], confirm: false })
    ;[...mounted.el.querySelectorAll('button')].find(button => button.textContent!.trim() === 'Retry PL-b')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.some(call => call.path.endsWith('/playlists/preview')), true)
    assert.equal(mounted.calls.some(call => call.path.endsWith('/playlists/apply')), false)
    mounted.destroy()
  })

  test('opening the page contacts YouTube for nothing', async () => {
    const mounted = await mount({ videos: [video()] })
    assert.deepEqual(mounted.calls.map(call => call.path), ['/projects/demo-project/youtube/library'])
    assert.match(mounted.text(), /Looking at this list does not contact YouTube/)
    mounted.destroy()
  })

  test('a failed load says so rather than rendering as empty', async () => {
    const mounted = await mount({ fail: 'backend unreachable' })
    assert.match(mounted.text(), /backend unreachable/)
    assert.doesNotMatch(mounted.text(), /Nothing has been uploaded/)
    mounted.destroy()
  })
})

describe('Upload Center Library boundaries', () => {
  test('the shell links Library as a real area, not out to the old page', () => {
    assert.match(shellSource, /upload\/library/)
    // Match to YouTube (the reconcile route), Comments and Analytics still hand over honestly.
    for (const pending of ['Match to YouTube', 'Comments', 'Analytics']) {
      assert.match(shellSource, new RegExp(pending))
    }
    assert.doesNotMatch(shellSource, /Coming soon/i)
  })

  test('Library never offers deletion, and never touches upload mode', () => {
    // Spec section 12 excludes video and playlist deletion from this release.
    assert.doesNotMatch(source, /deleteVideo|removeVideo|deletePlaylist|Delete video|Delete playlist/i)
    assert.doesNotMatch(source, /upload_mode|auto_schedule_on_render/)
  })

  test('Library renders no token, secret, or session url', () => {
    assert.doesNotMatch(source, /access_token|refresh_token|client_secret|session_url/)
  })
})
