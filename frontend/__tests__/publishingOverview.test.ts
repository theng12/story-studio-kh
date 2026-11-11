/**
 * The Publishing Overview page's honesty and behaviour on screen.
 *
 * The page must never render an unknown as a zero, must say "Publishing plan
 * not set" when there is no cadence, and must keep confirmed and planned
 * visually and structurally distinct (legend + per-event kind). The error,
 * empty, refresh, multi-channel and day-grouping states are mounted too.
 *
 * The responsive-controls pass adds mounted checks for: full-width layout with
 * contained tables, Coverage/Calendar keyboard tabs (the Content Store's
 * roving-tabindex pattern), one channel search across BOTH tabs (name, slug and
 * connected YouTube title), sortable coverage columns (asc/desc, unknown last,
 * stable ties, API priority default), filter/sort BEFORE the 25-channel page
 * slice, local-date Week/Month/Year calendar ranges with Previous/Next/Today,
 * bounded 25-EVENT pagination (65 entries on one day), the next-12 expected-slot
 * marker horizon, and preserved recommendation reasons/actions.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

let mountSequence = 0

async function component() {
  const filename = fileURLToPath(new URL('../pages/publishing.vue', import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'publishing' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'publishing',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  // `@shared/*` has no import map inside a data: module — point the page's
  // status vocabulary (the same module the server validates against) at the
  // real file, so these tests read the shipping constants rather than a copy.
  const shared = (name: string) => JSON.stringify(new URL(`../../electron/server/contracts/${name}.ts`, import.meta.url).href)
  const code = script.content
    .replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '')
    .replaceAll("'@shared/publishing-overview'", shared('publishing-overview'))
    .replace('export default', 'const __sfc__ =')
  // A fresh module per mount, so page state that is deliberately remembered
  // (the status filter) is re-read from localStorage exactly as a real page
  // load would be, instead of a shared data: URL handing back last time's ref.
  mountSequence += 1
  const support = `
    const usePublishingOverview = () => globalThis.__po;
    const useApi = () => globalThis.__poApi;
    // mount ${mountSequence}
  `
  const transformed = await transform(
    `${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`,
    { loader: 'ts', format: 'esm' },
  )
  const resolved = transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))
  return (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).default
}

async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }

interface MountOptions { error?: string | null; overview?: any }

/** Every PUT the page makes, so a test can prove it called nothing else. */
const puts: Array<{ path: string; body: any }> = []
let putError: { message: string; data?: any } | null = null

// The status filter is remembered in localStorage on purpose; a test that
// leaves one set must not decide the next test's starting chip.
beforeEach(() => {
  localStorage.clear()
  puts.length = 0
  putError = null
})

async function mount(options: MountOptions = {}) {
  const refreshCalls = { count: 0 }
  ;(globalThis as any).__po = {
    overview: ref(options.overview ?? null),
    loading: ref(false),
    error: ref(options.error ?? null),
    refreshing: ref(false),
    load: () => {},
    loadTimelineStages: async () => {},
    refresh: () => { refreshCalls.count++; return Promise.resolve(null) },
  }
  // The label editor's one write path. Tests never touch a real route.
  puts.length = 0
  putError = null
  ;(globalThis as any).__poApi = {
    put: async (path: string, body: any) => {
      if (putError) { const failure = putError; putError = null; throw failure }
      puts.push({ path, body })
      return { ok: true }
    },
  }
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp) }))
  // Proper stubs for the auto-imported components so the template resolves them
  // (and the notice's default slot actually renders).
  app.component('PlainBackLink', { render: () => null })
  app.component('PublishingTimeline', defineComponent({
    props: ['channels'],
    setup: (p: any) => () => h('section', { 'data-testid': 'timeline-channels' }, p.channels.map((c: any) => h('span', c.name))),
  }))
  app.component('WorkspaceNotice', { render(this: any) { return this.$slots.default ? this.$slots.default() : null } })
  // The page links rows with <NuxtLink class="plan-link">; without Nuxt's runtime the
  // tag resolves to nothing, so stub it as a real anchor (class falls through) the
  // same way the sibling suites do — otherwise a.plan-link is always absent.
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  // The page's heading now comes from the shared <PageTitle> (v1.4.371); the real
  // component is auto-imported under Nuxt, so the test provides the same slots.
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
  return { host, refreshCalls, close: () => { app.unmount(); host.remove() } }
}

function channel(overrides: any = {}) {
  return {
    slug: 'alpha', name: 'Alpha Channel',
    channel: null,
    // Absent = Unclassified. Never inferred from anything below.
    channel_status: null,
    plan_set: false, plan_name: null, timezone: null,
    confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', error: 'no_channel_assigned', schedules: [] },
    planned: { next_slot_at: null, next_uncovered_slot_at: null, next_unplanned_slot_at: null, last_slot_at: null, slots: [], assignments: [] },
    coverage: { last_confirmed_date: null, last_planned_date: null, next_uncovered_slot: null, scheduled_video_count: 0, planned_date_count: 0, ready_video_count: null, missing_slots_4w: null, oldest_checked_at: null, oldest_checked_stale: false, at_risk: false },
    readiness: { episodes: 3, episodes_with_code: 3, ready_to_publish: null, ready_unknown: 0, on_youtube: null, in_progress: 0, needs_attention: 0 },
    priority: { reason: 'none', at: null },
    recommendations: [],
    next_action: { kind: 'none', episode_code: null, label: 'Open the Production Board', url: '/projects/alpha/board' },
    ...overrides,
  }
}

// ---- Calendar fixtures are LOCAL dates in the CURRENT month ------------------
// The default Month view is anchored on today, so fixed October-2026 strings
// would silently fall out of range whenever the suite runs later.
const NOW = new Date()

function monthDay(day: number, hour = 18, minute = 0): string {
  return new Date(NOW.getFullYear(), NOW.getMonth(), day, hour, minute, 0, 0).toISOString()
}

const BETA = channel({
  slug: 'beta', name: 'Beta Channel',
  channel: { channel_id: 'UC2', title: 'Beta on YouTube' },
  plan_set: true, plan_name: 'Beta schedule', timezone: 'UTC',
  confirmed: {
    next_at: '2026-10-20T18:00:00.000Z', count: 1, last_checked_at: '2026-10-17T09:00:00.000Z', freshness: 'fresh',
    schedules: [{ video_id: 'vid1', episode_code: 'EP0001', title: 'First', scheduled_for: '2026-10-20T18:00:00.000Z', checked_at: '2026-10-17T09:00:00.000Z', stale: false }],
  },
  planned: {
    next_slot_at: '2026-10-22T18:00:00.000Z', next_uncovered_slot_at: '2026-10-22T18:00:00.000Z', next_unplanned_slot_at: '2026-10-22T18:00:00.000Z', last_slot_at: '2026-10-29T18:00:00.000Z',
    slots: [{ at: '2026-10-22T18:00:00.000Z', confirmed: false, planned: false }], assignments: [],
  },
  coverage: { last_confirmed_date: '2026-10-20', last_planned_date: null, next_uncovered_slot: '2026-10-22T18:00:00.000Z', scheduled_video_count: 1, planned_date_count: 0, ready_video_count: 2, at_risk: true },
  readiness: { episodes: 5, episodes_with_code: 5, ready_to_publish: 2, ready_unknown: 0, on_youtube: 1, in_progress: 0, needs_attention: 0 },
  priority: { reason: 'earliest_uncovered_slot', at: '2026-10-22T18:00:00.000Z' },
  recommendations: [
    { episode_code: 'EP0002', kind: 'ready_to_publish', label: 'Publish EP0002', url: '/projects/beta/upload/publish?episode_id=EP0002', reason: 'Finished video, not on YouTube yet.' },
    { episode_code: 'EP0003', kind: 'ready_to_publish', label: 'Publish EP0003', url: '/projects/beta/upload/publish?episode_id=EP0003', reason: 'Finished video, not on YouTube yet.' },
  ],
  next_action: { kind: 'ready_to_publish', episode_code: 'EP0002', label: 'Publish EP0002', url: '/projects/beta/upload/publish?episode_id=EP0002' },
})

// A connected channel YouTube has never been asked about: "never checked" is a
// different state from "no channel assigned", and from a stale answer.
const NEVER_CHECKED = channel({
  slug: 'gamma', name: 'Gamma Channel',
  channel: { channel_id: 'UC3', title: 'Gamma on YouTube' },
  confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', schedules: [] },
})

// A connected channel whose YouTube LINK read failed. Its finished episodes
// cannot be told apart from the ones already published, so nothing may be
// suggested for publishing — only the local missing-video fact still stands.
const NO_LINKS_REASON = "Story Studio could not read which episodes are already on YouTube."

const NO_LINKS = channel({
  slug: 'nolinks', name: 'No Links Channel',
  channel: { channel_id: 'UC9', title: 'No Links on YouTube' },
  plan_set: true, plan_name: 'No Links schedule', timezone: 'UTC',
  coverage: { last_confirmed_date: null, last_planned_date: null, next_uncovered_slot: '2026-10-22T18:00:00.000Z', scheduled_video_count: 0, planned_date_count: 0, ready_video_count: null, at_risk: true },
  readiness: { episodes: 3, episodes_with_code: 3, ready_to_publish: null, ready_unknown: 0, on_youtube: null, in_progress: 0, needs_attention: 0, error: NO_LINKS_REASON },
  priority: { reason: 'earliest_uncovered_slot', at: '2026-10-22T18:00:00.000Z' },
  recommendations: [],
  next_action: { kind: 'none', episode_code: null, label: 'Open the Production Board', url: '/projects/nolinks/board' },
})

const OVERVIEW = {
  generated_at: '2026-10-17T00:00:00.000Z',
  cache_ttl_ms: 86400000,
  channels: [channel(), NEVER_CHECKED, BETA],
  calendar: [
    { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: monthDay(20), episode_code: 'EP0001', video_id: 'vid1', title: 'First' },
    { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'planned', at: monthDay(22), empty: true },
  ],
}

// ---- Small mount helpers -----------------------------------------------------
function overviewWith(channels: any[], calendar: any[] = []) {
  return { generated_at: '2026-10-17T00:00:00.000Z', cache_ttl_ms: 1, channels, calendar }
}

function coverage(overrides: any = {}) {
  return {
    last_confirmed_date: null, last_planned_date: null, next_uncovered_slot: null,
    scheduled_video_count: 0, planned_date_count: 0, ready_video_count: null,
    missing_slots_4w: null, oldest_checked_at: null, oldest_checked_stale: false,
    at_risk: false,
    ...overrides,
  }
}

function makeChannel(name: string, coverageOverrides: any = {}, extra: any = {}) {
  return channel({
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    name,
    coverage: coverage(coverageOverrides),
    ...extra,
  })
}

function rowNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll('table.coverage-table tbody tr')]
    .map(row => (row.querySelector('.channel-link')?.textContent || '').trim())
}

function headerButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('table.coverage-table th button')]
    .find(candidate => (candidate.textContent || '').trim().startsWith(label))
  assert.ok(button, `sortable header "${label}" exists`)
  return button as HTMLButtonElement
}

function tabButton(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('[role="tab"]')]
    .find(candidate => (candidate.textContent || '').trim().startsWith(label))
  assert.ok(button, `tab "${label}" exists`)
  return button as HTMLButtonElement
}

function buttonByText(host: HTMLElement, selector: string, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll(selector)]
    .find(candidate => (candidate.textContent || '').trim() === text)
  assert.ok(button, `button "${text}" exists`)
  return button as HTMLButtonElement
}

function calendarViewButton(host: HTMLElement, label: string): HTMLButtonElement {
  return buttonByText(host, '.calendar-view-button', label)
}

async function search(host: HTMLElement, value: string) {
  const input = host.querySelector('input.channel-search') as HTMLInputElement
  assert.ok(input, 'channel search input renders')
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await flush()
}

test('Calendar opens the all-channel timeline, shares search, and retains the calendar list', async () => {
  const channels = Array.from({ length: 31 }, (_, i) => channel({ slug: `c${i}`, name: `Channel ${i}` }))
  const ui = await mount({ overview: overviewWith(channels) })
  try {
    tabButton(ui.host, 'Calendar').click(); await flush()
    assert.equal(ui.host.querySelector('[data-testid="timeline-channels"]')?.querySelectorAll('span').length, 31)
    await search(ui.host, 'Channel 30')
    assert.equal(ui.host.querySelector('[data-testid="timeline-channels"]')?.textContent, 'Channel 30')
    buttonByText(ui.host, '.calendar-view-button', 'Calendar list').click(); await flush()
    assert.equal(ui.host.querySelector('[data-testid="timeline-channels"]'), null)
    assert.equal((ui.host.querySelector('.calendar-controls')?.parentElement as HTMLElement).style.display, '')
    assert.equal(ui.refreshCalls.count, 0)
    assert.equal(puts.length, 0)
  } finally { ui.close() }
})

// ---- Existing honesty checks -------------------------------------------------
test('a plan-less channel says "Publishing plan not set"; an unchecked channel says never checked, not zero', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    const text = ui.host.textContent || ''
    assert.match(text, /Publishing plan not set/)
    assert.match(text, /Never checked/)
    assert.match(text, /Publishing Overview/)
    // The header timestamp is the overview read time, not a YouTube check time.
    assert.match(text, /Overview updated/)
    assert.doesNotMatch(text, /Last checked/)
  } finally { ui.close() }
})

test('confirmed and planned are distinct: legend present, each event carries its kind, at-risk is flagged', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    const text = ui.host.textContent || ''
    assert.match(text, /Confirmed by YouTube/)
    assert.match(text, /Planned \(target\)/)
    assert.match(text, /Expected slot, nothing placed/)

    assert.equal(ui.host.querySelectorAll('.calendar-event.event-confirmed').length, 1)
    assert.equal(ui.host.querySelectorAll('.calendar-event.event-planned').length, 1)
    // The empty cadence slot is an EXPECTED marker, not a local plan.
    assert.equal(ui.host.querySelectorAll('.calendar-event.event-planned.event-empty').length, 1)
    assert.match(text, /Expected slot — nothing placed yet/)
    // The at-risk channel is visibly flagged.
    assert.match(text, /At risk/)
    // The exact-episode next step is offered, not only a generic board link.
    assert.match(text, /Publish EP0002/)
  } finally { ui.close() }
})

test('the coverage table is the accessible list fallback and shows unknown, never 0', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    const table = ui.host.querySelector('table.coverage-table')
    assert.ok(table, 'coverage table renders')
    const headers = [...ui.host.querySelectorAll('table.coverage-table th')].map(th => th.textContent?.trim())
    assert.ok(headers.includes('Next uncovered slot'))
    assert.ok(headers.includes('Ready'))
    // The column counts locally chosen DATES (import keys included), so it is
    // named for what it counts rather than claiming to be episodes.
    assert.ok(headers.includes('Planned dates'))
    assert.match(ui.host.textContent || '', /unknown/)
  } finally { ui.close() }
})

test('an UNREADABLE plan is not reported as "not set", and an unreadable sweep is not a low number', async () => {
  const ui = await mount({
    overview: {
      generated_at: '2026-10-17T00:00:00.000Z',
      cache_ttl_ms: 1,
      channels: [
        channel({
          slug: 'broken', name: 'Broken Plan Channel',
          plan_set: null, plan_error: 'config.json is corrupted and cannot be parsed.',
          confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', error: 'channel_not_connected', schedules: [] },
          readiness: { episodes: 4, episodes_with_code: 4, ready_to_publish: null, ready_unknown: 2, on_youtube: null, in_progress: 0, needs_attention: 0 },
        }),
      ],
      calendar: [],
    },
  })
  try {
    const text = ui.host.textContent || ''
    // A read failure must not masquerade as an absent plan.
    assert.match(text, /Couldn't read publishing plan/)
    assert.doesNotMatch(text, /Publishing plan not set/)
    // …and the row still offers a real way out.
    assert.equal(ui.host.querySelectorAll('a.plan-link').length, 1)
    // The readiness figure says unknown, and says how much of it was unreadable.
    assert.match(text, /unknown/)
    assert.match(text, /2 unreadable/)
    // "assigned but not connected" is not "no channel assigned".
    assert.match(text, /YouTube channel assigned, not connected/)
    assert.match(text, /Not connected/)
  } finally { ui.close() }
})

test('a failed link read is unknown on screen: the backend reason, and no publish suggestion', async () => {
  const ui = await mount({
    overview: { generated_at: '2026-10-17T00:00:00.000Z', cache_ttl_ms: 1, channels: [BETA, NO_LINKS], calendar: [] },
  })
  try {
    const rows = [...ui.host.querySelectorAll('table.coverage-table tbody tr')]
    const rowFor = (name: string) => rows.find(row => (row.textContent || '').includes(name))!
    // The page CAN offer a publish suggestion — Beta's row proves the negative
    // assertion below is not vacuous.
    assert.match(rowFor('Beta Channel').textContent || '', /Publish EP0002/)

    const unknownRow = rowFor('No Links Channel')
    assert.doesNotMatch(unknownRow.textContent || '', /Publish/)
    // The Ready cell says unknown and carries the reason the BACKEND gave —
    // not a number, and not a message the page invented.
    const cell = [...unknownRow.querySelectorAll('td span.ready-unknown')]
      .find(span => (span.textContent || '').startsWith('unknown'))
    assert.ok(cell, 'the Ready cell renders unknown')
    assert.equal(cell!.getAttribute('title'), NO_LINKS_REASON)
  } finally { ui.close() }
})

test('an unresolved planned identity is spelled differently from a key that names no episode', async () => {
  const ui = await mount({
    overview: {
      generated_at: '2026-10-17T00:00:00.000Z',
      cache_ttl_ms: 1,
      channels: [
        channel({
          slug: 'noread', name: 'No Read Channel',
          plan_set: true, plan_name: 'No Read schedule', timezone: 'UTC',
          planned: {
            next_slot_at: '2026-10-22T18:00:00.000Z', next_uncovered_slot_at: '2026-10-22T18:00:00.000Z', next_unplanned_slot_at: null, last_slot_at: '2026-10-22T18:00:00.000Z',
            slots: [{ at: '2026-10-22T18:00:00.000Z', confirmed: false, planned: true }],
            assignments: [{ at: '2026-10-22T18:00:00.000Z', confirmed: false, identity_unknown: true }],
          },
          coverage: { last_confirmed_date: null, last_planned_date: '2026-10-22', next_uncovered_slot: '2026-10-22T18:00:00.000Z', scheduled_video_count: 0, planned_date_count: 1, ready_video_count: null, at_risk: true },
          readiness: { episodes: null, episodes_with_code: null, ready_to_publish: null, ready_unknown: 0, on_youtube: null, in_progress: null, needs_attention: null, error: "Story Studio could not read this channel's ideas, so it cannot say how many episodes it has." },
          priority: { reason: 'earliest_uncovered_slot', at: '2026-10-22T18:00:00.000Z' },
        }),
      ],
      calendar: [
        // A planned date whose episode identity could not be resolved…
        { channel_slug: 'noread', channel_name: 'No Read Channel', kind: 'planned', at: monthDay(22), identity_unknown: true },
        // …beside one that genuinely carries an identity, so the list is proven
        // to render identities at all.
        { channel_slug: 'noread', channel_name: 'No Read Channel', kind: 'planned', at: monthDay(23), episode_code: 'NR0001' },
      ],
    },
  })
  try {
    const titles = [...ui.host.querySelectorAll('.event-title')].map(el => (el.textContent || '').trim()).sort()
    assert.deepEqual(titles, ['Locally planned date — episode unknown', 'NR0001'].sort())
    // And the channel's readiness cell says unknown, not a count.
    const cell = [...ui.host.querySelectorAll('td span.ready-unknown')]
      .find(span => (span.textContent || '').startsWith('unknown'))
    assert.ok(cell, 'the Ready cell renders unknown')
  } finally { ui.close() }
})

test('a plan-less channel and an unassigned one are labelled distinctly', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    const text = ui.host.textContent || ''
    assert.match(text, /No YouTube channel assigned/)
    assert.match(text, /No channel assigned/)
    assert.doesNotMatch(text, /YouTube channel assigned, not connected/)
  } finally { ui.close() }
})

test('an error shows the notice and no channel rows', async () => {
  const ui = await mount({ overview: null, error: 'Story Studio could not read the Library.' })
  try {
    assert.match(ui.host.textContent || '', /Story Studio could not read the Library\./)
    assert.equal(ui.host.querySelectorAll('table.coverage-table').length, 0)
  } finally { ui.close() }
})

test('zero channels shows the empty state, not an empty table', async () => {
  const ui = await mount({ overview: { generated_at: '2026-10-17T00:00:00.000Z', cache_ttl_ms: 1, channels: [], calendar: [] } })
  try {
    assert.match(ui.host.textContent || '', /No channels yet/)
    assert.equal(ui.host.querySelectorAll('table.coverage-table').length, 0)
  } finally { ui.close() }
})

test('the refresh button calls the composable refresh, and nothing fetches on mount', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    assert.equal(ui.refreshCalls.count, 0, 'no provider refresh on render')
    const button = [...ui.host.querySelectorAll('button')].find(b => /Check YouTube Now/.test(b.textContent || ''))
    assert.ok(button, 'refresh button exists')
    ;(button as HTMLButtonElement).click()
    await flush()
    assert.equal(ui.refreshCalls.count, 1)
  } finally { ui.close() }
})

test('multiple channels render one row each and events group into local days', async () => {
  const ui = await mount({
    overview: {
      generated_at: '2026-10-17T00:00:00.000Z',
      cache_ttl_ms: 1,
      channels: [channel(), channel({ slug: 'gamma', name: 'Gamma Channel', next_action: { kind: 'none', episode_code: null, label: 'Open the Production Board', url: '/projects/gamma/board' } })],
      calendar: [
        { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: monthDay(20), video_id: 'v1' },
        { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'planned', at: monthDay(22), empty: true },
      ],
    },
  })
  try {
    assert.equal(ui.host.querySelectorAll('table.coverage-table tbody tr').length, 2)
    // Two different days → two day groups.
    assert.equal(ui.host.querySelectorAll('.calendar-day').length, 2)
  } finally { ui.close() }
})

// ---- Responsive controls -----------------------------------------------------
test('the page fills the window, contains wide tables, and compacts without dropping recommendations', async () => {
  const source = readFileSync(new URL('../pages/publishing.vue', import.meta.url), 'utf8')
  const mainCss = readFileSync(new URL('../assets/css/main.css', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /max-width:\s*1180px/, 'the old 1180px cap is gone')
  // The frame is shared: this page composes .page-frame and declares no width,
  // max-width, margin or padding of its own (owner, 2026-11-01: the pages were
  // "different width… no consistency"). Anything here would fight the frame.
  assert.match(source, /class="publishing-page page-frame"/, 'the page composes the shared frame')
  assert.doesNotMatch(
    source,
    /\.publishing-page\s*\{[^}]*(?:max-width|width|margin|padding)\s*:/,
    'the page declares no frame geometry of its own',
  )
  assert.match(mainCss, /\*\s*\{[^}]*box-sizing:\s*border-box/, 'border-box is global, so the frame width includes its padding')
  assert.match(source, /\.coverage-scroll\s*\{[^}]*overflow-x:\s*auto/, 'wide tables scroll inside their container')
  // Three columns were added to the Coverage table (Status, Missing (4 weeks),
  // Oldest checked), so the table scrolls at a wider floor than it used to.
  assert.match(source, /\.coverage-table\s*\{[^}]*min-width:\s*1180px/)
  assert.match(source, /@media \(max-width: 420px\)/, '375px gets its own layout')

  const ui = await mount({ overview: OVERVIEW })
  try {
    // Compact layout still renders the recommendation reasons and actions.
    const recLinks = [...ui.host.querySelectorAll('.rec-list .rec-link')]
    assert.equal(recLinks.length, 1)
    assert.match(recLinks[0].textContent || '', /Publish EP0003/)
    assert.equal(recLinks[0].getAttribute('title'), 'Finished video, not on YouTube yet.')
    assert.match(ui.host.textContent || '', /Publish EP0002/)
  } finally { ui.close() }
})

test('Coverage and Calendar are keyboard tabs using the Content Store roving-tabindex pattern', async () => {
  const ui = await mount({ overview: OVERVIEW })
  try {
    const tablist = ui.host.querySelector('[role="tablist"]') as HTMLElement
    assert.ok(tablist, 'tablist exists')
    const coverageTab = tabButton(ui.host, 'Coverage')
    const calendarTab = tabButton(ui.host, 'Calendar')

    assert.equal(coverageTab.getAttribute('aria-selected'), 'true')
    assert.equal(coverageTab.tabIndex, 0)
    assert.equal(calendarTab.getAttribute('aria-selected'), 'false')
    assert.equal(calendarTab.tabIndex, -1)
    assert.equal(coverageTab.getAttribute('aria-controls'), 'publishing-panel-coverage')
    assert.equal(calendarTab.getAttribute('aria-controls'), 'publishing-panel-calendar')

    const coveragePanel = ui.host.querySelector('#publishing-panel-coverage') as HTMLElement
    const calendarPanel = ui.host.querySelector('#publishing-panel-calendar') as HTMLElement
    assert.equal(coveragePanel.getAttribute('role'), 'tabpanel')
    assert.equal(coveragePanel.getAttribute('aria-labelledby'), 'publishing-tab-coverage')
    assert.equal(calendarPanel.getAttribute('role'), 'tabpanel')
    assert.equal(calendarPanel.getAttribute('aria-labelledby'), 'publishing-tab-calendar')
    assert.equal(coveragePanel.hidden, false)
    assert.equal(calendarPanel.hidden, true)

    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await flush()
    assert.equal(calendarTab.getAttribute('aria-selected'), 'true')
    assert.equal(calendarTab.tabIndex, 0)
    assert.equal(document.activeElement, calendarTab, 'focus follows the arrow key')
    assert.equal(calendarPanel.hidden, false)
    assert.equal(coveragePanel.hidden, true)

    // Home/End jump to the ends of the tablist like the Content Store tabs.
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    await flush()
    assert.equal(coverageTab.getAttribute('aria-selected'), 'true')
    tablist.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    await flush()
    assert.equal(calendarTab.getAttribute('aria-selected'), 'true')
  } finally { ui.close() }
})

test('one channel search matches name, slug and connected YouTube title on BOTH tabs', async () => {
  const quiet = makeChannel('Quiet Channel', {}, {
    slug: 'quiet-slug',
    channel: { channel_id: 'UCQ', title: 'Moonrise Studio' },
    confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', schedules: [] },
  })
  const other = makeChannel('Other Channel', {}, {
    slug: 'other',
    channel: { channel_id: 'UCO', title: 'Other Studio' },
    confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', schedules: [] },
  })
  const at = monthDay(12)
  const ui = await mount({
    overview: overviewWith([quiet, other], [
      { channel_slug: 'quiet-slug', channel_name: 'Quiet Channel', kind: 'confirmed', at, video_id: 'q1' },
      { channel_slug: 'other', channel_name: 'Other Channel', kind: 'confirmed', at, video_id: 'o1' },
    ]),
  })
  try {
    await search(ui.host, 'quiet') // name
    assert.deepEqual(rowNames(ui.host), ['Quiet Channel'])
    await search(ui.host, 'quiet-slug') // slug
    assert.deepEqual(rowNames(ui.host), ['Quiet Channel'])
    await search(ui.host, 'moonrise') // connected YouTube title
    assert.deepEqual(rowNames(ui.host), ['Quiet Channel'])

    // The same filter applies to the Calendar tab.
    tabButton(ui.host, 'Calendar').click()
    await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 1)
    assert.match(ui.host.querySelector('.calendar-event')!.textContent || '', /Quiet Channel/)

    await search(ui.host, 'other')
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 1)
    assert.match(ui.host.querySelector('.calendar-event')!.textContent || '', /Other Channel/)
  } finally { ui.close() }
})

test('coverage columns sort asc/desc, unknown last, stable ties, and API priority by default', async () => {
  const sortable = [
    makeChannel('Zulu', { planned_date_count: 1 }),
    makeChannel('Alpha', { planned_date_count: 3 }),
    makeChannel('Mike', { planned_date_count: 3 }),
  ]
  const ui = await mount({ overview: overviewWith(sortable) })
  try {
    // Default is the API's own priority order, not alphabetical.
    assert.deepEqual(rowNames(ui.host), ['Zulu', 'Alpha', 'Mike'])

    const nameHeader = headerButton(ui.host, 'Channel')
    nameHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Alpha', 'Mike', 'Zulu'])
    assert.equal(nameHeader.closest('th')!.getAttribute('aria-sort'), 'ascending')
    nameHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Zulu', 'Mike', 'Alpha'])
    assert.equal(nameHeader.closest('th')!.getAttribute('aria-sort'), 'descending')
    nameHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Zulu', 'Alpha', 'Mike'])
    assert.equal(nameHeader.closest('th')!.getAttribute('aria-sort'), 'none')

    // Equal values keep the API's order in both directions (stable ties).
    const plannedHeader = headerButton(ui.host, 'Planned dates')
    plannedHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Zulu', 'Alpha', 'Mike'])
    plannedHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Alpha', 'Mike', 'Zulu'])
  } finally { ui.close() }
})

test('unknown coverage values sort last in BOTH directions', async () => {
  const ready = [
    makeChannel('Ready One', { ready_video_count: 1 }),
    makeChannel('Ready Unknown', { ready_video_count: null }),
    makeChannel('Ready Zero', { ready_video_count: 0 }),
  ]
  const ui = await mount({ overview: overviewWith(ready) })
  try {
    const readyHeader = headerButton(ui.host, 'Ready')
    readyHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Ready Zero', 'Ready One', 'Ready Unknown'])
    readyHeader.click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Ready One', 'Ready Zero', 'Ready Unknown'])
  } finally { ui.close() }
})

test('filter and sort run BEFORE the 25-channel page slice; a filter change resets the page', async () => {
  const many = Array.from({ length: 60 }, (_, index) =>
    makeChannel(`Channel ${String(index).padStart(2, '0')}`, { planned_date_count: index }))
  const ui = await mount({ overview: overviewWith(many) })
  try {
    assert.equal(ui.host.querySelectorAll('table.coverage-table tbody tr').length, 25)
    assert.match(ui.host.querySelector('nav[aria-label="Coverage pages"]')!.textContent || '', /Page 1 of 3/)
    assert.match(ui.host.textContent || '', /1–25 of 60 channels/)

    const next = buttonByText(ui.host, 'nav[aria-label="Coverage pages"] button', 'Next')
    next.click(); await flush()
    assert.equal(ui.host.querySelectorAll('table.coverage-table tbody tr').length, 25)
    assert.deepEqual(rowNames(ui.host)[0], 'Channel 25')
    assert.match(ui.host.querySelector('nav[aria-label="Coverage pages"]')!.textContent || '', /Page 2 of 3/)

    next.click(); await flush()
    assert.equal(ui.host.querySelectorAll('table.coverage-table tbody tr').length, 10)
    assert.deepEqual(rowNames(ui.host)[0], 'Channel 50')
    assert.match(ui.host.querySelector('nav[aria-label="Coverage pages"]')!.textContent || '', /Page 3 of 3/)

    // Searching while on page 3 resets to page 1 and filters before slicing.
    await search(ui.host, 'Channel 59')
    assert.deepEqual(rowNames(ui.host), ['Channel 59'])
    assert.equal(ui.host.querySelector('nav[aria-label="Coverage pages"]'), null)
  } finally { ui.close() }
})

test('calendar Week/Month/Year uses local dates with Previous/Next/Today and a range label', async () => {
  const today = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 9, 0, 0, 0)
  const ui = await mount({
    overview: overviewWith([BETA], [
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: today.toISOString(), video_id: 'today' },
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'planned', at: monthDay(10), episode_code: 'EP0010' },
    ]),
  })
  try {
    tabButton(ui.host, 'Calendar').click(); await flush()
    const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(today)
    const range = () => (ui.host.querySelector('.calendar-range')?.textContent || '').trim()

    // Default view is Month, anchored on the local today.
    assert.equal(range(), monthLabel)
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 2)

    buttonByText(ui.host, '.calendar-nav button', 'Previous').click(); await flush()
    const previousMonth = range()
    assert.notEqual(previousMonth, monthLabel)
    buttonByText(ui.host, '.calendar-nav button', 'Next').click(); await flush()
    assert.equal(range(), monthLabel)
    buttonByText(ui.host, '.calendar-nav button', 'Next').click(); await flush()
    assert.notEqual(range(), monthLabel)
    buttonByText(ui.host, '.calendar-nav button', 'Today').click(); await flush()
    assert.equal(range(), monthLabel)

    // Year covers the whole local year and keeps the entries.
    calendarViewButton(ui.host, 'Year').click(); await flush()
    assert.equal(range(), String(today.getFullYear()))
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 2)

    // Week is a local Monday–Sunday window and always includes today.
    calendarViewButton(ui.host, 'Week').click(); await flush()
    assert.match(range(), /–/)
    const weekLabel = range()
    assert.ok(ui.host.querySelectorAll('.calendar-event').length >= 1)
    buttonByText(ui.host, '.calendar-nav button', 'Previous').click(); await flush()
    assert.notEqual(range(), weekLabel)
    buttonByText(ui.host, '.calendar-nav button', 'Next').click(); await flush()
    assert.equal(range(), weekLabel)
  } finally { ui.close() }
})

test('month and year ranges include their local boundary days', async () => {
  const firstDay = new Date(NOW.getFullYear(), NOW.getMonth(), 1, 0, 5).toISOString()
  const lastDay = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 0, 23, 55).toISOString()
  const yearFirst = new Date(NOW.getFullYear(), 0, 1, 0, 5).toISOString()
  const yearLast = new Date(NOW.getFullYear(), 11, 31, 23, 55).toISOString()
  const ui = await mount({
    overview: overviewWith([BETA], [
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: firstDay, video_id: 'first', title: 'First day' },
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: lastDay, video_id: 'last', title: 'Last day' },
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: yearFirst, video_id: 'yfirst', title: 'Year first' },
      { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: yearLast, video_id: 'ylast', title: 'Year last' },
    ]),
  })
  try {
    tabButton(ui.host, 'Calendar').click(); await flush()
    const text = ui.host.textContent || ''
    assert.match(text, /First day/)
    assert.match(text, /Last day/)

    calendarViewButton(ui.host, 'Year').click(); await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 4)
  } finally { ui.close() }
})

test('calendar paginates EVENTS in bounded batches of 25, even 65 entries on one day', async () => {
  const calendar = Array.from({ length: 65 }, (_, index) => ({
    channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed',
    at: monthDay(15, 10, index), video_id: `video-${index}`, title: `Video ${index}`,
  }))
  const ui = await mount({ overview: overviewWith([BETA], calendar) })
  try {
    tabButton(ui.host, 'Calendar').click(); await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 25)
    assert.equal(ui.host.querySelectorAll('.calendar-day').length, 1, 'all 65 are one local day')
    const nav = () => ui.host.querySelector('nav[aria-label="Calendar event pages"]')!
    assert.match(nav().textContent || '', /Events 1–25 of 65/)

    buttonByText(ui.host, 'nav[aria-label="Calendar event pages"] button', 'Next').click(); await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 25)
    assert.equal(ui.host.querySelectorAll('.calendar-day').length, 1)
    assert.match(nav().textContent || '', /Events 26–50 of 65/)

    buttonByText(ui.host, 'nav[aria-label="Calendar event pages"] button', 'Next').click(); await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event').length, 15)
    assert.match(nav().textContent || '', /Events 51–65 of 65/)
  } finally { ui.close() }
})

test('expected-slot markers explain the plan’s next-12 horizon; every returned entry is preserved', async () => {
  // The API bounds markers to PLANNED_SLOT_HORIZON (12) per channel. The page
  // must EXPLAIN that horizon rather than claim a complete year — and it must
  // never drop markers or actual entries the API returned for the range.
  const markers = Array.from({ length: 20 }, (_, index) => ({
    channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'planned', at: monthDay(index + 1), empty: true,
  }))
  const actual = [
    { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'confirmed', at: monthDay(21), video_id: 'a1', title: 'Real confirmed' },
    { channel_slug: 'beta', channel_name: 'Beta Channel', kind: 'planned', at: monthDay(22), episode_code: 'EP0009' },
  ]
  const ui = await mount({ overview: overviewWith([BETA], [...markers, ...actual]) })
  try {
    tabButton(ui.host, 'Calendar').click(); await flush()
    assert.equal(ui.host.querySelectorAll('.calendar-event.event-empty').length, 20)
    // Every actual confirmed/planned entry is still there.
    assert.equal(ui.host.querySelectorAll('.calendar-event.event-confirmed').length, 1)
    assert.equal(ui.host.querySelectorAll('.calendar-event.event-planned:not(.event-empty)').length, 1)
    assert.match(ui.host.textContent || '', /EP0009/)
    // The horizon is named as the plan's next 12 slots, not an annual promise.
    assert.match(ui.host.textContent || '', /next 12 slots/)
    assert.match(ui.host.textContent || '', /not a\s+complete\s+annual horizon/)
  } finally { ui.close() }
})


/** The freshness cell of one coverage row, by the channel name in that row. */
function freshnessText(host: HTMLElement, channelName: string): string {
  const row = [...host.querySelectorAll('table.coverage-table tbody tr')]
    .find(candidate => (candidate.querySelector('.channel-link')?.textContent || '').trim() === channelName)
  assert.ok(row, `a coverage row for ${channelName}`)
  return (row!.querySelector('.freshness')?.textContent || '').trim()
}

/**
 * One coverage cell of a row, resolved by its COLUMN HEADER rather than by
 * position — the table gained columns, and an index would silently start
 * reading the wrong one.
 */
function coverageText(host: HTMLElement, channelName: string, header = 'Next uncovered slot'): string {
  const row = [...host.querySelectorAll('table.coverage-table tbody tr')]
    .find(candidate => (candidate.querySelector('.channel-link')?.textContent || '').trim() === channelName)
  assert.ok(row, `a coverage row for ${channelName}`)
  const headers = [...host.querySelectorAll('table.coverage-table thead th')]
    .map(th => (th.textContent || '').replace(/[\u25b2\u25bc]\s*$/, '').trim())
  const index = headers.findIndex(text => text.startsWith(header))
  assert.ok(index >= 0, `the "${header}" column exists`)
  const cells = row!.querySelectorAll('td')
  return (cells[index]?.textContent || '').trim()
}

test('the freshness label names the artifact that is old, and the plan-versus-releases disagreement is stated', async () => {
  // The channel LISTING and the per-video checks have separate ages. A label
  // that hangs "stale" on the newest check blames the wrong one — so the page
  // says which artifact is old, with that artifact's own date.
  const instant = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso))
  const listingAt = '2025-10-19T07:05:52.000Z'
  const checkAt = '2026-10-21T07:05:52.000Z'
  const stale = channel({
    slug: 'stale', name: 'Stale Channel',
    channel: { channel_id: 'UC4', title: 'Stale on YouTube' },
    confirmed: {
      next_at: null, count: 0, last_checked_at: checkAt, freshness: 'stale',
      schedules: [], stale_videos: 2, unchecked_videos: 0,
      listing: {
        state: 'complete', complete_at: listingAt, partial_at: null, stale: true,
        last_attempt: { attempted_at: checkAt, outcome: 'complete' },
      },
    },
    // The plan expects Monday/Wednesday/Friday; these releases land on Tuesday.
    cadence: { off_cadence_count: 12, off_cadence_weekdays: [2] },
  })
  // A listing that could not be read, while the last successful one is still
  // fresh: "Fresh" would hide the failed refresh.
  const failed = channel({
    slug: 'failed', name: 'Failed Channel',
    channel: { channel_id: 'UC5', title: 'Failed on YouTube' },
    confirmed: {
      next_at: null, count: 0, last_checked_at: checkAt, freshness: 'fresh',
      schedules: [], stale_videos: 0, unchecked_videos: 0,
      listing: {
        state: 'complete', complete_at: checkAt, partial_at: null, stale: false,
        last_attempt: { attempted_at: checkAt, outcome: 'failed', error_code: 'provider_error' },
      },
    },
  })
  // A listing that stopped early: we have not seen the whole channel.
  const partial = channel({
    slug: 'partial', name: 'Partial Channel',
    channel: { channel_id: 'UC6', title: 'Partial on YouTube' },
    confirmed: {
      next_at: null, count: 0, last_checked_at: checkAt, freshness: 'stale',
      schedules: [], stale_videos: 0, unchecked_videos: 0,
      listing: {
        state: 'partial', complete_at: null, partial_at: listingAt, stale: true,
        last_attempt: { attempted_at: checkAt, outcome: 'partial' },
      },
    },
  })
  // A plan with no expected slot in the horizon: that is not "every expected
  // slot confirmed".
  const noSlots = channel({
    slug: 'noslots', name: 'No Slots Channel',
    channel: { channel_id: 'UC7', title: 'No Slots on YouTube' },
    plan_set: true, plan_name: 'Empty plan', timezone: 'UTC',
    planned: { next_slot_at: null, next_uncovered_slot_at: null, next_unplanned_slot_at: null, last_slot_at: null, slots: [], assignments: [] },
  })

  const ui = await mount({ overview: overviewWith([stale, failed, partial, noSlots]) })
  try {
    // The stale artifact is named with ITS date — not the newest check.
    const staleLabel = freshnessText(ui.host, 'Stale Channel')
    assert.match(staleLabel, /Stale listing/)
    assert.ok(staleLabel.includes(instant(listingAt)), `the listing's own date is shown: ${staleLabel}`)
    assert.equal(staleLabel.includes(instant(checkAt)), false, `not the newest check's date: ${staleLabel}`)
    assert.match(staleLabel, /2 stale checks/)

    // A failed listing attempt is said, even when the last success is fresh.
    const failedLabel = freshnessText(ui.host, 'Failed Channel')
    assert.match(failedLabel, /Listing failed/)
    assert.match(failedLabel, /provider_error/)
    assert.equal(failedLabel.includes('Fresh'), false)

    // A listing that stopped early is not a stale one.
    assert.match(freshnessText(ui.host, 'Partial Channel'), /Listing incomplete/)

    // No expected slot is not "all expected slots confirmed".
    assert.match(coverageText(ui.host, 'No Slots Channel'), /No expected slots in the horizon/)
    assert.equal(coverageText(ui.host, 'No Slots Channel').includes('All expected slots confirmed'), false)

    // The plan-versus-releases disagreement is stated, with its weekday.
    const text = ui.host.textContent || ''
    assert.match(text, /12 confirmed releases land on a day the plan does not expect/)
    assert.match(text, /\(Tue\)/)
  } finally { ui.close() }
})

// ── Channel status labels + the two new coverage columns (Brief A) ──────────

/** One filter chip: its label (the button's own text node) and its count. */
function chip(host: HTMLElement, label: string): HTMLButtonElement {
  const button = [...host.querySelectorAll('.status-filter')]
    .find(candidate => (candidate.firstChild?.textContent || '').trim() === label)
  assert.ok(button, `the "${label}" filter chip exists`)
  return button as HTMLButtonElement
}

function chipCount(button: HTMLElement): number {
  return Number(button.querySelector('span')?.textContent ?? NaN)
}

/** One row's single status control: the select is the label, so read the
 *  word it is showing (its selected option), not a second element. */
function statusCell(host: HTMLElement, channelName: string): { label: string; select: HTMLSelectElement } {
  const row = [...host.querySelectorAll('table.coverage-table tbody tr')]
    .find(candidate => (candidate.querySelector('.channel-link')?.textContent || '').trim() === channelName)
  assert.ok(row, `a coverage row for ${channelName}`)
  const select = row!.querySelector('select.status-editor') as HTMLSelectElement | null
  assert.ok(select, `the status editor for ${channelName} renders`)
  assert.equal(row!.querySelectorAll('.status-chip').length, 0, `the row for ${channelName} says its status once, not as a chip and a select`)
  assert.equal(row!.querySelectorAll('select.status-editor').length, 1, `exactly one status control for ${channelName}`)
  return {
    label: (select!.selectedOptions[0]?.textContent || '').trim(),
    select: select!,
  }
}

/** Drive the row's own editor the way a person does: pick, then change. */
async function chooseStatus(host: HTMLElement, channelName: string, value: string): Promise<void> {
  const { select } = statusCell(host, channelName)
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
  await flush()
}

test('status chips count every label with a real zero, default to All, and remember the choice', async () => {
  // No channel is Live yet: "Live 0" is a counted zero, not an unknown — the
  // owner has simply not labelled anything Live.
  const overview = overviewWith([
    channel({ slug: 'komsan', name: 'Komsan', channel_status: 'testing', priority: { reason: 'none', at: null } }),
    channel({ slug: 'paused-one', name: 'Paused One', channel_status: 'paused' }),
    channel({ slug: 'retired-one', name: 'Retired One', channel_status: 'retired' }),
    channel({ slug: 'unlabelled', name: 'Unlabelled One' }),
  ])
  const ui = await mount({ overview })
  try {
    const all = chip(ui.host, 'All')
    assert.equal(all.getAttribute('aria-pressed'), 'true', 'All is the default')
    assert.equal(chipCount(all), 4)
    assert.equal(chipCount(chip(ui.host, 'Unclassified')), 1, 'an absent key counts as Unclassified')
    assert.equal(chipCount(chip(ui.host, 'Live')), 0, 'a real zero, not an unknown')
    assert.equal(chipCount(chip(ui.host, 'Preparing')), 0)
    assert.equal(chipCount(chip(ui.host, 'Testing')), 1)
    assert.equal(chipCount(chip(ui.host, 'Paused')), 1)
    assert.equal(chipCount(chip(ui.host, 'Retired')), 1)
    assert.deepEqual(rowNames(ui.host), ['Komsan', 'Paused One', 'Retired One', 'Unlabelled One'])
    assert.equal(localStorage.getItem('storyStudio:publishingStatusFilter'), null, 'All needs no entry')

    chip(ui.host, 'Testing').click(); await flush()
    assert.deepEqual(rowNames(ui.host), ['Komsan'], 'the filter narrows the table')
    assert.equal(chip(ui.host, 'Testing').getAttribute('aria-pressed'), 'true')
    assert.equal(chip(ui.host, 'All').getAttribute('aria-pressed'), 'false')
    assert.equal(localStorage.getItem('storyStudio:publishingStatusFilter'), 'testing', 'the choice is remembered')

    // An empty chip says so with its own label rather than an empty table.
    chip(ui.host, 'Live').click(); await flush()
    assert.equal(rowNames(ui.host).length, 0)
    assert.match(ui.host.textContent || '', /No channel has the status “Live”/)
    assert.equal(localStorage.getItem('storyStudio:publishingStatusFilter'), 'live')
  } finally { ui.close() }

  // Remembered across a fresh load of the same page: the choice made above is
  // still the one the page comes back with.
  const again = await mount({ overview })
  try {
    assert.equal(chip(again.host, 'Live').getAttribute('aria-pressed'), 'true')
    assert.equal(chip(again.host, 'All').getAttribute('aria-pressed'), 'false')
    assert.equal(rowNames(again.host).length, 0)
    assert.match(again.host.textContent || '', /No channel has the status “Live”/)

    chip(again.host, 'All').click(); await flush()
    assert.equal(localStorage.getItem('storyStudio:publishingStatusFilter'), null, 'All clears the entry')
    assert.equal(rowNames(again.host).length, 4)
    assert.equal(chip(again.host, 'All').getAttribute('aria-pressed'), 'true')
  } finally { again.close() }
})

test('a status label is saved through the channel-settings route and to nothing else', async () => {
  const overview = overviewWith([
    channel({ slug: 'komsan', name: 'Komsan' }),
    channel({ slug: 'other', name: 'Other Channel' }),
  ])
  const ui = await mount({ overview })
  try {
    assert.equal(statusCell(ui.host, 'Komsan').label, 'Unclassified')
    await chooseStatus(ui.host, 'Komsan', 'testing')

    // ONE call, to the ordinary channel-settings route, with just the key.
    assert.equal(puts.length, 1, `exactly one write, got ${JSON.stringify(puts)}`)
    assert.equal(puts[0]!.path, '/projects/komsan')
    assert.deepEqual(puts[0]!.body, { channel_status: 'testing' })
    // No schedule, no upload, no publishing write — nothing else was called.
    assert.equal(puts.some(entry => /schedule|upload|publish|youtube/i.test(entry.path)), false)

    // The row and the counts follow the saved value.
    assert.equal(statusCell(ui.host, 'Komsan').label, 'Testing')
    assert.equal(statusCell(ui.host, 'Komsan').select.value, 'testing')
    assert.equal(chipCount(chip(ui.host, 'Testing')), 1)
    assert.equal(chipCount(chip(ui.host, 'Unclassified')), 1)

    // Reversible: clearing it sends null and lands on the same answer an
    // absent key already gives.
    await chooseStatus(ui.host, 'Komsan', 'unclassified')
    assert.equal(puts.length, 2)
    assert.deepEqual(puts[1]!.body, { channel_status: null })
    assert.equal(statusCell(ui.host, 'Komsan').label, 'Unclassified')
    assert.equal(chipCount(chip(ui.host, 'Unclassified')), 2)
  } finally { ui.close() }
})

test('a failed status save says so in the row, keeps the stored label and puts the editor back', async () => {
  const ui = await mount({ overview: overviewWith([channel({ slug: 'komsan', name: 'Komsan' })]) })
  try {
    putError = { message: 'Project not found', data: { detail: 'Project not found' } }
    await chooseStatus(ui.host, 'Komsan', 'paused')

    assert.equal(puts.length, 0, 'a refused write is not recorded as a save')
    const row = [...ui.host.querySelectorAll('table.coverage-table tbody tr')][0]!
    assert.equal(statusCell(ui.host, 'Komsan').label, 'Unclassified', 'the stored label stands')
    assert.equal(row.querySelector('select.status-editor')!.value, 'unclassified', 'the editor goes back')
    assert.match(row.querySelector('.status-error')?.textContent || '', /Project not found/)
    assert.equal(chipCount(chip(ui.host, 'Paused')), 0)
  } finally { ui.close() }
})

test('missing slots and the oldest check read unknown — never a zero — and Ready stays its own column', async () => {
  const now = new Date()
  const iso = (offsetDays: number) => new Date(now.getTime() + offsetDays * 86400000).toISOString()
  const covered = channel({
    slug: 'covered', name: 'Covered Channel',
    plan_set: true, plan_name: 'Covered plan', timezone: 'UTC',
    coverage: coverage({ missing_slots_4w: 0, oldest_checked_at: iso(-2), oldest_checked_stale: false, ready_video_count: 0 }),
  })
  const gap = channel({
    slug: 'gap', name: 'Gap Channel',
    plan_set: true, plan_name: 'Gap plan', timezone: 'UTC',
    coverage: coverage({ missing_slots_4w: 3, oldest_checked_at: iso(-40), oldest_checked_stale: true, ready_video_count: 2 }),
  })
  // No plan, never checked, and an unreadable ready count: three different
  // unknowns, none of them 0.
  const blind = channel({
    slug: 'blind', name: 'Blind Channel',
    coverage: coverage({ missing_slots_4w: null, oldest_checked_at: null, oldest_checked_stale: false, ready_video_count: null }),
    readiness: { episodes: 3, episodes_with_code: 3, ready_to_publish: null, ready_unknown: 0, on_youtube: null, in_progress: 0, needs_attention: 0, error: 'Story Studio could not read which episodes are already on YouTube.' },
  })

  const ui = await mount({ overview: overviewWith([covered, gap, blind]) })
  try {
    // A real zero is kept apart from "could not work it out".
    assert.equal(coverageText(ui.host, 'Covered Channel', 'Missing (4 weeks)'), '0')
    assert.equal(coverageText(ui.host, 'Gap Channel', 'Missing (4 weeks)'), '3')
    assert.equal(coverageText(ui.host, 'Blind Channel', 'Missing (4 weeks)'), 'unknown')

    // The OLDEST check, fresh, is a date; a stale one and a missing one are
    // both unknown, and neither is ever a zero.
    const freshDay = iso(-2).slice(0, 10)
    assert.equal(coverageText(ui.host, 'Covered Channel', 'Oldest checked'), freshDay)
    assert.equal(coverageText(ui.host, 'Gap Channel', 'Oldest checked'), 'unknown')
    assert.equal(coverageText(ui.host, 'Blind Channel', 'Oldest checked'), 'unknown')

    // Ready stock is still its own column with its own unknown.
    assert.equal(coverageText(ui.host, 'Covered Channel', 'Ready'), '0')
    assert.equal(coverageText(ui.host, 'Gap Channel', 'Ready'), '2')
    assert.equal(coverageText(ui.host, 'Blind Channel', 'Ready'), 'unknown')

    // Nothing here moved a date: the confirmed/planned columns still read what
    // the fixture put there.
    assert.equal(coverageText(ui.host, 'Gap Channel', 'Last confirmed'), '—')
    assert.equal(coverageText(ui.host, 'Gap Channel', 'Last planned'), '—')
  } finally { ui.close() }
})

test('a real gap still sorts first under a status filter, on the API priority alone', async () => {
  const at = '2026-10-22T18:00:00.000Z'
  const urgent = channel({
    slug: 'urgent', name: 'Urgent Channel', channel_status: 'live',
    plan_set: true, plan_name: 'Urgent plan', timezone: 'UTC',
    coverage: coverage({ next_uncovered_slot: at, at_risk: true }),
    priority: { reason: 'earliest_uncovered_slot', at },
  })
  const calm = channel({
    slug: 'calm', name: 'Calm Channel', channel_status: 'live',
    priority: { reason: 'none', at: null },
  })
  const other = channel({ slug: 'other', name: 'Other Status', channel_status: 'paused' })
  // The API already returns channels in priority order; the page preserves it.
  const ui = await mount({ overview: overviewWith([urgent, calm, other]) })
  try {
    // The API's own order: the channel with the real gap first, not alphabetical.
    assert.deepEqual(rowNames(ui.host), ['Urgent Channel', 'Calm Channel', 'Other Status'])

    chip(ui.host, 'Live').click(); await flush()
    assert.deepEqual(
      rowNames(ui.host),
      ['Urgent Channel', 'Calm Channel'],
      'the filter narrows the set but never re-orders it: real gaps stay first',
    )
    assert.equal(rowNames(ui.host).includes('Other Status'), false)
  } finally { ui.close() }
})
