/**
 * Regression: focusing the episode dropdown must NOT force a full refresh.
 *
 * The bug: EpisodeSelector bound `@focus` to a handler that called
 * `refresh()`, and `refresh()` requests `/episodes?refresh=1`, which drops
 * the backend's whole project status cache and re-walks every episode
 * folder. On the owner's 302-episode project, simply tabbing into (or
 * clicking) the dropdown triggered a complete project rescan — the reason
 * navigation felt slow and occasionally rendered blank.
 *
 * The fix: focus uses the cached read path (`load()`), which serves the
 * cached list, quietly revalidates when it is more than a few seconds old,
 * and only blocks when nothing is cached yet. The explicit ↻ button keeps
 * its documented full-refresh behaviour.
 *
 * Both halves are asserted here: the composable's `load()` never sends
 * `?refresh=1`, and the component's focus binding actually routes to it.
 */

import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineComponent, h, nextTick, createApp } from 'vue'

type FetchHandler = (url: string) => any | Promise<any>
let fetchHandler: FetchHandler = () => []
let fetchCalls: string[] = []

;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return await fetchHandler(url)
}

const { useEpisodes, invalidateEpisodes } = await import('../composables/useEpisodes.js')

const here = path.dirname(fileURLToPath(import.meta.url))
const selectorSource = fs.readFileSync(
  path.join(here, '..', 'components', 'EpisodeSelector.vue'),
  'utf8',
)

function fakeRow(code: string) {
  return {
    episode_code: code,
    title: `T${code}`,
    status: {
      script: true, introduction: false,
      prompts: false, scene_prompts: false, thumb_prompts: false,
      images: false, thumbnails: false,
      audio: false, merged_audio: false,
      video: false, video_assembly: false,
      video_ready: false, publishable: false,
      metadata: false, all_done: false,
    },
  }
}

function mountWithComposable(slug: string) {
  let captured: ReturnType<typeof useEpisodes> | null = null
  const Comp = defineComponent({
    setup() {
      captured = useEpisodes(slug, { invalidateOnJobTypes: [] })
      return () => h('div')
    },
  })
  const app = createApp(Comp)
  app.mount(document.createElement('div'))
  return { app, captured: captured! }
}

async function settle() {
  await nextTick()
  await new Promise(r => setTimeout(r, 0))
  await nextTick()
}

describe('episode dropdown focus does not force a project-wide refresh', () => {
  beforeEach(() => {
    fetchCalls = []
    fetchHandler = () => [fakeRow('EP001')]
    invalidateEpisodes('focus-proj')
  })

  test('load() — the focus path — never requests ?refresh=1', async () => {
    const { captured, app } = mountWithComposable('focus-proj')
    await settle()
    assert.equal(fetchCalls.length, 1, 'mount fetched once')

    // Simulate the user tabbing in and out of the dropdown repeatedly.
    for (let i = 0; i < 5; i++) {
      await captured.load()
      await settle()
    }

    assert.deepEqual(
      fetchCalls.filter(u => u.includes('refresh=1')),
      [],
      'focus must never send ?refresh=1 — that invalidates the whole project cache',
    )
    assert.equal(
      fetchCalls.length, 1,
      'focus on a hot cache must issue no request at all',
    )
    app.unmount()
  })

  test('the explicit refresh button keeps its full-refresh behaviour', async () => {
    const { captured, app } = mountWithComposable('focus-proj')
    await settle()
    await captured.refresh()
    await settle()

    assert.ok(
      fetchCalls.some(u => u.includes('refresh=1')),
      'refresh() must still force the documented full recompute',
    )
    app.unmount()
  })

  test('EpisodeSelector binds @focus to the cached loader, not refresh()', () => {
    assert.match(
      selectorSource,
      /@focus="loadEpisodes"/,
      'the dropdown still binds focus to loadEpisodes',
    )
    const body = selectorSource.match(/async function loadEpisodes\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/)
    assert.ok(body, 'loadEpisodes is defined in EpisodeSelector.vue')
    assert.match(body![1], /\bload\(\)/, 'focus handler calls the cached load()')
    assert.doesNotMatch(
      body![1],
      /\b(refresh|rescan)\(\)/,
      'focus handler must not call refresh()/rescan() — that is a full project rescan',
    )
  })
})
