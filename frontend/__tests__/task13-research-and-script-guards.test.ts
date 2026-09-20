import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileTemplate } from '@vue/compiler-sfc'
import { createApp, nextTick } from 'vue'
import { transform } from 'esbuild'

const researchPath = new URL('../pages/projects/[slug]/research.vue', import.meta.url)
const scriptsPath = new URL('../pages/projects/[slug]/scripts.vue', import.meta.url)

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start)
  assert.notEqual(from, -1, `missing ${start}`)
  const to = source.indexOf(end, from)
  assert.notEqual(to, -1, `missing ${end}`)
  return source.slice(from, to)
}

async function componentFromTemplate(templateSource: string, setup: string) {
  const compiled = compileTemplate({ source: templateSource, filename: 'task13-template.vue', id: 'task13-template' })
  assert.deepEqual(compiled.errors, [], 'the extracted production template block must compile')
  const vueUrl = await import.meta.resolve('vue')
  const code = `
    import { defineComponent, reactive, ref } from ${JSON.stringify(vueUrl)}
    ${compiled.code.replace('export function render', 'function render')}
    const component = defineComponent({ setup() { ${setup} } })
    component.render = render
    export default component
  `
  const output = await transform(code, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)).default
}

function mount(component: any) {
  const host = document.createElement('div')
  document.body.append(host)
  const errors: unknown[] = []
  const app = createApp(component)
  app.config.errorHandler = error => errors.push(error)
  app.mount(host)
  return { host, errors, unmount: () => { app.unmount(); host.remove() } }
}

async function researchLoadHarness(source: string) {
  const normalizer = source.includes('function normalizeResearchOutput')
    ? between(source, 'function normalizeResearchOutput', '\n\nconst result =')
    // The historical source did not have this function. The identity exists
    // only so its real loadExisting body can run and demonstrate that it left
    // malformed arrays untouched.
    : 'function normalizeResearchOutput(raw: ResearchOutput): ResearchOutput { return raw }'
  const loadExisting = between(source, 'async function loadExisting', '\n\nasync function runResearch')
  const vueUrl = await import.meta.resolve('vue')
  const code = `
    import { computed, ref } from ${JSON.stringify(vueUrl)}
    type ResearchOutput = any
    ${normalizer}
    const slug = ref('task13-project')
    const episodeId = ref('EP0001')
    const result = ref<any>(null)
    const serverResult = ref('')
    const form = ref({ topic: '', specific_questions: '', research_mode: '', source_model: '', web_model: '' })
    const resultMode = computed(() => 'model-knowledge')
    const webModeAvailable = ref(false)
    const webModels = ref<any[]>([])
    const selectedEpisode = ref<any>(null)
    const get = async () => globalThis.__task13ResearchResponse
    let researchScopeEpoch = 0
    let loadExistingSequence = 0
    ${loadExisting}
    export { loadExisting, result, serverResult }
  `
  const output = await transform(code, { loader: 'ts', format: 'esm' })
  ;(globalThis as any).__task13ResearchResponse = {
    exists: true,
    research: { topic: 'Malformed historic sidecar', specific_questions: 'Keep loading' },
  }
  return await import(`data:text/javascript;base64,${Buffer.from(output.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`)
}

test('Research metrics render a malformed saved record without a claims crash', async () => {
  const research = readFileSync(researchPath, 'utf8')
  const metrics = between(research, '<div class="workspace-metrics" aria-label="Research workspace context">', '\n      </template>')
  const Metrics = await componentFromTemplate(metrics, `
    return {
      episodeId: ref('EP0001'),
      result: ref({ topic: 'Malformed historic sidecar' }),
      researchReadinessTone: ref('warning'),
      researchReadinessLabel: ref('Needs review'),
    }
  `)
  const rendered = mount(Metrics)
  await nextTick()
  assert.equal(rendered.errors.length, 0, 'missing claims must not crash the actual workspace metrics block')
  assert.match(rendered.host.textContent || '', /0\s*claims/)
  rendered.unmount()
})

test('Research loadExisting normalizes malformed sidecar arrays before saving page state', async () => {
  const research = readFileSync(researchPath, 'utf8')
  const state: any = await researchLoadHarness(research)
  await state.loadExisting()
  assert.deepEqual(state.result.value.claims, [])
  assert.deepEqual(state.result.value.citations, [])
  assert.deepEqual(JSON.parse(state.serverResult.value).claims, [])
  assert.deepEqual(JSON.parse(state.serverResult.value).citations, [])
})

test('Scripts renders the format-context card when the live effective format is present', async () => {
  const scripts = readFileSync(scriptsPath, 'utf8')
  const contextComment = scripts.indexOf('<!-- Format context')
  assert.notEqual(contextComment, -1)
  const cardStart = scripts.indexOf('<div v-if=', contextComment)
  assert.notEqual(cardStart, -1)
  const cardEnd = scripts.indexOf('\n\n      <!-- v1.0.105+', cardStart)
  assert.notEqual(cardEnd, -1)
  const card = scripts.slice(cardStart, cardEnd)
  const Card = await componentFromTemplate(card, `
    return {
      formatContext: ref({
        name: 'Explainer', summary: 'Clear practical steps',
        chapterCountRange: [4, 6], lengthMinutesRange: [8, 12],
        defaultLengthMinutes: 10, defaultChapterCount: 5,
      }),
      chaptersOutOfRange: ref(''), lengthOutOfRange: ref(''),
      sectionLabel: { singular: 'Chapter', Plural: 'Chapters' },
      form: reactive({ chapters: 5, length: 10, words_per_chapter: 1200 }),
      recommendedWordsPerChapter: ref(1200), wordsPerMinute: ref(120),
    }
  `)
  const rendered = mount(Card)
  await nextTick()
  assert.equal(rendered.errors.length, 0)
  assert.ok(rendered.host.querySelector('.format-context-card'))
  assert.match(rendered.host.textContent || '', /Explainer/)
  assert.match(rendered.host.textContent || '', /Generation will still proceed|Typical w\/Chapter/)
  rendered.unmount()
})
