import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/upload/analytics.vue', import.meta.url))
const source = readFileSync(pagePath, 'utf8')
const inspirationSource = readFileSync(
  fileURLToPath(new URL('../components/TopPerformersInspiration.vue', import.meta.url)),
  'utf8',
)

async function loadPage(): Promise<Component> {
  const { descriptor } = parse(source, { filename: pagePath })
  const script = compileScript(descriptor, { id: 'uc-analytics' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename: pagePath,
    id: 'uc-analytics',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  const support = `
    import { ref, computed, onMounted } from ${JSON.stringify(vueUrl)}
    const useApi = () => globalThis.__ucApi
    const useRoute = () => ({ params: { slug: 'demo-project' } })
  `
  const code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const out = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    out.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const AT = '2026-09-03T10:00:00.000Z'

/**
 * The response shape is written ONCE here, mirroring what the route returns.
 * Fields are never invented: an earlier phase lost `replies` and `can_reply`
 * because a page fixture supplied what the server did not (tell 7b).
 */
const BASE = {
  episodes: [], fetched_at: AT, partial: false, unreached_video_ids: [],
  never_fetched: false, start_date: '2026-06-05', end_date: '2026-09-03', empty_reason: null,
}

const metric = (state: string, extra: Record<string, unknown> = {}) => ({ state, fetched_at: AT, ...extra })

const ALL_METRICS = [
  'views', 'watch_minutes', 'avg_view_seconds', 'avg_view_percentage', 'likes', 'comments', 'shares',
  'subscribers_gained', 'impressions', 'click_through_rate',
]

function episode(metrics: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    episode_code: 'EP0001',
    title: 'The Lantern Keeper',
    video_id: 'v1',
    metrics: Object.fromEntries(ALL_METRICS.map(id => [id, metrics[id] ?? metric('value', { value: 0 })])),
    facts: {
      published: metric('value', { value: Date.parse('2026-04-15T00:00:00Z') }),
      length: metric('value', { value: 3723 }),
    },
    ...overrides,
  }
}

async function mount(view: Record<string, any>, posts: Record<string, any> = {}, failures: { get?: any, post?: any } = {}) {
  const calls: any[] = []
  ;(globalThis as any).__ucApi = {
    get: async (path: string) => {
      calls.push({ method: 'GET', path })
      if (failures.get) throw failures.get
      return { ...BASE, ...view }
    },
    post: async (path: string, body: any) => {
      calls.push({ method: 'POST', path, body })
      if (failures.post) throw failures.post
      return posts[path] ?? { fetched: 1, partial: false }
    },
  }
  const Page = await loadPage()
  const el = document.createElement('div')
  const app = createApp(defineComponent({ render: () => h(Page as any) }))
  // Nuxt's link, as the anchor it renders.
  app.component('NuxtLink', defineComponent({
    props: { to: { type: String, required: true } },
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }))
  app.mount(el)
  for (let i = 0; i < 6; i++) await nextTick()
  return { el, text: () => el.textContent || '', calls, destroy: () => app.unmount() }
}

const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find(b => b.textContent!.trim().startsWith(label))

/**
 * Every metric cell, with the state the DOM itself declares. The detail (what
 * the cell means and when it was checked) lives in `title` and in
 * visually-hidden text; both are asserted to carry the same words.
 */
const metricCells = (el: HTMLElement) =>
  [...el.querySelectorAll('td.metric')].map(node => {
    const detail = node.getAttribute('title') ?? ''
    assert.equal(node.querySelector('.sr-only')?.textContent?.trim(), detail, 'the hidden text matches the title')
    return {
      state: node.getAttribute('data-state'),
      text: node.querySelector('.cell-text')?.textContent?.trim() ?? '',
      detail,
    }
  })

/** The body rows as [code, ...cell texts], in screen order. */
const bodyRows = (el: HTMLElement) =>
  [...el.querySelectorAll('tbody tr')].map(tr => ({
    code: tr.querySelector('th .code')?.textContent?.trim() ?? '',
    cells: Object.fromEntries([...tr.querySelectorAll('td')].map((td, i) => [
      [...el.querySelectorAll('thead th')][i + 1]!.textContent!.replace(/[▲▼]/g, '').trim(),
      td.querySelector('.cell-text')?.textContent?.trim() ?? '',
    ])),
  }))

const settle = async () => { for (let i = 0; i < 6; i++) await nextTick() }

const headerButton = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('thead button')].find(b => b.textContent!.replace(/[▲▼]/g, '').trim() === label) as HTMLButtonElement

const views = (value: number | null, extra: Record<string, unknown> = {}) =>
  value === null ? metric('no_data', extra) : metric('value', { value, ...extra })

describe('Upload Center Analytics', () => {
  test('the inspiration card reads typed analytics and distinguishes unavailable data from no data', () => {
    assert.match(inspirationSource, /\/youtube\/analytics/)
    assert.match(inspirationSource, /views\?\.state === 'value'/)
    assert.doesNotMatch(inspirationSource, /\br\.rows\b|\?\?\s*0/)
    assert.match(inspirationSource, /scope_missing/)
    assert.match(inspirationSource, /Analytics are unavailable/)
  })
  test('the four states are visibly distinct on screen, one pair at a time', async () => {
    const states = [
      ['value', metric('value', { value: 0 })],
      ['not_fetched', metric('not_fetched')],
      ['not_available', metric('not_available', { reason: 'Retention needs 1,000 views.' })],
      ['no_data', metric('no_data')],
    ] as Array<[string, any]>

    const rendered: Record<string, string> = {}
    for (const [name, value] of states) {
      const mounted = await mount({ episodes: [episode({ views: value })] })
      const cell = metricCells(mounted.el).find(c => c.state === (name === 'not_fetched' ? 'not_fetched' : name))!
      assert.ok(cell, `${name} did not render a cell carrying its state`)
      rendered[name] = cell.text
      mounted.destroy()
    }

    // Six pairs. A state that differed only by attribute would still read as a
    // number on screen, so the assertion is on the TEXT the owner sees.
    const names = Object.keys(rendered)
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        assert.notEqual(
          rendered[names[i]!], rendered[names[j]!],
          `${names[i]} and ${names[j]} render the same text`,
        )
      }
    }
  })

  test('a real zero shows the number; nothing else shows a numeral', async () => {
    const mounted = await mount({
      episodes: [episode({
        views: metric('value', { value: 0 }),
        likes: metric('not_fetched'),
        shares: metric('no_data'),
        comments: metric('not_available', { reason: 'Not offered here.' }),
      })],
    })

    const cells = metricCells(mounted.el)
    assert.equal(cells.find(c => c.state === 'value')!.text, '0')
    // bareNumberPaths, applied to what is RENDERED: every numeral on screen
    // must sit in a cell whose state says it is a measurement.
    for (const cell of cells) {
      if (cell.state === 'value') continue
      assert.doesNotMatch(cell.text, /\d/, `${cell.state} rendered a numeral: ${cell.text}`)
    }
    mounted.destroy()
  })

  test('a truncated report is its own reason, not a quota or provider error', async () => {
    const truncated = await mount({
      partial: true, partial_reason: 'report_truncated', unreached_video_ids: ['v9', 'v10'],
    })
    const text = truncated.text()
    // It means something different from the other two: waiting will not help
    // and retrying will not help, so the words must not say either.
    assert.match(text, /more episodes than one report returns/)
    assert.match(text, /not been measured/)
    assert.doesNotMatch(text, /allowance/i)
    assert.doesNotMatch(text, /stopped answering/i)
    // The videos are named, never summarised away.
    assert.match(text, /Not covered: v9, v10/)
    assert.doesNotMatch(text, /some (numbers|data|metrics) may be missing/i)
    truncated.destroy()

    // Control: the other two reasons still read as themselves.
    const quota = await mount({ partial: true, partial_reason: 'quota_exhausted' })
    assert.match(quota.text(), /allowance ran out/)
    assert.doesNotMatch(quota.text(), /more episodes than one report returns/)
    quota.destroy()

    const provider = await mount({ partial: true, partial_reason: 'provider_error' })
    assert.match(provider.text(), /stopped answering/)
    assert.doesNotMatch(provider.text(), /more episodes than one report returns/)
    provider.destroy()
  })

  test('an unassigned project is told why and cannot start a fetch', async () => {
    const mounted = await mount({ empty_reason: 'no_channel_assigned', never_fetched: true, fetched_at: null })
    assert.match(mounted.text(), /No YouTube channel is assigned/)
    assert.equal(button(mounted.el, 'Fetch for this period')!.disabled, true)
    mounted.destroy()

    const assigned = await mount({})
    assert.equal(button(assigned.el, 'Fetch for this period')!.disabled, false)
    assigned.destroy()
  })

  test('never fetched, no episodes and a real result are three different messages', async () => {
    const never = await mount({ never_fetched: true, fetched_at: null })
    assert.match(never.text(), /have not been fetched yet/)
    never.destroy()

    const empty = await mount({ episodes: [] })
    assert.match(empty.text(), /No episode from this project has been published/)
    empty.destroy()

    const measured = await mount({ episodes: [episode({})] })
    assert.match(measured.text(), /Last fetched/)
    measured.destroy()
  })

  test('reading the page contacts YouTube for nothing', async () => {
    const mounted = await mount({ episodes: [episode({})] })
    assert.deepEqual(
      mounted.calls.map(c => c.method), ['GET'],
      'opening analytics is a read of the saved copy and nothing else',
    )
    mounted.destroy()
  })

  test('analytics preserves structured load and refresh failures', async () => {
    const unavailable = await mount({}, {}, { get: { data: { detail: 'Analytics permission is missing for this channel.' } } })
    assert.match(unavailable.text(), /Analytics permission is missing/)
    unavailable.destroy()

    const refresh = await mount({}, {}, { post: { data: { detail: 'Today’s analytics allowance is exhausted.' } } })
    button(refresh.el, 'Fetch for this period')!.click()
    for (let i = 0; i < 6; i++) await nextTick()
    assert.match(refresh.text(), /analytics allowance is exhausted/)
    refresh.destroy()
  })

  test('no monetary figure and no card-click CTR appears', async () => {
    const mounted = await mount({ episodes: [episode({})] })
    assert.doesNotMatch(mounted.text(), /revenue|rpm|cpm|earnings|\bctr\b/i)
    mounted.destroy()
  })

  test('every metric names its age', async () => {
    // The "untrusted titles are text" half is gone with the field: the row is
    // labelled from `episode_code`, which the route fills from a validated
    // identifier, so driving a hostile <script> through it tested a path that
    // cannot occur. Author-controlled text on THIS page does not exist.
    const mounted = await mount({ episodes: [episode({})] })
    for (const cell of metricCells(mounted.el)) {
      assert.notEqual(cell.detail, '', 'a figure with no age cannot be judged')
    }
    mounted.destroy()
  })

  test('nothing on this page happens automatically', async () => {
    // Same tripwire the Comments page carries: every fetch is a click.
    assert.doesNotMatch(source, /setInterval|setTimeout\s*\([^)]*refresh|auto_refresh|autoRefresh/i)
  })

  test('the window is on screen, and every figure is read against it', async () => {
    const mounted = await mount({ episodes: [episode({})] })
    assert.match(mounted.text(), /Measured over 2026-06-05 to 2026-09-03/)
    // Each measured figure repeats the window, so a number lifted out of
    // context still carries it.
    const measured = metricCells(mounted.el).filter(c => c.state === 'value')
    assert.ok(measured.length > 0)
    for (const cell of measured) {
      assert.match(cell.detail, /for 2026-06-05 to 2026-09-03/)
    }
    mounted.destroy()
  })

  test('no data says the PERIOD was quiet, not that the video was never watched', async () => {
    const mounted = await mount({ episodes: [episode({ views: metric('no_data') })] })
    const cell = metricCells(mounted.el).find(c => c.state === 'no_data')!
    assert.match(cell.detail, /reported nothing for 2026-06-05 to 2026-09-03/)
    mounted.destroy()
  })

  // A test for "a cache with no window" lived here. It mounted
  // { start_date: null, end_date: null, never_fetched: false } — a shape the
  // route cannot produce, since the window is required on the stored cache and
  // one without it is dropped. It kept two dead page branches looking alive:
  // tell 7b, in the file whose own header says fields are never invented.

  test('a malformed value state renders as not fetched, never as zero', async () => {
    // `value` with no number is malformed. Printing 0 would manufacture the
    // exact reading this page exists to prevent.
    const malformed = Object.fromEntries(ALL_METRICS.map(id => [id, { state: 'value', fetched_at: AT }]))
    const mounted = await mount({ episodes: [episode(malformed)] })
    const cells = metricCells(mounted.el)
    assert.equal(cells.filter(c => c.state === 'value').length, 0, 'nothing claims to be a measurement')
    assert.equal(cells.every(c => c.state === 'not_fetched'), true)
    assert.equal(cells.some(c => /\d/.test(c.text)), false, 'and no numeral reached the screen')
    mounted.destroy()
  })

  test('a missing analytics grant reads as a permission, not an allowance', async () => {
    // Neither waiting nor retrying fixes this, so the words must suggest
    // neither. It rendered as "today's allowance ran out" — advice to wait for
    // a reset that would never help.
    const mounted = await mount({
      partial: true, partial_reason: 'scope_missing', unreached_video_ids: ['v1'],
    })
    const text = mounted.text()
    assert.match(text, /not granted analytics access/)
    assert.match(text, /Reconnect the channel/)
    assert.doesNotMatch(text, /allowance/i)
    assert.doesNotMatch(text, /Fetch(ing)? again/i)
    // The banner leads to the screen that fixes it.
    assert.ok(mounted.el.querySelector('a[href="/projects/demo-project/settings#youtube"]'))
    mounted.destroy()

    // Every unmeasured metric cell names the permission, not a forgotten fetch;
    // a figure measured before the grant was lost still shows as a figure.
    const cells = await mount({
      partial: true, partial_reason: 'scope_missing',
      episodes: [episode(Object.fromEntries(ALL_METRICS.map(id => [id, metric('not_fetched')])), {
        metrics: { ...Object.fromEntries(ALL_METRICS.map(id => [id, { state: 'not_fetched' }])), views: metric('value', { value: 12 }) },
      })],
    })
    const rendered = metricCells(cells.el)
    assert.equal(rendered.find(c => c.state === 'value')!.text, '12')
    const unmeasured = rendered.filter(c => c.state === 'not_fetched')
    assert.equal(unmeasured.length, ALL_METRICS.length - 1)
    for (const cell of unmeasured) {
      assert.equal(cell.text, 'Not available — reconnect YouTube with analytics access')
    }
    cells.destroy()
  })

  test('an unmeasured state still says when it was checked', async () => {
    // A figure with no age cannot be judged — and that applies to an ABSENCE
    // too: "no data" from this morning and from four months ago are different
    // facts about the same video.
    const mounted = await mount({
      episodes: [episode({
        views: metric('no_data'),
        likes: metric('not_available', { reason: 'Not offered here.' }),
      })],
    })
    const cells = metricCells(mounted.el)
    assert.match(cells.find(c => c.state === 'no_data')!.detail, /checked/)
    assert.match(cells.find(c => c.state === 'not_available')!.detail, /checked/)
    // ...and not_fetched has no age to state, because nothing was checked.
    const nothing = await mount({ episodes: [episode({ views: metric('not_fetched') })] })
    assert.doesNotMatch(
      metricCells(nothing.el).find(c => c.state === 'not_fetched')!.detail, /checked/)
    nothing.destroy()
    mounted.destroy()
  })

  // ── The table ─────────────────────────────────────────────────────────────
  const TABLE = {
    episodes: [
      episode({ views: views(100), likes: metric('value', { value: 5 }) }, { episode_code: 'EP0001', video_id: 'v1' }),
      episode({ views: views(300) }, { episode_code: 'EP0002', video_id: 'v2', title: '=HYPERLINK("evil")' }),
      episode({ views: views(null) }, { episode_code: 'EP0003', video_id: 'v3', title: 'Quiet one' }),
      episode({ views: views(50) }, { episode_code: 'EP0010', video_id: 'v10', title: 'Ghost Ship' }),
    ],
  }

  test('a header click sorts, again reverses, and a row with no figure stays last both ways', async () => {
    const mounted = await mount(TABLE)
    assert.deepEqual(bodyRows(mounted.el).map(r => r.code), ['EP0001', 'EP0002', 'EP0003', 'EP0010'])

    headerButton(mounted.el, 'Views').click()
    await settle()
    assert.deepEqual(bodyRows(mounted.el).map(r => r.code), ['EP0002', 'EP0001', 'EP0010', 'EP0003'])
    const viewsHeader = headerButton(mounted.el, 'Views').closest('th')!
    assert.equal(viewsHeader.getAttribute('aria-sort'), 'descending')

    headerButton(mounted.el, 'Views').click()
    await settle()
    assert.deepEqual(bodyRows(mounted.el).map(r => r.code), ['EP0010', 'EP0001', 'EP0002', 'EP0003'])
    assert.equal(viewsHeader.getAttribute('aria-sort'), 'ascending')
    assert.equal(headerButton(mounted.el, 'Episode').closest('th')!.getAttribute('aria-sort'), 'none')
    mounted.destroy()
  })

  test('the search filters by code or title, and the totals follow it', async () => {
    const mounted = await mount(TABLE)
    const footer = () => [...mounted.el.querySelectorAll('tfoot th, tfoot td')].map(n => n.textContent!.trim())
    const headers = [...mounted.el.querySelectorAll('thead th')].map(n => n.textContent!.replace(/[▲▼]/g, '').trim())
    const totalOf = (label: string) => footer()[headers.indexOf(label)]

    // A non-zero sum over the measured rows only; the no-data row is counted
    // as shown but not as measured, and contributes nothing.
    assert.equal(footer()[0], 'Totals of 3 measured rows of 4 shown')
    assert.equal(totalOf('Views'), '450')
    assert.equal(totalOf('Likes'), '5')
    // Averages and rates are never added up, and the page says why.
    assert.equal(totalOf('Avg % viewed'), 'No total')
    assert.equal(totalOf('Click-through rate'), 'No total')
    assert.match(mounted.text(), /Averages, rates, dates and lengths have no total/)

    const search = mounted.el.querySelector('input[type="search"]') as HTMLInputElement
    search.value = 'ghost'
    search.dispatchEvent(new Event('input'))
    await settle()
    assert.deepEqual(bodyRows(mounted.el).map(r => r.code), ['EP0010'])
    assert.equal(footer()[0], 'Totals of 1 measured rows of 1 shown')
    assert.equal(totalOf('Views'), '50')

    search.value = 'ep0003'
    search.dispatchEvent(new Event('input'))
    await settle()
    // Nothing measured: "No figures", never a 0 standing in for none.
    assert.equal(totalOf('Views'), 'No figures')
    mounted.destroy()
  })

  test('each episode links to its Publish row, with its live title beside it', async () => {
    const mounted = await mount(TABLE)
    const first = mounted.el.querySelector('tbody tr th')!
    assert.equal(first.querySelector('a')!.getAttribute('href'), '/projects/demo-project/upload/publish?episode_id=EP0001')
    assert.match(first.textContent!, /The Lantern Keeper/)
    // Published and length are formatted for reading.
    const row = bodyRows(mounted.el)[0]!
    assert.equal(row.cells.Published, '2026-04-15')
    assert.equal(row.cells.Length, '1:02:03')
    mounted.destroy()
  })

  test('the CSV is exactly the rows shown, in order, with totals, words for gaps and no formulas', async () => {
    const mounted = await mount(TABLE)
    headerButton(mounted.el, 'Views').click()
    await settle()

    let blob: Blob | null = null
    let filename = ''
    const realCreate = URL.createObjectURL
    const realRevoke = URL.revokeObjectURL
    const realClick = HTMLAnchorElement.prototype.click
    URL.createObjectURL = ((b: Blob) => { blob = b; return 'blob:analytics' }) as typeof URL.createObjectURL
    URL.revokeObjectURL = () => {}
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { filename = this.download }
    try {
      button(mounted.el, 'Export CSV')!.click()
    } finally {
      URL.createObjectURL = realCreate
      URL.revokeObjectURL = realRevoke
      HTMLAnchorElement.prototype.click = realClick
    }
    assert.equal(filename, 'analytics-demo-project-2026-06-05-to-2026-09-03.csv')
    const lines = (await blob!.text()).split('\n')
    assert.equal(lines[0], 'Episode,Title,Video ID,Published,Length (seconds),Views,Watch time (minutes),Avg view duration (seconds),Avg % viewed,Impressions,Click-through rate (%),Likes,Comments,Shares,Subscribers gained')
    assert.deepEqual(lines.slice(1, 5).map(line => line.split(',')[0]), ['EP0002', 'EP0001', 'EP0010', 'EP0003'])
    // A title a spreadsheet would run as a formula is written as text.
    assert.match(lines[1]!, /^EP0002,"'=HYPERLINK\(""evil""\)",v2,2026-04-15,3723,300,/)
    // A gap is its word, never 0.
    assert.match(lines[4]!, /^EP0003,Quiet one,v3,2026-04-15,3723,No data yet,/)
    assert.match(lines[5]!, /^Totals of 3 measured rows of 4 shown,,,No total,No total,450,/)
    assert.equal(lines.length, 6)
    mounted.destroy()
  })

  test('the period is chosen on screen, sent with the fetch, and a mismatch is said out loud', async () => {
    const mounted = await mount(TABLE)
    // The saved window (2026-06-05 to 2026-09-03) is not the last 90 days any more.
    assert.match(mounted.text(), /The table still shows 2026-06-05 to 2026-09-03/)

    button(mounted.el, 'Fetch for this period')!.click()
    await settle()
    const today = new Date().toISOString().slice(0, 10)
    const first = mounted.calls.find(c => c.method === 'POST')!
    assert.equal(first.body.end_date, today)
    assert.match(first.body.start_date, /^\d{4}-\d{2}-\d{2}$/)

    const select = mounted.el.querySelector('select') as HTMLSelectElement
    select.value = 'custom'
    select.dispatchEvent(new Event('change'))
    await settle()
    const [from, to] = [...mounted.el.querySelectorAll('input[type="date"]')] as HTMLInputElement[]
    from!.value = '2026-03-02'
    from!.dispatchEvent(new Event('input'))
    to!.value = '2026-03-01'
    to!.dispatchEvent(new Event('input'))
    await settle()
    assert.equal(button(mounted.el, 'Fetch for this period')!.disabled, true)
    assert.match(mounted.text(), /start date must be on or before the end date/)

    from!.value = '2026-02-01'
    from!.dispatchEvent(new Event('input'))
    await settle()
    button(mounted.el, 'Fetch for this period')!.click()
    await settle()
    const custom = mounted.calls.filter(c => c.method === 'POST').at(-1)!
    assert.deepEqual(custom.body, { start_date: '2026-02-01', end_date: '2026-03-01' })
    mounted.destroy()
  })
})
