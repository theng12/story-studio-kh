/**
 * v1.4.249 — Settings UX round (owner feedback on 1.4.248).
 *
 * Pins: the publishing schedule shows the plan by NAME and saves the same plan
 * the Upload Center edits; folders are chosen, never typed; Appearance &
 * notifications no longer scrolls past its content; Writing & style's cards draw
 * their own chevron inside the card.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { draftFromSchedule, episodesPerMonth, scheduleFromDraft, scheduleSummary } from '../utils/uploadPlanDraft.ts'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const aliases: Record<string, string> = {
  '"~/utils/uploadPlanDraft"': JSON.stringify(new URL('../utils/uploadPlanDraft.ts', import.meta.url).href),
}

async function compile(rel: string, support: string, extra: Record<string, string> = {}): Promise<Component> {
  const filename = fileURLToPath(new URL(rel, import.meta.url))
  const { descriptor } = parse(readFileSync(filename, 'utf8'), { filename })
  const id = rel.replace(/\W/g, '')
  const script = compileScript(descriptor, { id })
  const template = compileTemplate({ source: descriptor.template!.content, filename, id, compilerOptions: { bindingMetadata: script.bindings } })
  const vueUrl = await import.meta.resolve('vue')
  let code = `${support}\n${script.content.replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  code = (await transform(code, { loader: 'ts', format: 'esm' })).code.replaceAll('"vue"', JSON.stringify(vueUrl))
  for (const [from, to] of Object.entries({ ...aliases, ...extra })) code = code.replaceAll(from, to)
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) { await nextTick(); await new Promise(r => setTimeout(r, 0)) }
}

const plan = {
  id: 'plan_1', name: 'Night Tales schedule', platform: 'youtube', account_id: 'registry:UC1',
  schedule: { weekdays: [2, 4, 6], time_local: '19:30', timezone: 'Asia/Phnom_Penh', interval_weeks: 1 },
}

async function mountScheduleCard(state: any) {
  const calls: Array<{ method: string; path: string; body?: any }> = []
  ;(globalThis as any).__scheduleApi = {
    get: async (path: string) => { calls.push({ method: 'GET', path }); return state },
    put: async (path: string, body: any) => {
      calls.push({ method: 'PUT', path, body })
      const saved = { ...plan, name: body.name || plan.name, schedule: body.schedule }
      return { ...state, plan: state.channel ? saved : null, cadence: { schedule: body.schedule }, auto_schedule_on_render: body.auto_schedule_on_render ?? state.auto_schedule_on_render }
    },
  }
  const Editor = await compile('../components/UploadScheduleEditor.vue', '')
  const Card = await compile('../components/PublishingScheduleCard.vue', 'const useApi = () => globalThis.__scheduleApi')
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(defineComponent({ render: () => h(Card as any, { slug: 'demo' }) }))
  app.component('UploadScheduleEditor', Editor)
  app.component('NuxtLink', defineComponent({ props: ['to'], setup: (p, { slots }) => () => h('a', { href: p.to }, slots.default?.()) }))
  app.mount(host)
  await flush()
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === text)!
  return { host, calls, button, text: () => host.textContent || '', unmount: () => app.unmount() }
}

describe('Publishing: one schedule, shown by its plan name', () => {
  test('Settings shows the active plan by name with its days, time and zone', async () => {
    const m = await mountScheduleCard({ channel: { channel_id: 'UC1', title: 'Night Tales' }, plan, plans: [plan], cadence: null, auto_schedule_on_render: false })
    try {
      assert.match(m.text(), /Night Tales schedule/)
      assert.match(m.text(), /Active plan/)
      assert.match(m.text(), /Tue, Thu, Sat · 19:30 · Asia\/Phnom_Penh · every week/)
      assert.match(m.text(), /same one the Upload Center shows/)
      assert.equal(m.host.querySelector('a[href="/projects/demo/upload/plans"]') !== null, true)
    } finally { m.unmount() }
  })

  test('Edit Plan edits that same plan and saves it once, to the shared schedule endpoint', async () => {
    const m = await mountScheduleCard({ channel: { channel_id: 'UC1', title: 'Night Tales' }, plan, plans: [plan], cadence: null, auto_schedule_on_render: false })
    try {
      m.button('Edit Plan').click()
      await flush()
      const name = m.host.querySelector<HTMLInputElement>('.se-name input')!
      assert.equal(name.value, 'Night Tales schedule')
      const monday = [...m.host.querySelectorAll<HTMLButtonElement>('.se-day')].find(b => b.textContent === 'Mon')!
      monday.click()
      await flush()
      m.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
      const puts = m.calls.filter(c => c.method === 'PUT')
      assert.equal(puts.length, 1)
      assert.equal(puts[0]!.path, '/projects/demo/publishing-schedule')
      assert.equal(puts[0]!.body.name, 'Night Tales schedule')
      assert.deepEqual(puts[0]!.body.schedule.weekdays, [1, 2, 4, 6])
      assert.match(m.text(), /no need to save it there/)
      assert.match(m.text(), /Mon, Tue, Thu, Sat/)
    } finally { m.unmount() }
  })

  test('before a channel is chosen the same card sets the rhythm that becomes the plan', async () => {
    const m = await mountScheduleCard({ channel: null, plan: null, plans: [], cadence: null, auto_schedule_on_render: false })
    try {
      assert.match(m.text(), /No YouTube channel is chosen/)
      m.button('Set Schedule').click()
      await flush()
      assert.equal(m.host.querySelector('.se-name'), null, 'no plan name before a plan can exist')
      m.host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await flush()
      assert.match(m.text(), /Pick at least one day/)
      assert.equal(m.calls.filter(c => c.method === 'PUT').length, 0)
    } finally { m.unmount() }
  })

  test('schedule helpers', () => {
    const d = draftFromSchedule(plan.schedule, 'X')
    const r = scheduleFromDraft(d, { requireName: true })
    assert.ok(r.ok)
    assert.deepEqual(r.ok && r.schedule.weekdays, [2, 4, 6])
    assert.equal(episodesPerMonth(plan.schedule), 13)
    assert.equal(scheduleSummary({ weekdays: [], monthly_day: 3, time_local: '08:00', timezone: 'UTC' }), 'Day 3 of each month · 08:00 · UTC')
    assert.equal(scheduleFromDraft({ ...d, timezone: 'Not/AZone' }).ok, false)
  })
})

describe('Folder pickers', () => {
  test('Library and finished-videos folders use the shared FolderField and ask before changing', () => {
    // The shared component (designSystemControls.test.ts pins its behaviour) only
    // emits the picked path; the panel binds no v-model here, so the field shows
    // the old folder until the confirm in moveLibraryTo / chooseExportsFolder
    // succeeds and the Library is re-read. Both folders live in the app-level
    // <AppFilesSettings>; the channel page keeps only its per-channel media root.
    const appFiles = read('../components/AppFilesSettings.vue')
    assert.match(appFiles, /<FolderField\s+:model-value="library\?\.path \|\| ''"[\s\S]{0,500}@change="moveLibraryTo"/)
    // An empty app-wide override preserves each channel's own Exports folder.
    assert.match(appFiles, /<FolderField\s+:model-value="library\?\.exports_custom \? library\.exports_dir : ''"[\s\S]{0,800}@change="chooseExportsFolder"/)
    assert.match(appFiles, /async function moveLibraryTo\(picked: string\) \{[\s\S]{0,200}await ask\(/)
    assert.match(appFiles, /async function chooseExportsFolder\(picked: string\) \{[\s\S]{0,300}await ask\(/)
    assert.equal(read('../components/FolderField.vue').match(/NOTE FOR MERGE/), null, 'one FolderField, not a local copy')
  })

  test('Settings has no typed path fields for folders', () => {
    const appFiles = read('../components/AppFilesSettings.vue')
    const channelSettings = read('../pages/projects/[slug]/settings.vue')
    const appFilesTemplate = appFiles.slice(0, appFiles.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
    const channelTemplate = channelSettings.slice(0, channelSettings.indexOf('<script setup')).replace(/<!--[\s\S]*?-->/g, '')
    assert.doesNotMatch(appFilesTemplate, /v-model="archiveSource" class="input"|v-model="archiveDest" class="input"/)
    assert.doesNotMatch(appFilesTemplate, /aria-label="Browse archive (source|destination) folder"/)
    // Library, finished videos, both archive folders — the media-root field is
    // per-channel and stays in the channel settings.
    assert.equal(appFilesTemplate.match(/<FolderField/g)?.length, 4, 'library, finished videos and both archive folders use FolderField')
    assert.equal(channelTemplate.match(/<FolderField/g)?.length, 1, 'the channel media root keeps its shared folder picker')
    assert.doesNotMatch(channelTemplate, /v-model="archiveSource" class="input"|v-model="archiveDest" class="input"/)
  })
})

describe('Layout fixes', () => {
  test('Appearance & notifications cannot scroll past its content', () => {
    // The hidden alert-event checkboxes were `position: absolute` with no
    // positioned ancestor, so they were placed against the page and stretched
    // the window (measured: document 1773 px tall in a 900 px window).
    // The notifications card moved into <AppNotificationSettings>; the channel
    // page keeps its positioned workspace wrapper.
    assert.match(read('../components/AppNotificationSettings.vue'), /\.notification-event-card\s*\{ position: relative; \}/)
    assert.match(read('../pages/projects/[slug]/settings.vue'), /\.settings-workspace\s*\{[^}]*position: relative;/)
  })

  test('collapsible cards draw their chevron inside the card', () => {
    // One shared CollapsibleCard (design system): the chevron is a span INSIDE
    // the summary, and the browser's own marker is switched off.
    const card = read('../components/CollapsibleCard.vue')
    assert.match(card, /<summary class="ds-collapsible-header">[\s\S]*?<span class="ds-collapsible-chevron"[\s\S]*?<\/summary>/)
    const css = read('../assets/css/design-system.css')
    assert.match(css, /\.ds-collapsible-header::-webkit-details-marker \{ display: none; \}/)
    assert.match(css, /\.ds-collapsible-header::marker \{ content: ''; \}/)
    const settings = read('../pages/projects/[slug]/settings.vue')
    assert.doesNotMatch(settings, /list-style-position: outside/)
    assert.doesNotMatch(settings, /settings-disclosure/)
    // Every other <details> in Settings uses the shared chevron or draws its own marker.
    for (const tag of settings.slice(0, settings.indexOf('<script setup')).match(/<details[^>]*>/g) || []) {
      assert.match(tag, /disclosure|notification-setup/, `${tag} shows the browser's own triangle`)
    }
  })
})
