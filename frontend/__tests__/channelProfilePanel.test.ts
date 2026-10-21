import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

/**
 * The channel profile panel — Settings → This Channel → Channel identity.
 *
 * The panel owns the channel's name, handle, description, logo and banner. The
 * contract it codes against:
 *   GET    /projects/:slug/channel-profile          -> flat profile
 *   PUT    /projects/:slug/channel-profile          -> {name?, handle?, description?} only
 *   POST   /projects/:slug/channel-profile/:kind    -> {filename, data_base64}
 *   DELETE /projects/:slug/channel-profile/:kind    -> flat profile
 * A flat profile is {name, handle, description, logo_url, banner_url}.
 */

const PROFILE = {
  name: 'History Explained',
  handle: 'history.explained',
  description: 'Evidence-led history with a clear causal arc.',
  logo_url: '/api/projects/history-explained/channel-profile/asset/logo?v=abc123',
  banner_url: '/api/projects/history-explained/channel-profile/asset/banner?v=def456',
}

const OTHER_PROFILE = {
  name: 'Second Channel',
  handle: '',
  description: '',
  logo_url: null,
  banner_url: null,
}

interface HarnessOptions {
  slug?: string
  profiles?: Record<string, any>
  putError?: any
  postError?: any
  delError?: any
  /** Hold the first read open, so a stale answer can be delivered later. */
  holdFirstGet?: boolean
}

interface Call { method: string; path: string; body?: any }

let panelComponent: Promise<Component> | undefined
async function loadPanel(): Promise<Component> {
  if (panelComponent) return panelComponent
  panelComponent = (async () => {
    const filename = fileURLToPath(new URL('../components/ChannelProfilePanel.vue', import.meta.url))
    const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
    const script = compileScript(descriptor, { id: 'channel-profile-panel-test' })
    const template = compileTemplate({
      source: descriptor.template!.content,
      filename,
      id: 'channel-profile-panel-test',
      compilerOptions: { bindingMetadata: script.bindings },
    })
    const vueUrl = await import.meta.resolve('vue')
    const support = `
      import { computed, nextTick, reactive, ref, watch } from ${JSON.stringify(vueUrl)}
      const useApi = () => globalThis.__channelProfileHarness.api()
      const useToast = () => globalThis.__channelProfileHarness.toast()
    `
    const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
    const transformed = await transform(code, { loader: 'ts', format: 'esm' })
    return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
  })()
  return panelComponent
}

/** A FileReader that answers with fixed bytes — happy-dom's own one is not needed. */
class StubFileReader {
  result: string | null = null
  error: any = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readAsDataURL(_file: any): void {
    this.result = 'data:image/png;base64,QUJD'
    queueMicrotask(() => this.onload?.())
  }
}

async function flush(): Promise<void> {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

async function mountPanel(options: HarnessOptions = {}) {
  const profiles = options.profiles || { 'history-explained': PROFILE }
  const calls: Call[] = []
  const toasts: Array<{ type: string; message: string }> = []
  const saved: any[] = []
  let getCount = 0
  const held: { resolve?: (value: any) => void } = {}

  const api = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      getCount += 1
      if (options.holdFirstGet && getCount === 1) {
        return new Promise((resolve) => { held.resolve = resolve })
      }
      const slug = path.split('/')[2]
      const found = profiles[slug]
      if (!found) throw { data: { detail: 'Project not found' } }
      return found
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (options.postError) throw options.postError
      return { ...PROFILE, logo_url: '/api/projects/history-explained/channel-profile/asset/logo?v=new' }
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      if (options.putError) throw options.putError
      return { ...PROFILE, ...body }
    },
    del: async (path: string) => {
      calls.push({ method: 'DELETE', path })
      if (options.delError) throw options.delError
      return { ...PROFILE, banner_url: null }
    },
  }

  ;(globalThis as any).__channelProfileHarness = {
    api: () => api,
    toast: () => ({
      success: (message: string) => toasts.push({ type: 'success', message }),
      error: (message: string) => toasts.push({ type: 'error', message }),
    }),
  }
  const previousFileReader = (globalThis as any).FileReader
  ;(globalThis as any).FileReader = StubFileReader

  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const slug = ref(options.slug || 'history-explained')
  const Panel = await loadPanel()
  const Wrapper = defineComponent({
    setup() {
      return () => h(Panel, {
        slug: slug.value,
        onSaved: (profile: any) => saved.push(profile),
      })
    },
  })
  const app = createApp(Wrapper)
  app.mount(host)
  await flush()

  return {
    host, calls, toasts, saved,
    setSlug: async (next: string) => { slug.value = next; await flush() },
    /** Deliver the answer of the read that was held open. */
    resolveHeld: async (value: any) => { held.resolve?.(value); await flush() },
    unmount: () => {
      app.unmount()
      delete (globalThis as any).__channelProfileHarness
      ;(globalThis as any).FileReader = previousFileReader
    },
  }
}

function text(host: HTMLElement): string {
  return host.textContent || ''
}

function input(host: HTMLElement, id: string): HTMLInputElement {
  const found = host.querySelector<HTMLInputElement>(`#${id}`)
  assert.ok(found, `expected input #${id}`)
  return found
}

function button(host: HTMLElement, label: RegExp): HTMLButtonElement {
  const found = [...host.querySelectorAll<HTMLButtonElement>('button')].find(candidate => label.test(candidate.textContent || ''))
  assert.ok(found, `expected button ${label}`)
  return found
}

async function typeInto(host: HTMLElement, id: string, value: string): Promise<void> {
  const field = input(host, id)
  field.value = value
  field.dispatchEvent(new Event('input'))
  await flush()
}

test('shows the channel profile it read — name, handle and description', async () => {
  const mounted = await mountPanel()
  try {
    assert.ok(text(mounted.host).includes('History Explained'))
    assert.ok(text(mounted.host).includes('@history.explained'))
    assert.ok(text(mounted.host).includes('Evidence-led history'))
    assert.ok(mounted.host.querySelector('img[src*="asset/logo"]'))
    assert.ok(mounted.host.querySelector('img[src*="asset/banner"]'))
  } finally {
    mounted.unmount()
  }
})

test('saves only the three writable fields — the asset URLs are read-only', async () => {
  const mounted = await mountPanel()
  try {
    await typeInto(mounted.host, 'channel-profile-name', 'History Explained Remastered')
    await typeInto(mounted.host, 'channel-profile-handle', '@history.explained')
    await typeInto(mounted.host, 'channel-profile-description', 'A tighter arc.')
    button(mounted.host, /Save profile/).click()
    await flush()

    const put = mounted.calls.find(call => call.method === 'PUT')
    assert.ok(put, 'expected a PUT to the channel profile route')
    assert.equal(put.path, '/projects/history-explained/channel-profile')
    assert.deepEqual(Object.keys(put.body).sort(), ['description', 'handle', 'name'])
    assert.equal(put.body.name, 'History Explained Remastered')
    assert.equal(put.body.handle, '@history.explained')
    assert.equal(put.body.description, 'A tighter arc.')
    assert.ok(mounted.toasts.some(toast => toast.type === 'success'))
  } finally {
    mounted.unmount()
  }
})

test('says why a save failed instead of failing quietly', async () => {
  const mounted = await mountPanel({
    putError: { data: { detail: 'That handle is already taken.' } },
  })
  try {
    await typeInto(mounted.host, 'channel-profile-name', 'Another name')
    button(mounted.host, /Save profile/).click()
    await flush()

    const alert = mounted.host.querySelector('[role="alert"]')
    assert.ok(alert, 'expected an alert with the failure')
    assert.ok((alert?.textContent || '').includes('That handle is already taken.'))
    assert.ok(mounted.toasts.some(toast => toast.type === 'error'))
  } finally {
    mounted.unmount()
  }
})

test('a handle with spaces never leaves this Mac', async () => {
  const mounted = await mountPanel()
  try {
    await typeInto(mounted.host, 'channel-profile-handle', 'two words')
    button(mounted.host, /Save profile/).click()
    await flush()

    assert.equal(mounted.calls.filter(call => call.method === 'PUT').length, 0)
    const alert = mounted.host.querySelector('[role="alert"]')
    assert.ok((alert?.textContent || '').includes('no spaces'))
  } finally {
    mounted.unmount()
  }
})

test('uploads a logo as base64 to the channel-profile logo route', async () => {
  const mounted = await mountPanel()
  try {
    const field = input(mounted.host, 'channel-profile-logo-file')
    Object.defineProperty(field, 'files', {
      configurable: true,
      value: [{ name: 'logo.png', type: 'image/png', size: 3 }],
    })
    field.dispatchEvent(new Event('change'))
    await flush()

    const post = mounted.calls.find(call => call.method === 'POST')
    assert.ok(post, 'expected a POST for the logo')
    assert.equal(post.path, '/projects/history-explained/channel-profile/logo')
    assert.equal(post.body.filename, 'logo.png')
    assert.equal(post.body.data_base64, 'QUJD')
  } finally {
    mounted.unmount()
  }
})

test('refuses an image that is not a PNG, JPEG or WebP before sending it', async () => {
  const mounted = await mountPanel()
  try {
    const field = input(mounted.host, 'channel-profile-logo-file')
    Object.defineProperty(field, 'files', {
      configurable: true,
      value: [{ name: 'logo.gif', type: 'image/gif', size: 3 }],
    })
    field.dispatchEvent(new Event('change'))
    await flush()

    assert.equal(mounted.calls.filter(call => call.method === 'POST').length, 0)
    const alert = mounted.host.querySelector('[role="alert"]')
    assert.ok((alert?.textContent || '').includes('PNG'))
  } finally {
    mounted.unmount()
  }
})

test('removing the banner clears the reference on the server', async () => {
  const mounted = await mountPanel()
  try {
    button(mounted.host, /Remove banner/).click()
    await flush()

    const del = mounted.calls.find(call => call.method === 'DELETE')
    assert.ok(del, 'expected a DELETE for the banner')
    assert.equal(del.path, '/projects/history-explained/channel-profile/banner')
  } finally {
    mounted.unmount()
  }
})

test('another channel on screen replaces the profile — the last one never stands', async () => {
  const mounted = await mountPanel({
    profiles: { 'history-explained': PROFILE, 'second-channel': OTHER_PROFILE },
  })
  try {
    assert.ok(text(mounted.host).includes('History Explained'))
    await mounted.setSlug('second-channel')
    assert.ok(text(mounted.host).includes('Second Channel'))
    assert.equal(text(mounted.host).includes('Evidence-led history'), false)
    assert.equal(mounted.host.querySelector('img[src*="asset/logo"]'), null)
  } finally {
    mounted.unmount()
  }
})

test('an unsaved name edit survives a logo upload', async () => {
  const mounted = await mountPanel()
  try {
    await typeInto(mounted.host, 'channel-profile-name', 'Half-typed name')
    const field = input(mounted.host, 'channel-profile-logo-file')
    Object.defineProperty(field, 'files', {
      configurable: true,
      value: [{ name: 'logo.png', type: 'image/png', size: 3 }],
    })
    field.dispatchEvent(new Event('change'))
    await flush()

    // The art answer says nothing about the text — the edit is still the user's.
    assert.equal(input(mounted.host, 'channel-profile-name').value, 'Half-typed name')
    assert.equal(mounted.calls.filter(call => call.method === 'PUT').length, 0)
  } finally {
    mounted.unmount()
  }
})

test('a stale answer from a channel you already left never lands', async () => {
  const mounted = await mountPanel({
    holdFirstGet: true,
    profiles: { 'history-explained': PROFILE, 'second-channel': OTHER_PROFILE },
  })
  try {
    await mounted.setSlug('second-channel')
    assert.ok(text(mounted.host).includes('Second Channel'))
    await mounted.setSlug('history-explained')
    assert.ok(text(mounted.host).includes('History Explained'))

    // The read that was left behind finally answers, with content from before.
    await mounted.resolveHeld({ ...PROFILE, name: 'Stale Channel' })
    assert.equal(text(mounted.host).includes('Stale Channel'), false)
    assert.ok(text(mounted.host).includes('History Explained'))
  } finally {
    mounted.unmount()
  }
})

test('art that cannot be shown falls back to the initials', async () => {
  const mounted = await mountPanel()
  try {
    const logo = mounted.host.querySelector('img[src*="asset/logo"]')
    assert.ok(logo, 'expected the logo image')
    logo!.dispatchEvent(new Event('error'))
    await flush()

    assert.equal(mounted.host.querySelector('img[src*="asset/logo"]'), null)
    const initials = mounted.host.querySelector('.channel-preview-initials')
    assert.ok(initials, 'expected the initials to stand in for the missing logo')
    assert.equal((initials?.textContent || '').trim(), 'HE')
  } finally {
    mounted.unmount()
  }
})
