/**
 * The Review page (owner, 2026-10-29; compact rows 2026-11-02).
 *
 * What this pins:
 *   - each final plays IN the page through Story's own authenticated range
 *     route, with native controls — one row open at a time, no preload
 *     until opened;
 *   - the page carries no key, bearer or token: the URL it plays is the
 *     server's own final-video route, and the browser holds only the sign-in
 *     cookie the app already issues;
 *   - the copy says a mark is a review note only, never an upload or publish;
 *   - Pass / Needs changes send one decision for that final and show it;
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
      ino: 42,
      review_enabled: true,
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
  app.component('PageTitle', defineComponent({
    props: ['title', 'eyebrow', 'description'],
    setup: (p: any, { slots }: any) => () => h('header', [
      p.eyebrow ? h('span', p.eyebrow) : null,
      h('h1', p.title),
      p.description ? h('p', p.description) : null,
      slots.actions ? slots.actions() : null,
    ]),
  }))
  app.mount(host)
  await flush()
  return { host, app, calls }
}

test('compact rows: each final is a row with Play button, no video loaded until opened', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    // Row exists with the episode title and channel name
    const row = host.querySelector('.rv-row')
    assert.ok(row, 'a compact row is rendered for each final')
    assert.match(row!.textContent || '', /The First Story/)
    assert.match(row!.textContent || '', /Demo Channel/)
    // Video is NOT present until Play is clicked (preload none)
    assert.equal(host.querySelector('video'), null, 'no video element until the row is opened')
    // Play button exists with accessible name
    const playBtn = host.querySelector<HTMLButtonElement>('.rv-btn-play')
    assert.ok(playBtn, 'Play button exists')
    assert.equal(playBtn!.textContent, 'Play')
    assert.match(playBtn!.getAttribute('aria-label') || '', /EP0001/)
    assert.match(playBtn!.getAttribute('aria-label') || '', /The First Story/)
    assert.equal(playBtn!.getAttribute('aria-expanded'), 'false')
  } finally { app.unmount() }
})

test('Play opens one row video at a time through the authenticated route', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    const playBtn = host.querySelector<HTMLButtonElement>('.rv-btn-play')!
    playBtn.click()
    await flush()
    const video = host.querySelector('video')
    assert.ok(video, 'video element appears after Play')
    assert.equal(video!.hasAttribute('controls'), true)
    assert.equal(video!.getAttribute('preload'), 'metadata')
    assert.equal(video!.getAttribute('src'), '/api/projects/demo/video-editor/final-video/EP0001?v=1760000000000-64')
    assert.equal(playBtn.textContent, 'Close')
    assert.equal(playBtn.getAttribute('aria-expanded'), 'true')
    // Clicking again closes
    playBtn.click()
    await flush()
    assert.equal(host.querySelector('video'), null, 'video removed after Close')
  } finally { app.unmount() }
})

test('only one row video open at a time', async () => {
  const { host, app } = await mount({
    channels: [{ slug: 'demo', name: 'Demo Channel', review_enabled: true, final_count: 2 }],
    finals: [
      { channel_slug: 'demo', channel_name: 'Demo Channel', episode_code: 'EP0001', title: 'First', stream_url: '/api/projects/demo/video-editor/final-video/EP0001', size: 64, mtime_ms: 1_760_000_000_000, ino: 42, review_enabled: true, review: { state: 'not_reviewed' } },
      { channel_slug: 'demo', channel_name: 'Demo Channel', episode_code: 'EP0002', title: 'Second', stream_url: '/api/projects/demo/video-editor/final-video/EP0002', size: 64, mtime_ms: 1_760_000_000_000, ino: 43, review_enabled: true, review: { state: 'not_reviewed' } },
    ],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    const plays = host.querySelectorAll<HTMLButtonElement>('.rv-btn-play')
    assert.equal(plays.length, 2)
    plays[0].click()
    await flush()
    assert.equal(host.querySelectorAll('video').length, 1)
    // Opening the second closes the first
    plays[1].click()
    await flush()
    assert.equal(host.querySelectorAll('video').length, 1)
    assert.equal(host.querySelector('video')!.getAttribute('src'), '/api/projects/demo/video-editor/final-video/EP0002')
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
  } finally { app.unmount() }
})

test('Pass sends one decision for that final and shows the mark', async () => {
  const { host, app, calls } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    host.querySelector<HTMLButtonElement>('.rv-btn-ok')!.click()
    await flush()
    assert.deepEqual(calls.posts, [{
      url: '/review/finals/demo/EP0001',
      body: { decision: 'approved', expected_size: 64, expected_mtime_ms: 1_760_000_000_000, expected_ino: 42 },
    }])
    assert.match(host.textContent || '', /Passed/)
  } finally { app.unmount() }
})

test('Needs changes sends the other decision', async () => {
  const { host, app, calls } = await mount(listWithFinal({ state: 'not_reviewed' }))
  try {
    host.querySelector<HTMLButtonElement>('.rv-btn-changes')!.click()
    await flush()
    assert.deepEqual(calls.posts, [{
      url: '/review/finals/demo/EP0001',
      body: { decision: 'needs_changes', expected_size: 64, expected_mtime_ms: 1_760_000_000_000, expected_ino: 42 },
    }])
    assert.match(host.textContent || '', /Needs changes/)
  } finally { app.unmount() }
})

test('Clear auto-pass sends the file identity like Pass does', async () => {
  const { host, app, calls } = await mount(
    listWithFinal({
      state: 'current',
      decision: 'auto_passed',
      decided_at: '2026-10-29T01:00:00.000Z',
      identity: IDENTITY,
    }),
    { review: { state: 'not_reviewed' } },
  )
  try {
    host.querySelector<HTMLButtonElement>('.rv-btn-clear')!.click()
    await flush()
    assert.deepEqual(calls.posts, [{
      url: '/review/finals/demo/EP0001',
      body: { decision: 'clear', expected_size: 64, expected_mtime_ms: 1_760_000_000_000, expected_ino: 42 },
    }])
    assert.match(host.textContent || '', /Not reviewed/)
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
    assert.match(host.textContent || '', /This file changed since it was marked passed/)
    assert.match(host.textContent || '', /Watch it again, then mark it/)
  } finally { app.unmount() }
})

test('an unreadable mark is reported, never shown as "not reviewed"', async () => {
  const { host, app } = await mount(listWithFinal({ state: 'unreadable', error: 'The review mark is not valid JSON: unexpected token' }))
  try {
    assert.match(host.textContent || '', /could not be read/i)
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
    // The switch belongs to the selected channel, so select it first.
    host.querySelector<HTMLButtonElement>('.rv-chip:not(.rv-chip-active)')!.click()
    await flush()
    const toggle = host.querySelector<HTMLInputElement>('.rv-toggle input')!
    assert.ok(toggle, 'selecting the channel offers its review switch')
    assert.equal(toggle.checked, false)
    toggle.checked = true
    toggle.dispatchEvent(new Event('change'))
    await flush()
    assert.deepEqual(calls.puts, [{ url: '/review/channels/demo', body: { enabled: true } }])
    assert.equal(calls.gets, 2, 'turning review on reloads the list')
  } finally { app.unmount() }
})

test('summary line shows count or all-reviewed for the current filter', async () => {
  // Unreviewed items: shows count
  const { host: h1, app: a1 } = await mount({
    channels: [{ slug: 'demo', name: 'Demo', review_enabled: true, final_count: 3 }],
    finals: [
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0001', title: 'A', stream_url: '/a', size: 64, mtime_ms: 3_000, ino: 1, review_enabled: true, review: { state: 'not_reviewed' } },
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0002', title: 'B', stream_url: '/b', size: 64, mtime_ms: 2_000, ino: 2, review_enabled: true, review: { state: 'not_reviewed' } },
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0003', title: 'C', stream_url: '/c', size: 64, mtime_ms: 1_000, ino: 3, review_enabled: true, review: { state: 'current', decision: 'approved', decided_at: '2026-10-29T00:00:00Z', identity: IDENTITY } },
    ],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    assert.match(h1.textContent || '', /2 videos to review/)
    assert.match(h1.textContent || '', /Start with the top one/)
  } finally { a1.unmount() }

  // All reviewed
  const { host: h2, app: a2 } = await mount({
    channels: [{ slug: 'demo', name: 'Demo', review_enabled: true, final_count: 1 }],
    finals: [
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0001', title: 'A', stream_url: '/a', size: 64, mtime_ms: 3_000, ino: 1, review_enabled: true, review: { state: 'current', decision: 'approved', decided_at: '2026-10-29T00:00:00Z', identity: IDENTITY } },
    ],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    assert.match(h2.textContent || '', /All reviewed/)
  } finally { a2.unmount() }
})

test('reviewed rows are visually quieter', async () => {
  const { host, app } = await mount({
    channels: [{ slug: 'demo', name: 'Demo', review_enabled: true, final_count: 2 }],
    finals: [
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0001', title: 'Unreviewed', stream_url: '/a', size: 64, mtime_ms: 3_000, ino: 1, review_enabled: true, review: { state: 'not_reviewed' } },
      { channel_slug: 'demo', channel_name: 'Demo', episode_code: 'EP0002', title: 'Reviewed', stream_url: '/b', size: 64, mtime_ms: 2_000, ino: 2, review_enabled: true, review: { state: 'current', decision: 'approved', decided_at: '2026-10-29T00:00:00Z', identity: IDENTITY } },
    ],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    const rows = host.querySelectorAll('.rv-row')
    assert.equal(rows.length, 2)
    assert.ok(!rows[0].classList.contains('rv-row-reviewed'), 'unreviewed row has no reviewed class')
    assert.ok(rows[1].classList.contains('rv-row-reviewed'), 'reviewed row has quieter class')
  } finally { app.unmount() }
})

test('channel chips sorted unreviewed-first', async () => {
  const { host, app } = await mount({
    channels: [
      { slug: 'alpha', name: 'Alpha', review_enabled: true, final_count: 0 },
      { slug: 'beta', name: 'Beta', review_enabled: true, final_count: 2 },
      { slug: 'gamma', name: 'Gamma', review_enabled: true, final_count: 1 },
    ],
    finals: [
      { channel_slug: 'beta', channel_name: 'Beta', episode_code: 'EP0001', title: 'B1', stream_url: '/b1', size: 64, mtime_ms: 3_000, ino: 1, review_enabled: true, review: { state: 'current', decision: 'approved', decided_at: '2026-10-29T00:00:00Z', identity: IDENTITY } },
      { channel_slug: 'beta', channel_name: 'Beta', episode_code: 'EP0002', title: 'B2', stream_url: '/b2', size: 64, mtime_ms: 2_000, ino: 2, review_enabled: true, review: { state: 'current', decision: 'approved', decided_at: '2026-10-29T00:00:00Z', identity: IDENTITY } },
      { channel_slug: 'gamma', channel_name: 'Gamma', episode_code: 'EP0001', title: 'G1', stream_url: '/g1', size: 64, mtime_ms: 1_000, ino: 3, review_enabled: true, review: { state: 'not_reviewed' } },
    ],
    generated_at: '2026-10-29T00:00:00.000Z',
  })
  try {
    // All-channels chip first, then Gamma (1 unreviewed), Beta (0 unreviewed), Alpha (0 unreviewed)
    const chips = host.querySelectorAll('.rv-chip-name')
    const names = Array.from(chips).map(c => c.textContent)
    assert.deepEqual(names, ['All channels', 'Gamma', 'Alpha', 'Beta'])
  } finally { app.unmount() }
})

test('new finals arrive by the visible-window poll the rest of the app already uses', () => {
  assert.match(pageSource, /createVisibleInterval\(\(\) => \{ void load\(true\) \}, 20_000\)/)
  assert.match(pageSource, /onUnmounted\(\(\) => poller\.stop\(\)\)/)
})