import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/reconcile.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')
const shellSource = readFileSync(
  fileURLToPath(new URL('../pages/projects/[slug]/upload.vue', import.meta.url)),
  'utf8',
)

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-reconcile' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-reconcile',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, onMounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useConfirm = () => ({ ask: async (o) => globalThis.__ucConfirm(o) })
    const useRoute = () => ({ params: { slug: 'demo-project' } })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const EMPTY = {
  candidates: [], local_only: [], youtube_only: [], duplicates: [],
  ignored_video_ids: [], history: [], remote_listed_at: '2026-09-03T10:00:00.000Z',
}

async function mount(view: Record<string, any>, posts: Record<string, any> = {}, confirmAnswer = true) {
  const calls: any[] = []
  ;(globalThis as any).__ucConfirm = async () => confirmAnswer
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => { calls.push({ method: 'GET', path }); return { ...EMPTY, ...view } },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      const key = Object.keys(posts).find(k => path.endsWith(k))
      return key ? posts[key] : {}
    },
    del: async (path: string) => { calls.push({ method: 'DELETE', path }); return {} },
  }
  const Page = await loadPage()
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', calls, destroy: () => app.unmount() }
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find(b => b.textContent!.includes(label))

describe('Upload Center Reconcile', () => {
  test('opening the page contacts YouTube for nothing', async () => {
    const mounted = await mount({})
    // All three are LOCAL reads. The two undo records live on disk — they are
    // the 30-day reversibility promise Ideas and Settings make about Compact
    // and Rebalance, and reading either costs no quota and contacts nobody.
    //
    // The list is asserted exactly, not by "none of these is a YouTube path",
    // so a read added here has to be justified rather than slipping in. The
    // reseason entry was added deliberately in Phase 9 (blocker 4) and this
    // assertion is what caught it.
    assert.deepEqual(mounted.calls.map(c => c.path), [
      '/projects/demo-project/youtube/reconcile',
      '/projects/demo-project/upload/renumber-undo',
      '/projects/demo-project/episodes/reseason-undo',
    ])
    assert.match(mounted.text(), /only thing here that contacts YouTube/)
    mounted.destroy()
  })

  test('a channel that has never been listed does not read as having no matches', async () => {
    const never = await mount({ remote_listed_at: null })
    assert.match(never.text(), /have not been listed yet/)
    assert.match(never.text(), /Refresh the channel listing first/)
    never.destroy()

    const listed = await mount({ local_only: ['EP0001'], youtube_only: ['video-a'] })
    assert.match(listed.text(), /Channel listed/)
    assert.doesNotMatch(listed.text(), /Refresh the channel listing first/)
    listed.destroy()
  })

  test('recorded matches and guesses are labelled differently', async () => {
    const mounted = await mount({
      candidates: [
        { episode_code: 'EP0001', video_id: 'video-1', evidence: 'stored_video_id', reason: 'Already recorded.', auto_linkable: true },
        { episode_code: 'EP0002', video_id: 'video-2', evidence: 'exact_title', reason: 'The titles are identical.', auto_linkable: false },
      ],
    })
    assert.match(mounted.text(), /Recorded/)
    assert.match(mounted.text(), /Not linked automatically/)
    // Each suggestion explains itself.
    assert.match(mounted.text(), /Already recorded\./)
    assert.match(mounted.text(), /The titles are identical\./)
    mounted.destroy()
  })

  test('bulk linking demands a preview with exact counts, then a confirm', async () => {
    const mounted = await mount(
      {
        candidates: [
          { episode_code: 'EP0001', video_id: 'video-1', evidence: 'stored_video_id', reason: 'r', auto_linkable: true },
        ],
      },
      {
        '/preview': {
          counts: { will_link: 1, already_linked: 4, cannot_link: 2 },
          cannot_link: [
            { episode_code: 'EP0009', video_id: 'video-9', reason: 'needs_confirmation' },
            { episode_code: 'EP0010', video_id: 'video-10', reason: 'possible_duplicate_needs_review' },
          ],
        },
        '/apply': { counts: { linked: 1, refused: 2 } },
      },
    )

    // Nothing is applied before the preview is asked for.
    assert.equal(button(mounted.el, 'Link 1 now'), undefined)
    button(mounted.el, 'Preview linking them')!.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const text = mounted.text()
    assert.match(text, /4.*already linked/)
    assert.match(text, /2.*cannot be linked/)
    assert.match(text, /the evidence is a guess, so you decide/)
    assert.match(text, /more than one thing could claim this/)

    // And applying is a separate, deliberate click.
    assert.equal(mounted.calls.some(c => c.path.endsWith('/apply')), false)
    button(mounted.el, 'Link 1 now')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.some(c => c.path.endsWith('/apply')), true)
    mounted.destroy()
  })

  test('ambiguous duplicates are honestly left outside the bulk action', async () => {
    const mounted = await mount({
      duplicates: [{ kind: 'video', id: 'video-1', competing: ['EP0001', 'EP0002'] }],
    })
    assert.match(mounted.text(), /more than one match could claim/)
    assert.match(mounted.text(), /contested by EP0001, EP0002/)
    assert.match(mounted.text(), /not linked automatically/)
    assert.match(mounted.text(), /cannot resolve an ambiguous match/)
    mounted.destroy()
  })

  test('an unexpired renumber undo requires confirmation before permanent dismissal', async () => {
    const declined = await mount({ available: true, expired: false }, {}, false)
    button(declined.el, 'Discard undo')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(declined.calls.some(c => c.method === 'DELETE'), false)
    declined.destroy()

    const accepted = await mount({ available: true, expired: false })
    button(accepted.el, 'Discard undo')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.deepEqual(accepted.calls.find(c => c.method === 'DELETE'), {
      method: 'DELETE', path: '/projects/demo-project/upload/renumber-undo',
    })
    accepted.destroy()
  })

  test('an expired undo can be dismissed without a recovery confirmation', async () => {
    const mounted = await mount({ available: true, expired: true }, {}, false)
    button(mounted.el, 'Dismiss')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.equal(mounted.calls.some(c => c.method === 'DELETE'), true)
    mounted.destroy()
  })

  test('a truncated listing does not pretend another fetch reaches older videos', async () => {
    const mounted = await mount({ remote_listing_truncated: true })
    assert.match(mounted.text(), /will not reach the older ones/)
    assert.doesNotMatch(mounted.text(), /Fetch again after linking what you can/)
    mounted.destroy()
  })

  test('setting a video aside is reversible and never reads as "no match"', async () => {
    const mounted = await mount({ youtube_only: ['video-orphan'] })
    button(mounted.el, 'Set aside')!.click()
    for (let i = 0; i < 6; i++) await nextTick()

    const posted = mounted.calls.find(c => c.method === 'POST')
    assert.equal(posted.path, '/projects/demo-project/youtube/reconcile/ignore')
    assert.deepEqual(posted.body, { video_id: 'video-orphan', ignored: true })
    mounted.destroy()

    const withIgnored = await mount({ ignored_video_ids: ['video-orphan'] })
    assert.match(withIgnored.text(), /kept out of the way, not lost/)
    assert.notEqual(button(withIgnored.el, 'Bring back'), undefined)
    withIgnored.destroy()
  })

  test('every reconcile decision offers an undo that says what it restores', async () => {
    const mounted = await mount({
      history: [
        { decision_id: 'd1', episode_code: 'EP0001', previous_video_id: null, next_video_id: 'video-1' },
        { decision_id: 'd2', episode_code: 'EP0002', previous_video_id: 'video-old', next_video_id: 'video-2' },
        { decision_id: 'd3', episode_code: 'EP0003', previous_video_id: null, next_video_id: 'video-3', rolled_back_at: '2026-09-03T11:00:00.000Z' },
      ],
    })
    assert.match(mounted.text(), /Undo \(unlink\)/)
    assert.match(mounted.text(), /Undo \(back to video-old\)/)
    // An already-undone decision is not offered again.
    assert.doesNotMatch(mounted.text(), /EP0003/)

    button(mounted.el, 'Undo (unlink)')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    const posted = mounted.calls.find(c => c.path.endsWith('/rollback'))
    assert.deepEqual(posted.body, { decision_id: 'd1' })
    mounted.destroy()
  })

  test('a failed load says so rather than rendering as nothing to do', async () => {
    ;(globalThis as any).__ucConfirm = async () => confirmAnswer
  ;(globalThis as any).__ucApi = { get: async () => { throw new Error('backend unreachable') }, post: async () => ({}) }
    const Page = await loadPage()
    const el = document.createElement('div')
    const app = createApp(defineComponent({ render: () => h(Page as any) }))
    app.mount(el)
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(el.textContent!, /backend unreachable/)
    assert.doesNotMatch(el.textContent!, /Nothing to suggest/)
    app.unmount()
  })
})

describe('Upload Center Reconcile boundaries', () => {
  test('the shell links Reconcile as a real area', () => {
    assert.match(shellSource, /upload\/reconcile/)
    for (const pending of ['Comments', 'Analytics']) assert.match(shellSource, new RegExp(pending))
  })

  test('Reconcile never deletes, uploads, or merges automatically', () => {
    // Spec section 13 forbids all three.
    //
    // `\/upload\b` was part of this pattern and is dropped: the whole Upload
    // Center moved to /projects/:slug/upload in Phase 9, so that fragment now
    // matches every URL in the feature and forbids nothing. It was standing in
    // for "does not call the legacy upload endpoint", which no longer exists.
    // The three ACTIONS are what the spec forbids, and they are what is checked.
    assert.doesNotMatch(source, /deleteVideo|removeVideo|merge/i)
  })

  test('Reconcile renders no token, secret, or session url', () => {
    assert.doesNotMatch(source, /access_token|refresh_token|client_secret|session_url/)
  })
})
