/**
 * The Review page (owner, 2026-10-29: *"when I'm outside, I can just review the
 * video then approve it"*).
 *
 * What this pins:
 *   - each final plays IN the page through Story's own authenticated range
 *     route, with native controls — no download first;
 *   - the page carries no key, bearer or token: the URL it plays is the
 *     server's own final-video route, and the browser holds only the sign-in
 *     cookie the app already issues;
 *   - the copy says a mark is a review note only, never an upload or publish;
 *   - Approve / Needs changes send one decision for that final and show it;
 *   - a mark that no longer matches the file says the file changed;
 *   - a channel with review off lists nothing and offers the switch.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { transform } from 'esbuild'

const pagePath = new URL('../pages/review.vue', import.meta.url)
const pageSource = readFileSync(pagePath, 'utf8')

async function component() {
  const filename = pagePath.pathname
  const { descriptor } = parse(pageSource, { filename })
  const script = compileScript(descriptor, { id: 'review-page' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'review-page',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  // The page's own Nuxt auto-imports are supplied by the support block below.
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = [
    'const definePageMeta = () => undefined;',
    'const useApi = () => globalThis.__reviewApi;',
    'const createVisibleInterval = () => ({ start() {}, stop() {} });',
  ].join('\n')
  const transformed = await transform(`${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`, {
    loader: 'ts',
    format: 'esm',
  })
  const vueUrl = await import.meta.resolve('vue')
  const resolved = transformed.code.replaceAll('"vue"', JSON.stringify(vueUrl))
  return (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).default
}

async function flush() {
  await nextTick()
  await new Promise(resolve => setTimeout(resolve, 0))
  await nextTick()
}

const IDENTITY = {
  version: 1 as const,
  path: '/Library/Demo/episodes/EP0001/video/EP0001_final_video.mp4',
  size: 64,
  mtime_ms: 1_760_000_000_000,
  ino: 42,
  sha256: `sha256:${'a'.repeat(64)}`,
}

interface ListFixture {
  channels: Array<{ slug: string; name: string; review_enabled: boolean; final_count: number; error?: string }>
  finals: Array<Record<string, any>>
  generated_at: string
}

function listWithFinal(review: Record<string, any>): ListFixture {
  return {
    channels: [{ slug: 'demo', name: 'Demo Channel', review_enabled: true, final_count: 1 }],
    finals: [{
      channel_slug: 'demo',
      channel_name: 'Demo Channel',
      episode_code: 'EP0001',
      title: 'The First Story',
      stream_url: '/api/projects/demo/video-editor/final-video/EP0001?v=1760000000000-64',
      size: 64,
      mtime_ms: 1_760_000_000_000,
      review,
    }],
    generated_at: '2026-10-29T00:00:00.000Z',
  }
}

async function mount(list: ListFixture, postResult?: any) {
  const calls = { posts: [] as Array<{ url: string; body: any }>, puts: [] as Array<{ url: string; body: any }>, gets: 0 }
  ;(globalThis as any).__reviewApi = {
    get: async () => { calls.gets += 1; return list },
    post: async (url: string, body: any) => {
      calls.posts.push({ url, body })
      return postResult ?? {
        review: { state: 'current', decision: body.decision, decided_at: '2026-10-29T01:00:00.000Z', identity: IDENTITY },
      }
    },
    put: async (url: string, body: any) => { calls.puts.push({ url, body }); return { ok: true } },
  }
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp) }))
  app.component('PlainBackLink', { render: () => null })
  app.component('NuxtLink', defineComponent({
    props: ['to'],
    setup: (props: any, { slots }: any) => () => h('a', { href: props.to }, slots.default?.()),
  }))
  app.mount(host)
  await flush()
  return { host, app, calls }
}

test('plays each final in place with native controls, through the authenticated route', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    const video = host.querySelector('video')
    assert.ok(video, 'the final must be playable here, not downloaded first')
    assert.equal(video!.hasAttribute('controls'), true)
    assert.equal(video!.getAttribute('preload'), 'metadata')
    assert.equal(video!.getAttribute('src'), '/api/projects/demo/video-editor/final-video/EP0001?v=1760000000000-64')
    assert.match(host.textContent || '', /does not upload, schedule or publish anything/i)
    assert.match(host.textContent || '', /The First Story/)
  } finally { app.unmount() }
})

test('no key, bearer or token appears in the page or in what it renders', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    for (const text of [pageSource, host.innerHTML]) {
      assert.doesNotMatch(text, /\bAuthorization\b/)
      assert.doesNotMatch(text, /\bBearer\b/)
      assert.doesNotMatch(text, /localStorage/)
      assert.doesNotMatch(text, /document\.cookie/)
      assert.doesNotMatch(text, /ssk_[A-Za-z0-9_-]{20,}/)
      assert.doesNotMatch(text, /[?&](api_key|apikey|key|token|access_token)=/i)
    }
    // The only URL the page plays is the server's own final-video route.
    assert.equal(host.querySelector('video')!.getAttribute('src'), '/api/projects/demo/video-editor/final-video/EP0001?v=1760000000000-64')
  } finally { app.unmount() }
})

test('Approve sends one decision for that final and shows the mark', async () => {
  const { host, app, calls } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    host.querySelector<HTMLButtonElement>('.rv-btn-ok')!.click()
    await flush()
    assert.deepEqual(calls.posts, [{
      url: '/review/finals/demo/EP0001',
      body: { decision: 'approved', expected_size: 64, expected_mtime_ms: 1_760_000_000_000 },
    }])
    assert.match(host.textContent || '', /Approved/)
  } finally { app.unmount() }
})

test('Needs changes sends the other decision', async () => {
  const { host, app, calls } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    host.querySelector<HTMLButtonElement>('.rv-btn-changes')!.click()
    await flush()
    assert.deepEqual(calls.posts, [{
      url: '/review/finals/demo/EP0001',
      body: { decision: 'needs_changes', expected_size: 64, expected_mtime_ms: 1_760_000_000_000 },
    }])
    assert.match(host.textContent || '', /Needs changes/)
  } finally { app.unmount() }
})

test('a mark that no longer matches the file says the file changed', async () => {
  const { host, app } = await mount(listWithFinal({
    state: 'stale',
    decision: 'approved',
    decided_at: '2026-10-29T00:00:00.000Z',
    recorded: IDENTITY,
    current: { path: IDENTITY.path, size: 128, mtime_ms: 1_760_000_100_000, ino: 43 },
  }))
  try {
    assert.match(host.textContent || '', /This file changed since it was marked approved/)
    assert.match(host.textContent || '', /Watch it again, then mark it/)
  } finally { app.unmount() }
})

test('an unreadable mark is reported, never shown as "not reviewed"', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'unreadable', error: 'The review mark is not valid JSON: unexpected token' }))
  try {
    assert.match(host.textContent || '', /could not be read/)
    assert.match(host.textContent || '', /unexpected token/)
    assert.doesNotMatch(host.textContent || '', /Not reviewed yet/)
  } finally { app.unmount() }
})

test('a channel with review off lists nothing and offers the switch', async () => {
  const { host, app, calls } = await mount({
    channels: [{ slug: 'demo', name: 'Demo Channel', review_enabled: false, final_count: 0 }],
    finals: [],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    assert.match(host.textContent || '', /No finished videos are waiting/)
    assert.match(host.textContent || '', /Turn review on for a channel above/)
    const toggle = host.querySelector<HTMLInputElement>('.rv-toggle input')!
    assert.equal(toggle.checked, false)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await flush()
    assert.deepEqual(calls.puts, [{ url: '/review/channels/demo', body: { enabled: true } }])
    assert.equal(calls.gets, 2, 'turning review on reloads the list')
  } finally { app.unmount() }
})

test('new finals arrive by the visible-window poll the rest of the app already uses', () => {
  assert.match(pageSource, /createVisibleInterval\(\(\) => \{ void load\(true\) \}, 20_000\)/)
  assert.match(pageSource, /onUnmounted\(\(\) => poller\.stop\(\)\)/)
})
