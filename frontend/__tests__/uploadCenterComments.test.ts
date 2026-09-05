import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/comments.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-comments' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-comments',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, onMounted, reactive } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => ({ params: { slug: 'demo-project' } })
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const BASE = {
  comments: [], receipts: [], fetched_at: '2026-09-03T10:00:00.000Z',
  partial: false, unreached_video_ids: [], partially_read_video_ids: [],
  comments_disabled_video_ids: [], never_fetched: false, channel_assigned: true,
}

function comment(overrides: Record<string, unknown> = {}) {
  return {
    comment_id: 'c1', video_id: 'v1', author: 'Someone', text: 'A comment',
    published_at: '2026-09-03T10:00:00.000Z', moderation_status: 'published',
    channel_replied: false, reply_count: 0, replies: [], can_reply: true, ...overrides,
  }
}

async function mount(view: Record<string, any>, posts: Record<string, any> = {}, confirm = true) {
  const calls: any[] = []
  const confirms: any[] = []
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => { calls.push({ method: 'GET', path }); return { ...BASE, ...view } },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      const key = Object.keys(posts).find(k => path.endsWith(k))
      return key ? posts[key] : { counts: { done: 1, failed: 0, unrecorded: 0 }, receipt: { outcome: 'done' } }
    },
  }
  ;(globalThis as any).__ucConfirm = async (options: any) => { confirms.push(options); return confirm }

  const Page = await loadPage()
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', html: () => el.innerHTML, calls, confirms, destroy: () => app.unmount() }
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find(b => b.textContent!.trim().startsWith(label))

describe('Upload Center Comments', () => {
  test('hostile comment text is rendered as literal text, never as markup', async () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)> [link](javascript:alert(3))'
    const mounted = await mount({
      comments: [comment({ text: hostile, author: '<b>Bold</b> Author' })],
    })

    // The characters are on screen as text...
    assert.match(mounted.text(), /<script>alert\(1\)<\/script>/)
    assert.match(mounted.text(), /<img src=x onerror=alert\(2\)>/)
    assert.match(mounted.text(), /\[link\]\(javascript:alert\(3\)\)/)
    assert.match(mounted.text(), /<b>Bold<\/b> Author/)

    // ...and NOT as elements. Author names are the same class of input.
    assert.equal(mounted.el.querySelector('script'), null)
    assert.equal(mounted.el.querySelector('img'), null)
    assert.equal(mounted.el.querySelector('a'), null)
    assert.equal(mounted.el.querySelectorAll('b').length, 0)
    // The markup arrives escaped in the DOM.
    assert.match(mounted.html(), /&lt;script&gt;/)
    mounted.destroy()
  })

  test('a partial inbox shows the reason and the videos not reached', async () => {
    const mounted = await mount({
      comments: [comment()],
      partial: true, partial_reason: 'quota_exhausted', unreached_video_ids: ['v9', 'v10'],
    })
    assert.match(mounted.text(), /allowance ran out partway through/)
    assert.match(mounted.text(), /has not been looked at yet/)
    assert.match(mounted.text(), /Never opened: v9, v10/)
    // Never the vague version.
    assert.doesNotMatch(mounted.text(), /some comments may be missing/i)
    mounted.destroy()
  })

  test('each partial reason reads differently', async () => {
    for (const [reason, expected] of [
      ['quota_exhausted', /allowance ran out/],
      ['provider_error', /YouTube stopped answering/],
      ['limit_reached', /only the first batch/i],
    ] as Array<[string, RegExp]>) {
      const mounted = await mount({ comments: [comment()], partial: true, partial_reason: reason })
      assert.match(mounted.text(), expected, reason)
      if (reason === 'limit_reached') {
        // No page token is kept, so every fetch restarts at the newest batch.
        // "Fetch again to continue" promised progress that cannot happen and
        // costs quota to discover.
        assert.doesNotMatch(mounted.text(), /Fetch again to continue/, reason)
      }
      mounted.destroy()
    }
  })

  test('never fetched, no comments, and none in this view are three different messages', async () => {
    const never = await mount({ never_fetched: true, fetched_at: null })
    assert.match(never.text(), /have not been fetched yet/)
    never.destroy()

    const none = await mount({ comments: [] })
    assert.match(none.text(), /No comments on this channel/)
    none.destroy()

    // A held comment exists, but the default view is needs-reply.
    const otherView = await mount({ comments: [comment({ moderation_status: 'heldForReview' })] })
    assert.match(otherView.text(), /Nothing in this view/)
    otherView.destroy()
  })

  test('rejecting without banning is one plain click', async () => {
    const mounted = await mount({ comments: [comment()] })
    button(mounted.el, 'Reject')!.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const posted = mounted.calls.find(c => c.method === 'POST')
    assert.equal(posted.path, '/projects/demo-project/youtube/comments/moderate')
    assert.deepEqual(posted.body, { action: 'reject', comment_ids: ['c1'] })
    // No ban flag anywhere near the easy path, and no confirmation demanded.
    assert.equal('ban_author' in posted.body, false)
    assert.equal(mounted.confirms.length, 0)
    mounted.destroy()
  })

  test('banning is confirmed by name and goes to its own single-author route', async () => {
    const mounted = await mount({ comments: [comment({ author: 'Rude Person' })] })
    button(mounted.el, 'Reject and ban')!.click()
    for (let i = 0; i < 6; i++) await nextTick()

    assert.equal(mounted.confirms.length, 1)
    assert.match(mounted.confirms[0].title, /Rude Person/)
    assert.equal(mounted.confirms[0].danger, true)

    const posted = mounted.calls.find(c => c.path.endsWith('/ban'))
    assert.deepEqual(posted.body, { comment_id: 'c1', confirm: true })
    mounted.destroy()
  })

  test('a declined ban does nothing at all', async () => {
    const mounted = await mount({ comments: [comment()] }, {}, false)
    button(mounted.el, 'Reject and ban')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.some(c => c.method === 'POST'), false)
    mounted.destroy()
  })

  test('an unrecorded write warns against repeating it', async () => {
    const mounted = await mount(
      { comments: [comment()] },
      { '/moderate': { counts: { done: 0, failed: 0, unrecorded: 1 } } },
    )
    button(mounted.el, 'Reject')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /could not record it/)
    assert.match(mounted.text(), /Do not repeat it/)
    mounted.destroy()
  })

  test('opening the inbox contacts YouTube for nothing', async () => {
    const mounted = await mount({ comments: [comment()] })
    assert.deepEqual(mounted.calls.map(c => c.path), ['/projects/demo-project/youtube/comments'])
    mounted.destroy()
  })

  test('comments turned off is stated, not silently absent', async () => {
    const mounted = await mount({ comments: [], comments_disabled_video_ids: ['v1'] })
    assert.match(mounted.text(), /Comments are turned off on 1 video/)
    assert.match(mounted.text(), /Nobody can reply to those/)
    mounted.destroy()
  })
})

  test('search matches text or author, over the cache, without spending quota', async () => {
    const mounted = await mount({
      comments: [
        comment({ comment_id: 'c1', author: 'Ada', text: 'about whales' }),
        comment({ comment_id: 'c2', author: 'Grace', text: 'about ships' }),
      ],
    })
    const before = mounted.calls.length

    const box = mounted.el.querySelector('input[type=search]') as HTMLInputElement
    box.value = 'whales'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()

    assert.match(mounted.text(), /about whales/)
    assert.doesNotMatch(mounted.text(), /about ships/)

    box.value = 'grace'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()
    assert.match(mounted.text(), /about ships/, 'author matches too')

    assert.equal(mounted.calls.length, before, 'filtering never asks the server')
    mounted.destroy()
  })

  test('the view counts report the real workload, not what a filter is showing', async () => {
    const mounted = await mount({
      comments: [
        comment({ comment_id: 'c1', author: 'Ada', text: 'whales' }),
        comment({ comment_id: 'c2', author: 'Grace', text: 'ships' }),
      ],
    })
    const box = mounted.el.querySelector('input[type=search]') as HTMLInputElement
    box.value = 'whales'
    box.dispatchEvent(new Event('input'))
    for (let i = 0; i < 4; i++) await nextTick()

    // Still 2 waiting, even though 1 is on screen.
    assert.match(mounted.text(), /Needs reply \(2\)/)
    mounted.destroy()
  })

  test('replies are shown so a thread reads whole, and ours are marked', async () => {
    const mounted = await mount({
      comments: [comment({
        reply_count: 2,
        replies: [
          { comment_id: 'r1', author: 'Viewer', text: 'Second thought', from_channel: false },
          { comment_id: 'r2', author: 'Us', text: 'Thanks!', from_channel: true },
        ],
      })],
    })
    assert.match(mounted.text(), /Second thought/)
    assert.match(mounted.text(), /Thanks!/)
    assert.match(mounted.text(), /You/)
    mounted.destroy()
  })

  test('a thread YouTube has closed cannot be replied to', async () => {
    const mounted = await mount({ comments: [comment({ can_reply: false })] })
    const reply = [...mounted.el.querySelectorAll('button')].find(b => b.textContent!.trim() === 'Reply')!
    assert.equal(reply.disabled, true)
    mounted.destroy()
  })

  test('bulk moderation previews exact counts and needs a separate confirm', async () => {
    const mounted = await mount(
      { comments: [comment({ comment_id: 'c1' }), comment({ comment_id: 'c2' })] },
      { '/moderate/preview': { counts: { will_change: 2, already: 1, unknown: 0 } } },
    )
    const boxes = [...mounted.el.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    for (const box of boxes) {
      box.checked = true
      box.dispatchEvent(new Event('change'))
    }
    for (let i = 0; i < 4; i++) await nextTick()
    assert.match(mounted.text(), /2 selected/)

    button(mounted.el, 'Preview rejecting')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(mounted.text(), /2.*will change/)
    assert.match(mounted.text(), /1.*already that way/)
    // Nothing applied until the second, explicit click.
    assert.equal(mounted.calls.some(c => c.path.endsWith('/comments/moderate')), false)

    button(mounted.el, 'Reject 2 now')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    const applied = mounted.calls.find(c => c.path.endsWith('/comments/moderate'))
    assert.deepEqual(applied.body, { action: 'reject', comment_ids: ['c1', 'c2'] })
    mounted.destroy()
  })

  test('the bulk panel never offers a ban', async () => {
    const mounted = await mount({ comments: [comment()] })
    const box = mounted.el.querySelector('input[type=checkbox]') as HTMLInputElement
    box.checked = true
    box.dispatchEvent(new Event('change'))
    for (let i = 0; i < 4; i++) await nextTick()
    const bulk = mounted.el.querySelector('.bulk')!
    assert.equal([...bulk.querySelectorAll('button')].some(b => /ban/i.test(b.textContent!)), false)
    assert.match(bulk.textContent!, /one author at a time/)
    mounted.destroy()
  })

describe('Upload Center Comments boundaries', () => {
  test('the page never renders author-controlled content as HTML', () => {
    assert.doesNotMatch(source, /v-html/)
    assert.doesNotMatch(source, /innerHTML/)
    // No markdown renderer anywhere near comment text.
    assert.doesNotMatch(source, /marked|markdown-it|DOMPurify|sanitize-html/i)
  })

  test('the confirm dialog escapes too — the ban message carries an author name', () => {
    // The sibling-guard tell. comments.vue escapes its own output, but the ban
    // confirmation hands an author-controlled name to a DIFFERENT component,
    // which the page test cannot see. If ConfirmDialog ever rendered its title
    // or message as HTML, every danger confirm in this feature would become an
    // injection point at once.
    const confirmSource = readFileSync(
      fileURLToPath(new URL('../components/ConfirmDialog.vue', import.meta.url)), 'utf8',
    )
    assert.doesNotMatch(confirmSource, /v-html/)
    assert.doesNotMatch(confirmSource, /innerHTML/)
    // And it really does interpolate them.
    assert.match(confirmSource, /\{\{\s*state\.options\.title\s*\}\}/)
    assert.match(confirmSource, /\{\{\s*state\.options\.message\s*\}\}/)
  })

  test('there is no comment deletion offered anywhere on the page', () => {
    // Spec section 14 gives approve, reject and ban. Rejection hides.
    assert.doesNotMatch(source, /Delete comment|comments\/delete|action: 'delete'/i)
  })

  test('no automatic moderation, replying or hiding exists', () => {
    // Tripwire, like the Reconcile provider-write one: every action here is a
    // click. The moment an automatic path appears, this fails.
    assert.doesNotMatch(source, /setInterval|setTimeout\s*\([^)]*moderate|auto_moderate|autoReply|auto_reply/i)
  })
})

test('an unassigned project is told why, and cannot start a fetch it would lose', async () => {
  // Otherwise the only feedback is a 409 after the click, and every comment
  // already on screen reads "needs reply" with no explanation.
  const unassigned = await mount({ channel_assigned: false })
  assert.match(unassigned.text(), /No YouTube channel is assigned/)
  assert.equal(button(unassigned.el, 'Fetch comments')!.disabled, true)
  unassigned.destroy()

  // Control: with a channel, neither the notice nor the block is there.
  const assigned = await mount({})
  assert.doesNotMatch(assigned.text(), /No YouTube channel is assigned/)
  assert.equal(button(assigned.el, 'Fetch comments')!.disabled, false)
  assigned.destroy()
})

test('a video read in part is not reported as a video never reached', async () => {
  // One list for both facts told the owner a video whose comments are on
  // screen was "not reached".
  const mounted = await mount({
    partial: true, partial_reason: 'limit_reached',
    unreached_video_ids: ['never'], partially_read_video_ids: ['partly'],
  })
  // Read the two lines separately — as rendered they run together in textContent.
  const lines = [...mounted.el.querySelectorAll('.partial .hint')].map(n => n.textContent!.trim())
  const neverOpened = lines.find(line => line.startsWith('Never opened'))
  const partlyRead = lines.find(line => line.startsWith('Read, but'))
  assert.equal(neverOpened, 'Never opened: never')
  assert.match(partlyRead!, /Read, but has more than one fetch could return:\s*partly/)
  mounted.destroy()
})
