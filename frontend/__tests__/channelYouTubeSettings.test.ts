import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
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

const FAKE_CONFIG: Record<string, any> = {
  youtube_default_playlist: { UC_ACCOUNT_1: 'PL_A' },
}

async function mount(options?: {
  playlists?: any[]
  connected?: boolean
  config?: Record<string, any>
}): Promise<{
  el: HTMLElement
  calls: RecordedCall[]
  destroy: () => void
}> {
  const calls: RecordedCall[] = []
  const playlists = options?.playlists ?? [
    { id: 'PL_A', title: 'Series A', description: 'desc', privacyStatus: 'public', itemCount: 4 },
    { id: 'PL_B', title: 'Sleep Stories', description: '', privacyStatus: 'private', itemCount: 12 },
  ]
  const connected = options?.connected ?? true
  const config = options?.config ?? { ...FAKE_CONFIG }

  ;(globalThis as any).__channelYTSettingsApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (path.startsWith('/projects/test-slug/upload/playlists')) {
        if (!connected) throw { data: { error: 'No YouTube account connected.' } }
        return {
          account_id: 'UC_ACCOUNT_1',
          playlists,
          default_playlist_id: config.youtube_default_playlist?.UC_ACCOUNT_1 || '',
        }
      }
      if (path === '/projects/test-slug/settings/config') {
        return config
      }
      throw new Error(`unexpected GET ${path}`)
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      if (path === '/projects/test-slug/settings/config') {
        Object.assign(config, body)
        return { ok: true }
      }
      throw new Error(`unexpected PUT ${path}`)
    },
  }

  const Component = await loadComponent()
  const el = document.createElement('div')
  const app = createApp(
    defineComponent({
      setup() {
        return () => h(Component, { slug: 'test-slug' })
      },
    }),
  )
  app.mount(el)
  await nextTick()
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 5))

  return {
    el,
    calls,
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
      assert.equal(el.querySelector('#plan-window-slider')?.disabled, false, 'plan window is editable')
      assert.ok(!/Slate in Video Render/.test(text), 'no render-slate promise')
      assert.ok(!/Enabled for video assembly/.test(text), 'no video-assembly claim')
      assert.ok(!/outro visual cards/i.test(text), 'no outro-card claim')
      assert.ok(!/local timeline reservation/i.test(text), 'no timeline-reservation claim')
    } finally {
      destroy()
    }
  })

  test('renders playlists from cached inventory and marks the default playlist', async () => {
    const { el, destroy } = await mount()
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
    } finally {
      destroy()
    }
  })

  test('Saves new default playlist through PUT config when changed', async () => {
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
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 5))

      const puts = calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1, 'must send exactly one PUT')
      assert.equal(puts[0].path, '/projects/test-slug/settings/config')
      assert.deepEqual(puts[0].body.youtube_default_playlist, { UC_ACCOUNT_1: 'PL_B' })

      const text = el.textContent || ''
      assert.match(text, /Default playlist saved\./)
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

  test('Saves the plan through PUT config with no render fields', async () => {
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
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 5))

      const puts = calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0].path, '/projects/test-slug/settings/config')
      const plan = puts[0].body.youtube_end_screen
      assert.ok(plan, 'plan must be saved')
      assert.equal(plan.duration_seconds, 15)
      assert.ok(!('enabled' in plan), 'no render toggle is written')
      assert.ok(!('backdrop_style' in plan), 'no backdrop is written')
      assert.ok(!('audio_treatment' in plan), 'no audio field is written')

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
})
