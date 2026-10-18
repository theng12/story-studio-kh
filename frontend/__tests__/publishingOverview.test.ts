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
 *
 * NOTE: written but UNRUN — adda owns the execution lease.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'

async function component() {
  const filename = new URL('../pages/publishing.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'publishing' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'publishing',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const code = script.content.replace(/^import .* from ['"]~\/.*['"]\s*$/gm, '').replace('export default', 'const __sfc__ =')
  const support = 'const usePublishingOverview = () => globalThis.__po;'
  const transformed = await transform(
    `${support}\n${code}\n${template.code}\n__sfc__.render = render; export default __sfc__`,
    { loader: 'ts', format: 'esm' },
  )
  const resolved = transformed.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))
  return (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).default
}

async function flush() { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)); await nextTick() }

interface MountOptions { error?: string | null; overview?: any }

async function mount(options: MountOptions = {}) {
  const refreshCalls = { count: 0 }
  ;(globalThis as any).__po = {
    overview: ref(options.overview ?? null),
    loading: ref(false),
    error: ref(options.error ?? null),
    refreshing: ref(false),
    load: () => {},
    refresh: () => { refreshCalls.count++; return Promise.resolve(null) },
  }
  const Comp = await component()
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ setup: () => () => h(Comp) }))
  // Proper stubs for the auto-imported components so the template resolves them
  // (and the notice's default slot actually renders).
  app.component('PlainBackLink', { render: () => null })
  app.component('WorkspaceNotice', { render(this: any) { return this.$slots.default ? this.$slots.default() : null } })
  // The page links rows with <NuxtLink class="plan-link">; without Nuxt's runtime the
  // tag resolves to nothing, so stub it as a real anchor (class falls through) the
  // same way the sibling suites do — otherwise a.plan-link is always absent.
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  app.mount(host)
  await flush()
  return { host, refreshCalls, close: () => { app.unmount(); host.remove() } }
}

function channel(overrides: any = {}) {
  return {
    slug: 'alpha', name: 'Alpha Channel',
    channel: null,
    plan_set: false, plan_name: null, timezone: null,
    confirmed: { next_at: null, count: 0, last_checked_at: null, freshness: 'unknown', error: 'no_channel_assigned', schedules: [] },
    planned: { next_slot_at: null, next_uncovered_slot_at: null, next_unplanned_slot_at: null, last_slot_at: null, slots: [], assignments: [] },
    coverage: { last_confirmed_date: null, last_planned_date: null, next_uncovered_slot: null, scheduled_video_count: 0, planned_date_count: 0, ready_video_count: null, at_risk: false },
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
    scheduled_video_count: 0, planned_date_count: 0, ready_video_count: null, at_risk: false,
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
    const cell = [...unknownRow.querySelectorAll('td span.muted')]
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
    const cell = [...ui.host.querySelectorAll('td span.muted')]
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
  assert.doesNotMatch(source, /max-width:\s*1180px/, 'the old 1180px cap is gone')
  assert.match(source, /\.publishing-page\s*\{[^}]*width:\s*100%/, 'the page uses the full width')
  assert.match(source, /\.publishing-page\s*\{[^}]*box-sizing:\s*border-box/)
  assert.match(source, /\.coverage-scroll\s*\{[^}]*overflow-x:\s*auto/, 'wide tables scroll inside their container')
  assert.match(source, /\.coverage-table\s*\{[^}]*min-width:\s*860px/)
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
