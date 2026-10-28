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
// v1.4.365 — both halves are one page now. The race guards below are the same
// guards, over `sound-and-labels.vue`.
const soundAndLabels = source('../pages/projects/[slug]/sound-and-labels.vue')

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

test('Sound & Labels preserves the captured project and episode for late loads and saves', () => {
  // Every load and save captures the project and episode it STARTED on, and
  // compares that captured pair when it finishes. Without it, a selection that
  // moved mid-flight writes one episode's cues into another (AGENTS.md §4).
  assert.match(soundAndLabels, /const project = slug\.value\s*\n\s*const episode = episodeId\.value/)
  assert.match(soundAndLabels, /watch\(\[slug, episodeId\], \(\) => \{ scopeEpoch\+\+[^}]*\}, \{ flush: 'sync' \}\)/)
  assert.match(soundAndLabels, /function isCurrentScope\(project: string, episode: string, epoch: number\): boolean/)
  assert.match(soundAndLabels, /await put<any>\(`\/projects\/\$\{project\}\/sound-and-labels\/\$\{episode\}\/labels`, \{ cues: labelPayload \}\)/)
  assert.match(soundAndLabels, /await put<any>\(`\/projects\/\$\{project\}\/sound-and-labels\/\$\{episode\}\/sounds`, \{ cues: soundPayload, settings: mixSettings \}\)/)
  assert.match(soundAndLabels, /request !== loadSequence \|\| !isCurrentScope\(project, episode, epoch\)/)
  assert.match(soundAndLabels, /await saveNow\(false\)\s*\n\s*if \(!isCurrentScope\(project, episode, epoch\)\) return/)
})

test('an episode change replaces the page state before filling it from the new one', () => {
  // AGENTS.md §4 — the owner's most expensive defect class. A field that is
  // only overwritten "if the new value exists" leaves the previous episode's
  // value standing. Everything is blanked FIRST, then filled.
  const load = soundAndLabels.slice(soundAndLabels.indexOf('async function loadEpisode'))
  const body = load.slice(0, load.indexOf('\n}\n'))
  const blanks = body.indexOf("labels.value = null; sounds.value = null")
  const fills = body.indexOf('labels.value = data.labels')
  assert.ok(blanks > 0 && fills > blanks, 'the blank must come before the fill')
  // The mix settings belong to the loaded timeline, not to a remembered form:
  // remembering them is exactly how one episode's reverb reached another.
  assert.doesNotMatch(soundAndLabels, /useRememberedForm\('sound-and-labels', slug, settings/)
  assert.match(soundAndLabels, /if \(sounds\.value\?\.settings\) settings\.value = \{ \.\.\.sounds\.value\.settings \}/)
})

test('a save serializes on one tail and keeps edits made during the first write', async () => {
  const pending: Array<(value: unknown) => void> = []
  const writes: Array<{ url: string; body: any }> = []
  const runtime = new Function('pending', 'writes', compiled(`
    const slug = { value: 'alpha' }
    const episodeId = { value: 'episode-a' }
    const labels = { value: { cues: [{ id: 'cue-1', title: 'first' }] } }
    const sounds = { value: null }
    const settings = { value: { max_spots_per_minute: 3 } }
    const validation = { value: { labels: [], sound: [] } }
    const dirty = { value: true }
    const saving = { value: false }
    const savedAt = { value: '' }
    const saveError = { value: '' }
    let scopeEpoch = 1
    let editSeq = 1
    let saveTail = Promise.resolve()
    const success = () => {}
    const put = (url, body) => new Promise(resolve => { writes.push({ url, body }); pending.push(resolve) })
    ${extractFunction(soundAndLabels, 'isCurrentScope')}
    ${extractFunction(soundAndLabels, 'writeTimeline')}
    ${extractFunction(soundAndLabels, 'saveNow')}
    return {
      writeTimeline,
      edit: title => { labels.value.cues[0].title = title; dirty.value = true; editSeq++ },
      writes: () => writes,
      resolve: (index, value) => pending[index](value),
      dirty,
      labels,
    }
  `))(pending, writes) as {
    writeTimeline(announce: boolean): Promise<void>
    edit(title: string): void
    writes(): Array<{ url: string; body: any }>
    resolve(index: number, value: unknown): void
    dirty: { value: boolean }
    labels: { value: { cues: Array<{ title: string }> } }
  }

  const first = runtime.writeTimeline(false)
  await Promise.resolve()
  runtime.edit('latest')
  const second = runtime.writeTimeline(false)
  runtime.resolve(0, { timeline: { cues: [{ title: 'server-first' }] }, validation: [] })
  await first
  await Promise.resolve()

  assert.equal(runtime.writes()[0]?.url, '/projects/alpha/sound-and-labels/episode-a/labels')
  assert.equal(runtime.writes()[1]?.body.cues[0]?.title, 'latest', 'the edit made during the first write is what goes second')
  runtime.resolve(1, { timeline: { cues: [{ title: 'server-latest' }] }, validation: [] })
  await Promise.all([first, second])

  assert.equal(runtime.dirty.value, false)
  assert.equal(runtime.labels.value.cues[0]?.title, 'server-latest')
})
