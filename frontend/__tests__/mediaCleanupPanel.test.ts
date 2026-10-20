import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, mock, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  } })
})

async function component() {
  const filename = new URL('../components/MediaCleanupPanel.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'cleanup' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'cleanup', compilerOptions: { bindingMetadata: script.bindings } })
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = `const useApi = () => globalThis.__cleanupApi; const useConfirm = () => ({ask: (...args) => globalThis.__cleanupAsk(...args)});`
  const transformed = await transform(`${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
}
async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function mount(api: any, ask: any = async () => true, slugRef: any = ref('first'), retentionState: any = retentionOn) {
  // The panel reads the automatic-retention setting on mount; a test that does not care
  // about it gets the saved state here rather than having to answer the URL itself.
  const base = api.get
  ;(globalThis as any).__cleanupApi = { ...api, get: (url: string) => url.endsWith('/trash/retention') ? retentionState : base(url) }
  ;(globalThis as any).__cleanupAsk = ask
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp, { slug: slugRef.value }) }))
  app.mount(host); await flush(); await flush(); await flush()
  return { host, close: () => { app.unmount(); host.remove() } }
}
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  assert.ok(node, `button ${label} exists`); return node
}
/** The one confirm button inside the review block (its label can match the action button). */
function confirmButton(host: HTMLElement) {
  const node = host.querySelector<HTMLButtonElement>('.cleanup-actions .btn-primary')
  assert.ok(node, 'review confirm button exists'); return node
}
const space = { free_bytes: 5 * 1024 ** 3, project_trash_bytes: 2 * 1024 ** 3, library_trash_bytes: 3 * 1024 ** 3, app_trash_bytes: 1024 ** 3 }
/** The one automatic-retention setting, as Story → Trash writes it and this panel reads it. */
const retentionOn = { auto_cleanup_enabled: true, last_auto_cleanup: { at: '2026-10-18T09:00:00.000Z', status: 'completed', detail: 'Moved 3 items to Story\'s Trash.' } }
const shrinkFile = { path: '/Library/chan-a/EP0001/s001.png', relative_path: 's001.png', bytes: 2048, category: 'images', project_slug: 'chan-a', channel_name: 'Channel A', episode_code: 'EP0001', production_ms: null }
const shrinkPreview = {
  preview_id: 'lib-1', action: 'shrink_images', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
  channels: [{ slug: 'chan-a', name: 'Channel A', files: [shrinkFile], file_count: 1, total_bytes: 2048, blocked_reasons: [] }],
  file_count: 1, total_bytes: 2048, blocked_reasons: [], trash_roots: ['/Library/_trash'], already_cleaned_episodes: 0,
  estimate: { compress_files: 1, compress_bytes_before: 2048, compress_bytes_after: 240, already_jpeg_files: 0, trash_files: 0, trash_bytes: 0 },
}
const finalFile = { path: '/Library/chan-a/EP0001/final.mp4', relative_path: 'final.mp4', bytes: 3 * 1024 ** 3, category: 'final_video', project_slug: 'chan-a', channel_name: 'Channel A', episode_code: 'EP0001', production_ms: Date.now() - 10 * 24 * 3600 * 1000 }
const cleanupPreview = {
  preview_id: 'lib-2', action: 'cleanup_all', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 600_000).toISOString(),
  channels: [{ slug: 'chan-a', name: 'Channel A', files: [finalFile], file_count: 1, total_bytes: 3 * 1024 ** 3, blocked_reasons: [] }],
  file_count: 1, total_bytes: 3 * 1024 ** 3, blocked_reasons: [], trash_roots: ['/Library/_trash'], already_cleaned_episodes: 0,
  estimate: { compress_files: 0, compress_bytes_before: 0, compress_bytes_after: 0, already_jpeg_files: 0, trash_files: 1, trash_bytes: 3 * 1024 ** 3 },
  leftovers: { count: 2, total_bytes: 50 * 1024 ** 2, items: [
    { project_slug: 'chan-a', channel_name: 'Channel A', kind: 'render_scratch', episode_code: 'EP0001', path: '/tmp/x', bytes: 30 * 1024 ** 2 },
    { project_slug: 'chan-a', channel_name: 'Channel A', kind: 'audio_quality_copy', episode_code: 'EP0001', path: '/tmp/y', bytes: 20 * 1024 ** 2 },
  ] },
}
const libraryOperation = (action: string, preview: any) => ({ id: 'lib-op', project_slug: '*', kind: 'preview', status: 'completed', stage: null, done: 1, total: 1, current: '', library: true, library_action: action, library_preview: preview })

test('the panel offers exactly the two all-channel actions and none of the removed per-channel tools', async () => {
  const ui = await mount({ get: async (url: string) => url.endsWith('/space') ? space : {}, post: async () => ({}) })
  try {
    const text = ui.host.textContent || ''
    assert.ok(button(ui.host, 'Shrink Images (All Channels)'))
    assert.ok(button(ui.host, 'Clean Up All Channels'))
    for (const gone of ['This channel only', 'Other ways', 'Choose exactly which files', 'Convert PNG scenes to JPEG', 'Find Leftover Files', 'Free Up Space for', 'Select All Uploaded', 'Review Selected Files', 'Clear Uploaded Videos']) {
      assert.doesNotMatch(text, new RegExp(gone.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${gone} is removed`)
    }
    assert.match(text, /Free on this drive: 5\.00 GB/)
    assert.match(text, /Whole Trash: 3\.00 GB/)
  } finally { ui.close() }
})

test('Shrink images: previews every channel, confirms once, then runs the reviewed library action', async () => {
  const calls: any[] = []
  const asked: string[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : url.includes('/library/media-cleanup/operations/') ? libraryOperation('shrink_images', shrinkPreview) : {},
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.includes('/library/media-cleanup/preview') ? 'lib-op' : 'run-op' } },
  }, async (options: any) => { asked.push(options.title); return true })
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    assert.deepEqual(calls[0], { url: '/library/media-cleanup/preview', body: { action: 'shrink_images', check_again: false } })
    const text = ui.host.textContent || ''
    assert.match(text, /Shrink 1 file across 1 channel/)
    assert.match(text, /Channel A/)
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    assert.equal(asked.includes('Shrink scene images on 1 channel?'), true, 'the whole library is confirmed first')
    assert.deepEqual(calls[1], { url: '/library/media-cleanup/run', body: { preview_id: 'lib-1' } })
  } finally { ui.close() }
})

test('Clean up all channels: reports uploaded videos and leftovers separately, then runs one merged action', async () => {
  const calls: any[] = []
  const asked: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : url.includes('/library/media-cleanup/operations/') ? libraryOperation('cleanup_all', cleanupPreview) : {},
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.includes('/library/media-cleanup/preview') ? 'lib-op' : 'run-op' } },
  }, async (options: any) => { asked.push(options); return true })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    assert.deepEqual(calls[0], { url: '/library/media-cleanup/preview', body: { action: 'cleanup_all', check_again: false } })
    const text = ui.host.textContent || ''
    assert.match(text, /Clean up all channels · 1 uploaded video \(3\.00 GB\) \+ 2 leftover folders \(50\.0 MB\)/)
    assert.match(text, /Leftover files · 2 · 50\.0 MB/)
    assert.match(text, /produced /)
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    assert.equal(asked.at(-1).title, 'Clean up all channels?')
    assert.match(asked.at(-1).message, /1 uploaded final video/)
    assert.match(asked.at(-1).message, /2 unused leftover folders/)
    assert.deepEqual(calls[1], { url: '/library/media-cleanup/run', body: { preview_id: 'lib-2' } })
  } finally { ui.close() }
})

test('the review says how many episodes were already cleaned, and "Check every episode again" is opt-in and sent with the check', async () => {
  const calls: any[] = []
  const skipped = { ...cleanupPreview, already_cleaned_episodes: 12 }
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : url.includes('/library/media-cleanup/operations/') ? libraryOperation('cleanup_all', skipped) : {},
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.includes('/library/media-cleanup/preview') ? 'lib-op' : 'run-op' } },
  })
  try {
    const box = ui.host.querySelector<HTMLInputElement>('.cleanup-recheck input')
    assert.ok(box, 'the "check every episode again" option is offered')
    assert.match(ui.host.textContent || '', /Check every episode again/)
    assert.equal(box.checked, false, 'a full check is opt-in')

    box.checked = true
    box.dispatchEvent(new Event('change'))
    await flush()
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()

    assert.deepEqual(calls[0], { url: '/library/media-cleanup/preview', body: { action: 'cleanup_all', check_again: true } })
    assert.match(ui.host.textContent || '', /12 episodes already cleaned, skipped/)
  } finally { ui.close() }
})

test('a channel whose files are too many to send shows its real count and a sample, not the whole list', async () => {
  const asked: any[] = []
  const manyFiles = {
    ...cleanupPreview,
    file_count: 24_118,
    channels: [{ slug: 'chan-a', name: 'Channel A', files: [finalFile], file_count: 24_118, total_bytes: 3 * 1024 ** 3, blocked_reasons: [] }],
  }
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : url.includes('/library/media-cleanup/operations/') ? libraryOperation('cleanup_all', manyFiles) : {},
    post: async (url: string) => ({ operation_id: url.includes('/library/media-cleanup/preview') ? 'lib-op' : 'run-op' }),
  }, async (options: any) => { asked.push(options); return true })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    const text = ui.host.textContent || ''
    assert.match(text, /24118 uploaded videos/, 'the header carries the real count')
    assert.match(text, /Channel A · 24118 files/)
    assert.match(text, /and 24117 more files in this channel/)
    // The confirm text must keep the real count, not the size of the sample.
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    assert.match(asked.at(-1).message, /24118 uploaded final videos/)
  } finally { ui.close() }
})

test('declining the confirmation runs nothing', async () => {
  const calls: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : url.includes('/library/media-cleanup/operations/') ? libraryOperation('shrink_images', shrinkPreview) : {},
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: 'lib-op' } },
  }, async () => false)
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    for (let i = 0; i < 3; i++) await flush()
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 0, 'a declined confirmation must not run cleanup')
  } finally { ui.close() }
})

test('the panel claims nothing until the confirmation is accepted, and one accepted review posts one run', async () => {
  const calls: any[] = []
  let approve: (value: boolean) => void = () => {}
  const ask = () => new Promise<boolean>(resolve => { approve = resolve })
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : libraryOperation('shrink_images', shrinkPreview),
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: 'run-op' } },
  }, ask)
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    // Opening the confirmation must not claim the run already started — the defect the owner saw
    // (a review reading "Starting…" behind the modal the instant its button was pressed).
    confirmButton(ui.host).click(); await flush()
    assert.equal(confirmButton(ui.host).textContent?.trim(), 'Confirming…', 'an open confirmation is not "Starting…"')
    assert.doesNotMatch(ui.host.textContent || '', /Starting…/, 'nothing claims to be starting before the owner approves')
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 0, 'nothing is posted before approval')
    // A repeat click while the confirmation is open must not open a second dialog or post.
    confirmButton(ui.host).click(); await flush()
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 0, 'a repeat click still posts nothing')
    // Accepting is the change the owner sees: the panel locks, reads Starting…, and posts the one
    // reviewed operation exactly once.
    approve(true)
    for (let i = 0; i < 5; i++) await flush()
    const runs = calls.filter(c => c.url.endsWith('/run'))
    assert.equal(runs.length, 1, 'one accepted review posts exactly one run')
    assert.deepEqual(runs[0].body, { preview_id: 'lib-1' })
  } finally { ui.close() }
})

test('a running all-channel operation shows progress and Stop stops it', async () => {
  const posts: string[] = []
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      if (url.includes('/library/media-cleanup/operations/')) {
        reads++
        return { id: 'lib-op', project_slug: '*', kind: 'preview', status: reads === 1 ? 'running' : 'stopping', stage: 'checking', done: 1, total: 4, current: 'Channel A', channels_done: 1, channels_total: 3, library: true, library_action: 'cleanup_all' }
      }
      return {}
    },
    post: async (url: string) => { posts.push(url); return { operation_id: 'lib-op' } },
  })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    assert.match(ui.host.textContent || '', /1 \/ 4/)
    assert.match(ui.host.textContent || '', /1 \/ 3 channels/)
    button(ui.host, 'Stop').click(); await flush(); await flush()
    assert.deepEqual(posts, ['/library/media-cleanup/preview', '/library/media-cleanup/operations/lib-op/stop'])
  } finally { ui.close() }
})

test('Stop claims Stopping… at once, and a stale running read cannot repaint it as a live Stop', async () => {
  const posts: string[] = []
  let stopRequested = false
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      if (url.includes('/library/media-cleanup/operations/')) {
        // The server keeps answering the pre-stop `running` snapshot while it
        // finishes the current file; the stop itself took effect (stopping).
        return { id: 'lib-op', project_slug: '*', kind: 'preview', status: 'running', stage: 'compressing', done: 1, total: 4, current: 'Channel A', library: true, library_action: 'shrink_images' }
      }
      return {}
    },
    post: async (url: string) => {
      posts.push(url)
      if (url.endsWith('/stop')) { stopRequested = true; return { operation_id: 'lib-op', status: 'stopping' } }
      return { operation_id: 'lib-op' }
    },
  })
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    assert.ok(button(ui.host, 'Stop'), 'the running operation offers Stop')
    stopRequested = false
    button(ui.host, 'Stop').click()
    // The POST resolved; before the next poll answers, the panel must already read Stopping….
    await flush()
    assert.equal(stopRequested, true, 'the stop POST was sent once')
    assert.match(ui.host.textContent || '', /Stopping after the current file…/, 'the panel claims Stopping… as soon as the backend accepted the stop')
    // A poll already in flight (or re-triggered) comes back with the stale `running` snapshot.
    for (let i = 0; i < 5; i++) await flush()
    assert.doesNotMatch(ui.host.textContent || '', /Shrinking images/, 'the stale read must not repaint the panel as still running')
    assert.match(ui.host.textContent || '', /Stopping after the current file…/)
    assert.equal([...ui.host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Stop'), false, 'no live Stop button while the stop is accepted')
  } finally { ui.close() }
})

test('one missed progress read does not freeze the operation: it keeps checking and then shows the review', async () => {
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      reads++
      if (reads === 1) throw Object.assign(new Error('engine busy'), { status: 503, data: { detail: 'Engine busy.' } })
      return libraryOperation('shrink_images', shrinkPreview)
    },
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    const drain = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
    mock.timers.enable({ apis: ['setTimeout'] })
    button(ui.host, 'Shrink Images (All Channels)').click(); await drain()
    assert.match(ui.host.textContent || '', /Checking again/)
    mock.timers.tick(3_000); await drain()
    assert.equal(reads, 2, 'the operation is read again after the miss')
    assert.match(ui.host.textContent || '', /Shrink Images on All Channels/)
  } finally { mock.timers.reset(); ui.close() }
})

test('unknown space measurements render honestly without dispatching cleanup', async () => {
  const posts: string[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? { free_bytes: null, project_trash_bytes: null, library_trash_bytes: null, app_trash_bytes: null } : {},
    post: async (url: string) => { posts.push(url); return {} },
  })
  try {
    const summary = ui.host.querySelector('.cleanup-space')
    assert.ok(summary, 'the informational summary stays visible when every measurement is unavailable')
    const text = summary.textContent || ''
    for (const label of ['Free on this drive', 'This channel in the Trash', 'Whole Trash', 'Old app copies from updates']) {
      assert.match(text, new RegExp(`${label}: could not be measured`))
    }
    assert.equal((text.match(/could not be measured/g) || []).length, 4)
    assert.deepEqual(posts, [], 'rendering unknown measurements must not start cleanup')
  } finally { ui.close() }
})

test('Check All Uploads refreshes upload records without listing episodes', async () => {
  const calls: string[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : {},
    post: async (url: string) => { calls.push(url); return { checked: 2, outcome: 'ok', legacy: { checked: 1, processed: 0, not_found: 1 } } },
  })
  try {
    button(ui.host, 'Check All Uploads').click(); await flush(); await flush()
    assert.deepEqual(calls, ['/projects/first/youtube/sync'])
    assert.match(ui.host.textContent || '', /YouTube checked 2 uploads \(1 no longer on YouTube\)/)
  } finally { ui.close() }
})

/** A real key/value localStorage so a test can seed or read the saved operation id. */
function memoryStore(seed: Record<string, string> = {}) {
  const store: Record<string, string> = { ...seed }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value },
    removeItem: (key: string) => { delete store[key] },
  } })
  return store
}

test('a run left behind is restored on mount: progress and Stop, and never a re-run or a re-confirm', async () => {
  const store = memoryStore({ 'media-cleanup:library': 'lib-op' })
  const calls: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space
      : { id: 'lib-op', project_slug: '*', kind: 'run', status: 'running', stage: 'removing', done: 2, total: 5, current: 'Channel A', library: true, library_action: 'cleanup_all' },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: 'x' } },
  })
  try {
    assert.match(ui.host.textContent || '', /2 \/ 5/, 'the saved run shows its progress again')
    assert.ok(button(ui.host, 'Stop'), 'Stop is available on the restored run')
    assert.deepEqual(calls, [], 'restoring never starts a preview or a run')
    assert.equal(store['media-cleanup:library'], 'lib-op', 'the id stays while the run is in flight')
  } finally { ui.close() }
})

test('restoring an already-finished scan does not reopen the review, and clears the saved id', async () => {
  const store = memoryStore({ 'media-cleanup:library': 'lib-op' })
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : libraryOperation('shrink_images', shrinkPreview),
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    await flush(); await flush()
    assert.doesNotMatch(ui.host.textContent || '', /Shrink Images on All Channels/, 'a finished scan must not reopen the confirm')
    assert.equal(store['media-cleanup:library'], undefined, 'the id is cleared once the operation is terminal')
  } finally { ui.close() }
})

test('an operation that no longer exists (app restart) is cleared with a plain message', async () => {
  const store = memoryStore({ 'media-cleanup:library': 'gone' })
  const ui = await mount({
    get: async (url: string) => { if (url.endsWith('/space')) return space; throw Object.assign(new Error('not found'), { statusCode: 404 }) },
    post: async () => ({ operation_id: 'x' }),
  })
  try {
    await flush(); await flush()
    assert.match(ui.host.textContent || '', /no longer running/)
    assert.equal(store['media-cleanup:library'], undefined, 'a gone operation is not remembered')
    assert.ok(button(ui.host, 'Shrink Images (All Channels)'), 'the buttons are usable again')
  } finally { ui.close() }
})

test('a refused run request (an expired review) shows the reason and leaves the review in place', async () => {
  const calls: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : libraryOperation('shrink_images', shrinkPreview),
    post: async (url: string, body: any) => {
      calls.push({ url, body })
      if (url.endsWith('/run')) throw Object.assign(new Error('expired'), { data: { detail: 'That all-channel preview is missing or expired. Check the files again.' } })
      return { operation_id: 'lib-op' }
    },
  })
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    assert.match(ui.host.textContent || '', /preview is missing or expired/)
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 1, 'the run was attempted once and refused')
  } finally { ui.close() }
})

test('a review with nothing to clean up explains why and disables the confirm', async () => {
  const empty = { ...cleanupPreview, file_count: 0, total_bytes: 0, channels: [], leftovers: { count: 0, total_bytes: 0, items: [] } }
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : libraryOperation('cleanup_all', empty),
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    assert.match(ui.host.textContent || '', /Nothing to clean up right now/)
    assert.equal(confirmButton(ui.host).disabled, true, 'the confirm is disabled with an explanation')
  } finally { ui.close() }
})

test('changing channel while a confirm is open does not run the reviewed cleanup', async () => {
  const calls: any[] = []
  const slug = ref('first')
  let approve: (value: boolean) => void = () => {}
  const ask = () => new Promise<boolean>(resolve => { approve = resolve })
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : libraryOperation('shrink_images', shrinkPreview),
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: 'lib-op' } },
  }, ask, slug)
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    await flush()
    slug.value = 'second'
    await flush()
    approve(true)
    for (let i = 0; i < 5; i++) await flush()
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 0, 'a stale confirm must not run cleanup')
  } finally { ui.close() }
})

test('the Free Up Space panel carries the automatic switch and reads the same saved setting', async () => {
  const ui = await mount({ get: async (url: string) => url.endsWith('/space') ? space : {}, post: async () => ({}) })
  try {
    const box = ui.host.querySelector<HTMLInputElement>('.cleanup-auto input')
    assert.ok(box, 'the switch is on the Free Up Space panel, beside the manual button')
    assert.equal(box.checked, true, 'it shows the saved state, not a default of its own')
    const text = ui.host.textContent || ''
    assert.match(text, /Run automatically \(daily\): clears uploaded finals older than 7 days and unused leftovers/)
    assert.match(text, /Last run .* — completed: Moved 3 items to Story's Trash\./)
    assert.match(text, /Next run about /, 'the next run is shown too')
  } finally { ui.close() }
})

test('flipping the panel switch writes the one setting Story → Trash also writes', async () => {
  const writes: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : {},
    post: async () => ({}),
    put: async (url: string, body: any) => { writes.push({ url, body }); return { ...retentionOn, auto_cleanup_enabled: body.auto_cleanup_enabled } },
  })
  try {
    const box = ui.host.querySelector<HTMLInputElement>('.cleanup-auto input')!
    box.checked = false
    box.dispatchEvent(new Event('change'))
    await flush(); await flush()
    assert.deepEqual(writes, [{ url: '/trash/retention', body: { auto_cleanup_enabled: false } }], 'one write, the shared setting')
    assert.equal(box.checked, false, 'the switch holds the saved state')
    assert.match(ui.host.textContent || '', /Off\. The two buttons above still work/, 'off says what still works by hand')
  } finally { ui.close() }
})

test('a refused switch write is said out loud and the switch goes back', async () => {
  const ui = await mount({
    get: async (url: string) => url.endsWith('/space') ? space : {},
    post: async () => ({}),
    put: async () => { throw Object.assign(new Error('refused'), { data: { detail: 'Only the owner can change retention.' } }) },
  })
  try {
    const box = ui.host.querySelector<HTMLInputElement>('.cleanup-auto input')!
    box.checked = false
    box.dispatchEvent(new Event('change'))
    await flush(); await flush()
    assert.equal(box.checked, true, 'the switch must not claim a state the app did not take')
    assert.match(ui.host.textContent || '', /Only the owner can change retention\./)
  } finally { ui.close() }
})

test('a run over thousands of files counts them all from the counters, not the capped sample', async () => {
  // The operation carries `item_count` (the real number) plus a capped sample of
  // outcomes, so the panel must never read the totals off the sample — that is
  // what would report "3 files changed" for a 4,000-file sweep.
  const sample = [0, 1, 2].map(index => ({ path: `/Library/chan-a/EP000${index}/final.mp4`, outcome: 'removed' }))
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      reads += 1
      if (reads === 1) return libraryOperation('cleanup_all', cleanupPreview)
      return {
        id: 'lib-op', project_slug: '*', kind: 'run', status: 'completed', stage: null, done: 4000, total: 4000, current: '',
        library: true, library_action: 'cleanup_all',
        result: { items: sample, item_count: 4000, removed_count: 3990, skipped_count: 10, bytes_reclaimed: 4000 * 1024 ** 2 },
      }
    },
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    const text = ui.host.textContent || ''
    assert.match(text, /3990 files changed/, 'the real total comes from the counters, not the 3-item sample')
    assert.match(text, /10 skipped or could not finish/)
    assert.match(text, /and 3997 more files — all of them are counted above/, 'the capped sample says what it left out')
  } finally { ui.close() }
})

test('a run that failed two files past the cap names them and their reasons, outside the collapsed list', async () => {
  // The sample is capped at 50, and the two failures of the live 2026-10-20 run
  // sat at positions 120 and 180 — so the backend keeps them first in the sample
  // and the panel says them out loud rather than leaving them in the disclosure.
  const sample = Array.from({ length: 50 }, (_, index) => ({
    path: `/Library/chan-a/EP0001/s${String(index).padStart(3, '0')}.png`, outcome: 'compressed',
  }))
  sample[0] = {
    path: '/Library/chan-a/EP0001/s119.png', outcome: 'failed',
    reason: 'EACCES: permission denied, rename ... The original is now in the Trash at /Library/_trash/chan-a/EP0001/images/scene_images/s119.png.',
    original_path: '/Library/_trash/chan-a/EP0001/images/scene_images/s119.png',
  }
  sample[1] = { path: '/Library/chan-a/EP0001/s179.png', outcome: 'failed', reason: 'EIO: the original could not be put back.' }
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      reads += 1
      if (reads === 1) return libraryOperation('shrink_images', shrinkPreview)
      return {
        id: 'lib-op', project_slug: '*', kind: 'run', status: 'completed', stage: null, done: 200, total: 200, current: '',
        library: true, library_action: 'shrink_images',
        result: { items: sample, item_count: 200, compressed_count: 198, failed_count: 2, bytes_reclaimed: 0 },
      }
    },
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    button(ui.host, 'Shrink Images (All Channels)').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()

    const block = ui.host.querySelector('.cleanup-unresolved')
    assert.ok(block, 'the failures are shown in their own block, not only inside "View file outcomes"')
    const said = block!.textContent || ''
    assert.match(said, /2 files could not be finished/, 'the heading counts what is shown')
    assert.match(said, /s119\.png/, 'the file that failed is named')
    assert.match(said, /s179\.png/, 'both failures are named')
    assert.match(said, /permission denied/, 'the reason is shown plainly')
    assert.match(said, /the original is now in the Trash at \/Library\/_trash/, 'where the original went is said')
    assert.match(ui.host.textContent || '', /198 files changed/, 'the counters are still the real totals')
  } finally { ui.close() }
})

test('a finished run says what moved AND what was left behind, never just "all moved"', async () => {
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return space
      reads += 1
      if (reads === 1) return libraryOperation('cleanup_all', cleanupPreview)
      return {
        id: 'lib-op', project_slug: '*', kind: 'run', status: 'completed', stage: null, done: 3, total: 3, current: '',
        library: true, library_action: 'cleanup_all',
        result: { items: [], leftovers_moved: 1, leftovers_bytes_moved: 20 * 1024 ** 2, leftovers_left: 2 },
      }
    },
    post: async () => ({ operation_id: 'lib-op' }),
  })
  try {
    button(ui.host, 'Clean Up All Channels').click()
    for (let i = 0; i < 5; i++) await flush()
    confirmButton(ui.host).click()
    for (let i = 0; i < 5; i++) await flush()
    const text = ui.host.textContent || ''
    assert.match(text, /1 leftover folder moved/, 'the leftover that moved is reported')
    assert.match(text, /2 leftover folders could not be moved and stayed in place/, 'the leftovers left behind are reported, not hidden')
  } finally { ui.close() }
})
