import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, mock, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const savedOperations = new Map<string, string>()
beforeEach(() => {
  savedOperations.clear()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => savedOperations.get(key) ?? null,
    setItem: (key: string, value: string) => savedOperations.set(key, value),
    removeItem: (key: string) => savedOperations.delete(key),
  } })
})

async function component() {
  const filename = new URL('../components/MediaCleanupPanel.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'cleanup' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'cleanup', compilerOptions: { bindingMetadata: script.bindings } })
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = `const useApi = () => globalThis.__cleanupApi; const useConfirm = () => ({ask: (...args) => globalThis.__cleanupAsk(...args)}); const pickFolder = async () => '/external/archive';`
  const transformed = await transform(`${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))).toString('base64')}`)).default
}
async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
async function mount(api: any, ask: any = async () => true) {
  ;(globalThis as any).__cleanupApi = api
  ;(globalThis as any).__cleanupAsk = ask
  const props = ref({ slug: 'first' })
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp, props.value) }))
  app.mount(host); await flush(); await flush(); await flush()
  return { host, props, close: () => { app.unmount(); host.remove() } }
}
function button(host: HTMLElement, label: string) {
  const node = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label)
  assert.ok(node, `button ${label} exists`); return node
}
function change(input: HTMLInputElement) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })) }
const listed = { episodes: [{ episode_code: 'EP0001', title: 'Uploaded episode', video_id: 'abc' }], blocked_reasons: [] }
const preview = { preview_id: 'review-1', project_slug: 'first', files: [{ path: '/episode/image.png', relative_path: 'image.png', category: 'images', bytes: 2048 }], total_bytes: 2048, blocked_reasons: [], episodes: [{ episode_code: 'EP0001', files: [{ path: '/episode/image.png', relative_path: 'image.png', category: 'images', bytes: 2048 }], blocked_reasons: [] }] }

test('cleanup ignores old project responses and resets all selection on project switch', async () => {
  const response = deferred<any>()
  const ui = await mount({ get: (url: string) => url.includes('/first/') ? response.promise : Promise.resolve({ episodes: [], blocked_reasons: [] }) })
  try {
    ui.props.value = { slug: 'second' }; await flush()
    response.resolve(listed); await flush()
    assert.doesNotMatch(ui.host.textContent || '', /EP0001/)
    assert.equal(button(ui.host, 'Refresh Uploads').disabled, false)
  } finally { ui.close() }
})

test('review uses selected scope, cancellation spends nothing, double confirm starts one exact reviewed operation', async () => {
  const calls: any[] = []
  const confirm = deferred<boolean>()
  let askCount = 0
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes') ? listed : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.endsWith('/preview') ? 'preview-op' : 'run-op' } },
  }, () => { askCount++; return askCount === 1 ? Promise.resolve(false) : confirm.promise })
  try {
    button(ui.host, 'Select All Uploaded').click(); await flush()
    const images = ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!
    change(images); await flush()
    button(ui.host, 'Review Selected Files').click(); await flush(); await flush()
    assert.deepEqual(calls[0], { url: '/projects/first/media-cleanup/preview', body: { episode_codes: ['EP0001'], categories: ['images'] } })
    button(ui.host, 'Move Reviewed Files to the Trash').click(); await flush()
    assert.equal(calls.length, 1, 'declined confirmation must not run cleanup')
    const run = button(ui.host, 'Move Reviewed Files to the Trash'); run.click(); run.click(); await flush()
    assert.equal(askCount, 2, 'one pending confirmation despite repeated click')
    confirm.resolve(true); await flush()
    assert.equal(calls.filter(c => c.url.endsWith('/run')).length, 1)
    assert.deepEqual(calls[1].body, { preview_id: 'review-1', mode: 'remove' })
  } finally { ui.close() }
})

test('dismissed or changed selections cannot reuse a stale reviewed file list', async () => {
  const ui = await mount({ get: async (url: string) => url.endsWith('/episodes') ? listed : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', stage: null, done: 1, total: 1, current: '', preview }, post: async () => ({ operation_id: 'preview-op' }) })
  try {
    button(ui.host, 'Select All Uploaded').click(); await flush()
    change(ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!); await flush()
    button(ui.host, 'Review Selected Files').click(); await flush(); await flush()
    assert.match(ui.host.textContent || '', /Review 1 files/)
    button(ui.host, 'Clear Selection').click(); await flush()
    assert.doesNotMatch(ui.host.textContent || '', /Move Reviewed Files to the Trash/)
  } finally { ui.close() }
})


test('dismissed review stays dismissed after navigating away and returning', async () => {
  const api = { get: async (url: string) => url.endsWith('/episodes') ? listed : ({ id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', stage: null, done: 1, total: 1, current: '', preview }) }
  savedOperations.set('media-cleanup:first', 'preview-op')
  const ui = await mount(api)
  try {
    assert.match(ui.host.textContent || '', /Move Reviewed Files to the Trash/)
    button(ui.host, 'Dismiss Review').click(); await flush()
    assert.equal(savedOperations.has('media-cleanup:first'), false)
  } finally { ui.close() }
  const restored = await mount(api)
  try { assert.doesNotMatch(restored.host.textContent || '', /Move Reviewed Files to the Trash/) }
  finally { restored.close() }
})

test('stopped preview explains no files changed instead of claiming file outcomes exist', async () => {
  savedOperations.set('media-cleanup:first', 'preview-op')
  const ui = await mount({ get: async (url: string) => url.endsWith('/episodes') ? listed : ({ id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'stopped', stage: null, done: 1, total: 2, current: '' }) })
  try {
    assert.match(ui.host.textContent || '', /Scan stopped — no files changed/)
    assert.doesNotMatch(ui.host.textContent || '', /review the file outcomes/)
  } finally { ui.close() }
})

test('interrupted removals identify pending outcomes separately from skipped files', async () => {
  savedOperations.set('media-cleanup:first', 'run-op')
  const ui = await mount({ get: async (url: string) => url.endsWith('/episodes') ? listed : ({ id: 'run-op', project_slug: 'first', kind: 'run', status: 'stopped', stage: null, done: 1, total: 2, current: '', result: { items: [{ path: 'one.png', outcome: 'removed' }, { path: 'two.png', outcome: 'pending' }], bytes_reclaimed: 2048 } }) })
  try {
    assert.match(ui.host.textContent || '', /1 files changed; 0 skipped/)
    assert.match(ui.host.textContent || '', /1 need review after interruption/)
  } finally { ui.close() }
})

test('Free Up Space needs no folder: it loads uploads itself, shows the project _trash and the space freed, confirms, then runs as compress', async () => {
  const calls: any[] = []
  const asked: any[] = []
  const presetPreview = { ...preview, preset: 'archive_episode', trash_roots: ['/Library/chan/_trash'], estimate: { compress_files: 412, compress_bytes_before: 490 * 1024 ** 2, compress_bytes_after: 57 * 1024 ** 2, already_jpeg_files: 0, trash_files: 3, trash_bytes: 2.6 * 1024 ** 3 } }
  const episodes = { episodes: [
    { episode_code: 'EP0001', title: 'Done', video_id: 'a', local_media_status: { state: 'partially_removed', preset_archived_at: '2026-09-30T00:00:00Z' } },
    { episode_code: 'EP0002', title: 'Fresh', video_id: 'b', local_media_status: { state: 'available', preset_archived_at: null } },
  ], blocked_reasons: [] }
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes') ? episodes : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview: presetPreview },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.endsWith('/preview') ? 'preview-op' : 'run-op' } },
  }, async (options: any) => { asked.push(options); return true })
  try {
    // No click needed to list uploads, and the not-yet-freed episode is already selected.
    assert.match(ui.host.textContent || '', /EP0002/)
    button(ui.host, 'Free Up Space for 1 Selected').click(); await flush(); await flush()
    assert.deepEqual(calls[0], { url: '/projects/first/media-cleanup/preview', body: { episode_codes: ['EP0002'], preset: 'archive_episode' } })
    const text = ui.host.textContent || ''
    assert.match(text, /412 images 490\.0 MB → ~57\.0 MB/)
    assert.match(text, /Frees about 3\.02 GB/)
    assert.match(text, /\/Library\/chan\/_trash/)
    assert.match(text, /space is freed when you empty the Trash/)
    assert.doesNotMatch(text, /permanent/i)
    assert.equal(ui.host.querySelector('#cleanup-destination'), null, 'no folder input on the main path')
    assert.ok(![...ui.host.querySelectorAll('button')].some(b => /browse/i.test(b.textContent || '')), 'no Browse button on the main path')
    button(ui.host, 'Free Up Space').click(); await flush()
    assert.match(asked[0].message, /\/Library\/chan\/_trash/)
    assert.match(asked[0].message, /frees about 3\.02 GB/)
    assert.deepEqual(calls[1].body, { preview_id: 'review-1', mode: 'compress' })
  } finally { ui.close() }
})

test('the advanced review defaults to _trash, never to a destination folder', async () => {
  const calls: any[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes') ? listed : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.endsWith('/preview') ? 'preview-op' : 'run-op' } },
  })
  try {
    change(ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!); await flush()
    button(ui.host, 'Review Selected Files').click(); await flush(); await flush()
    assert.equal(ui.host.querySelector('#cleanup-destination'), null)
    button(ui.host, 'Move Reviewed Files to the Trash').click(); await flush()
    assert.deepEqual(calls[1].body, { preview_id: 'review-1', mode: 'remove' })
  } finally { ui.close() }
})

test('one missed progress read does not freeze the operation: it keeps checking and then shows the result', async () => {
  let reads = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/episodes')) return listed
      if (url.endsWith('/space')) return null
      reads++
      if (reads === 1) throw Object.assign(new Error('engine busy'), { status: 503, data: { detail: 'Engine busy.' } })
      return { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview }
    },
    post: async () => ({ operation_id: 'preview-op' }),
  })
  try {
    button(ui.host, 'Select All Uploaded').click(); await flush()
    change(ui.host.querySelector<HTMLInputElement>('input[type=checkbox][value=images]')!); await flush()
    const drain = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); await nextTick() } }
    mock.timers.enable({ apis: ['setTimeout'] })
    button(ui.host, 'Review Selected Files').click(); await drain()
    assert.match(ui.host.textContent || '', /Checking again/)
    mock.timers.tick(3_000); await drain()
    assert.equal(reads, 2, 'the operation is read again after the miss')
    assert.match(ui.host.textContent || '', /Move Reviewed Files to the Trash/)
  } finally { mock.timers.reset(); ui.close() }
})

test('narration parts: a not-uploaded episode is listed but never pre-selected, and Narration parts is its own category', async () => {
  const both = { episodes: [
    { episode_code: 'EP0001', title: 'Uploaded episode', video_id: 'abc' },
    { episode_code: 'EP0002', title: 'Narrated, not uploaded', video_id: null },
  ], blocked_reasons: [] }
  const ui = await mount({ get: async () => both })
  try {
    const text = ui.host.textContent || ''
    assert.match(text, /1 episode selected/)
    assert.match(text, /Not uploaded · only Narration parts can be freed/)
    assert.equal(ui.host.querySelectorAll('a[href*="youtube.com"]').length, 1, 'no upload link for the not-uploaded episode')
    const parts = [...ui.host.querySelectorAll<HTMLInputElement>('.cleanup-categories input')].find(input => input.value === 'narration_parts')
    assert.ok(parts, 'Narration parts category is offered')
    assert.equal(parts!.checked, false, 'never pre-selected')
    button(ui.host, 'Select All Uploaded').click(); await flush()
    assert.match(ui.host.textContent || '', /1 episode selected/)
  } finally { ui.close() }
})

test('shows free disk and _trash sizes, why uploads are not offered, and checks all uploads on request', async () => {
  const calls: string[] = []
  let listCalls = 0
  const ui = await mount({
    get: async (url: string) => {
      if (url.endsWith('/space')) return { free_bytes: 5 * 1024 ** 3, project_trash_bytes: 2 * 1024 ** 3, library_trash_bytes: 3 * 1024 ** 3, app_trash_bytes: 1024 ** 3 }
      listCalls++
      return { episodes: [], blocked_reasons: ['2 uploaded episodes: YouTube has not confirmed this upload yet — press Check All Uploads (Upload Center) so YouTube can confirm it.'],
        not_offered: [{ episode_code: 'EP0001', title: 'One', reason: 'YouTube has not confirmed this upload yet.' }, { episode_code: 'EP0002', title: 'Two', reason: 'YouTube no longer has this video.' }],
        all_episodes: [{ episode_code: 'EP0001', title: 'One' }, { episode_code: 'EP0002', title: 'Two' }] }
    },
    post: async (url: string) => { calls.push(url); return { checked: 2, outcome: 'ok', legacy: { checked: 1, processed: 0, not_found: 1 } } },
  })
  try {
    await flush()
    const text = ui.host.textContent || ''
    assert.match(text, /Free on this drive: 5\.00 GB/)
    assert.match(text, /This channel in the Trash: 2\.00 GB/)
    assert.match(text, /Whole Trash: 3\.00 GB/)
    assert.match(text, /Old app copies from updates: 1\.00 GB \(empties itself after 15 days\)/)
    assert.match(text, /Nothing can be freed here yet\. The reasons are listed above\./)
    assert.match(text, /press Check All Uploads/)
    assert.match(text, /2 uploaded episodes are not offered — see why/)
    assert.match(text, /EP0002 Two — YouTube no longer has this video\./)
    const before = listCalls
    button(ui.host, 'Check All Uploads').click(); await flush(); await flush()
    assert.deepEqual(calls, ['/projects/first/youtube/sync'])
    assert.ok(listCalls > before, 'the list is read again after the check')
    assert.match(ui.host.textContent || '', /YouTube checked 2 uploads \(1 no longer on YouTube\)/)
  } finally { ui.close() }
})

test('shows every unavailable space measurement honestly without dispatching cleanup', async () => {
  const posts: string[] = []
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes')
      ? { episodes: [], blocked_reasons: [] }
      : { free_bytes: null, project_trash_bytes: null, library_trash_bytes: null, app_trash_bytes: null },
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

test('Convert PNG scenes to JPEG works per episode and for the whole channel, and runs only as a conversion', async () => {
  const calls: any[] = []
  const asked: string[] = []
  const convertPreview = { ...preview, preset: 'convert_png', estimate: { compress_files: 1, compress_bytes_before: 2048, compress_bytes_after: 240, already_jpeg_files: 0, trash_files: 0, trash_bytes: 0 }, trash_roots: ['/project/_trash'] }
  const ui = await mount({
    get: async (url: string) => url.endsWith('/episodes')
      ? { episodes: [], blocked_reasons: [], not_offered: [], all_episodes: [{ episode_code: 'EP0001', title: 'One' }, { episode_code: 'EP0002', title: 'Two' }] }
      : { id: 'preview-op', project_slug: 'first', kind: 'preview', status: 'completed', done: 1, total: 1, current: '', stage: null, preview: convertPreview },
    post: async (url: string, body: any) => { calls.push({ url, body }); return { operation_id: url.endsWith('/preview') ? 'preview-op' : 'run-op' } },
  }, async (options: any) => { asked.push(options.title); return true })
  try {
    const select = ui.host.querySelector<HTMLSelectElement>('select[aria-label="Episode to convert"]')!
    select.value = 'EP0002'; select.dispatchEvent(new Event('change', { bubbles: true })); await flush()
    button(ui.host, 'Check This Episode').click(); await flush(); await flush()
    assert.deepEqual(calls[0], { url: '/projects/first/media-cleanup/preview', body: { episode_codes: ['EP0002'], preset: 'convert_png' } })
    assert.match(ui.host.textContent || '', /Convert to JPEG:/)
    button(ui.host, 'Convert to JPEG').click(); await flush(); await flush()
    assert.deepEqual(calls[1], { url: '/projects/first/media-cleanup/run', body: { preview_id: 'review-1', mode: 'compress' } })
    assert.equal(asked.at(-1), 'Convert PNG scenes to JPEG?')

    button(ui.host, 'Dismiss Review').click(); await flush()
    button(ui.host, 'Check All 2 Episodes').click(); await flush(); await flush()
    assert.equal(asked.includes('Check all 2 episodes for PNG scenes?'), true, 'the whole channel is confirmed first')
    assert.deepEqual(calls.at(-1).body, { episode_codes: ['EP0001', 'EP0002'], preset: 'convert_png' })
  } finally { ui.close() }
})
