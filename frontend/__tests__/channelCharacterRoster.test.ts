/**
 * Character Sheet — Channel roster (JOB5).
 *
 * The roster is the shared Channel Characters editor embedded ABOVE the
 * episode-specific cast on the Character Sheet. It must:
 *   - render with no episode selected (outside the episode gate)
 *   - filter legacy episode-scope records out of the no-episode list endpoint
 *   - keep its own race fence, never feeding dropUnknownAnchors or the
 *     continuity save (which may not move pacing — AGENTS §5)
 *   - read the FULL canonical record before edit (the resolved project view
 *     collapses channel speech) and stage changes until Save
 *   - name the other channels affected by a shared identity/reference edit,
 *     and preserve their profiles/assignments when one channel's voice changes
 *   - keep the library editor's dirty gating and partial-reference-upload
 *     recovery (a failed upload must not create a duplicate on retry)
 *
 * Source tests run with plain node; runtime tests compile the real SFCs and
 * are skipped (with the reason stated) when frontend deps are not installed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const rosterFile = fileURLToPath(new URL('../components/ChannelCharacterRoster.vue', import.meta.url))
const editorFile = fileURLToPath(new URL('../components/CharacterRecordEditor.vue', import.meta.url))
const sheetFile = fileURLToPath(new URL('../pages/projects/[slug]/character-sheet.vue', import.meta.url))

const rosterSource = readFileSync(rosterFile, 'utf8')
const editorSource = readFileSync(editorFile, 'utf8')
const sheetSource = readFileSync(sheetFile, 'utf8')

function scriptOf(source: string): string {
  const start = source.indexOf('<script')
  const end = source.lastIndexOf('</script>')
  assert.ok(start >= 0 && end > start, 'SFC has a script block')
  return source.slice(start, end)
}

const rosterScript = scriptOf(rosterSource)
const editorScript = scriptOf(editorSource)

// ── Source contract ──────────────────────────────────────────────────────────

test('the roster renders above the episode gate, so it works with no episode selected', () => {
  const rosterAt = sheetSource.indexOf('<ChannelCharacterRoster')
  const gateAt = sheetSource.indexOf('<div v-if="!episodeId"')
  assert.ok(rosterAt >= 0, 'Character Sheet hosts the roster component')
  assert.ok(gateAt > rosterAt, 'roster sits BEFORE the no-episode gate (always rendered)')
  assert.match(rosterSource, /No episode needed/)
})

test('the roster filters legacy episode-scope records and owns its own race fence', () => {
  assert.match(rosterScript, /scope === 'project'/)
  assert.match(rosterScript, /rosterScopeSequence/, 'roster fence is separate from the episode cast fence')
  // The episode cast stays on listForEpisode in the page's own ref + fence.
  assert.match(sheetSource, /await cm\.listForEpisode\(ep\)/)
  assert.match(sheetSource, /characterScopeSequence/)
  // Nothing from the roster reaches the continuity save or anchor cleanup.
  assert.doesNotMatch(rosterScript, /anchor_character_ids|dropUnknownAnchors|claim_pacing|continuity|pacing|usePresets/i)
  assert.doesNotMatch(editorScript, /anchor_character_ids|dropUnknownAnchors|claim_pacing|continuity|pacing|usePresets/i)
  // The continuity save still serialises only the config — unchanged boundary.
  assert.match(sheetSource, /JSON\.parse\(JSON\.stringify\(config\.value\)\)/)
})

test('the editor stages changes until Save and gates close on dirty state', () => {
  assert.match(editorSource, /:close-on-backdrop="false"/)
  assert.match(editorSource, /:close-on-escape="!editorDirty"/)
  assert.match(editorSource, /<button type="button" class="btn btn-secondary" @click="requestClose">Cancel<\/button>/)
  assert.match(editorSource, /Max 5 MB/)
  // Cancel/close only ends the session and emits — no persistence path runs
  // from requestClose, and a save still in flight can no longer write back.
  assert.match(editorScript, /function requestClose\(\) \{\n(?:\s*\/\/[^\n]*\n)+\s*editorSession\+\+\n\s*emit\('close'\)\n\}/)
  // Make Portrait and Delete are staged in draft state: no API call in either
  // function body — the writes happen inside saveCharacter only.
  assert.doesNotMatch(editorScript, /function makePortrait[\s\S]{0,400}?(cl\.update|cmUpdate|await )/)
  assert.doesNotMatch(editorScript, /function removeReference[\s\S]{0,600}?await del/)
  assert.doesNotMatch(editorScript, /changeReferences/)
  assert.match(editorScript, /stagedDeletes/)
})

test('canonical reads and reference URLs follow the record source origin', () => {
  // openEdit refuses to seed the editor from the collapsed list record.
  assert.match(rosterScript, /record\.source === 'library' \? 'library' : 'project'/)
  assert.match(rosterScript, /cl\.getOne\(record\.id\)/)
  assert.match(editorScript, /recordOrigin\.value === 'library'\s*\?\s*`\/api\/character-library/)
  assert.match(editorScript, /`\/projects\/\$\{encodeURIComponent\(props\.slug\)\}\/characters/)
  // The collapsed speech of the project view must never be written back as
  // the canonical record: library saves go through channel_profiles seeded
  // from the canonical record's own profiles.
  assert.match(editorScript, /c\.channel_profiles\?\.\[slug\]\?\.speech/)
})

test('shared identity edits name the other channels; one channel voice edit keeps the rest', () => {
  assert.match(editorSource, /Shared with other channels/)
  assert.match(editorSource, /sharedWithNames\.join\(', '\)/)
  // Payload carries every selected channel's profile and the full label set.
  assert.match(editorScript, /projects: \[\.\.\.selectedChannels\.value\]/)
  assert.match(editorScript, /profiles\[slug\] = \{ speech: \{\s*\.\.\.speech, voiceProvider: 'genstudio'\s*\} \}/)
  // Unchecking this channel removes only this channel's label/profile — the
  // rest of the payload is untouched (backend unassigns, never deletes).
  assert.match(editorSource, /Unchecking this channel removes the character from this channel only/)
})

// ── Runtime (real SFC compile) ───────────────────────────────────────────────

let depsAvailable = true
try {
  await import('@vue/compiler-sfc')
  await import('esbuild')
  await import('vue')
} catch {
  depsAvailable = false
}
const depsSkip = depsAvailable ? false : 'frontend deps not installed in this worktree — source tests above still ran'

async function flush(): Promise<void> {
  const { nextTick } = await import('vue')
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await nextTick()
  }
}

async function compileSfc(file: string, id: string, support: string): Promise<any> {
  const { parse, compileScript } = await import('@vue/compiler-sfc')
  const { transform } = await import('esbuild')
  const source = readFileSync(file, 'utf8')
  const { descriptor } = parse(source, { filename: file })
  const script = compileScript(descriptor, { id })
  const vueUrl = await import.meta.resolve('vue')
  const content = script.content
    .replace(/^import[\s\S]*?from [^\n]+\n/gm, '')
    .replace('export default', 'const __sfc__ =')
  const output = await transform(`${support}\n${content}\nconst setup = __sfc__.setup
    __sfc__.setup = (props, ctx) => {
      const state = setup(props, ctx)
      globalThis.__job5Fixture.state = state
      return () => h('main')
    }
    export default __sfc__`, { loader: 'ts', format: 'esm' })
  return (await import(`data:text/javascript;base64,${Buffer.from(
    output.code.replaceAll('"vue"', JSON.stringify(vueUrl)),
  ).toString('base64')}`)).default
}

const VUE_IMPORTS = 'import { computed, defineComponent as _defineComponent, h, ref, reactive, watch, onMounted } from '

function rosterSupport(vueUrl: string): string {
  return `
    ${VUE_IMPORTS}${JSON.stringify(vueUrl)}
    const useCharacters = () => globalThis.__job5Fixture.chars
    const useCharacterLibrary = () => globalThis.__job5Fixture.cl
    const useApi = () => globalThis.__job5Fixture.api
    const useToast = () => ({ success: (m) => globalThis.__job5Fixture.toasts.push(m), error: (m) => globalThis.__job5Fixture.errors.push(m) })
  `
}

function editorSupport(vueUrl: string): string {
  // useApi/useConfirm must FORWARD at call time: the editor destructures
  // `const { del, put } = useApi()` / `const { ask } = useConfirm()` once at
  // setup, so a plain object swap on the fixture would never reach the
  // captured binding and a deferred override would never be entered.
  return `
    ${VUE_IMPORTS}${JSON.stringify(vueUrl)}
    const useCharacterLibrary = () => globalThis.__job5Fixture.cl
    const useCharacters = () => globalThis.__job5Fixture.chars
    const useApi = () => ({
      get: (...a) => globalThis.__job5Fixture.api.get(...a),
      post: (...a) => globalThis.__job5Fixture.api.post(...a),
      put: (...a) => globalThis.__job5Fixture.api.put(...a),
      del: (...a) => globalThis.__job5Fixture.api.del(...a),
    })
    const useConfirm = () => ({ ask: (...a) => globalThis.__job5Fixture.confirm.ask(...a) })
    const useToast = () => ({ success: (m) => globalThis.__job5Fixture.toasts.push(m), error: (m) => globalThis.__job5Fixture.errors.push(m) })
  `
}

async function mountRoster() {
  const calls: string[] = []
  const errors: string[] = []
  const f: any = {
    calls, errors, toasts: [],
    listResult: [] as any[],
    canonical: {} as Record<string, any>,
    projects: [] as Array<{ slug: string; name: string }>,
  }
  f.chars = {
    list: async () => { calls.push('chars.list'); return f.listResult },
    getOne: async (id: string) => { calls.push(`chars.getOne:${id}`); return f.canonical[id] },
  }
  f.cl = {
    getOne: async (id: string) => { calls.push(`cl.getOne:${id}`); return f.canonical[id] },
  }
  f.api = {
    get: async (path: string) => { calls.push(`get:${path}`); return path === '/projects' ? f.projects : [] },
  }
  ;(globalThis as any).__job5Fixture = f

  const vueUrl = await import.meta.resolve('vue')
  const component = await compileSfc(rosterFile, 'channel-character-roster', rosterSupport(vueUrl))
  const { createApp } = await import('vue')
  const app = createApp(component, { slug: 'kh' })
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  return { f, state: f.state, calls, errors, unmount: () => { app.unmount(); host.remove() } }
}

async function mountEditor(props: Record<string, unknown>) {
  const calls: string[] = []
  const errors: string[] = []
  const toasts: string[] = []
  const f: any = { calls, errors, toasts, created: 0, confirm: { ask: async () => true } }
  f.cl = {
    create: async (p: any) => { f.created++; calls.push(`cl.create:${JSON.stringify({ name: p.name, projects: p.projects })}`); return { id: 'new-1', ...p, references: { images: [] }, source: 'project', scope: 'project', schemaVersion: 1, created_at: 'now' } },
    update: async (id: string, p: any) => { calls.push(`cl.update:${id}:${JSON.stringify(p)}`); return { id, ...p, references: p.references || { images: [] }, source: 'project', scope: 'project', schemaVersion: 1, created_at: 'now' } },
    getOne: async (id: string) => { calls.push(`cl.getOne:${id}`); return { id, name: 'X', description: 'd', references: { images: [] } } },
    uploadReferenceImage: async () => { calls.push('cl.upload'); throw new Error('Image is larger than 5 MB') },
  }
  f.chars = {
    create: async (p: any) => { f.created++; calls.push('chars.create'); return { id: 'new-1', ...p } },
    update: async (id: string, p: any) => { calls.push(`chars.update:${id}:${JSON.stringify(p)}`); return { id, ...p } },
    getOne: async (id: string) => { calls.push(`chars.getOne:${id}`); return { id, name: 'X', description: 'd' } },
    uploadReferenceImage: async () => { calls.push('chars.upload'); throw new Error('boom') },
  }
  f.api = {
    put: async (path: string, body: any) => { calls.push(`put:${path}:${JSON.stringify(body)}`); return { ok: true, config: body } },
    del: async (path: string) => { calls.push(`del:${path}`); return { id: 'c1', references: { images: [] } } },
    get: async () => ({}),
    post: async () => ({}),
  }
  ;(globalThis as any).__job5Fixture = f

  const vueUrl = await import.meta.resolve('vue')
  const component = await compileSfc(editorFile, 'character-record-editor', editorSupport(vueUrl))
  const { createApp } = await import('vue')
  const app = createApp(component, props)
  const host = document.body.appendChild(document.createElement('div'))
  app.mount(host)
  await flush()
  return { f, state: f.state, calls, errors, toasts, unmount: () => { app.unmount(); host.remove() } }
}

test('roster lists only project-scope records; openEdit reads the canonical record', { skip: depsSkip }, async () => {
  const { f, state, calls, unmount } = await mountRoster()
  try {
    f.listResult = [
      { id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'library', projects: ['kh', 'en'], references: { images: [] }, schemaVersion: 1, created_at: 'now' },
      { id: 'old-ep', name: 'Old Episode Guest', description: 'legacy', scope: 'episode', source: 'project', references: { images: [] }, schemaVersion: 1, created_at: 'now' },
      { id: 'legacy', name: 'Legacy Local', description: 'own file', scope: 'project', source: 'project', references: { images: [] }, schemaVersion: 1, created_at: 'now' },
    ]
    f.projects = [{ slug: 'kh', name: 'Khmer Channel' }, { slug: 'en', name: 'English Channel' }]
    await state.load()
    await flush()

    const ids = state.records.value.map((r: any) => r.id)
    assert.deepEqual(ids, ['aria', 'legacy'], 'episode-scope legacy records stay out of the roster')
    assert.ok(calls.includes('get:/projects'))

    // Canonical read: library origin goes through /character-library, and the
    // editor receives the FULL record (channel_profiles intact), not the
    // collapsed list item.
    f.canonical.aria = {
      id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
      projects: ['kh', 'en'],
      speech: { voiceId: 'collapsed' },
      channel_profiles: { kh: { speech: { voiceId: 'v-kh' } }, en: { speech: { voiceId: 'v-en' } } },
      references: { images: [] }, schemaVersion: 1, created_at: 'now',
    }
    await state.openEdit(state.records.value.find((r: any) => r.id === 'aria'))
    await flush()
    assert.ok(calls.includes('cl.getOne:aria'), `canonical library read, calls=${calls.join('|')}`)
    assert.equal(state.editing.value.channel_profiles.en.speech.voiceId, 'v-en', 'editor holds the full canonical profiles')
    assert.equal(state.editorVisible.value, true)
  } finally {
    unmount()
  }
})

test('a failed reference upload after create updates the same record on the next Save', { skip: depsSkip }, async () => {
  const { f, state, calls, errors, unmount } = await mountEditor({
    visible: true,
    character: null,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }],
  })
  try {
    state.draft.name = 'Ana'
    state.draft.description = 'A guide'
    state.pendingReference.value = new File(['x'], 'big.png')
    await state.saveCharacter()
    await flush()

    assert.equal(f.created, 1, 'record created once')
    assert.ok(calls.some(c => c.startsWith('cl.upload')), `upload attempted, calls=${calls.join('|')}`)
    assert.match(errors[0], /was saved, but the image could not be added: Image is larger than 5 MB/)
    assert.equal(state.editing.value?.id, 'new-1', 'editor points at the created record after the partial failure')

    state.pendingReference.value = null
    await state.saveCharacter()
    await flush()
    assert.equal(f.created, 1, 'no duplicate character on retry')
    assert.ok(calls.some(c => c.startsWith('cl.update:new-1')), `retry updated, calls=${calls.join('|')}`)
  } finally {
    unmount()
  }
})

test('editing one channel voice keeps every other channel profile and label; Cancel saves nothing', { skip: depsSkip }, async () => {
  const canonical = {
    id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
    projects: ['kh', 'en'],
    channel_profiles: {
      kh: { speech: { voiceId: 'v-kh', voiceProvider: 'genstudio' } },
      en: { speech: { voiceId: 'v-en', tonation: 'soft', voiceProvider: 'genstudio' } },
    },
    references: { images: [] }, schemaVersion: 1, created_at: 'now',
  }
  const { f, state, calls, unmount } = await mountEditor({
    visible: true,
    character: canonical,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }, { slug: 'en', name: 'English Channel' }],
  })
  try {
    // Cancel first: staged edits are discarded with zero API calls.
    state.draft.name = 'Aria the Knight'
    state.requestClose()
    assert.deepEqual(calls, [], 'Cancel never persists')

    state.voiceProfiles.kh.voiceId = 'v-kh-new'
    await state.saveCharacter()
    await flush()

    const update = calls.find(c => c.startsWith('cl.update:'))
    assert.ok(update, `update called, calls=${calls.join('|')}`)
    const payload = JSON.parse(update!.slice('cl.update:aria:'.length))
    assert.equal(payload.channel_profiles.en.speech.voiceId, 'v-en', 'other channel voice preserved')
    assert.equal(payload.channel_profiles.en.speech.tonation, 'soft', 'other channel delivery note preserved')
    assert.deepEqual([...payload.projects].sort(), ['en', 'kh'], 'assignments preserved')
    assert.equal(payload.channel_profiles.kh.speech.voiceId, 'v-kh-new', 'current channel voice updated')
  } finally {
    unmount()
  }
})

test('portrait/delete are staged: Cancel persists nothing, Save applies them in order', { skip: depsSkip }, async () => {
  const canonical = {
    id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
    projects: ['kh'],
    references: { images: ['a.png', 'b.png'] },
    schemaVersion: 1, created_at: 'now',
  }
  const { state, calls, unmount } = await mountEditor({
    visible: true,
    character: canonical,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }],
  })
  try {
    await state.makePortrait('b.png')
    await state.removeReference('a.png')
    assert.deepEqual(calls, [], 'portrait reorder and delete make zero writes before Save')
    assert.deepEqual(state.draftImages.value, ['b.png'], 'staged order visible in the draft')
    assert.deepEqual(state.stagedDeletes.value, ['a.png'], 'staged delete held in the draft')

    // Cancel discards the staged reference changes with zero writes.
    state.requestClose()
    assert.deepEqual(calls, [], 'Cancel persists nothing')

    // Reopen and Save: the staged delete runs first (Trash route), then the
    // record save carries the staged order.
    state.seed()
    await state.makePortrait('b.png')
    await state.removeReference('a.png')
    await state.saveCharacter()
    await flush()
    const delAt = calls.findIndex(c => c.startsWith('del:/character-library/aria/reference-image/a.png'))
    const updAt = calls.findIndex(c => c.startsWith('cl.update:aria:'))
    assert.ok(delAt >= 0, `staged delete applied on Save, calls=${calls.join('|')}`)
    assert.ok(updAt >= 0, `record save applied on Save, calls=${calls.join('|')}`)
    assert.ok(delAt < updAt, 'delete lands before the record write')
    assert.match(calls[updAt], /"references":\{"images":\["b.png"\]\}/)
    assert.deepEqual(state.stagedDeletes.value, [], 'staged deletes drained after Save')
  } finally {
    unmount()
  }
})

test('a save completing after a record switch cannot touch the new editor state', { skip: depsSkip }, async () => {
  const canonical = {
    id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
    projects: ['kh'],
    references: { images: ['a.png'] },
    schemaVersion: 1, created_at: 'now',
  }
  const { f, state, toasts, unmount } = await mountEditor({
    visible: true,
    character: canonical,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }],
  })
  try {
    let release!: () => void
    f.cl.update = (id: string, p: any) => new Promise((resolve) => {
      release = () => resolve({
        id, name: 'A-SAVED', description: p.description, projects: p.projects,
        references: { images: ['a.png'] }, source: 'project', scope: 'project',
        schemaVersion: 1, created_at: 'now',
      })
    })
    const pending = state.saveCharacter()
    // Record/channel switch mid-save: seed() is what the visible-watch runs on
    // reopen — it ends the session and resets the draft for the new record.
    state.seed()
    state.draft.name = 'B typing'
    release()
    await pending
    await flush()

    assert.equal(state.editing.value.name, 'Aria', 'late completion did not overwrite the re-seeded record')
    assert.equal(state.draft.name, 'B typing', 'late completion did not touch the new draft')
    assert.deepEqual(toasts, [], 'no success or error toast from the stale session')
    assert.equal(state.saving.value, false, 'stale finally did not clobber the new session saving flag')
  } finally {
    unmount()
  }
})

test('a DELETE resolving after a record switch cannot drain the new session staged list', { skip: depsSkip }, async () => {
  const canonical = {
    id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
    projects: ['kh'],
    references: { images: ['a.png', 'b.png'] },
    schemaVersion: 1, created_at: 'now',
  }
  const { f, state, unmount } = await mountEditor({
    visible: true,
    character: canonical,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }],
  })
  try {
    // Stage a delete in session one, then hold the DELETE mid-save.
    await state.removeReference('a.png')
    assert.deepEqual(state.stagedDeletes.value, ['a.png'])
    let releaseDel!: () => void
    f.api.del = (path: string) => new Promise((resolve) => {
      assert.match(path, /\/reference-image\/a\.png$/)
      releaseDel = () => resolve({ id: 'aria', references: { images: ['b.png'] } })
    })
    const pending = state.saveCharacter()
    // Prove the awaited callback was actually entered before the switch —
    // otherwise the race assertion below would be vacuous.
    assert.equal(typeof releaseDel, 'function', 'save entered the DELETE before the record switch')

    // Record switch while the DELETE is in flight; the new session stages the
    // SAME filename — the late completion must not filter it away.
    state.seed()
    await state.removeReference('a.png')
    assert.deepEqual(state.stagedDeletes.value, ['a.png'], 'new session staged its own delete')
    assert.deepEqual(state.draftImages.value, ['b.png'], 'new session draft')

    releaseDel()
    await pending
    await flush()
    assert.deepEqual(state.stagedDeletes.value, ['a.png'], 'late DELETE completion left the new session staged list intact')
    assert.deepEqual(state.draftImages.value, ['b.png'], 'late DELETE completion left the new session draft intact')
  } finally {
    unmount()
  }
})

test('a delete confirm resolving after a record switch stages nothing in the new session', { skip: depsSkip }, async () => {
  const canonical = {
    id: 'aria', name: 'Aria', description: 'knight', scope: 'project', source: 'project',
    projects: ['kh'],
    references: { images: ['a.png', 'b.png'] },
    schemaVersion: 1, created_at: 'now',
  }
  const { f, state, calls, unmount } = await mountEditor({
    visible: true,
    character: canonical,
    origin: 'library',
    slug: 'kh',
    channels: [{ slug: 'kh', name: 'Khmer Channel' }],
  })
  try {
    let releaseConfirm!: () => void
    f.confirm = { ask: () => new Promise((resolve) => { releaseConfirm = () => resolve(true) }) }
    const pending = state.removeReference('a.png')
    // Prove the confirm dialog was actually entered before the switch.
    assert.equal(typeof releaseConfirm, 'function', 'removeReference entered the confirm before the record switch')

    // Record switch while the confirm dialog is open.
    state.seed()
    releaseConfirm()
    await pending
    await flush()

    assert.deepEqual(state.stagedDeletes.value, [], 'late confirm did not stage a delete in the new session')
    assert.deepEqual(state.draftImages.value, ['a.png', 'b.png'], 'late confirm did not touch the new session draft')
    assert.deepEqual(calls, [], 'no write resulted from the stale confirm')
  } finally {
    unmount()
  }
})
