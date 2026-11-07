import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const componentPath = fileURLToPath(new URL('../components/ChannelYouTubeSettings.vue', import.meta.url))
// The component imports the contract as `.../youtube-channel-settings.js`, which only
// exists as .ts on disk; point the data: URL module at the real file URL (Node strips types).
const contractUrl = pathToFileURL(
  fileURLToPath(new URL('../../electron/server/contracts/youtube-channel-settings.ts', import.meta.url)),
).href

const source = readFileSync(componentPath, 'utf8')

async function loadComponent(): Promise<Component> {
  const { descriptor } = parse(source, { filename: componentPath })
  const script = compileScript(descriptor, { id: 'channel-youtube-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: componentPath,
    id: 'channel-youtube-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  // The component imports its own vue bindings; only Nuxt's auto-import is shimmed here.
  const support = `
    const useApi = () => globalThis.__channelYTSettingsApi
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const finalCode = transformed.code
    .replaceAll('"vue"', JSON.stringify(vueUrl))
    .replaceAll('"../../electron/server/contracts/youtube-channel-settings.js"', JSON.stringify(contractUrl))
    .replaceAll("'../../electron/server/contracts/youtube-channel-settings.js'", JSON.stringify(contractUrl))
  return (await import(`data:text/javascript;base64,${Buffer.from(finalCode).toString('base64')}`)).default
}

interface RecordedCall {
  method: string
  path: string
  body?: any
}

interface PendingGet {
  path: string
  resolve: (value: any) => void
  reject: (error: any) => void
}

const SETTINGS_PATH = '/projects/test-slug/youtube/channel-settings'
const FAKE_CONFIG: Record<string, any> = {
  youtube_default_playlist: { UC_ACCOUNT_1: 'PL_A' },
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await nextTick()
}

function summaryFor(
  config: Record<string, any>,
  playlists: any[],
  overrides: Record<string, any> = {},
): any {
  return {
    channel_id: 'UC_CHANNEL_1',
    inventory: {
      account_id: 'UC_ACCOUNT_1',
      playlists,
      default_playlist_id: config.youtube_default_playlist?.UC_ACCOUNT_1 || '',
      cached_at: Date.now(),
      count: playlists.length,
      has_connected_account: true,
    },
    end_screen: config.youtube_end_screen ?? {
      duration_seconds: 20,
      template: 'playlist_and_subscribe',
      elements: [
        { id: 'elem_playlist', type: 'playlist', playlist_id: config.youtube_default_playlist?.UC_ACCOUNT_1 || '', label: 'Series Playlist' },
        { id: 'elem_sub', type: 'subscribe', label: 'Subscribe' },
      ],
    },
    end_screen_capabilities: { remote_api_supported: false },
    ...overrides,
  }
}

async function mount(options?: {
  playlists?: any[]
  connected?: boolean
  config?: Record<string, any>
  /** GET rejects with this detail — a real provider/route failure. */
  loadErrorDetail?: string
  /** Hold every GET until the test resolves it, for stale-response races. */
  deferGets?: boolean
  slug?: string
  accountId?: string
}): Promise<{
  el: HTMLElement
  calls: RecordedCall[]
  pendingGets: PendingGet[]
  setSlug: (slug: string) => void
  destroy: () => void
}> {
  const calls: RecordedCall[] = []
  const pendingGets: PendingGet[] = []
  const playlists = options?.playlists ?? [
    { id: 'PL_A', title: 'Series A', description: 'desc', privacyStatus: 'public', itemCount: 4 },
    { id: 'PL_B', title: 'Sleep Stories', description: '', privacyStatus: 'private', itemCount: 12 },
  ]
  const connected = options?.connected ?? true
  const config = options?.config ?? { ...FAKE_CONFIG }
  const loadErrorDetail = options?.loadErrorDetail
  const deferGets = options?.deferGets ?? false

  const summary = () => summaryFor(config, connected ? playlists : [])

  ;(globalThis as any).__channelYTSettingsApi = {
    get: (path: string) => {
      calls.push({ method: 'GET', path })
      if (!path.startsWith('/projects/test-slug/youtube/channel-settings')
        && !path.startsWith('/projects/other-slug/youtube/channel-settings')) {
        return Promise.reject(new Error(`unexpected GET ${path}`))
      }
      if (loadErrorDetail) return Promise.reject({ data: { detail: loadErrorDetail } })
      const respond = () => {
        if (!connected) {
          return {
            channel_id: null,
            inventory: {
              account_id: '',
              playlists: [],
              default_playlist_id: '',
              cached_at: null,
              count: 0,
              has_connected_account: false,
            },
            end_screen: config.youtube_end_screen ?? { duration_seconds: 20, template: 'playlist_and_subscribe', elements: [] },
            end_screen_capabilities: { remote_api_supported: false },
          }
        }
        return summary()
      }
      if (deferGets) {
        return new Promise((resolve, reject) => pendingGets.push({ path, resolve, reject }))
      }
      return Promise.resolve(respond())
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      if (path !== SETTINGS_PATH && path !== '/projects/other-slug/youtube/channel-settings') {
        throw new Error(`unexpected PUT ${path}`)
      }
      // Server-side contract, enforced here so the component's payload is pinned:
      // identity must match, and a named playlist must belong to the channel.
      if (typeof body.default_playlist_id === 'string' && body.default_playlist_id !== '') {
        if (body.expected_account_id !== 'UC_ACCOUNT_1') {
          throw { data: { code: 'YOUTUBE_CHANNEL_MISMATCH', detail: 'The assigned YouTube channel changed. Reload the channel settings and try again.' } }
        }
        if (!playlists.some((p) => p.id === body.default_playlist_id)) {
          throw { data: { detail: `Playlist "${body.default_playlist_id}" is not a playlist on the assigned YouTube channel.` } }
        }
        config.youtube_default_playlist = { ...config.youtube_default_playlist, UC_ACCOUNT_1: body.default_playlist_id }
      }
      if (body.end_screen) config.youtube_end_screen = body.end_screen
      return summary()
    },
  }

  const Component = await loadComponent()
  const el = document.createElement('div')
  const slugRef = ref(options?.slug ?? 'test-slug')
  const app = createApp(
    defineComponent({
      setup() {
        return () =>
          h(Component, {
            slug: slugRef.value,
            ...(options?.accountId ? { accountId: options.accountId } : {}),
          })
      },
    }),
  )
  app.mount(el)
  await flushPromises()

  return {
    el,
    calls,
    pendingGets,
    setSlug: (slug: string) => {
      slugRef.value = slug
    },
    destroy: () => app.unmount(),
  }
}

describe('ChannelYouTubeSettings.vue', () => {
  test('template states the API cannot write end screens — manual plan only', async () => {
    const { el, destroy } = await mount()
    try {
      const text = el.textContent || ''
      assert.match(text, /Not supported by the YouTube API — manual plan only/)
      assert.match(text, /has no official endpoint for end screens, so Story Studio never writes one/)
      assert.match(text, /Playlist Series Inventory/)
      assert.match(text, /End-Screen Setup Plan/)
      assert.match(text, /Steps to apply in YouTube Studio/)
      assert.match(
        text,
        /YouTube Data API v3 supports playlist inventory and adding uploaded videos/,
      )
    } finally {
      destroy()
    }
  })

  test('no unimplemented render promises: no render toggle, backdrop or audio controls', async () => {
    const { el, destroy } = await mount()
    try {
      const text = el.textContent || ''
      assert.equal(el.querySelectorAll('input[type="checkbox"]').length, 0, 'no render toggle')
      assert.equal(el.querySelector('#backdrop-style-select'), null, 'no backdrop control')
      assert.equal(el.querySelector('#audio-treatment-select'), null, 'no audio control')
      assert.equal((el.querySelector('#plan-window-slider') as HTMLInputElement | null)?.disabled, false, 'plan window is editable')
      assert.ok(!/Slate in Video Render/.test(text), 'no render-slate promise')
      assert.ok(!/Enabled for video assembly/.test(text), 'no video-assembly claim')
      assert.ok(!/outro visual cards/i.test(text), 'no outro-card claim')
      assert.ok(!/local timeline reservation/i.test(text), 'no timeline-reservation claim')
    } finally {
      destroy()
    }
  })

  test('renders playlists from the channel-settings summary and marks the default playlist', async () => {
    const { el, calls, destroy } = await mount()
    try {
      const text = el.textContent || ''
      assert.match(text, /Series A/)
      assert.match(text, /Sleep Stories/)
      assert.match(text, /Default Playlist/)
      assert.match(text, /2 Playlists Found/)
      assert.match(text, /public/)
      assert.match(text, /private/)
      assert.match(text, /4 items/)
      assert.match(text, /12 items/)
      const select = el.querySelector('#default-playlist-select') as HTMLSelectElement | null
      assert.ok(select, 'default playlist selector must render')
      assert.equal(select!.value, 'PL_A')

      // One authoritative endpoint — no whole-config map reads anywhere.
      assert.equal(calls.filter((c) => c.method === 'GET').length, 1)
      assert.equal(calls[0].path.startsWith(SETTINGS_PATH), true)
      assert.equal(calls.some((c) => c.path.includes('/settings/config')), false)
      assert.equal(calls.some((c) => c.path.includes('/upload/playlists')), false)
    } finally {
      destroy()
    }
  })

  test('Saves a new default playlist through the pinned endpoint, not the config map', async () => {
    const { el, calls, destroy } = await mount()
    try {
      const select = el.querySelector('#default-playlist-select') as HTMLSelectElement
      select.value = 'PL_B'
      select.dispatchEvent(new Event('change'))
      await nextTick()

      const setBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Set Default',
      )
      assert.ok(setBtn, 'Set Default button must render')
      ;(setBtn as HTMLButtonElement).click()
      await flushPromises()

      const puts = calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1, 'must send exactly one PUT')
      assert.equal(puts[0].path, SETTINGS_PATH)
      assert.equal(puts[0].body.expected_account_id, 'UC_ACCOUNT_1', 'identity confirmed, never chosen')
      assert.equal(puts[0].body.default_playlist_id, 'PL_B')
      assert.equal('youtube_default_playlist' in puts[0].body, false, 'no generic config map write')
      assert.equal(calls.some((c) => c.path.includes('/settings/config')), false)

      const text = el.textContent || ''
      assert.match(text, /Default playlist saved\./)
      // Response readback: the selector now shows what the server confirmed.
      const after = el.querySelector('#default-playlist-select') as HTMLSelectElement
      assert.equal(after.value, 'PL_B')
    } finally {
      destroy()
    }
  })

  test('Plan window slider is bounded to the documented 5-20s', async () => {
    const { el, destroy } = await mount()
    try {
      const slider = el.querySelector('#plan-window-slider') as HTMLInputElement
      assert.ok(slider, 'plan window slider renders')
      assert.equal(slider.min, '5')
      assert.equal(slider.max, '20')
      assert.equal(slider.step, '1')
      assert.equal(slider.value, '20')
      const text = el.textContent || ''
      assert.match(text, /5s \(YouTube minimum\)/)
      assert.match(text, /20s \(YouTube maximum\)/)
      assert.match(text, /last 5–20 seconds/)
      assert.match(text, /at least 25 seconds long/)
    } finally {
      destroy()
    }
  })

  test('Applying a layout template resets planned elements to the preset', async () => {
    const { el, destroy } = await mount()
    try {
      const templateCard = [...el.querySelectorAll('.template-card')].find((c) =>
        c.textContent?.includes('2 Videos'),
      )
      assert.ok(templateCard, 'Template card must render')
      ;(templateCard as HTMLButtonElement).click()
      await nextTick()

      const typeSelects = el.querySelectorAll('.element-type-select')
      assert.equal(typeSelects.length, 2, 'Two elements after switching to "2 Videos" template')
      const values = [...typeSelects].map((s) => (s as HTMLSelectElement).value)
      assert.ok(values.includes('latest_upload'), 'Includes latest upload')
      assert.ok(values.includes('best_for_viewer'), 'Includes best for viewer')
    } finally {
      destroy()
    }
  })

  test('Saves the plan through the pinned endpoint with no render fields', async () => {
    const { el, calls, destroy } = await mount()
    try {
      const slider = el.querySelector('#plan-window-slider') as HTMLInputElement
      slider.value = '15'
      slider.dispatchEvent(new Event('input'))
      await nextTick()

      const saveBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Save Settings',
      )
      assert.ok(saveBtn, 'Save Settings button must render')
      ;(saveBtn as HTMLButtonElement).click()
      await flushPromises()

      const puts = calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0].path, SETTINGS_PATH)
      assert.equal(puts[0].body.expected_account_id, 'UC_ACCOUNT_1')
      const plan = puts[0].body.end_screen
      assert.ok(plan, 'plan must be saved')
      assert.equal(plan.duration_seconds, 15)
      assert.ok(!('enabled' in plan), 'no render toggle is written')
      assert.ok(!('backdrop_style' in plan), 'no backdrop is written')
      assert.ok(!('audio_treatment' in plan), 'no audio field is written')
      assert.equal('youtube_end_screen' in puts[0].body, false, 'plan travels under its own key, not a config map')
      assert.equal(calls.some((c) => c.path.includes('/settings/config')), false)

      const text = el.textContent || ''
      assert.match(text, /Settings saved\./)
    } finally {
      destroy()
    }
  })

  test('Shows unconnected notice when no YouTube channel is assigned', async () => {
    const { el, destroy } = await mount({ connected: false })
    try {
      const text = el.textContent || ''
      assert.match(text, /No YouTube channel is currently assigned/)
      assert.match(text, /Connections/)
      assert.equal(el.querySelector('#default-playlist-select'), null)
    } finally {
      destroy()
    }
  })

  test('A failed load shows the real error with a retry — never the unconnected notice', async () => {
    const { el, destroy } = await mount({
      loadErrorDetail: 'YouTube could not list playlists for the assigned channel: playlists.list failed (503)',
    })
    try {
      const text = el.textContent || ''
      assert.match(text, /YouTube could not list playlists/)
      assert.ok(!/No YouTube channel is currently assigned/.test(text), 'provider failure must not read as "no channel"')
      assert.ok(!/Playlist Series Inventory/.test(text), 'inventory does not render from a failed load')
      const retry = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Try Again')
      assert.ok(retry, 'a retry path must be offered')
    } finally {
      destroy()
    }
  })

  test('A stale load response for the previous slug is discarded after a channel switch', async () => {
    const { el, pendingGets, setSlug, destroy } = await mount({ deferGets: true })
    try {
      // Load #1 for test-slug is still in flight when the channel changes.
      assert.equal(pendingGets.length, 1)
      assert.equal(pendingGets[0].path.startsWith('/projects/test-slug/'), true)

      setSlug('other-slug')
      await flushPromises()
      assert.equal(pendingGets.length, 2, 'the slug watcher starts a fresh load')
      assert.equal(pendingGets[1].path.startsWith('/projects/other-slug/'), true)

      // The NEW slug answers first…
      pendingGets[1].resolve({
        channel_id: 'UC_CHANNEL_OTHER',
        inventory: {
          account_id: 'UC_ACCOUNT_1',
          playlists: [{ id: 'PL_OTHER', title: 'Other Channel Series', description: '', privacyStatus: 'public', itemCount: 1 }],
          default_playlist_id: '',
          cached_at: Date.now(),
          count: 1,
          has_connected_account: true,
        },
        end_screen: { duration_seconds: 20, template: 'playlist_and_subscribe', elements: [] },
        end_screen_capabilities: { remote_api_supported: false },
      })
      await flushPromises()
      assert.match(el.textContent || '', /Other Channel Series/)

      // …then the OLD slug's response lands late. It must not overwrite the new channel.
      pendingGets[0].resolve({
        channel_id: 'UC_CHANNEL_1',
        inventory: {
          account_id: 'UC_ACCOUNT_1',
          playlists: [{ id: 'PL_A', title: 'Series A', description: 'desc', privacyStatus: 'public', itemCount: 4 }],
          default_playlist_id: 'PL_A',
          cached_at: Date.now(),
          count: 1,
          has_connected_account: true,
        },
        end_screen: { duration_seconds: 20, template: 'playlist_and_subscribe', elements: [] },
        end_screen_capabilities: { remote_api_supported: false },
      })
      await flushPromises()

      const text = el.textContent || ''
      assert.match(text, /Other Channel Series/, 'the current channel stays on screen')
      assert.ok(!/Series A\b/.test(text), 'the previous channel\'s inventory must not come back')
    } finally {
      destroy()
    }
  })

  test('A response for a foreign account identity is not applied', async () => {
    const { el, destroy } = await mount({ accountId: 'UC_ACCOUNT_1' })
    try {
      // The mock's summary is for UC_ACCOUNT_1, which matches — render normally.
      assert.match(el.textContent || '', /Series A/)

      // Now remount with a prop account the server answer does not belong to.
      const foreign = await mount({ accountId: 'UC_ACCOUNT_2' })
      try {
        const text = foreign.el.textContent || ''
        assert.ok(!/Series A/.test(text), 'a mismatched account\'s inventory is never rendered')
        assert.match(text, /No YouTube channel is currently assigned/)
      } finally {
        foreign.destroy()
      }
    } finally {
      destroy()
    }
  })
})
