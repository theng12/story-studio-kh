/**
 * The update control sits at the TOP of every Story window — both layouts via
 * AppHeader, plus the layout:false Welcome shell — and is available in EVERY
 * state (loading / current / unavailable). Opening it reaches the existing
 * explicit action path; no click ever installs on its own.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const flush = () => new Promise(r => setTimeout(r, 0))
const vueUrl = import.meta.resolve('vue')
const utilsUrl = import.meta.resolve('../utils/app-update.js')
const intervalUrl = import.meta.resolve('../composables/useVisibleInterval.js')

const bannerSupport = `import { ref, computed, onMounted, onUnmounted, defineComponent as _defineComponent } from ${JSON.stringify(vueUrl)}
import { createVisibleInterval } from ${JSON.stringify(intervalUrl)}
import { INSTALL_IMMEDIATELY_LABEL, canInstallImmediately, installImmediatelyQuestion, installNowQuestion, readyText, waitingText } from ${JSON.stringify(utilsUrl)}
const useApi = () => globalThis.__headerUpdateApi
const useConfirm = () => ({ ask: (...args) => globalThis.__headerUpdateAsk(...args) })`

async function compile(pathname: string, id: string): Promise<any> {
  const source = readFileSync(new URL(pathname, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: pathname })
  const script = compileScript(descriptor, { id, templateOptions: { id, filename: pathname } })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pathname,
    id,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [], `${pathname} template compiles`)
  // Strip every import: the support prelude supplies them by resolved URL
  // (Nuxt's ~/ alias map does not exist in this test process).
  const body = script.content.replace(/^import .*$/gm, '')
  const compiled = await transform(
    `${bannerSupport}\n${body.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render; export default __sfc__`,
    { loader: 'ts', format: 'esm' },
  )
  const dataUrl = `data:text/javascript;base64,${Buffer.from(
    compiled.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`
  return (await import(dataUrl)).default
}

interface Api { calls: { path: string; body?: any }[]; get: (p: string) => Promise<any>; post: (p: string, b?: any) => Promise<any> }

function apiFor(getImpl: (path: string) => Promise<any>, postImpl: (path: string, body?: any) => Promise<any>): Api {
  const calls: Api['calls'] = []
  return {
    calls,
    get: async (path) => { calls.push({ path }); return getImpl(path) },
    post: async (path, body) => { calls.push({ path, body }); return postImpl(path, body) },
  }
}

const READY = {
  phase: 'ready',
  release: { version: '1.4.999' },
  settings: { auto_install: false },
  jobs_left: 0,
}

async function mountBanner(api: Api, ask: (q: any) => Promise<boolean>) {
  ;(globalThis as any).__headerUpdateApi = api
  ;(globalThis as any).__headerUpdateAsk = ask
  const Banner = await compile('../components/AppUpdateBanner.vue', 'app-update-banner')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp(defineComponent({ render: () => h(Banner) }))
  app.component('NuxtLink', defineComponent({ name: 'NuxtLink', props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  app.mount(host)
  await nextTick(); await nextTick(); await nextTick()
  return {
    host,
    trigger: () => host.querySelector<HTMLButtonElement>('[data-testid="app-update-trigger"]')!,
    open: async () => { host.querySelector<HTMLButtonElement>('[data-testid="app-update-trigger"]')!.click(); await flush(); await nextTick() },
    destroy: () => { app.unmount(); host.remove() },
  }
}

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('the control is at the top of every window shell, and the old bottom pill is gone', () => {
  const header = read('../components/AppHeader.vue')
  assert.match(header, /<AppUpdateBanner data-testid="header-update" \/>/, 'AppHeader embeds it in its tools row')
  assert.doesNotMatch(read('../app.vue'), /AppUpdateBanner/, 'the bottom-of-window mount is removed, not duplicated')
  const banner = read('../components/AppUpdateBanner.vue')
  assert.doesNotMatch(banner, /position: fixed/, 'no fixed bottom affordance remains')
  assert.doesNotMatch(banner, /bottom: 16px/, 'the old bottom pill placement is gone')
  const welcome = read('../pages/welcome.vue')
  assert.match(welcome, /definePageMeta\(\{ layout: false \}\)/, 'welcome really is the layout-less shell')
  assert.match(welcome, /<AppUpdateBanner class="welcome-update" \/>/, 'the Welcome shell has its own top control')
})

test('the trigger is icon-only and available in the loading state, never fabricating a version', async () => {
  let resolveGet: (v: any) => void = () => {}
  const pending = new Promise(r => { resolveGet = r })
  const api = apiFor(() => pending, async () => { throw new Error('no install while loading') })
  const { trigger, open, destroy } = await mountBanner(api, async () => true)
  try {
    assert.ok(trigger(), 'the control exists before any status arrives')
    assert.equal(trigger().textContent?.trim(), '', 'icon only — no prose crowding the header')
    assert.match(trigger().title, /Checking for updates/, 'honest loading wording, not a false up-to-date')
    assert.doesNotMatch(trigger().title, /\d+\.\d+\.\d+/, 'no version before one is known')

    resolveGet({ phase: 'idle', current_version: '1.4.5', release: null })
    await flush(); await nextTick()
    assert.match(trigger().title, /Up to date: 1\.4\.5/, 'current state after the read')
    assert.match(trigger().getAttribute('aria-label') || '', /Up to date/, 'state is exposed to assistive tech')

    await open()
    const dialog = host2Dialog(trigger())
    assert.ok(dialog, 'the popover opens from the icon')
    assert.match(dialog.textContent || '', /Update settings/, 'the existing updater path is one click away')
    assert.deepEqual(api.calls.filter(c => c.path === '/app-update/install-now'), [], 'nothing installs by itself')
  } finally { destroy() }
})

function host2Dialog(trigger: HTMLElement): Element | null {
  return trigger.closest('[data-testid="app-update-trigger"]')?.parentElement?.querySelector('[role="dialog"]') ?? null
}

test('a failed status read says unavailable and stays reachable — never hidden', async () => {
  const api = apiFor(async () => { throw new Error('engine down') }, async () => { throw new Error('no install') })
  const { trigger, open, destroy } = await mountBanner(api, async () => true)
  try {
    assert.ok(trigger(), 'the control still renders when the status cannot be read')
    assert.match(trigger().title, /unavailable/i, 'honest unavailable wording')
    await open()
    const dialog = host2Dialog(trigger())
    assert.match(dialog?.querySelector('[role="alert"]')?.textContent || '', /Could not read the update status/, 'the failure says why')
    assert.ok([...dialog!.querySelectorAll('a')].some(a => a.getAttribute('href') === '/settings#app-update'), 'recovery path stays available')
    assert.deepEqual(api.calls.filter(c => c.path === '/app-update/install-now'), [], 'no install on a broken read')
  } finally { destroy() }
})

test('a failed update check never labels the installed version up to date', async () => {
  const api = apiFor(async () => ({ phase: 'idle', current_version: '1.4.5', last_check_error: 'Release feed unavailable' }), async () => { throw new Error('no install') })
  const { trigger, open, destroy } = await mountBanner(api, async () => true)
  try {
    assert.match(trigger().title, /unavailable/i)
    assert.doesNotMatch(trigger().title, /Up to date/)
    await open()
    assert.match(host2Dialog(trigger())?.textContent || '', /Release feed unavailable/)
    assert.ok(trigger().querySelector('.is-danger'))
    assert.deepEqual(api.calls.filter(c => c.path === '/app-update/install-now'), [])
  } finally { destroy() }
})

test('Escape closes the popover and returns focus to the trigger; outside click closes it', async () => {
  const api = apiFor(async () => READY, async () => { throw new Error('no install') })
  const { trigger, open, destroy } = await mountBanner(api, async () => true)
  try {
    await open()
    assert.ok(host2Dialog(trigger()), 'open before Escape')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick()
    assert.ok(host2Dialog(trigger()) === null, 'Escape closes it')
    assert.ok(document.activeElement === trigger(), 'focus returns to the trigger')

    await open()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await nextTick()
    assert.ok(host2Dialog(trigger()) === null, 'outside click closes it')
  } finally { destroy() }
})

test('opening shows the existing action path and a declined install posts nothing', async () => {
  const held = { ...READY, jobs_left: 2 }
  const api = apiFor(async () => held, async () => { throw new Error('install must not be posted without an explicit click') })
  let asked = 0
  const { trigger, open, host, destroy } = await mountBanner(api, async () => { asked += 1; return false })
  try {
    const posts = () => api.calls.filter(c => c.path === '/app-update/install-now')
    assert.deepEqual(posts(), [], 'mounting posts nothing')
    assert.equal(api.calls[0]?.path, '/app-update/status', 'the one existing status endpoint is read')
    assert.match(trigger().title, /ready/i, 'the honest state is on the control')

    await open()
    const dialog = host.querySelector('[role="dialog"]')!
    assert.match(dialog.textContent || '', /Story Studio 1\.4\.999 is ready/, 'it states the real state')

    const install = [...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Install Now')!
    assert.ok(install, 'the existing Install Now action is exposed')
    install.click()
    await flush(); await flush(); await nextTick()
    assert.equal(asked, 1, `the existing confirm still asks first (asked=${asked})`)
    assert.deepEqual(posts(), [], 'a declined install posts nothing — no silent mutation')
    assert.equal(host.querySelector('[role="alert"]'), null, 'a decline is not an error')
    assert.match(host.querySelector('[role="dialog"]')?.textContent || '', /is ready/, 'state unchanged after declining')
  } finally { destroy() }
})

test('a confirmed Install Now posts exactly the existing endpoint and body', async () => {
  const api = apiFor(
    async () => READY,
    async (_path, body) => ({ ...READY, phase: 'installing', _posted: body }),
  )
  const { host, open, destroy } = await mountBanner(api, async () => true)
  try {
    await open()
    const dialog = host.querySelector('[role="dialog"]')!
    ;[...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Install Now')!.click()
    await flush(); await flush(); await flush(); await nextTick()
    const posts = api.calls.filter(c => c.path === '/app-update/install-now')
    assert.equal(posts.length, 1, 'exactly one explicit install request')
    assert.deepEqual(posts[0].body, {}, 'plain Install Now keeps posting {} (never the immediate flag)')
    assert.match(host.textContent || '', /Installing Story Studio 1\.4\.999/, 'the state after posting is honest')
  } finally { destroy() }
})
