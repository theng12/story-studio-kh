import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { DAY_MS, WEEK_MS, dateProblem, episodeKey, layoutEpisodes, weekInZone, weeklyReleases } from '../utils/publishingTimeline'
import type { PublishingOverviewChannel, PublishingTimelineEpisode } from '../../electron/server/contracts/publishing-overview'
const now = Date.parse('2026-11-09T12:00:00Z'), start = Date.parse('2026-11-09T00:00:00Z')
const episode = (patch: Partial<PublishingTimelineEpisode> = {}): PublishingTimelineEpisode => ({ id: 'one', episode_code: 'EP1', title: 'A story', upload_start_at: null, public_release_at: null, date_source: 'none', stage: 'idea', state: 'waiting', detail: 'Accepted idea.', url: '/projects/a/board', publication_checked_at: null, publication_freshness: 'unknown', ...patch })
const channel = (episodes: PublishingTimelineEpisode[]): PublishingOverviewChannel => ({ slug: 'a', name: 'Alpha', timezone: 'UTC', channel_status: null, timeline: { episodes }, confirmed: { schedules: [], freshness: 'fresh', listing: { state: 'complete', stale: false } } } as unknown as PublishingOverviewChannel)

test('channel-local Monday weeks handle timezone boundaries and invalid data', () => {
  assert.equal(weekInZone('2026-11-08T20:00:00Z', 'Asia/Phnom_Penh'), '2026-11-09')
  assert.equal(weekInZone('2026-11-08T20:00:00Z', 'America/Los_Angeles'), '2026-11-02')
  assert.equal(weekInZone('bad', 'UTC'), null)
  assert.equal(weekInZone('2026-11-09T00:00:00Z', 'bad/zone'), null)
  assert.equal(weekInZone('2026-11-09T00:00:00Z', null), null)
})
test('planned releases and upload starts cannot clear a confirmed gap', () => {
  const row = channel([episode({ upload_start_at: '2026-11-09T10:00:00Z' }), episode({ id: 'two', episode_code: 'EP2', public_release_at: '2026-11-10T10:00:00Z', date_source: 'planned' })])
  assert.deepEqual(weeklyReleases(row, '2026-11-09', 3), { confirmed: 0, planned: 1, gap: 3 })
})
test('one episode counts once even when both schedule and timeline name it', () => {
  const row = channel([episode({ public_release_at: '2026-11-10T10:00:00Z', date_source: 'confirmed' })])
  row.confirmed.schedules = [{ episode_code: 'EP1', video_id: 'v1', scheduled_for: '2026-11-10T10:00:00Z', stale: false }]
  assert.deepEqual(weeklyReleases(row, '2026-11-09', 3), { confirmed: 1, planned: 0, gap: 2 })
  row.confirmed.freshness = 'stale'
  assert.equal(weeklyReleases(row, '2026-11-09', 3).gap, null)
})
test('old, partial and failed payloads never show a checked zero gap', () => {
  const row = channel([])
  delete row.timeline
  assert.equal(weeklyReleases(row, '2026-11-09', 3).gap, null)
  row.timeline = { episodes: [], error: 'Drive unavailable' }
  assert.equal(weeklyReleases(row, '2026-11-09', 3).gap, null)
  row.timeline = { episodes: [] }; row.confirmed.listing!.state = 'partial'
  assert.equal(weeklyReleases(row, '2026-11-09', 3).gap, null)
})
test('two collision lanes plus folds retain every overlapping episode', () => {
  const episodes = Array.from({ length: 7 }, (_, i) => episode({ id: String(i), episode_code: `EP${i}`, public_release_at: '2026-11-10T10:00:00Z', date_source: 'planned' }))
  const layout = layoutEpisodes(episodes, start, 8, 36)
  assert.equal(layout.visible.length, 2); assert.equal(layout.folded.length, 5)
  assert.equal(new Set([...layout.visible, ...layout.folded].map(item => episodeKey(item.episode))).size, 7)
  assert.ok(layout.visible.every(item => item.width >= 156))
})
test('unknown, invalid and reversed dates stay reachable without invented positions', () => {
  const missing = episode(), invalid = episode({ id: 'bad', public_release_at: 'not-a-date' }), reversed = episode({ id: 'reverse', upload_start_at: '2026-11-12T00:00:00Z', public_release_at: '2026-11-10T00:00:00Z' })
  const layout = layoutEpisodes([missing, invalid, reversed], start, 8, 36)
  assert.equal(layout.undated.length, 3); assert.equal(layout.visible.length, 0)
  assert.match(dateProblem(reversed)!, /after release/)
  assert.match(dateProblem(invalid)!, /Invalid/)
})
test('windows retain exact upload/release positions and exclude outside episodes', () => {
  const release = new Date(start + 3 * DAY_MS).toISOString()
  const e = episode({ upload_start_at: new Date(start + DAY_MS).toISOString(), public_release_at: release, date_source: 'planned' })
  const layout = layoutEpisodes([e, episode({ id: 'outside', public_release_at: new Date(start + 9 * WEEK_MS).toISOString() })], start, 8, 36)
  assert.equal(layout.visible[0]!.left, 36); assert.equal(layout.visible[0]!.upload, start + DAY_MS); assert.equal(layout.visible[0]!.release, Date.parse(release)); assert.equal(layout.outside.length, 1)
})

async function mount(channels: PublishingOverviewChannel[]) {
  const filename = new URL('../components/PublishingTimeline.vue', import.meta.url).pathname
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const script = compileScript(descriptor, { id: 'timeline' })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id: 'timeline', compilerOptions: { bindingMetadata: script.bindings } })
  assert.deepEqual(template.errors, [])
  const source = script.content.replace(/['"]~\/utils\/publishingTimeline['"]/g, JSON.stringify(new URL('../utils/publishingTimeline.ts', import.meta.url).href)).replace('export default', 'const __sfc__ =')
  const compiled = await transform(`${source}\n${template.code}\n__sfc__.render = render; export default __sfc__`, { loader: 'ts', format: 'esm' })
  const resolved = compiled.code.replaceAll('"vue"', JSON.stringify(await import.meta.resolve('vue')))
  const Comp = (await import(`data:text/javascript;base64,${Buffer.from(resolved).toString('base64')}`)).default
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(Comp, { channels, now })
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  app.mount(host); await nextTick()
  return { host, close: () => { app.unmount(); host.remove() } }
}
const click = async (host: HTMLElement, text: string) => { const button = [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === text); assert.ok(button, text); button.click(); await nextTick() }
test('mounted timeline shows all channels and preserves unknown rows and list access', async () => {
  const old = channel([]); old.slug = 'old'; old.name = 'Old payload'; delete old.timeline
  const ui = await mount([channel([episode()]), old])
  try {
    assert.equal(ui.host.querySelectorAll('.timeline-channel').length, 2)
    assert.match(ui.host.textContent!, /Episode timeline not checked/)
    assert.match(ui.host.textContent!, /undated or conflicting/)
    await click(ui.host, 'Episode list')
    assert.equal(ui.host.querySelectorAll('.episode-table tbody').length, 2)
    assert.match(ui.host.textContent!, /EP1 · A story/)
    assert.match(ui.host.textContent!, /Not set/)
  } finally { ui.close() }
})
test('mounted fold lists every hidden item and navigation changes weeks', async () => {
  const episodes = Array.from({ length: 6 }, (_, i) => episode({ id: `e${i}`, episode_code: `EP${i}`, public_release_at: '2026-11-10T10:00:00Z', date_source: 'planned' }))
  const ui = await mount([channel(episodes)])
  try {
    assert.equal(ui.host.querySelectorAll('.episode-window').length, 2)
    assert.equal(ui.host.querySelectorAll('.folded-episodes li').length, 4)
    const range = ui.host.querySelector('.timeline-range')!.textContent
    await click(ui.host, 'Next')
    assert.notEqual(ui.host.querySelector('.timeline-range')!.textContent, range)
    await click(ui.host, 'Today')
    assert.equal(ui.host.querySelector('.timeline-range')!.textContent, range)
  } finally { ui.close() }
})
test('enlarge and Escape restore the view and body scroll', async () => {
  const previous = document.body.style.overflow
  const ui = await mount([channel([])])
  try {
    await click(ui.host, 'Enlarge'); assert.equal(ui.host.querySelector('[role="dialog"]')?.getAttribute('aria-modal'), 'true')
    ui.host.querySelector('section')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await nextTick()
    assert.equal(ui.host.querySelector('[role="dialog"]'), null); assert.equal(document.body.style.overflow, previous)
  } finally { ui.close() }
})
