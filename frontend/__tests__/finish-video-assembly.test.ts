import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { transform } from 'esbuild'

const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')
const template = page.slice(0, page.indexOf('<script setup'))
const script = page.slice(page.indexOf('<script setup'))

function fnSource(name: string): string {
  const start = script.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `expected ${name}`)
  const open = script.indexOf('{', script.indexOf(')', start))
  let depth = 0
  for (let i = open; i < script.length; i++) {
    if (script[i] === '{') depth++
    if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1)
  }
  throw new Error(`could not extract ${name}`)
}

// Runs the real runSubtitlePreflight/generateVideo source. Gate limit: it cannot see that the
// notice renders or that the scroll lands; the template assertions below pin the wiring.
async function harness(result: any, subtitlesEnabled: boolean) {
  const start = script.indexOf('let preflightRequestSequence = 0')
  const preflight = script.slice(start, script.indexOf('\n/**', start))
  const clickStart = script.indexOf('async function generateVideo()')
  const click = script.slice(clickStart, script.indexOf('// --------------- Lifecycle', clickStart))
  const { code } = await transform(`${preflight}\n${click}`, { loader: 'ts', format: 'esm' })
  return new Function('post', 'subtitlesEnabled', `
    let videoEpisodeSequence = 0, queued = 0
    const episodeId = { value: 'EP1' }, slug = { value: 'p' }
    const preflightRunning = { value: false }, preflightConfirmed = { value: false }
    const subtitlePreflight = { value: null }, preflightCacheKey = { value: 0 }, preflightStale = { value: true }
    const currentStep = { value: 6 }, generating = { value: false }, assemblyJobActiveForEpisode = { value: false }
    const videoAssemblyGenerating = { value: false }, errors = [], infos = []
    const subtitles = { enabled: subtitlesEnabled }
    const buildVideoAssemblyPayload = () => ({})
    const showError = m => errors.push(m)
    const info = m => infos.push(m)
    const nextTick = () => Promise.resolve()
    const runGenerateVideo = async () => { queued++ }
    ${code}
    return { generateVideo, resetSubtitlePreflight, preflightConfirmed, preflightStale, currentStep, infos, get queued() { return queued } }
  `)(async () => result, subtitlesEnabled)
}

test('1: subtitles on with no subtitle file is not auto-confirmed and does not render', async () => {
  const h = await harness({ skipped: 'This episode has no subtitle file to burn, so there is nothing to check.', frames: [] }, true)
  await h.generateVideo()
  assert.equal(h.queued, 0)
  assert.equal(h.preflightConfirmed.value, false)
  assert.equal(h.currentStep.value, 5)
  assert.match(h.infos[0]!, /no subtitle file/i)
})

test('1: subtitles switched off still skips the check and renders in one click', async () => {
  const h = await harness({ skipped: 'Subtitles are switched off for this render.', frames: [] }, false)
  await h.generateVideo()
  assert.equal(h.queued, 1)
})

test('1: the notice offers Open Subtitles for this episode and Render Without Captions', () => {
  assert.match(template, /v-if="noSubtitleFile && !preflightConfirmed"/)
  assert.match(template, /subtitles\?episode_id=\$\{encodeURIComponent\(episodeId\)\}`"[^>]*>Open Subtitles/)
  assert.match(template, /@click="preflightConfirmed = true; generateVideo\(\)"[\s\S]*?Render Without Captions/)
})

test('9: bouncing from Step 6 to the caption check says why and scrolls to it', async () => {
  const h = await harness({ frames: ['frame'], subtitle_filename: 'a.srt' }, true)
  await h.generateVideo()
  assert.equal(h.currentStep.value, 5)
  assert.match(h.infos[0]!, /caption frames/i)
  assert.match(fnSource('generateVideo'), /getElementById\('caption-check'\)\?\.scrollIntoView/)
  assert.match(template, /id="caption-check"/)
})

test('3: resetSubtitlePreflight clears the stale-subtitles banner (episode change)', async () => {
  const h = await harness({ skipped: 'x', frames: [] }, false)
  assert.equal(h.preflightStale.value, true)
  h.resetSubtitlePreflight()
  assert.equal(h.preflightStale.value, false)
  assert.match(fnSource('resetSubtitlePreflight'), /preflightStale\.value = false/)
  assert.ok(script.indexOf('const preflightStale = ref(false)') < script.indexOf('function resetSubtitlePreflight'))
})

test('2: the render panel keeps the terminal status instead of saying Finished for everything', () => {
  assert.match(template, /activeJobStatus === 'error'">Render failed — \{\{ activeJobErrorLine \}\}/)
  assert.match(template, /activeJobStatus === 'cancelled'">Cancelled/)
  assert.match(template, /activeJobStatus === 'done'">Done/)
  assert.match(template, /@click="generateVideo">Try Again/)
  assert.match(script, /const activeJobStatus = computed\(/)
})

test('5: Reveal effects loads its library and plan, and the plan can be asked for', () => {
  assert.match(script, /watch\(\(\) => sceneReveal\.enabled, \(enabled\) => \{[\s\S]*?void loadRevealLibrary\(\)[\s\S]*?void loadRevealPlan\(\)/)
  assert.match(script, /watch\(\[slug, episodeId\], \(\) => \{\s*revealPlan\.value = null/)
  assert.match(template, /v-if="!revealPlan" class="mt-3">[\s\S]*?Show Planned Arrivals/)
  assert.match(template, /revealLibraryError && !revealLibrary\.length/)
})

test('6: a failed animations load shows an error with Try Again, not Loading forever', () => {
  assert.match(template, /v-if="animationsCatalogLoading"[\s\S]*?v-else-if="animationsCatalogError"[\s\S]*?@click="loadAnimationsCatalog">Try Again/)
  assert.doesNotMatch(template, /v-if="!animationsCatalog\.length"/)
  assert.doesNotMatch(fnSource('loadAnimationsCatalog'), /catch \{ \/\* non-fatal \*\/ \}/)
  assert.match(fnSource('loadAnimationsCatalog'), /animationsCatalogError\.value = /)
})

test('7: folder open/refresh failures also raise a toast', () => {
  for (const name of ['refreshBackgroundLibrary', 'openBackgroundsFolder', 'refreshOverlayLibrary', 'openOverlaysFolder']) {
    assert.match(fnSource(name), /showError\((bgLibraryError|overlayPickerError)\.value\)/, name)
  }
})

test('8: preset save/delete/rename report success only after the save finished', async () => {
  assert.doesNotMatch(template, /\.overwrite\(\); success\(/)
  assert.doesNotMatch(template, /\.remove\(\); success\(/)
  assert.doesNotMatch(template, /\.then\(\(\) => success\(/)
  assert.equal((template.match(/@overwrite="finishPreset\(/g) || []).length, 7)

  const { code } = await transform(`async ${fnSource('finishPreset')}`, { loader: 'ts', format: 'esm' })
  const make = () => {
    const log: string[] = []
    const run = new Function('success', 'info', 'showError', `${code}\nreturn finishPreset`)(
      (m: string) => log.push(`ok:${m}`), (m: string) => log.push(`info:${m}`), (m: string) => log.push(`err:${m}`),
    )
    return { run, log }
  }
  const saved = make()
  await saved.run(Promise.resolve({ id: 'p' }), 'Intro preset saved')
  assert.deepEqual(saved.log, ['ok:Intro preset saved'])
  const failed = make()
  await failed.run(Promise.reject(new Error('disk full')), 'Intro preset saved')
  assert.equal(failed.log.length, 1)
  assert.match(failed.log[0]!, /^err:Your preset was not saved\. disk full/)
  const nothing = make()
  await nothing.run(Promise.resolve(null), 'Intro preset saved')
  assert.match(nothing.log[0]!, /^info:Nothing was changed/)
})

test('10: owner-facing wording is plain English and technical text is secondary', () => {
  assert.doesNotMatch(page, /no memory tier|streams from the jobs queue|failed to persist/)
  for (const field of ['scanError', 'transitionsCatalogError', 'subtitlesStatusError', 'ffmpegStatus.check_error']) {
    assert.match(template, new RegExp(`Technical details: <code>\\{\\{ ${field.replace('.', '\\.')} \\}\\}</code>`), field)
  }
  assert.doesNotMatch(template, /We couldn't (check this episode's assets|load the transition catalogue): <code>/)
})
