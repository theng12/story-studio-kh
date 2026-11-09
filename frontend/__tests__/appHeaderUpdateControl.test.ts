/**
 * The update control lives at the TOP of every Story window (AppHeader, used
 * by both layouts), replacing the old fixed bottom pill: opening it must reach
 * the existing explicit action path, and no click may ever install on its own.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const flush = () => new Promise(r => setTimeout(r, 0))

const vueUrl = import.meta.resolve('vue')
const bannerUrl = import.meta.resolve('../components/AppUpdateBanner.vue')
const utilsUrl = import.meta.resolve('../utils/app-update.js')
const intervalUrl = import.meta.resolve('../composables/useVisibleInterval.js')

async function compile(pathname: string, id: string, support: string): Promise<any> {
  const source = readFileSync(new URL(pathname, import.meta.url), 'utf8')
  const { descriptor } = parse(source, { filename: pathname })
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pathname,
    id,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  assert.deepEqual(template.errors, [], `${pathname} template compiles`)
  // Strip every import (vue, ~/…): the support prelude above supplies them by
  // resolved URL, which is what keeps this runnable without Nuxt's alias map.
  const body = script.content.replace(/^import .*$/gm, '')
  const compiled = await transform(
    `${support}\n${body.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render; export default __sfc__`,
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

const bannerSupport = `import { ref, computed, onMounted, onUnmounted, defineComponent as _defineComponent } from ${JSON.stringify(vueUrl)}
import { createVisibleInterval } from ${JSON.stringify(intervalUrl)}
import { INSTALL_IMMEDIATELY_LABEL, canInstallImmediately, installImmediatelyQuestion, installNowQuestion, readyText, waitingText } from ${JSON.stringify(utilsUrl)}
const useApi = () => globalThis.__headerUpdateApi
const useConfirm = () => ({ ask: (...args) => globalThis.__headerUpdateAsk(...args) })`

async function mountBanner(api: Api, ask: (q: any) => Promise<boolean>) {
  ;(globalThis as any).__headerUpdateApi = api
  ;(globalThis as any).__headerUpdateAsk = ask
  const Banner = await compile('../components/AppUpdateBanner.vue', 'app-update-banner', bannerSupport)
  const host = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Banner) }))
  app.component('NuxtLink', defineComponent({ name: 'NuxtLink', props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  app.mount(host)
  await nextTick(); await nextTick(); await nextTick()
  return { host, destroy: () => app.unmount() }
}

test('the status pill sits at the top of the window, and the old bottom pill is gone', async () => {
  // Both layouts (default + dashboard) render AppHeader at the top of the page.
  const header = readFileSync(new URL('../components/AppHeader.vue', import.meta.url), 'utf8')
  assert.match(header, /<AppUpdateBanner data-testid="header-update" \/>/, 'AppHeader embeds the control in its tools row')
  assert.match(header, /\.app-header-tools \{[^}]*\n/m, 'the tools row still exists as the anchor')
  // Only one mount point app-wide: app.vue no longer owns a bottom banner.
  const appSource = readFileSync(new URL('../app.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(appSource, /AppUpdateBanner/, 'the bottom-of-window mount is removed, not duplicated')
  const bannerSource = readFileSync(new URL('../components/AppUpdateBanner.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(bannerSource, /position: fixed/, 'no fixed bottom affordance remains')
  assert.doesNotMatch(bannerSource, /bottom: 16px/, 'the old bottom pill placement is gone')
})

test('opening the control shows the existing action path and never installs by itself', async () => {
  // A queue holding jobs is what makes the existing path ask first
  // (installNowQuestion returns null when nothing would be interrupted).
  const held = { ...READY, jobs_left: 2 }
  const api = apiFor(async () => held, async () => { throw new Error('install must not be posted without an explicit click') })
  let asked = 0
  const { host, destroy } = await mountBanner(api, async () => { asked += 1; return false })
  try {
    const posts = () => api.calls.filter(c => c.path === '/app-update/install-now')
    assert.deepEqual(posts(), [], 'mounting posts nothing')
    assert.equal(api.calls[0]?.path, '/app-update/status', 'the one existing status endpoint is read')
    assert.equal(posts().length, 0, 'the status poll never installs')

    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="app-update-trigger"]')
    assert.ok(trigger, 'the trigger renders')
    assert.match(trigger!.title, /ready/i, 'the honest state is on the control')
    assert.equal(trigger!.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(host.querySelector('[role="dialog"]'), null, 'closed by default')

    trigger!.click()
    await flush(); await nextTick()
    const dialog = host.querySelector('[role="dialog"]')
    assert.ok(dialog, 'the button opens the popover')
    assert.match(dialog!.textContent || '', /Story Studio 1\.4\.999 is ready/, 'it states the real state')

    const [install] = [...dialog!.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'Install Now')
    assert.ok(install, 'the existing Install Now action is exposed')
    install!.click()
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
  const { host, destroy } = await mountBanner(api, async () => true)
  try {
    host.querySelector<HTMLButtonElement>('[data-testid="app-update-trigger"]')!.click()
    await nextTick()
    const dialog = host.querySelector('[role="dialog"]')!
    ;[...dialog.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Install Now')!.click()
    await flush(); await flush(); await flush(); await nextTick()
    const posts = api.calls.filter(c => c.path === '/app-update/install-now')
    assert.equal(posts.length, 1, 'exactly one explicit install request')
    assert.deepEqual(posts[0].body, {}, 'plain Install Now keeps posting {} (never the immediate flag)')
    assert.match(host.textContent || '', /Installing Story Studio 1\.4\.999/, 'the state after posting is honest')
  } finally { destroy() }
})