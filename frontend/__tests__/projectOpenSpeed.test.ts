/**
 * Opening a project, the Overview and the Production Board stay fast on a
 * 400-episode channel (1.4.257).
 *
 *   - The project shell names the channel's Formula from
 *     `/projects/:slug/effective-niche` (0.1 s), not from `/niches`, which
 *     re-verified every installed Content Pack on every project open.
 *   - The shared Formula list loads once per session; `refresh()` re-reads.
 *   - Board ↻ and Overview Refresh use the paced re-read; Shift-click keeps the
 *     full rebuild. Pipeline mark-done / overrides / import re-read only the
 *     episode they changed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

let fetchCalls: string[] = []
;(globalThis as any).$fetch = async (url: string) => {
  fetchCalls.push(url)
  return { niches: [{ id: 'formula', name: 'Formula' }] }
}
const { useNiches } = await import('../composables/useNiches.js')

async function settle() {
  await nextTick()
  await new Promise<void>(resolve => setImmediate(resolve))
  await nextTick()
}

function mountNiches() {
  let captured: ReturnType<typeof useNiches> | null = null
  const app = createApp(defineComponent({ setup() { captured = useNiches(); return () => h('div') } }))
  app.mount(document.createElement('div'))
  return { app, niches: captured! }
}

describe('project open', () => {
  test('the shell reads the effective Formula, not the whole catalogue', () => {
    const layout = source('../layouts/dashboard.vue')
    assert.doesNotMatch(layout, /useNiches\(/)
    assert.match(layout, /\/projects\/\$\{projectSlug\}\/effective-niche/)
    assert.match(layout, /void loadVisualSource\(\); void loadChannelFormula\(\)/)
  })

  test('the Formula list is fetched once per session and re-read only on refresh', async () => {
    fetchCalls = []
    const first = mountNiches()
    await settle()
    const second = mountNiches()
    await settle()
    assert.equal(fetchCalls.filter(url => url.endsWith('/niches')).length, 1, 'a second mount reuses the loaded list')
    assert.equal(second.niches.niches.value[0]?.id, 'formula')
    await second.niches.refresh()
    assert.equal(fetchCalls.filter(url => url.endsWith('/niches')).length, 2, 'refresh() still re-reads')
    first.app.unmount(); second.app.unmount()
  })
})

describe('refresh buttons', () => {
  test('Board ↻ is paced; Shift-click is the full rebuild', () => {
    const board = source('../pages/projects/[slug]/board.vue')
    assert.match(board, /@click="onRefreshClick"/)
    assert.match(board, /event\.shiftKey \? refresh\(\) : revalidate\(\)/)
    assert.match(board, /v-if="isRevalidating && episodes\.length"[^>]*>Updating…</)
  })

  test('Pipeline ↻ and EpisodeSelector ↻ are paced; Shift-click is the full rebuild', () => {
    const pipeline = source('../pages/projects/[slug]/pipeline.vue')
    const pipelineClick = pipeline.slice(pipeline.indexOf('async function onRefreshClick('), pipeline.indexOf('\n}\n', pipeline.indexOf('async function onRefreshClick(')))
    assert.match(pipelineClick, /e\.shiftKey \? refreshEpisodes\(\) : revalidateEpisodes\(\)/)
    const selector = source('../components/EpisodeSelector.vue')
    assert.match(selector, /@click="onRefreshClick"/)
    const selectorClick = selector.slice(selector.indexOf('async function onRefreshClick('), selector.indexOf('\n}\n', selector.indexOf('async function onRefreshClick(')))
    assert.match(selectorClick, /e\.shiftKey \? refresh\(\) : revalidate\(\)/)
  })

  test('the scripts page deep link reads the list without rebuilding every row', () => {
    const scripts = source('../pages/projects/[slug]/scripts.vue')
    const start = scripts.indexOf('async function refetchEpisodeStatus(')
    const body = scripts.slice(start, scripts.indexOf('\n}\n', start))
    assert.match(body, /await revalidateEpisodeCache\(\)/)
    assert.doesNotMatch(scripts, /refresh: refreshEpisodeCache/)
  })

  test('Pipeline mutations re-read only the episode they changed', () => {
    const pipeline = source('../pages/projects/[slug]/pipeline.vue')
    for (const fn of ['onImported', 'onOverridesSaved', 'onMarkDone', 'bulkMarkSelected']) {
      const start = pipeline.indexOf(`function ${fn}(`)
      assert.ok(start > 0, fn)
      const body = pipeline.slice(start, pipeline.indexOf('\n}\n', start))
      assert.match(body, /revalidateAfterMutation\(/, `${fn} re-reads its row`)
      assert.doesNotMatch(body, /refreshEpisodes\(\)/, `${fn} must not rebuild every row`)
    }
  })
})
