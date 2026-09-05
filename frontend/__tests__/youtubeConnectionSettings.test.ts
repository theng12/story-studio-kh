import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const componentPath = fileURLToPath(new URL('../components/YouTubeConnectionSettings.vue', import.meta.url))
const source = readFileSync(componentPath, 'utf8')
const uploadPage = readFileSync(new URL('../pages/projects/[slug]/upload.vue', import.meta.url), 'utf8')
const uploadAccounts = readFileSync(new URL('../composables/useUploadAccounts.ts', import.meta.url), 'utf8')

async function loadComponent(): Promise<Component> {
  const { descriptor } = parse(source, { filename: componentPath })
  const script = compileScript(descriptor, { id: 'youtube-connection-settings' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: componentPath,
    id: 'youtube-connection-settings',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, onMounted, onUnmounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__youtubeSettingsApi
    const useConfirm = () => ({ ask: async (options) => globalThis.__youtubeSettingsConfirm(options) })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const APPLICATION = {
  application_id: 'youtube_app_1',
  client_id: 'client-id.apps.googleusercontent.com',
  fingerprint: 'fingerprint-value',
  configured_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
  has_client_secret: true,
}

interface Recorded { method: string; path: string; body?: any }

async function mount(input: {
  application?: typeof APPLICATION | null
  channels?: any[]
  assignment?: any
  confirm?: boolean
  /** Terminal connect status the polled endpoint reports. */
  connectStatus?: any
  /** Simulate the browser blocking the Google sign-in window. */
  popupBlocked?: boolean
  /** Simulate Story's actual context-isolated Electron marker. */
  electron?: boolean
  connectionError?: { code: string; detail: string }
}): Promise<{
  el: HTMLElement
  calls: Recorded[]
  confirms: any[]
  opened: string[]
  navigated: string[]
  openerAtNavigation: unknown[]
  destroy: () => void
}> {
  const calls: Recorded[] = []
  const confirms: any[] = []
  const opened: string[] = []
  const navigated: string[] = []
  const openerAtNavigation: unknown[] = []
  const state = {
    application: input.application === undefined ? APPLICATION : input.application,
    channels: input.channels ?? [],
    assignment: input.assignment ?? null,
  }

  const popup = {
    opener: {} as unknown,
    location: {
      replace(url: string) {
        openerAtNavigation.push(popup.opener)
        navigated.push(url)
      },
    },
    close() {},
  }
  ;(globalThis as any).window.open = (url: string) => {
    opened.push(url)
    return input.popupBlocked ? null : popup
  }
  delete (globalThis as any).window.require
  ;(globalThis as any).window.electron = input.electron ? { isElectron: true } : undefined

  ;(globalThis as any).__youtubeSettingsApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (path === '/youtube/connections') {
        if (input.connectionError) throw { data: input.connectionError }
        return { application: state.application, channels: state.channels, assignments: [] }
      }
      if (path.startsWith('/youtube/connections/channels/connect/')) {
        return input.connectStatus ?? { status: 'error', error: 'no status configured' }
      }
      if (path.endsWith('/youtube/assignment')) return { assignment: state.assignment }
      throw new Error(`unexpected GET ${path}`)
    },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      return { application: APPLICATION, dependent_channel_count: 0, replaced_previous_application: false, assignment: null }
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      return { flow_id: 'flow-1', auth_url: 'https://accounts.google.test/auth' }
    },
    del: async (path: string, options: any) => {
      calls.push({ method: 'DELETE', path, body: options?.body })
    },
  }
  ;(globalThis as any).__youtubeSettingsConfirm = async (options: any) => {
    confirms.push(options)
    return input.confirm !== false
  }

  const Component = await loadComponent()
  const el = document.createElement('div')
  const app = createApp(defineComponent({
    render: () => h(Component as any, { slug: 'demo-project' }),
  }))
  app.mount(el)
  await nextTick()
  await nextTick()
  await nextTick()
  return { el, calls, confirms, opened, navigated, openerAtNavigation, destroy: () => app.unmount() }
}

async function clickConnect(mounted: { el: HTMLElement }): Promise<void> {
  const connect = [...mounted.el.querySelectorAll('button')]
    .find(button => button.textContent!.includes('Connect a YouTube channel'))!
  connect.click()
  for (let i = 0; i < 8; i++) await nextTick()
}

describe('Settings → YouTube', () => {
  test('explains the one-time setup when no OAuth application exists', async () => {
    const mounted = await mount({ application: null })
    assert.match(mounted.el.textContent!, /Google Cloud OAuth application/)
    assert.match(mounted.el.textContent!, /one-time setup/i)
    // No channel step is offered before the application exists.
    assert.match(mounted.el.textContent!, /Save the OAuth application above before connecting a channel/)
    // The Connect action itself must not be offered — checked as a control, not
    // as a substring, so explanatory copy elsewhere cannot satisfy or break it.
    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(b => b.textContent!.includes('Connect a YouTube channel')),
      false,
    )
    mounted.destroy()
  })

  test('requires credential re-entry when the public registry outlives its encrypted secret', async () => {
    const mounted = await mount({
      application: { ...APPLICATION, has_client_secret: false },
      channels: [{ channel_id: 'UC-stale', title: 'Stale', status: 'reconnect_required', assigned_project_slug: null }],
    })
    assert.match(mounted.el.textContent!, /no longer has an available encrypted client secret/i)
    assert.notEqual(mounted.el.querySelector('#youtube-client-secret'), null)
    assert.equal(
      [...mounted.el.querySelectorAll('button')].some(button => button.textContent!.includes('Connect a YouTube channel')),
      false,
    )
    const reconnect = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.trim() === 'Reconnect')!
    assert.equal(reconnect.disabled, true)
    mounted.destroy()
  })

  test('never renders a client secret and clears the draft after saving', async () => {
    const mounted = await mount({ application: null })
    const secretInput = mounted.el.querySelector('#youtube-client-secret') as HTMLInputElement
    assert.equal(secretInput.type, 'password')

    const idInput = mounted.el.querySelector('#youtube-client-id') as HTMLInputElement
    idInput.value = 'client-id.apps.googleusercontent.com'
    idInput.dispatchEvent(new Event('input'))
    secretInput.value = 'super-secret-value'
    secretInput.dispatchEvent(new Event('input'))
    await nextTick()

    const save = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes('Save application'))!
    save.click()
    await nextTick(); await nextTick(); await nextTick()

    const put = mounted.calls.find(call => call.method === 'PUT')!
    assert.equal(put.body.client_secret, 'super-secret-value')
    // The draft is dropped the moment it is stored, and nothing renders it.
    assert.equal((mounted.el.querySelector('#youtube-client-secret') as HTMLInputElement | null)?.value ?? '', '')
    assert.equal(mounted.el.innerHTML.includes('super-secret-value'), false)
    mounted.destroy()
  })

  test('offers only the explicit scoped recovery for a recoverable YouTube secret bucket', async () => {
    const mounted = await mount({
      connectionError: {
        code: 'YOUTUBE_SECRET_RECOVERY_REQUIRED',
        detail: 'The local YouTube credential store needs repair.',
      },
    })
    assert.match(mounted.el.textContent!, /provider API keys, projects/i)
    assert.match(mounted.el.textContent!, /published-video records and history stay in place/i)
    const recover = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes('Remove unusable YouTube credentials'))!
    recover.click()
    await nextTick(); await nextTick(); await nextTick()
    assert.equal(mounted.confirms[0].danger, true)
    assert.equal(
      mounted.calls.some(call => call.method === 'DELETE' && call.path === '/youtube/connections/credential-authority'),
      true,
    )
    mounted.destroy()
  })

  test('does not recover credentials when the destructive confirmation is declined', async () => {
    const mounted = await mount({
      connectionError: { code: 'YOUTUBE_SECRET_RECOVERY_REQUIRED', detail: 'Repair required.' },
      confirm: false,
    })
    const recover = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes('Remove unusable YouTube credentials'))!
    recover.click()
    await nextTick(); await nextTick()
    assert.equal(mounted.calls.some(call => call.method === 'DELETE'), false)
    mounted.destroy()
  })

  test('shows channel health and offers reconnect only for an unhealthy grant', async () => {
    const mounted = await mount({
      channels: [
        { channel_id: 'UC-healthy', title: 'Healthy', status: 'connected', last_refresh_at: '2026-09-01T10:00:00.000Z', assigned_project_slug: 'demo-project' },
        { channel_id: 'UC-stale', title: 'Stale', status: 'reconnect_required', assigned_project_slug: null },
        { channel_id: 'UC-scopes', title: 'Scopes', status: 'scope_upgrade_required', assigned_project_slug: null },
      ],
    })
    const text = mounted.el.textContent!
    assert.match(text, /Connected/)
    assert.match(text, /Reconnect required/)
    assert.match(text, /Permission upgrade required/)
    assert.match(text, /Publishing for demo-project/)
    assert.match(text, /Not assigned to a project/)

    const reconnects = [...mounted.el.querySelectorAll('button')].filter(b => b.textContent!.trim() === 'Reconnect')
    assert.equal(reconnects.length, 2, 'only the two unhealthy grants offer Reconnect')
    mounted.destroy()
  })

  test('offers only channels no other project owns', async () => {
    const mounted = await mount({
      channels: [
        { channel_id: 'UC-free', title: 'Free Channel', status: 'connected', assigned_project_slug: null },
        { channel_id: 'UC-taken', title: 'Taken Channel', status: 'connected', assigned_project_slug: 'another-project' },
        { channel_id: 'UC-stale', title: 'Stale Channel', status: 'reconnect_required', assigned_project_slug: null },
      ],
    })
    const options = [...mounted.el.querySelectorAll('option')].map(option => option.value).filter(Boolean)
    assert.deepEqual(options, ['UC-free'])
    mounted.destroy()
  })

  test('directs an unassigned project to reconnect when only unhealthy channels exist', async () => {
    const mounted = await mount({
      channels: [{ channel_id: 'UC-stale', title: 'Stale Channel', status: 'reconnect_required', assigned_project_slug: null }],
    })
    assert.deepEqual([...mounted.el.querySelectorAll('option')].map(option => option.value).filter(Boolean), [])
    assert.match(mounted.el.textContent!, /Reconnect a channel in step 2/)
    assert.doesNotMatch(mounted.el.textContent!, /belongs to another project/)
    mounted.destroy()
  })

  test('says so plainly when every connected channel belongs elsewhere', async () => {
    const mounted = await mount({
      channels: [{ channel_id: 'UC-taken', title: 'Taken', status: 'connected', assigned_project_slug: 'another-project' }],
    })
    assert.match(mounted.el.textContent!, /Every connected channel already belongs to another project/)
    mounted.destroy()
  })

  test('no channels at all is not reported as every channel being taken', async () => {
    // Found by looking at the real screen: with nothing connected, the panel
    // claimed every connected channel belonged to another project. One empty
    // list was being made to mean two different things.
    const mounted = await mount({ channels: [] })
    assert.doesNotMatch(mounted.el.textContent!, /belongs to another project/)
    assert.match(mounted.el.textContent!, /Connect a YouTube channel in step 2 first/)
    mounted.destroy()
  })

  test('confirms a channel replacement and sends the channel it expects to replace', async () => {
    const mounted = await mount({
      channels: [
        { channel_id: 'UC-old', title: 'Old Channel', status: 'connected', assigned_project_slug: 'demo-project' },
        { channel_id: 'UC-new', title: 'New Channel', status: 'connected', assigned_project_slug: null },
      ],
      assignment: { project_slug: 'demo-project', channel_id: 'UC-old', assigned_at: '2026-09-01T10:00:00.000Z' },
    })

    const select = mounted.el.querySelector('select') as HTMLSelectElement
    select.value = 'UC-new'
    select.dispatchEvent(new Event('change'))
    await nextTick()

    const replace = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.includes('Replace channel'))!
    replace.click()
    await nextTick(); await nextTick(); await nextTick()

    assert.equal(mounted.confirms.length, 1)
    assert.equal(mounted.confirms[0].danger, true)
    assert.match(mounted.confirms[0].message, /Old Channel/)
    assert.match(mounted.confirms[0].message, /New Channel/)

    const put = mounted.calls.find(call => call.method === 'PUT')!
    assert.equal(put.path, '/projects/demo-project/youtube/assignment')
    assert.deepEqual(put.body, { channel_id: 'UC-new', expected_previous_channel_id: 'UC-old' })
    mounted.destroy()
  })

  test('connecting opens the authorization url the server returned and reports success', async () => {
    const mounted = await mount({
      connectStatus: {
        status: 'success',
        channel: { channel_id: 'UC-new', channel_title: 'Brand New' },
        granted_scopes: [],
        scope_upgrade_required: false,
      },
    })
    await clickConnect(mounted)

    assert.deepEqual(mounted.opened, ['about:blank'])
    assert.deepEqual(mounted.navigated, ['https://accounts.google.test/auth'])
    assert.deepEqual(mounted.openerAtNavigation, [null], 'the new tab must be isolated before provider navigation')
    assert.equal(mounted.calls.some(call => call.path === '/youtube/connections/channels/connect'), true)
    assert.match(mounted.el.textContent!, /Brand New connected\./)
    // Success re-reads the registry rather than trusting the poll's payload.
    assert.equal(mounted.calls.filter(call => call.path === '/youtube/connections').length >= 2, true)
    mounted.destroy()
  })

  test('Electron hands Google to the main-process external opener without treating a null proxy as blocked', async () => {
    const mounted = await mount({
      electron: true,
      popupBlocked: true,
      connectStatus: {
        status: 'success',
        channel: { channel_id: 'UC-electron', channel_title: 'Electron Channel' },
        granted_scopes: [],
        scope_upgrade_required: false,
      },
    })
    await clickConnect(mounted)

    assert.deepEqual(mounted.opened, ['https://accounts.google.test/auth'])
    assert.deepEqual(mounted.navigated, [])
    assert.match(mounted.el.textContent!, /Electron Channel connected\./)
    mounted.destroy()
  })

  test('a partial permission grant is reported as a warning, not a plain success', async () => {
    const mounted = await mount({
      connectStatus: {
        status: 'success',
        channel: { channel_id: 'UC-partial', channel_title: 'Partial' },
        granted_scopes: ['https://www.googleapis.com/auth/youtube.upload'],
        scope_upgrade_required: true,
      },
    })
    await clickConnect(mounted)

    const warn = mounted.el.querySelector('.result.warn')
    assert.notEqual(warn, null, 'a partial grant must not be shown as a clean success')
    assert.match(warn!.textContent!, /fewer permissions/i)
    mounted.destroy()
  })

  test('a refused connection shows the server’s reason', async () => {
    const mounted = await mount({
      connectStatus: {
        status: 'error',
        error: 'That Google account authorized a different YouTube channel. Reconnect the same channel.',
        error_code: 'YOUTUBE_CHANNEL_MISMATCH',
      },
    })
    await clickConnect(mounted)

    const error = mounted.el.querySelector('.result.err')
    assert.notEqual(error, null)
    assert.match(error!.textContent!, /authorized a different YouTube channel/)
    mounted.destroy()
  })

  test('a blocked sign-in window says so instead of waiting silently', async () => {
    const mounted = await mount({ popupBlocked: true })
    await clickConnect(mounted)

    const error = mounted.el.querySelector('.result.err')
    assert.notEqual(error, null, 'a blocked popup must be reported')
    assert.match(error!.textContent!, /blocked the Google sign-in window/)
    // It must not create or poll a flow the owner can never complete.
    assert.equal(mounted.calls.some(call => call.method === 'POST' && call.path.endsWith('/channels/connect')), false)
    mounted.destroy()
  })

  test('a declined disconnect changes nothing', async () => {
    const mounted = await mount({
      channels: [{ channel_id: 'UC-one', title: 'One', status: 'connected', assigned_project_slug: null }],
      confirm: false,
    })
    const disconnect = [...mounted.el.querySelectorAll('button')]
      .find(button => button.textContent!.trim() === 'Disconnect')!
    disconnect.click()
    await nextTick(); await nextTick()
    assert.match(mounted.confirms[0].message, /removes only the local credential/i)
    assert.match(mounted.confirms[0].message, /Google Account permissions/i)

    assert.equal(mounted.confirms.length, 1)
    assert.equal(mounted.calls.some(call => call.method === 'DELETE'), false)
    mounted.destroy()
  })
})

describe('Settings → YouTube boundaries', () => {
  test('is the only active frontend connection workflow', () => {
    assert.match(uploadPage, /settings#youtube/)
    assert.match(uploadPage, /Manage YouTube connection/)
    assert.doesNotMatch(uploadPage + uploadAccounts, /upload\/oauth\/(?:start|status)|upload\/oauth-client/)
    assert.doesNotMatch(uploadPage, /revoked on Google|tokens are revoked/i)
  })

  test('does not display quota — quota belongs to the Upload Center', () => {
    // Settings may EXPLAIN that quota belongs to the Cloud project (spec §6);
    // it must not read or render any quota figure. Assert the behaviour, not
    // the word: no quota endpoint, no bucket, no ceiling, no reset time.
    assert.doesNotMatch(source, /['"`][^'"`]*quota[^'"`]*['"`]\s*\)/i, 'no quota request path')
    assert.doesNotMatch(source, /video_uploads|other_endpoints|quota_bucket|units? (?:used|remaining)|resets? at/i)
    assert.doesNotMatch(source, /\/youtube\/quota|quotaSnapshot|readYouTubeQuota/)
  })

  test('does not touch upload mode or automatic scheduling', () => {
    assert.doesNotMatch(source, /upload_mode|auto_schedule_on_render|scheduled_upload/)
  })

  test('never reads a secret back from the server', () => {
    // The application view exposes only whether a secret is stored.
    assert.doesNotMatch(source, /client_secret_masked|application\.client_secret/)
    assert.match(source, /has_client_secret/)
  })
})
