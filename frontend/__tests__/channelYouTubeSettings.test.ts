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
  test('template honestly distinguishes local presentation vs remote unsupported API', async () => {
    const { el, destroy } = await mount()
    try {
      const text = el.textContent || ''
      assert.match(text, /Honest Capability Notice: Local Video Presentation Only/)
      assert.match(text, /does not expose an official endpoint/i)
      assert.match(text, /Playlist Series Inventory/)
      assert.match(text, /End-Screen Outro Framing/)
      assert.match(
        text,
        /YouTube Data API v3 supports playlist inventory and adding uploaded videos/,
      )
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

  test('End-screen controls are OFF by default and display only local presentation claims', async () => {
    const { el, destroy } = await mount()
    try {
      const toggles = el.querySelectorAll('input[type="checkbox"]')
      assert.equal(toggles.length, 1)
      assert.equal((toggles[0] as HTMLInputElement).checked, false, 'Off by default')

      const durationSlider = el.querySelector('#outro-duration-slider') as HTMLInputElement | null
      assert.ok(durationSlider, 'Duration slider renders')
      assert.equal(durationSlider!.disabled, true, 'Disabled when feature is off')

      const text = el.textContent || ''
      assert.match(text, /Off by default/)
      assert.match(text, /local timeline reservation/i)
      assert.match(text, /YouTube Studio Editor/)
    } finally {
      destroy()
    }
  })

  test('Enabling the feature unlocks duration slider, templates, and adds video assembly claims', async () => {
    const { el, destroy } = await mount()
    try {
      const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement
      toggle.checked = true
      toggle.dispatchEvent(new Event('change'))
      await nextTick()

      const durationSlider = el.querySelector('#outro-duration-slider') as HTMLInputElement
      assert.equal(durationSlider.disabled, false, 'Enabled when checkbox checked')

      const text = el.textContent || ''
      assert.match(text, /Enabled for video assembly/)

      const templateCards = el.querySelectorAll('.template-card')
      assert.equal(templateCards.length, 5, 'Must have 5 YouTube layout templates')
      assert.match(text, /Playlist & Subscribe/)
      assert.match(text, /1 Video & 1 Subscribe/)
      assert.match(text, /2 Videos/)
      assert.match(text, /Video, Playlist & Subscribe/)
      assert.match(text, /Custom Layout/)
    } finally {
      destroy()
    }
  })

  test('Outro duration slider is bounded to YouTube 5-20s', async () => {
    const { el, destroy } = await mount()
    try {
      const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement
      toggle.checked = true
      toggle.dispatchEvent(new Event('change'))
      await nextTick()

      const slider = el.querySelector('#outro-duration-slider') as HTMLInputElement
      assert.equal(slider.min, '5')
      assert.equal(slider.max, '20')
      assert.equal(slider.step, '1')
      assert.equal(slider.value, '20')
      const text = el.textContent || ''
      assert.match(text, /5s \(YouTube minimum\)/)
      assert.match(text, /20s \(YouTube maximum\)/)
    } finally {
      destroy()
    }
  })

  test('Applying a layout template resets end-screen elements to the preset', async () => {
    const { el, destroy } = await mount()
    try {
      const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement
      toggle.checked = true
      toggle.dispatchEvent(new Event('change'))
      await nextTick()

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

  test('Saves end-screen settings through PUT config', async () => {
    const { el, calls, destroy } = await mount()
    try {
      const toggle = el.querySelector('input[type="checkbox"]') as HTMLInputElement
      toggle.checked = true
      toggle.dispatchEvent(new Event('change'))
      await nextTick()

      const slider = el.querySelector('#outro-duration-slider') as HTMLInputElement
      slider.value = '15'
      slider.dispatchEvent(new Event('input'))
      await nextTick()

      const saveBtn = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Save YouTube Settings',
      )
      assert.ok(saveBtn, 'Save YouTube Settings button must render')
      ;(saveBtn as HTMLButtonElement).click()
      await nextTick()
      await new Promise((resolve) => setTimeout(resolve, 5))

      const puts = calls.filter((c) => c.method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0].path, '/projects/test-slug/settings/config')
      assert.ok(puts[0].body.youtube_end_screen)
      assert.equal(puts[0].body.youtube_end_screen.enabled, true)
      assert.equal(puts[0].body.youtube_end_screen.duration_seconds, 15)

      const text = el.textContent || ''
      assert.match(text, /All YouTube channel settings saved\./)
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
