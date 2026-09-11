import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { transform } from 'esbuild'

const page = readFileSync(new URL('../pages/projects/[slug]/video-assembly.vue', import.meta.url), 'utf8')

async function clickHarness(post: (...args: any[]) => Promise<any>) {
  const start = page.indexOf('let preflightRequestSequence = 0')
  const preflight = page.slice(start, page.indexOf('\n/**', start))
  const clickStart = page.indexOf('async function generateVideo()')
  const click = page.slice(clickStart, page.indexOf('// --------------- Lifecycle', clickStart))
  const { code } = await transform(preflight + '\n' + click, { loader: 'ts', format: 'esm' })
  return new Function('post', `
    let videoEpisodeSequence = 0, queued = 0
    const episodeId = { value: 'TN0165' }, slug = { value: 'project' }
    const preflightRunning = { value: false }, preflightConfirmed = { value: false }
    const subtitlePreflight = { value: null }, preflightCacheKey = { value: 0 }, preflightStale = { value: false }
    const currentStep = { value: 6 }, generating = { value: false }, assemblyJobActiveForEpisode = { value: false }
    const videoAssemblyGenerating = { value: false }, errors = []
    const buildVideoAssemblyPayload = () => ({ episode_id: episodeId.value })
    const showError = message => errors.push(message)
    const runGenerateVideo = async () => { if (!generating.value) { generating.value = true; queued++ } }
    ${code}
    return { generateVideo, preflightRunning, preflightConfirmed, currentStep, errors,
      get queued() { return queued },
      switchEpisode() { episodeId.value = 'TN0166'; videoEpisodeSequence++; resetSubtitlePreflight() }
    }
  `)(post)
}

test('one Generate click queues immediately after the caption check is skipped', async () => {
  const h = await clickHarness(async () => ({ skipped: 'Subtitles disabled', frames: [] }))
  await h.generateVideo()
  assert.equal(h.queued, 1)
  assert.equal(h.currentStep.value, 6)
})

test('repeated clicks during a slow caption check still queue exactly one render', async () => {
  let finish!: (value: any) => void
  let requests = 0
  const h = await clickHarness(() => { requests++; return new Promise(resolve => { finish = resolve }) })
  const first = h.generateVideo()
  assert.equal(h.preflightRunning.value, true)
  await h.generateVideo()
  assert.equal(requests, 1)
  finish({ skipped: 'Subtitles disabled', frames: [] })
  await first
  assert.equal(h.queued, 1)
  assert.equal(h.preflightRunning.value, false)
})

test('real caption frames still require deliberate confirmation before rendering', async () => {
  const h = await clickHarness(async () => ({ frames: ['caption-frame'] }))
  await h.generateVideo()
  assert.equal(h.queued, 0)
  assert.equal(h.currentStep.value, 5)
  h.preflightConfirmed.value = true
  await h.generateVideo()
  assert.equal(h.queued, 1)
})

test('a failed caption check reports the failure without queuing', async () => {
  const h = await clickHarness(async () => { throw new Error('Caption check unavailable') })
  await h.generateVideo()
  assert.equal(h.queued, 0)
  assert.deepEqual(h.errors, ['Caption check unavailable'])
  assert.equal(h.preflightRunning.value, false)
})

test('an old skipped check cannot queue a different episode', async () => {
  let finish!: (value: any) => void
  const h = await clickHarness(() => new Promise(resolve => { finish = resolve }))
  const first = h.generateVideo()
  h.switchEpisode()
  finish({ skipped: 'Subtitles disabled', frames: [] })
  await first
  assert.equal(h.queued, 0)
})

test('the toolbar disables Generate and announces the caption check while it waits', () => {
  const toolbar = page.slice(page.indexOf('<TopActionBar'), page.indexOf('@generate="generateVideo"'))
  const expression = (name: string) => {
    const value = toolbar.match(new RegExp(':' + name + '="([^"]+)"'))?.[1]
    assert.ok(value, `Missing ${name} binding`)
    return new Function('preflightRunning', 'generating', 'assemblyJobActiveForEpisode', `return (${value})`)(true, false, false)
  }
  assert.equal(expression('generate-loading'), true)
  assert.equal(expression('generate-loading-label'), 'Checking captions…')
  assert.equal(expression('generate-status'), 'Checking captions before rendering…')
})
