import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/index.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')
const shellSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/upload.vue', import.meta.url)),
  'utf8',
)

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-overview' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-overview',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, watch, onMounted, h as __h } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => ({ params: { slug: 'demo-project' } })
    const NuxtLink = { props: ['to'], setup: (p, { slots }) => () => __h('a', { href: String(p.to) }, slots.default ? slots.default() : []) }
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

function quota(overrides: Record<string, any> = {}) {
  const bucket = (used: number, limit: number, unit: string, limit_verified = true) =>
    ({ used, limit, remaining: limit - used, unit, stale: false, limit_verified })
  return {
    resets_at: '2026-09-03T07:00:00.000Z',
    external_usage_note: 'Only calls recorded by this Story Studio installation are known.',
    buckets: {
      video_uploads: bucket(3, 100, 'calls'),
      search: bucket(0, 100, 'calls'),
      other_endpoints: bucket(1200, 10000, 'units'),
      // Its real allowance is not documented anywhere, so the limit is a
      // placeholder and the panel must not print it as one.
      analytics: { used: 12, limit: null, remaining: null, unit: 'units', stale: false, limit_verified: false },
    },
    ...overrides,
  }
}

const NOTHING = { processing: 0, failed: 0, rejected: 0, status_unavailable: 0, drift: 0 }

/** Fills the fields every overview response carries, so cases stay readable. */
function overview(partial: any) {
  return {
    assigned_channel: null, unavailable_reason: null, quota: null,
    quota_unavailable_reason: null, attention: NOTHING,
    episodes_needing_attention: 0, operation_count: 0, last_remote_sync_at: null,
    last_sync_attempt: null,
    ...partial,
  }
}

async function mount(overview: any | (() => any), opts: { fail?: string } = {}): Promise<{ el: HTMLElement; text: string; destroy: () => void }> {
  const posts: string[] = []
  ;(globalThis as any).__ucApi = {
    get: async () => { if (opts.fail) throw new Error(opts.fail); return typeof overview === 'function' ? overview() : overview },
    post: async (path: string) => { posts.push(path); return {} },
  }
  ;(globalThis as any).__ucPosts = posts
  const Page = await loadPage()
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 5; i++) await nextTick()
  return { el, text: el.textContent || '', destroy: () => app.unmount() }
}

describe('Upload Center Overview', () => {
  test('a failed icon on one channel does not suppress the next assigned channel icon', async () => {
    let current = overview({
      assigned_channel: { channel_id: 'UC-old', title: 'Old Channel', status: 'connected' }, quota: quota(),
    })
    const mounted = await mount(() => current)
    const oldImage = mounted.el.querySelector<HTMLImageElement>('.channel-avatar img')!
    assert.match(oldImage.src, /registry%3AUC-old\/avatar$/)
    oldImage.dispatchEvent(new Event('error'))
    await nextTick()
    assert.match(mounted.el.querySelector('.channel-avatar')?.textContent || '', /OC/)

    current = overview({
      assigned_channel: { channel_id: 'UC-new', title: 'New Channel', status: 'connected' }, quota: quota(),
    })
    const sync = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Sync with YouTube Now'))!
    sync.click()
    for (let i = 0; i < 5; i++) await nextTick()
    const newImage = mounted.el.querySelector<HTMLImageElement>('.channel-avatar img')!
    assert.match(newImage.src, /registry%3AUC-new\/avatar$/)
    mounted.destroy()
  })

  test('names the exact setup step that is missing, not a generic empty state', async () => {
    const cases: Array<[string, RegExp]> = [
      ['no_oauth_application', /Connect Story Studio to YouTube once/],
      ['no_channel_connected', /Connect a YouTube channel/],
      ['no_channel_assigned', /Choose this project’s channel/],
    ]
    for (const [reason, expected] of cases) {
      const mounted = await mount(overview({ unavailable_reason: reason, quota_unavailable_reason: 'no_oauth_application' }))
      assert.match(mounted.text, expected, reason)
      // Each reason must be distinguishable from the others.
      for (const [otherReason, otherCopy] of cases) {
        if (otherReason !== reason) assert.doesNotMatch(mounted.text, otherCopy, `${reason} vs ${otherReason}`)
      }
      mounted.destroy()
    }
  })

  test('shows the four quota buckets with their real units and the uncertainty note', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 4, last_remote_sync_at: '2026-09-02T10:00:00.000Z',
    }))
    assert.match(mounted.text, /Video uploads/)
    assert.match(mounted.text, /3 \/ 100/)
    assert.match(mounted.text, /1200 \/ 10000/)
    assert.match(mounted.text, /calls/)
    assert.match(mounted.text, /units/)
    // The honesty about other installations is not optional decoration.
    assert.match(mounted.text, /Only calls recorded by this Story Studio installation are known/)

    // A bucket whose ceiling we have not confirmed shows usage WITHOUT a
    // fraction, and names the uncertainty. Printing "12 / 10000" there would
    // present arithmetic on a guess as a measurement.
    assert.match(mounted.text, /Analytics/)
    assert.doesNotMatch(mounted.text, /12 \/ 10000/)
    assert.match(mounted.text, /daily limit not confirmed/)
    mounted.destroy()
  })

  test('"nothing waiting" reads differently before and after anything is uploaded', async () => {
    const fresh = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' }, quota: quota(),
    }))
    assert.match(fresh.text, /No episode has been uploaded from this project yet/)
    fresh.destroy()

    const settled = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 7, last_remote_sync_at: '2026-09-02T10:00:00.000Z',
    }))
    assert.match(settled.text, /Every uploaded episode is settled/)
    settled.destroy()
  })

  test('never claims a sync that never happened', async () => {
    const never = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 2,
    }))
    assert.match(never.text, /Not checked with YouTube yet/)
    never.destroy()
  })

  test('lists only the attention rows that are non-zero, and counts them', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' }, quota: quota(),
      attention: { processing: 2, failed: 0, rejected: 1, status_unavailable: 0, drift: 0 },
      episodes_needing_attention: 3, operation_count: 9, last_remote_sync_at: '2026-09-02T10:00:00.000Z',
    }))
    assert.match(mounted.text, /3 episodes to look at/)
    assert.match(mounted.text, /still processing on YouTube/)
    assert.match(mounted.text, /rejected by YouTube/)
    assert.doesNotMatch(mounted.text, /upload failed/)
    assert.doesNotMatch(mounted.text, /status could not be checked/)
    mounted.destroy()
  })

  test('an unhealthy channel is labelled, not shown as connected', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'reconnect_required' },
      quota: quota(), operation_count: 1,
    }))
    assert.match(mounted.text, /Reconnect required/)
    mounted.destroy()
  })

  test('a reconnect or permission upgrade blocks remote sync and routes to Settings', async () => {
    for (const [status, expected] of [
      ['reconnect_required', /Reconnect this channel in Settings/],
      ['scope_upgrade_required', /Update this channel’s permission in Settings/],
    ]) {
      const mounted = await mount(overview({
        assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status }, quota: quota(), operation_count: 1,
      }))
      const sync = [...mounted.el.querySelectorAll('button')].find(button => button.textContent!.includes('Sync with YouTube Now'))!
      assert.equal(sync.disabled, true, status)
      assert.match(mounted.text, expected, status)
      assert.deepEqual((globalThis as any).__ucPosts, [], `${status} must not start an unrecorded sync`)
      mounted.destroy()
    }
  })

  test('an unreadable quota ledger is shown, not hidden as an unconfigured project', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: null, quota_unavailable_reason: 'ledger_unreadable', operation_count: 3,
    }))
    assert.match(mounted.text, /daily allowance count could not be read/)
    assert.match(mounted.text, /Uploads and other provider writes are paused/)
    assert.doesNotMatch(mounted.text, /Uploading still works/)
    mounted.destroy()
  })

  test('one episode with two problems is counted once', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' }, quota: quota(),
      attention: { processing: 1, failed: 0, rejected: 0, status_unavailable: 0, drift: 1 },
      episodes_needing_attention: 1, operation_count: 1,
    }))
    assert.match(mounted.text, /1 episode to look at/)
    assert.doesNotMatch(mounted.text, /2 episodes/)
    mounted.destroy()
  })

  test('a real last-sync time is rendered, and its age decides which sentence', async () => {
    // Derived from the clock, never a literal date. This test was written with
    // `2026-09-02T10:00:00.000Z` — fresh on the day it was written, and stale
    // the next morning, at which point it failed for the passage of time
    // rather than for any change to the code. Same class as the Phase 1 publish
    // time bomb.
    //
    // Both branches asserted, because a fixture that happens to sit on one side
    // of a threshold only ever tests that side.
    const recent = new Date(Date.now() - 60_000).toISOString()
    const fresh = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 1, last_remote_sync_at: recent,
    }))
    assert.match(fresh.text, /Last checked with YouTube/)
    assert.doesNotMatch(fresh.text, /Not checked with YouTube yet/)
    fresh.destroy()

    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
    const stale = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 1, last_remote_sync_at: old,
    }))
    assert.match(stale.text, /may be out of date/)
    assert.doesNotMatch(stale.text, /Not checked with YouTube yet/)
    stale.destroy()
  })

  test('data older than a day is called out rather than shown as current', async () => {
    const old = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString()
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 3, last_remote_sync_at: old,
      last_sync_attempt: { attempted_at: old, outcome: 'ok', checked: 3 },
    }))
    assert.match(mounted.text, /may be out of date/)
    mounted.destroy()

    const recent = new Date(Date.now() - 60 * 1000).toISOString()
    const fresh = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 3, last_remote_sync_at: recent,
      last_sync_attempt: { attempted_at: recent, outcome: 'ok', checked: 3 },
    }))
    assert.doesNotMatch(fresh.text, /may be out of date/)
    assert.match(fresh.text, /Last checked with YouTube/)
    fresh.destroy()
  })

  test('being unable to reach YouTube reads differently from YouTube refusing', async () => {
    const at = new Date().toISOString()
    const base = {
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 3, last_remote_sync_at: '2026-09-01T10:00:00.000Z',
    }
    const offline = await mount(overview({
      ...base, last_sync_attempt: { attempted_at: at, outcome: 'failed', checked: 0, error_code: 'offline' },
    }))
    assert.match(offline.text, /could not reach YouTube/)
    assert.match(offline.text, /internet connection/)
    assert.doesNotMatch(offline.text, /refused/)
    offline.destroy()

    const refused = await mount(overview({
      ...base, last_sync_attempt: { attempted_at: at, outcome: 'failed', checked: 0, error_code: 'provider_error' },
    }))
    assert.match(refused.text, /YouTube refused the last check/)
    assert.match(refused.text, /reauthoriz/)
    assert.doesNotMatch(refused.text, /internet connection/)
    refused.destroy()

    const spent = await mount(overview({
      ...base, last_sync_attempt: { attempted_at: at, outcome: 'failed', checked: 0, error_code: 'quota_exhausted' },
    }))
    assert.match(spent.text, /allowance is used up/)
    spent.destroy()
  })

  test('a successful attempt shows no failure banner', async () => {
    const at = new Date().toISOString()
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 3, last_remote_sync_at: at,
      last_sync_attempt: { attempted_at: at, outcome: 'ok', checked: 3 },
    }))
    assert.doesNotMatch(mounted.text, /could not reach YouTube|refused the last check|did not finish/)
    mounted.destroy()
  })

  test('syncing is an explicit click, never something the page does on load', async () => {
    const mounted = await mount(overview({
      assigned_channel: { channel_id: 'UC-x', title: 'My Channel', status: 'connected' },
      quota: quota(), operation_count: 1,
    }))
    assert.deepEqual((globalThis as any).__ucPosts, [], 'nothing is spent just by opening the page')

    const sync = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.includes('Sync with YouTube Now'))!
    sync.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.deepEqual((globalThis as any).__ucPosts, ['/projects/demo-project/youtube/sync'])
    mounted.destroy()
  })

  test('a failed load says so instead of rendering an empty page', async () => {
    const mounted = await mount(null, { fail: 'backend unreachable' })
    assert.match(mounted.text, /backend unreachable/)
    assert.doesNotMatch(mounted.text, /Nothing is waiting/)
    mounted.destroy()
  })
})

describe('Upload Center navigation', () => {
  test('Overview uses exact-only active styling so a child page has one selected area', () => {
    const overviewLink = '<NuxtLink :to="`/projects/${slug}/upload`" class="uc-area" exact-active-class="active">'
    assert.ok(shellSource.includes(overviewLink))
    assert.equal(shellSource.includes('class="uc-area" active-class="active" exact-active-class="active"'), false)
  })
})

describe('Upload Center shell', () => {
  test('uses the project dashboard layout so the channel sidebar remains visible', () => {
    assert.match(shellSource, /definePageMeta\(\{\s*layout: 'dashboard'\s*\}\)/)
  })

  test('the Upload Center IS /projects/:slug/upload — the page the old one served', () => {
    // The cutover renamed the directory rather than adding a redirect: two URLs
    // for one screen, and a name nobody types, is what a redirect buys. The
    // shell lives at pages/projects/[slug]/upload.vue and its children at
    // pages/projects/[slug]/upload/*, so Nuxt serves the Overview at the exact
    // path the 8,812-line page used.
    const here = fileURLToPath(new URL('.', import.meta.url))
    assert.ok(
      existsSync(join(here, '../pages/projects/[slug]/upload.vue')),
      'the Upload Center shell must sit at the /upload path',
    )
    assert.ok(
      existsSync(join(here, '../pages/projects/[slug]/upload/index.vue')),
      'and its Overview must be the index of that path',
    )
    // The old page is gone, not renamed alongside it.
    assert.equal(existsSync(join(here, '../pages/projects/[slug]/upload-center.vue')), false)
    assert.equal(existsSync(join(here, '../components/upload/AnalyticsTab.vue')), false)
  })

  test('no link anywhere in the app points at a page the cutover removed', () => {
    // TWO dead shapes, and the first version of this test only knew one.
    //
    // `upload?tab=` was how the legacy page selected an area. `upload-center/`
    // was the redesign's own path before the rename — and the rename is what
    // orphaned it, so a test written only against the OLDER pattern could not
    // see the link this very commit broke. It missed a live 404 on the
    // Overview's "Open Publish" button.
    //
    // The trailing slash keeps the shell's `.upload-center` CSS class legal:
    // a class name is not a route.
    const here = fileURLToPath(new URL('.', import.meta.url))
    const DEAD_LINK = /upload\?tab=|upload-center\//
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        // __tests__ excluded: this very file contains the pattern it searches for.
        if (['node_modules', '.nuxt', 'dist', '__tests__'].includes(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) { walk(full); continue }
        if (!/\.(vue|ts)$/.test(entry.name)) continue
        const text = readFileSync(full, 'utf8')
        if (DEAD_LINK.test(text)) offenders.push(full)
      }
    }
    walk(join(here, '..'))
    assert.deepEqual(offenders, [], 'these still link at the deleted page')
  })

  test('every area now has its own page, with nothing handed back to the old one', () => {
    for (const area of ['Library', 'Reconcile', 'Comments', 'Analytics']) {
      // The tab reads "Match to YouTube"; its route path is still /reconcile.
      assert.match(shellSource, new RegExp(area === 'Reconcile' ? 'Match to YouTube' : area))
      assert.match(shellSource, new RegExp(`upload/${area.toLowerCase()}`))
    }
    // No dead "Coming soon" panels — the spec forbids them in the replacement.
    assert.doesNotMatch(shellSource, /Coming soon/i)
    // Analytics was the last area still handed over to the legacy screen. Now
    // that it is built, no tab may point back there: a link to the old page
    // from the replacement is exactly the half-migrated state Phase 9 removes.
    assert.doesNotMatch(shellSource, /upload\?tab=/)
  })

  test('does not touch the old page or its upload mode semantics', () => {
    assert.doesNotMatch(source, /upload_mode|auto_schedule_on_render/)
    assert.doesNotMatch(shellSource, /upload_mode|auto_schedule_on_render/)
  })
})
