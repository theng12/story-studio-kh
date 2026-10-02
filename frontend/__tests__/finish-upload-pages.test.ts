import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

/**
 * Audit-finish fixes for the Upload Center pages. Mounted tests for the pages
 * the existing harnesses already mount; source assertions for publish.vue,
 * which is too large to mount here.
 *
 * What these cannot catch: layout/overflow of the new links and buttons, and
 * the real server's wording of errors (publish's duplicate-upload text is
 * matched from the queue's message shape, not from a live server).
 */

const pageUrl = (rel: string) => new URL(`../pages/projects/[slug]/${rel}`, import.meta.url)

async function loadPage(rel: string, id: string): Promise<Component> {
  const pagePath = fileURLToPath(pageUrl(rel))
  const source = readFileSync(pagePath, 'utf8')
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({
    source: descriptor.template!.content, filename: pagePath, id,
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, watch, reactive, onMounted, h as __h } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => ({ params: { slug: 'demo-project' } })
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
    const NuxtLink = { props: ['to'], setup: (p, { slots }) => () => __h('a', { href: String(p.to) }, slots.default ? slots.default() : []) }
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

async function mount(rel: string, id: string, api: { get: (p: string) => any; post?: (p: string, b: any) => any; del?: (p: string) => any }, confirm = true) {
  const calls: any[] = []
  const confirms: any[] = []
  ;(globalThis as any).__ucConfirm = async (o: any) => { confirms.push(o); return confirm }
  ;(globalThis as any).__ucApi = {
    get: async (p: string) => { calls.push({ method: 'GET', path: p }); return api.get(p) },
    post: async (p: string, b: any) => { calls.push({ method: 'POST', path: p, body: b }); return api.post ? api.post(p, b) : {} },
    del: async (p: string) => { calls.push({ method: 'DELETE', path: p }); return api.del ? api.del(p) : {} },
  }
  const Page = await loadPage(rel, id)
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', calls, confirms, destroy: () => app.unmount() }
}
const flush = async () => { for (let i = 0; i < 8; i++) await nextTick() }
const btn = (el: HTMLElement, label: string) => [...el.querySelectorAll('button')].find(b => b.textContent!.trim().startsWith(label))

describe('finish: library — Use Story Studio changes live YouTube', () => {
  const field = (name: string, local: string, live: string) =>
    ({ field: name, state: 'conflict', local, last_synced: null, live })
  const lib = (fields: any[]) => ({
    videos: [{
      operation_id: 'op-1', episode_code: 'EP0001', video_id: 'v1',
      comparison: { fields, needs_attention: true, live_fetched_at: '2026-09-03T10:00:00.000Z', thumbnail_changed_since_last_sync: null },
      playlists: {}, caption: null,
    }],
    empty_reason: null,
  })

  test('the choice is confirmed with the field and both values, then says YouTube was updated', async () => {
    const m = await mount('upload/library.vue', 'f-lib', { get: () => lib([field('title', 'Our Title', 'Their Title')]) })
    assert.match(m.text(), /does not contact YouTube/)
    assert.match(m.text(), /“Update YouTube”/)
    btn(m.el, 'Update YouTube')!.click()
    await flush()
    assert.equal(m.confirms.length, 1)
    assert.match(m.confirms[0].title, /Title on YouTube for EP0001/)
    assert.match(m.confirms[0].message, /Their Title/)
    assert.match(m.confirms[0].message, /Our Title/)
    assert.notEqual(m.confirms[0].danger, true)
    assert.match(m.text(), /YouTube updated — EP0001: Title now matches Story Studio/)
    assert.doesNotMatch(m.text(), /decision saved/)
    m.destroy()
  })

  test('privacy and schedule get a danger confirmation with a visibility warning', async () => {
    for (const name of ['privacy_status', 'scheduled_for']) {
      const m = await mount('upload/library.vue', 'f-lib', { get: () => lib([field(name, 'public', 'private')]) })
      btn(m.el, 'Update YouTube')!.click()
      await flush()
      assert.equal(m.confirms[0].danger, true, name)
      assert.match(m.confirms[0].message, /show or hide the video/)
      m.destroy()
    }
  })

  test('declining the confirmation sends nothing to YouTube', async () => {
    const m = await mount('upload/library.vue', 'f-lib', { get: () => lib([field('title', 'A', 'B')]) }, false)
    btn(m.el, 'Update YouTube')!.click()
    await flush()
    assert.equal(m.calls.some(c => c.method === 'POST'), false)
    m.destroy()
  })

  test('Keep YouTube and Review later still need no confirmation', async () => {
    const m = await mount('upload/library.vue', 'f-lib', { get: () => lib([field('title', 'A', 'B')]) })
    btn(m.el, 'Keep YouTube')!.click()
    await flush()
    assert.equal(m.confirms.length, 0)
    assert.equal(m.calls.filter(c => c.method === 'POST').length, 1)
    m.destroy()
  })
})

describe('finish: comments', () => {
  const comments = [
    { comment_id: 'c1', video_id: 'v1', author: 'Alice', text: 'First', published_at: '2026-09-03T10:00:00.000Z', moderation_status: 'published', channel_replied: false, reply_count: 0, replies: [], can_reply: true },
    { comment_id: 'c2', video_id: 'v1', author: 'Bob', text: 'Second', published_at: '2026-09-03T11:00:00.000Z', moderation_status: 'heldForReview', channel_replied: false, reply_count: 0, replies: [], can_reply: true },
  ]
  const inbox = {
    comments, receipts: [], fetched_at: '2026-09-03T10:00:00.000Z', partial: false, unreached_video_ids: [],
    partially_read_video_ids: [], comments_disabled_video_ids: [], never_fetched: false, channel_assigned: true,
  }
  const api = { get: () => inbox, post: () => ({ counts: { done: 1, failed: 0, unrecorded: 0 }, receipt: { outcome: 'done' } }) }

  test('a half-written reply never follows you to another comment, and names who it is for', async () => {
    const m = await mount('upload/comments.vue', 'f-com', { get: () => ({ ...inbox, comments: [comments[0], { ...comments[1], moderation_status: 'published', comment_id: 'c2' }] }) })
    btn(m.el, 'Reply')!.click()
    await flush()
    assert.match(m.text(), /Replying to Alice/)
    const ta = m.el.querySelector('textarea')!
    ta.value = 'Thanks Alice!'
    ta.dispatchEvent(new Event('input'))
    await flush()
    const replyButtons = [...m.el.querySelectorAll('button')].filter(b => b.textContent!.trim() === 'Reply')
    replyButtons[replyButtons.length - 1].click()
    await flush()
    assert.match(m.text(), /Replying to Bob/)
    assert.equal(m.el.querySelector('textarea')!.value, '')
    m.destroy()
  })

  test('changing the view clears a selection that is no longer visible', async () => {
    const m = await mount('upload/comments.vue', 'f-com', api)
    const box = m.el.querySelector('input[type=checkbox]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await flush()
    assert.match(m.text(), /1 selected/)
    btn(m.el, 'Held for review')!.click()
    await flush()
    assert.doesNotMatch(m.text(), /selected/)
    m.destroy()
  })

  test('changing a filter clears the selection too', async () => {
    const m = await mount('upload/comments.vue', 'f-com', api)
    const box = m.el.querySelector('input[type=checkbox]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    await flush()
    const search = m.el.querySelector('input[type=search]') as HTMLInputElement
    search.value = 'zzz'
    search.dispatchEvent(new Event('input'))
    await flush()
    assert.doesNotMatch(m.text(), /1 selected/)
    m.destroy()
  })

  test('Reject is confirmed in plain words, and declining does nothing', async () => {
    const m = await mount('upload/comments.vue', 'f-com', api, false)
    btn(m.el, 'Reject')!.click()
    await flush()
    assert.equal(m.confirms.length, 1)
    assert.match(m.confirms[0].message, /hides the comment on YouTube/)
    assert.match(m.confirms[0].message, /not banned/)
    assert.equal(m.calls.some(c => c.method === 'POST'), false)
    m.destroy()
  })
})

describe('finish: reconcile', () => {
  const view = {
    candidates: [], local_only: [], youtube_only: [], duplicates: [], ignored_video_ids: [], history: [],
    remote_listed_at: '2026-09-03T10:00:00.000Z',
  }

  test('a failed undo is shown in the page and does not replace it', async () => {
    const m = await mount('upload/reconcile.vue', 'f-rec', {
      get: (p) => p.endsWith('/upload/renumber-undo') ? { available: true, expired: false, renamed_count: 2, adopted_count: 0 } : p.endsWith('/reseason-undo') ? { available: false } : view,
      post: () => { throw Object.assign(new Error('x'), { data: { detail: 'Disk is read-only' } }) },
    })
    btn(m.el, 'Undo the renumber')!.click()
    await flush()
    assert.match(m.text(), /Disk is read-only/)
    // The rest of the page is still there, with its undo controls.
    assert.match(m.text(), /Channel listing/)
    assert.ok(btn(m.el, 'Undo the renumber'))
    m.destroy()
  })

  test('a failed dismiss says so', async () => {
    const m = await mount('upload/reconcile.vue', 'f-rec', {
      get: (p) => p.endsWith('/upload/renumber-undo') ? { available: true, expired: true, renamed_count: 2, adopted_count: 0 } : p.endsWith('/reseason-undo') ? { available: false } : view,
      del: () => { throw new Error('nope') },
    })
    btn(m.el, 'Dismiss')!.click()
    await flush()
    assert.match(m.text(), /nope/)
    m.destroy()
  })

  test('a real load error offers Retry that loads again', async () => {
    let fail = true
    const m = await mount('upload/reconcile.vue', 'f-rec', {
      get: (p) => { if (p.endsWith('/youtube/reconcile') && fail) throw new Error('offline'); return p.includes('undo') ? { available: false } : view },
    })
    assert.match(m.text(), /offline/)
    fail = false
    btn(m.el, 'Retry')!.click()
    await flush()
    assert.match(m.text(), /Channel listing/)
    m.destroy()
  })

  test('plain-English wording, and the tab is named Match to YouTube', async () => {
    const m = await mount('upload/reconcile.vue', 'f-rec', { get: (p) => p.includes('undo') ? { available: false } : { ...view, history: [{ decision_id: 'd1', episode_code: 'EP0001', previous_video_id: null, next_video_id: 'v1' }] } })
    assert.doesNotMatch(m.text(), /Reconcile/)
    assert.match(m.text(), /matches your episodes to the videos on your YouTube channel/)
    assert.match(m.text(), /Every link made on this page can be undone/)
    m.destroy()
    const shell = readFileSync(fileURLToPath(pageUrl('upload.vue')), 'utf8')
    assert.match(shell, /upload\/reconcile`[^>]*>\s*Match to YouTube\s*</)
    assert.doesNotMatch(shell, />\s*Reconcile\s*</)
  })
})

describe('finish: overview', () => {
  const overview = {
    assigned_channel: { channel_id: 'UC1', title: 'Chan', status: 'connected' }, unavailable_reason: null, quota: null,
    quota_unavailable_reason: null, attention: { processing: 0, failed: 0, rejected: 0, status_unavailable: 0, drift: 0 },
    episodes_needing_attention: 0, operation_count: 0, last_remote_sync_at: null, last_sync_attempt: null,
  }

  test('a failed sync click shows why', async () => {
    const m = await mount('upload/index.vue', 'f-idx', {
      get: () => overview,
      post: () => { throw Object.assign(new Error('x'), { data: { detail: 'Quota is used up' } }) },
    })
    btn(m.el, 'Sync with YouTube now')!.click()
    await flush()
    assert.match(m.text(), /Couldn’t check with YouTube: Quota is used up/)
    m.destroy()
  })

  test('a load error has a Retry', async () => {
    let fail = true
    const m = await mount('upload/index.vue', 'f-idx', { get: () => { if (fail) throw new Error('down'); return overview } })
    assert.match(m.text(), /down/)
    fail = false
    btn(m.el, 'Retry')!.click()
    await flush()
    assert.match(m.text(), /Publishing to/)
    m.destroy()
  })
})

describe('finish: publish (source)', () => {
  const src = readFileSync(fileURLToPath(pageUrl('upload/publish.vue')), 'utf8')

  test('a duplicate upload attempt reads as information, not a red failure, and reloads', () => {
    assert.match(src, /youtube_upload generation already queued\\\/running/)
    assert.match(src, /is already waiting to upload — see Jobs\./)
    assert.match(src, /rowResults\[episodeCode\] = uploadFailure\(error, episodeCode[\s\S]{0,300}void load\(\)/)
    assert.match(src, /\.row-result\.info/)
  })

  test('the bulk queue loop stops when the page is left', () => {
    const unmount = src.match(/onUnmounted\(\(\) => \{[\s\S]*?\n\}\)/)
    assert.ok(unmount)
    assert.match(unmount[0], /actionRevision \+= 1/)
    // The loop's own guard is what the bump trips; it must still be there.
    assert.match(src, /for \(const item of reviewed\) \{\s*if \(!actionIsCurrent\(action\)\) return/)
  })

  test('the no-active-plan error links to the Upload plans tab, everywhere it is shown', () => {
    assert.doesNotMatch(src, /Upload Center → Upload plans/)
    assert.equal((src.match(/isNoActivePlanMessage\(/g) || []).length, 4) // definition + 3 displays
    assert.equal((src.match(/throw new Error\(NO_ACTIVE_PLAN_MESSAGE\)/g) || []).length, 2)
  })

  test('a paused upload says it is paused and points at Jobs', () => {
    assert.match(src, /Paused — resume it in Jobs/)
    assert.match(src, /isUploadPaused\(ep\) \? 'Resume in Jobs' : 'View in Jobs'/)
  })
})
