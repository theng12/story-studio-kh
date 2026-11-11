<template>
  <section ref="root" class="publishing-timeline" :class="{ enlarged }" :role="enlarged ? 'dialog' : 'region'" :aria-modal="enlarged || undefined" aria-label="Channel episode timeline" @keydown.esc="closeEnlarged" @keydown.tab="containFocus">
    <div class="timeline-toolbar">
      <div class="timeline-navigation" role="group" aria-label="Timeline dates">
        <button type="button" class="btn btn-secondary btn-sm" @click="shift(-1)">Previous</button>
        <button type="button" class="btn btn-secondary btn-sm" @click="today">Today</button>
        <button type="button" class="btn btn-secondary btn-sm" @click="shift(1)">Next</button>
        <strong class="timeline-range" aria-live="polite">{{ rangeLabel }}</strong>
      </div>
      <div class="timeline-options">
        <label>Show <select v-model.number="weeks"><option v-for="n in [4, 8, 12, 16]" :key="n" :value="n">{{ n }} weeks</option></select></label>
        <div role="group" aria-label="Timeline zoom"><button type="button" class="btn btn-secondary btn-sm" :disabled="zoom === 0" @click="zoom--">Zoom out</button> <button type="button" class="btn btn-secondary btn-sm" :disabled="zoom === widths.length - 1" @click="zoom++">Zoom in</button></div>
        <label>Releases/week <input v-model.number="target" type="number" min="0" step="1" aria-label="Weekly release comparison; zero turns it off" /></label>
        <button type="button" class="btn btn-secondary btn-sm" :aria-pressed="showList" @click="showList = !showList">{{ showList ? 'Timeline' : 'Episode list' }}</button>
        <button ref="enlargeButton" type="button" class="btn btn-secondary btn-sm" :aria-pressed="enlarged" @click="toggleEnlarged">{{ enlarged ? 'Back' : 'Enlarge' }}</button>
      </div>
    </div>
    <p class="timeline-note">Read-only. Dates are live local plans and the last YouTube observations. Circle: actual upload start. Diamond: public release. The line joins these dates; it is not production time. Axis: UTC; weekly counts use each channel’s timezone.</p>
    <ul class="timeline-legend" aria-label="Timeline legend"><li><span class="date-symbol upload-symbol" aria-hidden="true"></span>Upload start</li><li><span class="date-symbol release-symbol" aria-hidden="true"></span>Release</li><li><span class="sample-line" aria-hidden="true"></span>Confirmed at last check</li><li><span class="sample-line planned-line" aria-hidden="true"></span>Planned target</li></ul>
    <p v-if="comparison === 0" class="timeline-note">Weekly comparison is off. Set a whole number above zero to compare releases.</p>
    <p v-if="channels.length === 0" class="timeline-empty" role="status">No channels match the channel search.</p>

    <div v-if="!showList && channels.length" ref="scroller" class="timeline-scroll" tabindex="0" aria-label="Scrollable timeline; scroll horizontally or drag empty space" @pointerdown="startPan" @pointermove="pan" @pointerup="endPan" @pointercancel="endPan" @wheel="onTimelineWheel">
      <div class="timeline-canvas" :style="{ width: `${labelWidth + canvasWidth}px`, '--week-width': `${weekWidth}px` }">
        <div class="timeline-axis"><div class="channel-heading">{{ channels.length }} channels</div><div class="week-axis" :style="{ width: `${canvasWidth}px` }"><span v-for="week in weekDays" :key="week" :style="{ width: `${weekWidth}px` }">{{ shortDay(week) }}</span><span v-if="nowPosition >= 0 && nowPosition <= canvasWidth" class="today-tick" :style="{ left: `${nowPosition}px` }">Today</span></div></div>
        <div v-for="row in rows" :key="row.channel.slug" class="timeline-channel">
          <div class="channel-label"><NuxtLink :to="`/projects/${encodeURIComponent(row.channel.slug)}/upload`">{{ row.channel.name }}</NuxtLink><span>{{ row.channel.timezone || 'Timezone not set' }}</span><span>{{ row.channel.channel_status || 'Unclassified' }}</span></div>
          <div class="channel-track" :style="{ width: `${canvasWidth}px` }">
            <div class="week-comparisons"><div v-for="week in row.counts" :key="week.day" :style="{ width: `${weekWidth}px` }"><span v-if="comparison" :class="{ 'gap-label': week.gap !== null && week.gap > 0 }">{{ week.confirmed }} confirmed · {{ week.planned }} planned<br />{{ week.gap === null ? 'Gap not checked' : `${week.gap} short of ${comparison}` }}{{ week.partial ? ' · partial week' : '' }}</span></div></div>
            <div class="episode-tracks">
              <div v-for="item in row.layout.visible" :key="episodeKey(item.episode)" class="episode-window" :class="[item.episode.date_source, `state-${item.episode.state}`]" :style="{ left: `${item.left}px`, width: `${item.width}px`, top: `${item.lane * 54}px` }" @mouseenter="select(row.channel, item.episode)" @focusin="select(row.channel, item.episode)">
                <span v-if="item.upload !== null && item.release !== null" class="window-line" aria-hidden="true" :style="{ left: `${Math.max(0, position(item.upload)) - item.left}px`, width: `${Math.max(0, Math.min(canvasWidth, position(item.release)) - Math.max(0, position(item.upload)))}px` }"></span>
                <span v-if="visibleDate(item.upload)" class="date-symbol upload-symbol window-marker" :style="{ left: `${position(item.upload!) - item.left}px` }" :title="`Upload start: ${item.episode.upload_start_at}`"></span>
                <span v-if="visibleDate(item.release)" class="date-symbol release-symbol window-marker" :style="{ left: `${position(item.release!) - item.left}px` }" :title="`Release: ${item.episode.public_release_at}`"></span>
                <NuxtLink :to="item.episode.url" class="episode-label" :title="describe(row.channel, item.episode)"><svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true"><path :d="iconPath(item.episode.state)" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg><span>{{ item.episode.episode_code || 'Idea' }} · {{ item.episode.title }}</span><small>{{ status(item.episode) }}</small></NuxtLink>
              </div>
            </div>
            <div class="row-notes">
              <p v-if="!row.channel.timeline" class="timeline-warning">Episode timeline not checked. Reload after Story Studio updates.</p>
              <p v-else-if="row.channel.timeline.error" class="timeline-warning" role="status">{{ row.channel.timeline.error }}</p>
              <p v-if="row.channel.timeline && !row.channel.timeline.episodes.length && !row.channel.timeline.error">No accepted episodes.</p>
              <details v-if="row.layout.folded.length" class="folded-episodes"><summary>+{{ row.layout.folded.length }} overlapping episodes</summary><ul><li v-for="item in row.layout.folded" :key="episodeKey(item.episode)"><NuxtLink :to="item.episode.url" @focus="select(row.channel, item.episode)" @mouseenter="select(row.channel, item.episode)">{{ item.episode.episode_code || 'Idea' }} · {{ item.episode.title }}</NuxtLink><span>{{ describe(row.channel, item.episode) }}</span></li></ul></details>
              <details v-if="row.layout.undated.length"><summary>{{ row.layout.undated.length }} undated or conflicting episodes</summary><ul><li v-for="episode in row.layout.undated" :key="episodeKey(episode)"><NuxtLink :to="episode.url">{{ episode.episode_code || 'Idea' }} · {{ episode.title }}</NuxtLink><span>{{ describe(row.channel, episode) }}</span></li></ul></details>
              <span v-if="row.layout.outside.length">{{ row.layout.outside.length }} outside this range · available in Episode list</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="channels.length" class="episode-list-scroll">
      <table class="episode-table"><caption>All returned episodes, including undated episodes and those outside the visible weeks.</caption><thead><tr><th scope="col">Channel / episode</th><th scope="col">Upload start</th><th scope="col">Public release</th><th scope="col">Status and evidence</th></tr></thead><tbody v-for="channel in channels" :key="channel.slug"><tr v-if="!channel.timeline || channel.timeline.error || !channel.timeline.episodes.length"><th scope="row">{{ channel.name }}</th><td colspan="3">{{ channel.timeline?.error || (channel.timeline ? 'No accepted episodes.' : 'Episode timeline not checked.') }}</td></tr><tr v-for="episode in channel.timeline?.episodes || []" :key="episodeKey(episode)"><th scope="row">{{ channel.name }}<NuxtLink :to="episode.url">{{ episode.episode_code || 'Idea' }} · {{ episode.title }}</NuxtLink></th><td>{{ formatDate(episode.upload_start_at, channel.timezone) }}</td><td>{{ formatDate(episode.public_release_at, channel.timezone) }}<span>{{ episode.date_source }}</span></td><td>{{ describe(channel, episode) }}</td></tr></tbody></table>
    </div>
    <aside v-if="selected" class="episode-detail" aria-live="polite" aria-atomic="true"><strong>{{ selected.channel.name }} · {{ selected.episode.episode_code || 'Idea' }} · {{ selected.episode.title }}</strong><p>{{ describe(selected.channel, selected.episode) }}</p><NuxtLink :to="selected.episode.url">Open Production Board</NuxtLink></aside>
    <p v-else class="timeline-note">Point to or focus an episode for dates and evidence. Folded episodes and the episode list keep every item reachable.</p>
    <p class="timeline-note">Plans do not fill confirmed gaps. An incomplete or stale YouTube listing leaves gaps “not checked”. No future upload start is invented when the queue has not started. Expected plan slots elsewhere cover only the next 12 slots.</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import type { PublishingOverviewChannel, PublishingTimelineEpisode } from '@shared/publishing-overview'
import { DAY_MS, WEEK_MS, dateProblem, episodeKey, layoutEpisodes, monday, timestamp, weeklyReleases } from '~/utils/publishingTimeline'
const props = defineProps<{ channels: PublishingOverviewChannel[]; now?: number }>()
const instant = computed(() => props.now ?? Date.now())
const start = ref(Date.parse(`${monday(new Date(instant.value).toISOString().slice(0, 10))}T00:00:00Z`))
const weeks = ref(8), zoom = ref(1), target = ref<number | string>(3), showList = ref(false), enlarged = ref(false)
const widths = [24, 36, 52]
const labelWidth = 212
const root = ref<HTMLElement | null>(null), scroller = ref<HTMLElement | null>(null), enlargeButton = ref<HTMLButtonElement | null>(null)
const selectedKey = ref<{ slug: string; id: string } | null>(null)
const selected = computed(() => {
  const channel = props.channels.find(row => row.slug === selectedKey.value?.slug)
  const episode = channel?.timeline?.episodes.find(row => episodeKey(row) === selectedKey.value?.id)
  return channel && episode ? { channel, episode } : null
})
const comparison = computed(() => typeof target.value === 'number' && Number.isSafeInteger(target.value) && target.value > 0 ? target.value : 0)
const dayWidth = computed(() => widths[zoom.value]!)
const weekWidth = computed(() => dayWidth.value * 7)
const canvasWidth = computed(() => weekWidth.value * weeks.value)
const weekDays = computed(() => Array.from({ length: weeks.value }, (_, i) => new Date(start.value + i * WEEK_MS).toISOString().slice(0, 10)))
const rangeLabel = computed(() => `${shortDay(weekDays.value[0]!)} – ${shortDay(new Date(start.value + weeks.value * WEEK_MS - DAY_MS).toISOString().slice(0, 10))}`)
const nowPosition = computed(() => position(instant.value))
const rows = computed(() => props.channels.map(channel => ({ channel, layout: layoutEpisodes(channel.timeline?.episodes || [], start.value, weeks.value, dayWidth.value), counts: weekDays.value.map(day => ({ day, ...weeklyReleases(channel, day, comparison.value), partial: day === monday(new Date(instant.value).toISOString().slice(0, 10)) && instant.value > Date.parse(`${day}T00:00:00Z`) })) })))
function shortDay(day: string): string { return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) }
function position(at: number): number { return (at - start.value) / DAY_MS * dayWidth.value }
function visibleDate(at: number | null): boolean { return at !== null && at >= start.value && at < start.value + weeks.value * WEEK_MS }
function shift(direction: number) { start.value += direction * weeks.value * WEEK_MS }
function today() { start.value = Date.parse(`${monday(new Date(instant.value).toISOString().slice(0, 10))}T00:00:00Z`); if (scroller.value) scroller.value.scrollLeft = 0 }
function status(episode: PublishingTimelineEpisode): string { return `${episode.stage.replaceAll('_', ' ')} · ${episode.state.replaceAll('_', ' ')}` }
function formatDate(value: string | null, zone: string | null): string {
  if (!value) return 'Not set'
  if (timestamp(value) === null) return 'Invalid date'
  try { return `${new Date(value).toLocaleString(undefined, { timeZone: zone || 'UTC' })} (${zone || 'UTC; channel timezone not set'})` } catch { return `${value} (invalid channel timezone)` }
}
function describe(channel: PublishingOverviewChannel, episode: PublishingTimelineEpisode): string {
  return [status(episode), episode.detail, dateProblem(episode), `Upload start: ${formatDate(episode.upload_start_at, channel.timezone)}.`, `Release: ${formatDate(episode.public_release_at, channel.timezone)} (${episode.date_source}).`, `YouTube: ${episode.publication_freshness}; last checked ${formatDate(episode.publication_checked_at, channel.timezone)}.`].filter(Boolean).join(' ')
}
function select(channel: PublishingOverviewChannel, episode: PublishingTimelineEpisode) { selectedKey.value = { slug: channel.slug, id: episodeKey(episode) } }
function iconPath(state: string): string { return state === 'failed' ? 'M4 4l12 12M16 4L4 16' : state === 'complete' ? 'M3 10l5 5L17 5' : state === 'paused' ? 'M7 4v12M13 4v12' : 'M10 3a7 7 0 1 0 0 14a7 7 0 1 0 0-14M10 6v5l3 2' }
let oldOverflow = ''
async function toggleEnlarged() { if (enlarged.value) return closeEnlarged(); oldOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; enlarged.value = true; await nextTick(); enlargeButton.value?.focus() }
function closeEnlarged() { if (!enlarged.value) return; enlarged.value = false; document.body.style.overflow = oldOverflow; nextTick(() => enlargeButton.value?.focus()) }
function containFocus(event: KeyboardEvent) {
  if (!enlarged.value || !root.value) return
  const controls = [...root.value.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input, select, summary, [tabindex="0"]')].filter(el => el.getClientRects().length)
  const first = controls[0], last = controls.at(-1)
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onBeforeUnmount(() => { if (enlarged.value) document.body.style.overflow = oldOverflow })
let drag: { x: number; scroll: number; id: number } | null = null
function startPan(event: PointerEvent) { if (event.button || event.pointerType === 'touch' || (event.target as HTMLElement).closest('a,button,input,select,summary,details')) return; drag = { x: event.clientX, scroll: scroller.value?.scrollLeft || 0, id: event.pointerId } }
function pan(event: PointerEvent) { if (!drag || !scroller.value || Math.abs(event.clientX - drag.x) < 5) return; scroller.value.setPointerCapture(event.pointerId); scroller.value.scrollLeft = drag.scroll - event.clientX + drag.x; event.preventDefault() }
function endPan() { if (drag && scroller.value?.hasPointerCapture(drag.id)) scroller.value.releasePointerCapture(drag.id); drag = null }
function onTimelineWheel(event: WheelEvent) { if (!event.ctrlKey && !event.metaKey) return; event.preventDefault(); zoom.value = Math.max(0, Math.min(widths.length - 1, zoom.value + (event.deltaY < 0 ? 1 : -1))) }
</script>

<style scoped>
.publishing-timeline { min-width: 0; color: var(--text-primary); }
.publishing-timeline.enlarged { position: fixed; inset: 0; z-index: 2000; padding: 24px; background: var(--bg-primary); overflow: auto; }
.timeline-toolbar, .timeline-navigation, .timeline-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.timeline-toolbar { justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.timeline-options label { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.timeline-options select, .timeline-options input { color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; min-height: 36px; padding: 5px 8px; font: inherit; }
.timeline-options input { width: 64px; }
.timeline-range { font-size: 13px; font-variant-numeric: tabular-nums; }
.timeline-note, .row-notes, .episode-detail p, .episode-table { font-size: 12px; line-height: 1.6; }
.timeline-note { color: var(--text-secondary); max-width: 100ch; margin: 10px 0; }
.timeline-legend { display: flex; flex-wrap: wrap; gap: 16px; list-style: none; padding: 0; margin: 12px 0; font-size: 12px; color: var(--text-secondary); }
.timeline-legend li { display: inline-flex; align-items: center; gap: 8px; }
.date-symbol { display: inline-block; width: 10px; height: 10px; flex-shrink: 0; background: var(--text-primary); border: 2px solid var(--bg-secondary); outline: 1px solid var(--text-secondary); }
.upload-symbol { border-radius: 50%; }
.release-symbol { transform: rotate(45deg); }
.sample-line { width: 24px; border-top: 2px solid var(--text-secondary); }
.planned-line { border-top-style: dashed; }
.timeline-scroll { max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 8px; scrollbar-color: var(--text-muted) var(--bg-secondary); touch-action: pan-x pan-y; }
.timeline-canvas { background: var(--bg-secondary); }
.timeline-axis, .timeline-channel { display: flex; }
.timeline-axis { position: sticky; top: 0; z-index: 4; background: var(--bg-tertiary); border-bottom: 1px solid var(--border); }
.channel-heading, .channel-label { position: sticky; left: 0; width: 212px; flex: 0 0 212px; padding: 12px; box-sizing: border-box; background: var(--bg-secondary); border-right: 1px solid var(--border); z-index: 3; overflow-wrap: anywhere; }
.channel-heading { background: var(--bg-tertiary); font-size: 12px; font-weight: 600; }
.channel-label a { display: block; font-size: 13px; font-weight: 600; color: var(--text-primary); text-underline-offset: 3px; }
.channel-label span { display: block; font-size: 12px; margin-top: 4px; color: var(--text-secondary); }
.week-axis { display: flex; position: relative; padding: 12px 0; }
.week-axis > span:not(.today-tick) { box-sizing: border-box; flex-shrink: 0; padding: 0 12px; font-size: 12px; font-variant-numeric: tabular-nums; }
.today-tick { position: absolute; top: 30px; font-size: 12px; font-weight: 600; background: var(--bg-tertiary); color: var(--text-primary); border-left: 1px solid var(--text-primary); padding: 0 4px; }
.timeline-channel { border-bottom: 1px solid var(--border); }
.channel-track { flex-shrink: 0; min-height: 160px; background-image: repeating-linear-gradient(to right, transparent 0, transparent calc(var(--week-width, 168px) - 1px), var(--border) calc(var(--week-width, 168px) - 1px), var(--border) var(--week-width, 168px)); }
.week-comparisons { display: flex; min-height: 48px; }
.week-comparisons > div { flex-shrink: 0; box-sizing: border-box; padding: 8px 12px; font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.gap-label { font-weight: 600; }
.episode-tracks { position: relative; height: 112px; }
.episode-window { position: absolute; height: 48px; }
.window-line { position: absolute; top: 9px; left: 0; right: 0; border-top: 2px solid var(--text-secondary); }
.planned .window-line { border-top-style: dashed; }
.window-marker { position: absolute; top: 4px; }
.episode-label { position: relative; display: grid; grid-template-columns: 14px minmax(0, 1fr); column-gap: 5px; margin: 16px 6px 0 0; width: min(220px, 100%); font-size: 12px; line-height: 1.3; color: var(--text-primary); text-decoration: none; background: var(--bg-secondary); }
.episode-label > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.episode-label small { grid-column: 2; font-size: 12px; color: var(--text-secondary); }
.state-failed svg { color: var(--error); }
.state-active svg { color: var(--info); }
.state-complete svg { color: var(--success); }
.row-notes { position: sticky; left: 224px; width: min(660px, calc(100vw - 280px)); padding: 0 12px 10px; color: var(--text-secondary); }
.row-notes p { margin: 4px 0; }
.row-notes summary { cursor: pointer; min-height: 32px; padding: 4px 0; color: var(--text-primary); }
.row-notes ul { padding-left: 18px; }
.row-notes li { margin: 8px 0; }
.row-notes li span { display: block; }
.timeline-warning { font-weight: 600; color: var(--text-primary); }
.episode-detail { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; max-width: 100ch; font-size: 13px; }
.episode-detail p { margin: 6px 0; color: var(--text-secondary); }
.episode-list-scroll { overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.episode-table { width: 100%; border-collapse: collapse; text-align: left; }
.episode-table caption { padding: 12px; text-align: left; color: var(--text-secondary); }
.episode-table th, .episode-table td { padding: 12px; border-bottom: 1px solid var(--border); vertical-align: top; min-width: 170px; max-width: 50ch; }
.episode-table td span, .episode-table th a { display: block; }
.publishing-timeline :is(a, button, input, select, summary, [tabindex]):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.publishing-timeline ::selection { background: var(--accent); color: var(--accent-on); }
@media (max-width: 600px) { .publishing-timeline.enlarged { padding: 12px; } .row-notes { width: 240px; position: static; } .timeline-range { flex-basis: 100%; } }
@media (prefers-reduced-motion: reduce) { .publishing-timeline * { scroll-behavior: auto; transition: none; } }
@media (forced-colors: active) { .date-symbol { background: CanvasText; border-color: Canvas; outline-color: CanvasText; } .window-line, .sample-line { border-color: CanvasText; } .episode-label { background: Canvas; color: CanvasText; } }
</style>
