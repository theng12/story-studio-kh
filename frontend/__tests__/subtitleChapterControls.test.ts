import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { createApp, defineComponent, h, nextTick } from 'vue'

const pagePath = fileURLToPath(new URL('../pages/projects/[slug]/subtitles.vue', import.meta.url))

async function readinessRender() {
  const { descriptor } = parse(readFileSync(pagePath, 'utf8'), { filename: pagePath })
  const template = descriptor.template!.content
  const start = template.indexOf('<!-- Status -->')
  const end = template.indexOf('<!-- Transcribe -->', start)
  assert.ok(start >= 0 && end > start, 'the actual subtitle readiness section must be present')
  // Keep the production warning branches, their wrapper, and chapter actions together.
  const compiled = compileTemplate({ source: template.slice(start, end), filename: pagePath, id: 'subtitle-chapter-controls' })
  assert.deepEqual(compiled.errors, [])
  const output = await transform(compiled.code, { loader: 'ts', format: 'esm' })
  const vueUrl = import.meta.resolve('vue')
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).render
}

const Surface = defineComponent({ setup: (_, { slots }) => () => h('section', slots.default?.()) })
const Link = defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })

test('the real subtitle chapter controls remain available before assembly for fully and partly narrated episodes', async () => {
  const render = await readinessRender()
  const chapters = [{ slug: 'Chapter_01', label: 'Chapter 1' }, { slug: 'Chapter_02', label: 'Chapter 2' }]
  for (const scenario of [
    { name: 'all chapters narrated', present: 2, hasAll: true, error: '', chapters },
    { name: 'one ready chapter', present: 1, hasAll: false, error: '', chapters: chapters.slice(0, 1) },
    { name: 'no audio, even with stale chapter rows', present: 0, hasAll: false, error: '', chapters },
    { name: 'status read failed', present: 2, hasAll: true, error: 'Status unavailable', chapters },
  ]) {
    const calls: string[] = []
    const state = {
      episodeId: 'EP0001', slug: 'subtitle-controls-fixture', loading: false, statusError: scenario.error,
      status: { has_chapter_audio: scenario.hasAll, chapter_audio_present: scenario.present, chapter_audio_expected: 2, audio_assembly_ready: false },
      sections: scenario.chapters, coverage: { done: 0, total: 2 }, coveragePct: 0,
      subtitleFreshnessUnavailable: false, subtitleTimelineComplete: false, planningSourceRevalidationRequired: false,
      subtitleTimelineIntegrity: null, missingSentenceChapters: [], audioReview: null,
      subtitleSelectionUnavailable: false, selectedSubtitleIds: [], selectedSubtitleSections: [], subtitleAttentionIds: [],
      transcribing: false, transcribeJobActive: false, canTranscribe: false, canTranscribeChapter: () => true,
      transcribeDisabledReason: 'Full episode timing needs Audio Assembly', genstudioSelectedModel: null,
      isFreeToRun: () => true, subtitleActionLabel: (_section: string, label: string) => label,
      chapterHasCurrentSrt: () => false, chapterIsStale: () => false, chapterHasSrt: () => true, chapterIsGarbled: () => false,
      audioSectionLink: (section: string) => `/projects/subtitle-controls-fixture/audio?episode_id=EP0001&section=${section}`,
      retranscribeChapter: (section: string) => calls.push(section),
      reviewChapterAudio: () => undefined, loadStatus: () => undefined, selectSubtitleAttention: () => undefined, transcribe: () => undefined,
    }
    const errors: unknown[] = []
    const app = createApp({ setup: () => state, render })
    for (const name of ['WorkspaceSection', 'WorkspaceNotice', 'LoadingSpinner', 'ChapterAudioPreview']) app.component(name, Surface)
    app.component('NuxtLink', Link)
    app.config.errorHandler = error => errors.push(error)
    const host = document.body.appendChild(document.createElement('div'))
    try {
      app.mount(host)
      await nextTick()
      assert.deepEqual(errors, [], scenario.name)
      const visible = scenario.present > 0 && !scenario.error
      assert.equal(host.querySelectorAll('.sub-chapter-row').length, visible ? scenario.chapters.length : 0, scenario.name)
      const action = host.querySelector<HTMLButtonElement>('button[aria-label="Regenerate Chapter 1 subtitles"]')
      if (visible) {
        assert.ok(action, `${scenario.name}: the real chapter action must render before assembly`)
        assert.equal(action.disabled, false, scenario.name)
        assert.ok(host.querySelector('input[aria-label="Select Chapter 1 subtitles"]'), scenario.name)
        action.click()
        assert.deepEqual(calls, ['Chapter_01'], `${scenario.name}: the compiled action targets that chapter`)
      } else assert.equal(action, null, scenario.name)
    } finally { app.unmount(); host.remove() }
  }
})
