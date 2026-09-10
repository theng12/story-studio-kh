import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'
import { nextTick, ref, watch } from 'vue'

function source(path: string): string {
  return readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
}

function extractFunction(text: string, name: string): string {
  const functionStart = text.indexOf(`function ${name}(`)
  assert.ok(functionStart >= 0, `${name}() must exist`)
  const start = text.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart
  let depth = 0
  let body = false
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') { depth++; body = true }
    if (text[i] === '}') {
      depth--
      if (body && depth === 0) return text.slice(start, i + 1)
    }
  }
  throw new Error(`could not extract ${name}`)
}

function compiled(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
}

const presets = source('../pages/projects/[slug]/presets.vue')
const remote = source('../pages/remote.vue')
const settings = source('../pages/projects/[slug]/settings.vue')
const contextualCues = source('../pages/projects/[slug]/contextual-cues.vue')
const soundDesign = source('../pages/projects/[slug]/sound-design.vue')

test('Preset group saves serialize overlapping mutations', async () => {
  const runtime = new Function(compiled(`
    const savingGroups = { value: new Set() }
    let persistCalls = 0
    let releasePersist
    const persist = async () => {
      persistCalls++
      await new Promise(resolve => { releasePersist = resolve })
    }
    ${extractFunction(presets, 'isGroupSaving')}
    ${extractFunction(presets, 'setGroupSaving')}
    ${extractFunction(presets, 'saveGroup')}
    return {
      saveGroup,
      isGroupSaving,
      persistCalls: () => persistCalls,
      releasePersist: () => releasePersist(),
    }
  `))() as {
    saveGroup(group: string, list: unknown[]): Promise<boolean>
    isGroupSaving(group: string): boolean
    persistCalls(): number
    releasePersist(): void
  }

  const first = runtime.saveGroup('audio', [])
  assert.equal(runtime.isGroupSaving('audio'), true)
  assert.equal(await runtime.saveGroup('audio', []), false)
  assert.equal(runtime.persistCalls(), 1)
  runtime.releasePersist()
  assert.equal(await first, true)
  assert.equal(runtime.isGroupSaving('audio'), false)
})

test('Remote ignores an older load after switching away and back', async () => {
  let resolveFormat: ((value: unknown) => void) | undefined
  const runtime = new Function(compiled(`
    const selectedSlug = { value: 'alpha' }
    let projectLoadEpoch = 1
    const visualSource = { value: 'narrated-scenes' }
    const episodeCodes = { value: [] }
    const pendingApprovals = { value: [] }
    const runError = { value: '' }
    const get = async () => new Promise(resolve => { resolveFormat = resolve })
    const normalizeVisualSource = value => value || 'narrated-scenes'
    ${extractFunction(remote, 'isCurrentProjectLoad')}
    ${extractFunction(remote, 'loadApprovals')}
    ${extractFunction(remote, 'loadProject')}
    return {
      loadProject,
      switchTo: (slug, epoch) => { selectedSlug.value = slug; projectLoadEpoch = epoch },
      visualSource,
    }
  `))() as {
    loadProject(slug: string, epoch: number): Promise<void>
    switchTo(slug: string, epoch: number): void
    visualSource: { value: string }
  }

  const oldLoad = runtime.loadProject('alpha', 1)
  runtime.switchTo('beta', 2)
  runtime.switchTo('alpha', 3)
  resolveFormat?.({ visualSource: 'timestamp-driven' })
  await oldLoad

  assert.equal(runtime.visualSource.value, 'narrated-scenes')
})

test('Art-style selection is route-aware and disabled while its captured project save is pending', () => {
  assert.match(settings, /const artStyleSaving = ref\(false\)/)
  assert.match(settings, /<select v-model="artStyleSelection" class="input" :disabled="artStyleSaving">/)
  assert.match(settings, /const targetSlug = slug\.value/)
  assert.match(settings, /await put\(`\/projects\/\$\{targetSlug\}\/settings\/config`, payload\)/)
  assert.match(settings, /if \(artStyleSaving\.value\) return/)
  assert.match(settings, /if \(slug\.value !== targetSlug \|\| artStyleRouteEpoch !== routeEpoch\) return/)
  assert.match(settings, /const persistedStyleId = \(c as any\)\.active_style_preset_id \|\| ''/)
  assert.match(settings, /if \(artStyleSelection\.value !== persistedStyleId\) \{\s*artStyleRollback = true/)
  assert.match(settings, /watch\(slug, \(\) => \{\s*artStyleRouteEpoch\+\+\s*artStyleSaveMessage\.value = ''\s*if \(artStyleSelection\.value\) \{/)
})

test('initial art-style hydration consumes suppression before the first user choice', async () => {
  assert.ok(
    settings.indexOf('watch(artStyleSelection') < settings.lastIndexOf('watch(config', settings.indexOf('const persistedStyleId =')),
    'the save watcher must exist before immediate config hydration',
  )

  const config = ref<{ active_style_preset_id: string }>({ active_style_preset_id: 'saved-style' })
  const selection = ref('')
  const saves: string[] = []
  let initialized = false
  let rollback = false

  watch(selection, (next) => {
    if (rollback) {
      rollback = false
      return
    }
    if (!initialized) return
    saves.push(next)
  })
  watch(config, (value) => {
    const persistedStyleId = value.active_style_preset_id || ''
    if (selection.value !== persistedStyleId) {
      rollback = true
      selection.value = persistedStyleId
    }
    initialized = true
  }, { immediate: true })

  await nextTick()
  assert.equal(selection.value, 'saved-style')
  assert.deepEqual(saves, [])

  selection.value = 'user-style'
  await nextTick()
  assert.deepEqual(saves, ['user-style'])
})

test('Contextual Cues preserves the captured project and episode for late loads and saves', () => {
  assert.match(contextualCues, /const timelineProjectSlug = ref\(''\)/)
  assert.match(contextualCues, /watch\(\[slug, episodeId\], \(\) => \{ cueScopeEpoch\+\+[^}]*\}, \{ flush: 'sync' \}\)/)
  assert.match(contextualCues, /const projectSlug = timelineProjectSlug\.value\s*\n  const episode = timelineEpisodeId\.value/)
  assert.match(contextualCues, /await put<any>\(`\/projects\/\$\{projectSlug\}\/contextual-cues\/\$\{episode\}`, \{ cues \}\)/)
  assert.match(contextualCues, /request !== timelineLoadSequence \|\| !isCurrentCueScope\(projectSlug, episode, scopeEpoch\)/)
  assert.match(contextualCues, /const stillOwnsTimeline = timelineProjectSlug\.value === projectSlug && timelineEpisodeId\.value === episode/)
  assert.match(contextualCues, /await saveNow\(\)\s*\n  if \(!isCurrentCueScope\(projectSlug, episode, scopeEpoch\)\) return\s*\n  if \(dirty\.value \|\| saveError\.value\)/)
})

test('Sound Design preserves the captured project and episode for late loads and saves', () => {
  assert.match(soundDesign, /const timelineProjectSlug = ref\(''\)/)
  assert.match(soundDesign, /watch\(\[slug, episodeId\], \(\) => \{ soundScopeEpoch\+\+[^}]*\}, \{ flush: 'sync' \}\)/)
  assert.match(soundDesign, /get<any>\(`\/projects\/\$\{projectSlug\}\/sound-design\/\$\{episode\}`\)/)
  assert.match(soundDesign, /await put<any>\(`\/projects\/\$\{projectSlug\}\/sound-design\/\$\{episode\}`, \{ cues, settings: timelineSettings \}\)/)
  assert.match(soundDesign, /request !== soundLoadSequence \|\| !isCurrentSoundScope\(projectSlug, episode, scopeEpoch\)/)
  assert.match(soundDesign, /if \(!stillOwnsTimeline \|\| soundEditSeq !== sentAt\) return/)
  assert.match(soundDesign, /await saveTimeline\(false\)\s*\n  if \(!isCurrentSoundScope\(projectSlug, episode, scopeEpoch\)\) return\s*\n  if \(dirty\.value\)/)
})

test('Sound Design serializes an original-target flush and keeps edits made during the first save', async () => {
  const pending: Array<(value: unknown) => void> = []
  const writes: Array<{ url: string; body: any }> = []
  const runtime = new Function('pending', 'writes', compiled(`
    const slug = { value: 'alpha' }
    const episodeId = { value: 'episode-a' }
    const timelineProjectSlug = { value: 'alpha' }
    const timelineEpisodeId = { value: 'episode-a' }
    const timeline = { value: { cues: [{ id: 'cue-1', label: 'first' }] } }
    const settings = { value: { density: 'minimal' } }
    const validation = { value: [] }
    const dirty = { value: true }
    const saving = { value: false }
    let soundScopeEpoch = 1
    let soundEditSeq = 1
    let soundSaveTail = Promise.resolve()
    const success = () => {}
    const error = () => {}
    const put = (url, body) => new Promise(resolve => { writes.push({ url, body }); pending.push(resolve) })
    ${extractFunction(soundDesign, 'isCurrentSoundScope')}
    ${extractFunction(soundDesign, 'writeTimeline')}
    ${extractFunction(soundDesign, 'saveTimeline')}
    return {
      saveTimeline,
      edit: label => { timeline.value.cues[0].label = label; dirty.value = true; soundEditSeq++ },
      writes: () => writes,
      resolve: (index, value) => pending[index](value),
      dirty,
      timeline,
    }
  `))(pending, writes) as {
    saveTimeline(announce?: boolean): Promise<void>
    edit(label: string): void
    writes(): Array<{ url: string; body: any }>
    resolve(index: number, value: unknown): void
    dirty: { value: boolean }
    timeline: { value: { cues: Array<{ label: string }> } }
  }

  const first = runtime.saveTimeline(false)
  await Promise.resolve()
  runtime.edit('latest')
  const second = runtime.saveTimeline(false)
  runtime.resolve(0, { timeline: { cues: [{ label: 'server-first' }] }, validation: [] })
  await first
  await Promise.resolve()

  assert.equal(runtime.writes()[0]?.url, '/projects/alpha/sound-design/episode-a')
  assert.equal(runtime.writes()[1]?.body.cues[0]?.label, 'latest')
  runtime.resolve(1, { timeline: { cues: [{ label: 'server-latest' }] }, validation: [] })
  await Promise.all([first, second])

  assert.equal(runtime.dirty.value, false)
  assert.equal(runtime.timeline.value.cues[0]?.label, 'server-latest')
})
