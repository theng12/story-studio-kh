/**
 * The ASSEMBLED prompt length on the Thumbnail Generator page.
 *
 * The saved prompt is not the prompt the model receives. The render appends
 * the render-time extras, the reference guidance and the style keywords, and
 * then refuses the result when it is over the model's published limit — so
 * the number that decides the render is the assembled length, and it has to
 * be visible where the customer chooses the extras and the reference.
 *
 * The count is MEASURED by the backend with the render's own assembly and
 * read by the page. The page must never re-derive it: the reference guidance
 * depends on the reference file existing on disk, and the style keywords
 * depend on the episode's cast and on the renderer's name matching. A second
 * copy of that assembly in the frontend would be a second answer (AGENTS §1).
 *
 * The file has two halves. The first reads the page's source — the contracts
 * that a runtime check cannot see (no duplicated assembly, no fallback
 * ceiling, no length derived in the page). The second MOUNTS the page's
 * setup with stubs and drives it: a reply measured for another project must
 * never land, a malformed answer must read as unknown rather than as zero
 * characters, and only the thumbnails a render would actually submit may hold
 * the batch up.
 *
 * The runtime half CONTROLS TIME instead of waiting for it: the page debounces
 * its measurement by 250ms, so the test fakes the clock and advances it, and
 * every promise is drained in order. A sleep here would assert that this
 * machine schedules the test promptly rather than that the page is correct
 * (the `no-new-wallclock-sleeps` guard). Each page instance lives in its own
 * effect scope, and the test stops that scope, so a watcher left running
 * cannot react to the next test's state.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { compileScript, parse } from '@vue/compiler-sfc'
import { effectScope, nextTick, reactive, ref } from 'vue'
import { transform } from 'esbuild'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

const images = source('../pages/projects/[slug]/images.vue')

// ── The page's source contracts ──────────────────────────────────────────

describe('the published limit is the one on screen, and it is live', () => {
  test('the cap comes from the live catalogue, never from a number kept here', () => {
    assert.match(images, /max_prompt_characters/)
    assert.match(images, /const publishedCap = computed<number \| null>/)
    // A model that publishes no cap has NO limit — and this page never
    // substitutes one of its own.
    assert.match(images, /activeModelCap\.value > 0 \? activeModelCap\.value : null/)
    assert.doesNotMatch(images, /max_prompt_characters\s*[:=]\s*\d/)
    assert.doesNotMatch(images, /(DEFAULT|FALLBACK|BACKUP|RESERVED)_(CAP|LIMIT|CEILING)/i)
  })

  test('the published figure is exact — no approximation marker', () => {
    assert.doesNotMatch(images, /Prompt cap: <strong>~/)
    assert.match(images, /Prompt cap: <strong>\{\{ activeModelCap\.toLocaleString\(\) \}\} chars<\/strong>/)
    // The limit it enforces is spelled out where the choice is made.
    assert.match(images, /accepts up to\s*\n?\s*<strong>\{\{ publishedCap\.toLocaleString\(\) \}\} characters<\/strong> per prompt\./)
  })

  test('a model that publishes no limit says so, without overclaiming', () => {
    // "No published limit" is not "the provider never refuses a length" —
    // the page can only say that it cannot check the length in advance.
    assert.match(images, /No prompt limit is published for/)
    assert.match(images, /Story Studio cannot check the length in advance\./)
    assert.doesNotMatch(images, /so no length is refused/)
  })
})

describe('the length is measured by the renderer, never re-derived here', () => {
  test('the page asks the backend for the assembled length', () => {
    assert.match(images, /thumbnail-prompt-lengths/)
    // No copy of the assembly lives on this page.
    for (const helper of [
      'assembleThumbnailRenderPrompt',
      'styleKeywordClause',
      'thumbnailReferenceGuidance',
      'savedThumbnailReferenceGuidanceFor',
      'matchedStyleKeywords',
      'measureAssemblyOverhead',
    ]) {
      assert.doesNotMatch(images, new RegExp(helper), `the page must not re-implement ${helper}`)
    }
  })

  test('the measurement request carries the fields the render request carries', () => {
    // The request semantics of the render: the same extras, the same
    // reference, the same image mode — so the measurement is the render's own
    // assembly and not a parallel one.
    assert.match(images, /extra_details: extraDetails\.value\.trim\(\),/)
    assert.match(images, /thumbnail_reference_asset: thumbnailReferenceActive\.value/)
    assert.match(images, /image_mode: thumbnailReferenceActive\.value \? 'img2img' : 'text2img',/)
    assert.match(images, /episode_title: selectedEpisode\.value\?\.title \|\| '',/)
    assert.match(images, /model: activeForm\.value\.model,/)
  })

  test('the count is shown next to the limit, per thumbnail', () => {
    assert.match(images, /v-for="row in assembledLengthRows"/)
    assert.match(images, /\{\{ row\.characters\.toLocaleString\(\) \}\}/)
    assert.match(images, /\{\{ \(row\.characters - \(publishedCap \|\| 0\)\)\.toLocaleString\(\) \}\} over the limit/)
  })

  test('a measurement that could not be taken says so — never a guess', () => {
    assert.match(images, /The length is not shown\./)
    assert.match(images, /The assembled prompt length could not be measured\./)
  })

  test('a page with no model selected measures nothing, and says so', () => {
    // The measurement takes the model the render would use, so a page with
    // no model has nothing to measure — it says that instead of asking the
    // server for a reading it cannot produce.
    assert.match(images, /const canMeasureAssembled = computed\(\(\) => !!activeForm\.value\.model\)/)
    assert.match(images, /if \(!form\.episode_id \|\| !activeForm\.value\.model\)/)
    assert.match(images, /Choose an image model to measure the assembled prompts\./)
  })
})

describe('it is recomputed on every live change', () => {
  test('the measurement follows the project, the episode, the model, the extras, the reference and the prompt set', () => {
    assert.match(images, /watch\(assembledLengthsInputs, \(signature\) => \{/)
    assert.match(images, /project: slug\.value,/)
    assert.match(images, /episode: form\.episode_id,/)
    assert.match(images, /title: selectedEpisode\.value\?\.title \|\| '',/)
    assert.match(images, /model: activeForm\.value\.model,/)
    assert.match(images, /extras: extraDetails\.value\.trim\(\),/)
    // The WHOLE reference payload, not its id: the same id can come back with
    // a different file or a different reframing prompt.
    assert.match(images, /reference: thumbnailReferenceActive\.value/)
    assert.doesNotMatch(images, /thumbnail_reference_asset\?\.id \|\| ''/)
    assert.match(images, /imageMode: thumbnailReferenceActive\.value \? 'img2img' : 'text2img',/)
    assert.match(images, /prompts: igPanelRefreshKey\.value,/)
  })

  test('the extras the customer types are what travels into the measurement', () => {
    assert.match(images, /extra_details: extraDetails\.value\.trim\(\),/)
    // One request per settled state — the extras box is typed into.
    assert.match(images, /setTimeout\(\(\) => \{ void loadAssembledLengths\(signature\) \}, 250\)/)
  })

  test('a change drops the reading on screen and cancels the reply in flight', () => {
    assert.match(images, /assembledLengthsRequest\+\+/)
    assert.match(images, /assembledLengthsSignature\.value = ''\n  assembledLengths\.value = null/)
    // A reply measured for the old inputs never lands on screen.
    assert.match(images, /if \(request !== assembledLengthsRequest\) return/)
    // The pending timer dies with the page, and so does the reply.
    assert.match(images, /onBeforeUnmount\(\(\) => \{\n  if \(assembledLengthsTimer\) clearTimeout\(assembledLengthsTimer\)\n  \/\/ A reply that lands after the page is gone must not touch anything\.\n  assembledLengthsRequest\+\+/)
  })

  test('a reading that is not current cannot refuse a render', () => {
    assert.match(images, /const assembledLengthsFresh = computed/)
    assert.match(images, /if \(!assembledLengthsFresh\.value\) return \[\]/)
  })
})

describe('an over-limit prompt is refused before anything is queued', () => {
  test('the refusal happens before the render is posted', () => {
    const queue = images.slice(images.indexOf('async function queueGeneration'), images.indexOf('async function submit'))
    const refusal = queue.indexOf('showError(overCapRefusalText(overCap))')
    const post = queue.search(/await post(?:<[^>]+>)?\(`\/projects\/\$\{slug\.value\}\/generate\/images`, params\)/)
    assert.ok(refusal > 0, 'the page refuses an over-limit prompt')
    assert.ok(post > 0, 'the page posts the render')
    assert.ok(refusal < post, 'the refusal comes before the render is queued')
  })

  test('the refusal says which model, which limit and by how much', () => {
    assert.match(images, /accepts up to \$\{cap\.toLocaleString\(\)\} characters per prompt\./)
    assert.match(images, /\$\{\(row\.characters - cap\)\.toLocaleString\(\)\} over/)
    assert.match(images, /no credits are spent on a refused prompt\./)
  })

  test('an unknown or unpublished limit never refuses anything', () => {
    // No published cap: nothing is over anything.
    assert.match(images, /if \(!publishedCap\.value\) return \[\]/)
    // A stale, unmatched or unmeasured reading is not evidence.
    assert.match(images, /if \(!assembledLengthsFresh\.value\) return \[\]/)
    assert.match(images, /if \(!assembledLengthsMatchBoard\.value\) return \[\]/)
    assert.match(images, /const submitted = submittedThumbnailNumbers\(force\)\n  if \(!submitted\) return \[\]/)
  })

  test('only the prompts this render would actually submit can hold it up', () => {
    // "Skip existing" keeps the thumbnails already on disk, so an over-limit
    // prompt on a rendered thumbnail must not block the missing ones.
    assert.match(images, /const missing = activePoolStatus\.value\?\.missing/)
    assert.match(images, /if \(force\) return new Set\(rows\.map\(row => row\.number\)\)/)
    assert.match(images, /return overCapRows\.value\.filter\(row => submitted\.has\(row\.number\)\)/)
  })

  test('a single row keeps the renderer’s own refusal', () => {
    // The board's row buttons call prepare(), and the panel adds the row
    // number only afterwards — so the page cannot know which row is being
    // rendered and must not refuse a healthy row because another is over.
    const prepare = images.slice(
      images.indexOf('async function prepareGeneration'),
      images.indexOf('async function queueGeneration'),
    )
    assert.ok(prepare.length > 0, 'prepareGeneration exists')
    assert.doesNotMatch(prepare, /overCapToSubmit/, 'a row render is not blocked by another thumbnail')
  })
})

// ── The page's behaviour, driven with stubs ─────────────────────────────

/**
 * The page's setup, compiled and mounted against stubs.
 *
 * The stubs answer every read the page makes. The disk scan never settles on
 * purpose: it is what bumps the prompt-file revision, and a revision that
 * moves on its own would make every measurement race the reply that
 * measures it.
 */
const support = `
  import { computed, defineComponent as _defineComponent, reactive, ref, watch, onMounted, onBeforeUnmount } from VUE_URL
  const definePageMeta = () => undefined
  const useRoute = () => ({ params: globalThis.__tlRoute, query: {} })
  const useRouter = () => ({ replace: async () => undefined })
  const useApi = () => ({ get: globalThis.__tlGet, post: globalThis.__tlPost, put: async () => ({}) })
  const useFreshGenerationAction = () => ({ begin: () => 'operation-1', complete: () => undefined })
  const useProject = () => ({ config: globalThis.__tlConfig, refreshConfig: async () => undefined })
  const useGenStudioImageModels = () => ({ models: globalThis.__tlModels, refresh: async () => undefined })
  const useToast = () => ({ success: () => undefined, error: (m) => { globalThis.__tlErrors.push(String(m)) }, info: () => undefined })
  const useGenerating = () => ({ imageGenerating: ref(false), thumbImageGenerating: ref(false) })
  const useConfirmation = () => ({ confirmGeneration: async () => true })
  const useJobs = () => ({ isJobActiveFor: () => false, jobs: ref([]) })
  const useAppTitle = () => undefined
  const useRememberedForm = () => undefined
  const useEpisodeStatus = () => ({ selectedEpisode: globalThis.__tlEpisode })
  const usePresets = () => ({ load: async () => undefined, activeId: ref('') })
  const useConfirm = () => ({ ask: async () => true })
  const isPublishedAspectRatio = () => true
  const storyDefaultAspectRatio = () => '16:9'
  const findOutputOption = () => null
  const outputOptionsForRatio = () => []
  const describeImageUnitCost = () => ({ basis: 'per-image', text: '1 credit', title: '' })
  const CREDIT_BASIS_LABEL = { 'per-image': 'Cost per image' }
  const customerSafeJobText = (t) => String(t || '')
  const jobRequestIds = () => []
`

interface Harness {
  state: any
  route: { slug: string }
  models: any
  pending: Array<(value: any) => void>
  calls: { path: string; body: any }[]
  errors: string[]
  /** Stop the page's watchers. A watcher left running would react to the
   *  NEXT test's state. */
  stop: () => void
}

const MODEL_WITH_CAP = { id: 'model-one', display_name: 'Model One', max_prompt_characters: 4_000 }

let componentPromise: Promise<any> | null = null

async function loadComponent(): Promise<any> {
  if (!componentPromise) {
    componentPromise = (async () => {
      const pagePath = new URL('../pages/projects/[slug]/images.vue', import.meta.url)
      const { descriptor } = parse(readFileSync(pagePath, 'utf8'), { filename: pagePath.pathname })
      const script = compileScript(descriptor, { id: 'thumb-render-length-harness' })
      const vueUrl = await import.meta.resolve('vue')
      const stripped = script.content.replace(/^import[\s\S]*?from ['"][^'"]+['"]\n/gm, '')
      const code = `${support.replace('VUE_URL', JSON.stringify(vueUrl))}\n`
        + `${stripped.replace('export default', 'const __sfc__ =')}\nexport default __sfc__`
      const out = await transform(code, { loader: 'ts', format: 'esm' })
      const url = `data:text/javascript;base64,${Buffer.from(out.code.replaceAll('"vue"', JSON.stringify(vueUrl))).toString('base64')}`
      return (await import(url)).default
    })()
  }
  return componentPromise
}

async function setup(options: { slug?: string } = {}): Promise<Harness> {
  const pending: Array<(value: any) => void> = []
  const calls: { path: string; body: any }[] = []
  const errors: string[] = []
  const route = reactive({ slug: options.slug ?? 'project-one' })
  const models = ref([MODEL_WITH_CAP])
  const config = ref({ thumbnail_reference_asset: null })
  ;(globalThis as any).__tlRoute = route
  ;(globalThis as any).__tlModels = models
  ;(globalThis as any).__tlConfig = config
  ;(globalThis as any).__tlEpisode = ref(null)
  ;(globalThis as any).__tlErrors = errors
  ;(globalThis as any).__tlGet = async (path: string) => {
    if (path.includes('/video-editor/scan/')) return new Promise(() => {})
    if (path.includes('/image-status')) {
      return { thumbnails: { total: 2, present: 1, missing: [2] } }
    }
    if (path.includes('/images-repair-status')) {
      return { scene: { missing_items: [] }, thumb: { missing_items: [] } }
    }
    return {}
  }
  ;(globalThis as any).__tlPost = async (path: string, body?: any) => {
    calls.push({ path, body })
    if (path.includes('/thumbnail-prompt-lengths')) {
      return await new Promise((resolve) => { pending.push(resolve) })
    }
    return { job_id: 'job-1' }
  }
  const Component = await loadComponent()
  // The page's watchers belong to a scope of their own, so a test can stop
  // them. A watcher left running would react to the NEXT test's state.
  const scope = effectScope()
  const state: any = scope.run(() => Component.setup({}, { expose: () => undefined }))
  // The episode and the model are the customer's choices; the page measures
  // against them, so they are set before the first measurement goes out.
  state.form.episode_id = 'EP0001'
  state.form.thumbnail.model = 'model-one'
  await nextTick()
  return { state, route, models, pending, calls, errors, stop: () => scope.stop() }
}

/**
 * Let every pending promise settle — no wall clock involved.
 *
 * The page's reads are promises, not timers: the integrity read and the
 * measurement reply both land on microtasks. Draining them in order is
 * deterministic, where a sleep would only bet on how quickly this machine
 * schedules the test.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

/**
 * The page debounces its measurement by 250ms, so a test that wants the
 * request has to advance that clock. The clock is FAKED
 * (`t.mock.timers.enable()`), so this is the page's own debounce firing, not
 * a wait for wall time.
 */
const MEASUREMENT_DEBOUNCE_MS = 250

describe('the measurement is bound to the inputs it was measured for', () => {
  test('a reply measured for another project never lands on this one', async (t) => {
    // The clock is faked: the page's debounce is advanced, never waited out.
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = await setup({ slug: 'project-one' })
    try {
      t.mock.timers.tick(MEASUREMENT_DEBOUNCE_MS)
      await flush()
      assert.equal(h.pending.length, 1, 'the page asked for one measurement')
      const firstRequest = h.pending[0]!

      // The customer switches project: every input to the measurement changes.
      h.route.slug = 'project-two'
      await nextTick()

      firstRequest({ thumbnails: [{ number: 1, characters: 1_234 }] })
      await flush()

      assert.equal(h.state.assembledLengths.value, null, 'the reply for the previous project was dropped')
      assert.equal(h.state.assembledLengthsSignature.value, '', 'it carries no signature either')
    } finally {
      h.stop()
      t.mock.timers.reset()
    }
  })

  test('a malformed answer reads as unknown — never as zero-length prompts', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = await setup({ slug: 'project-one' })
    try {
      t.mock.timers.tick(MEASUREMENT_DEBOUNCE_MS)
      await flush()
      assert.equal(h.pending.length, 1, 'the page asked for one measurement')

      h.pending[h.pending.length - 1]!({ thumbnails: [{ number: 1, characters: 'lots' }] })
      await flush()

      assert.equal(h.state.assembledLengths.value, null, 'a malformed row is not a measurement')
      assert.match(h.state.assembledLengthsError.value, /cannot read|not be measured/)
    } finally {
      h.stop()
      t.mock.timers.reset()
    }
  })
})

describe('only the prompts a render would actually submit can hold it up', () => {
  test('a kept thumbnail does not hold up the missing ones', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = await setup({ slug: 'project-one' })
    try {
      t.mock.timers.tick(MEASUREMENT_DEBOUNCE_MS)
      await flush()
      assert.equal(h.pending.length, 1, 'the page asked for one measurement')

      h.pending[h.pending.length - 1]!({
        thumbnails: [
          { number: 1, characters: 5_000 },
          { number: 2, characters: 6_000 },
        ],
      })
      await flush()

      assert.equal(h.state.assembledLengthsFresh.value, true, 'the reading is current')
      assert.deepEqual(h.state.imageStatus.thumbnails.missing, [2], 'the board reports thumbnail 2 as missing')

      // "Skip existing" keeps thumbnail 1, which is already on disk.
      assert.deepEqual(
        h.state.overCapToSubmit(false).map((r: any) => r.number),
        [2],
        'only the prompt that will actually be submitted can hold the batch up',
      )
      // "Regenerate" submits every prompt.
      assert.deepEqual(
        h.state.overCapToSubmit(true).map((r: any) => r.number),
        [1, 2],
        'Regenerate submits every prompt, so every over-limit prompt counts',
      )
    } finally {
      h.stop()
      t.mock.timers.reset()
    }
  })
})
