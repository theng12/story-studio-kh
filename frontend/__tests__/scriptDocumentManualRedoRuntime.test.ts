import assert from 'node:assert/strict'
import test from 'node:test'
import { createRenderer } from '@vue/runtime-core'
import { defineComponent, nextTick, reactive, ref } from 'vue'
import { useChapterRegenerate } from '../composables/useChapterRegenerate.js'
import { useConfirm } from '../composables/useConfirm.js'
import { useToast } from '../composables/useToast.js'

const renderer = createRenderer<any, any>({
  patchProp: () => undefined,
  insert: () => undefined,
  remove: () => undefined,
  createElement: () => ({}),
  createText: text => ({ text }),
  createComment: text => ({ text }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.text = text },
  parentNode: () => null,
  nextSibling: () => null,
})

function clearToasts(): void {
  const toast = useToast()
  for (const item of [...toast.toasts.value]) toast.dismiss(item.id)
}

function mountRegenerate() {
  let state!: ReturnType<typeof useChapterRegenerate>
  const app = renderer.createApp(defineComponent({
    setup() {
      state = useChapterRegenerate()
      return () => null
    },
  }))
  app.mount({})
  return { state, unmount: () => app.unmount() }
}

function manualInput(options: {
  form: Record<string, any>
  source: { source_job_id: string; item_key: `chapter:${number}` } | null
  project: { value: string }
  episode: { value: string }
  userEpoch: { value: number }
  chapter?: number
}) {
  const chapter = options.chapter ?? 3
  return {
    projectSlug: options.project.value,
    episodeId: options.episode.value,
    title: 'Detached manual chapter',
    form: options.form,
    chapter,
    words: 725,
    manualRedo: {
      source: options.source,
      userEpoch: options.userEpoch.value,
      currentUserEpoch: () => options.userEpoch.value,
      currentProjectSlug: () => options.project.value,
      currentEpisodeId: () => options.episode.value,
    },
  } as any
}

async function confirmAndWait(pending: Promise<void>): Promise<void> {
  const confirm = useConfirm()
  assert.equal(confirm.state.visible, true, 'the actual chapter action keeps its existing confirmation')
  confirm.confirm()
  await pending
}

function retryActions() {
  return useToast().toasts.value.filter(item => item.action?.label === 'Retry')
}

test('automatic source disappearance and default normalization preserve an exact unknown-response Retry', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project')
  const episode = ref('EP7201')
  const userEpoch = ref(0)
  const form = reactive({ model: 'accepted-model', style: 'calm', words_per_chapter: 725 })
  let source: { source_job_id: string; item_key: 'chapter:3' } | null = {
    source_job_id: 'stopped-chapter-source', item_key: 'chapter:3',
  }
  const posts: Array<{ url: string; body: Record<string, any> }> = []
  let first = true
  ;(globalThis as any).$fetch = async (url: string, request: any) => {
    posts.push({ url, body: structuredClone(request.body) })
    if (first) {
      first = false
      source = null // SSE settlement removes the source from the live selector.
      form.model = 'new-default-model' // Background catalogue/default reconciliation.
      await nextTick()
      throw new Error('HTTP response lost after accepted admission')
    }
    return { job_id: 'adopted-chapter-action', reused: true }
  }

  try {
    const input = manualInput({ form, source, project, episode, userEpoch })
    await confirmAndWait(mounted.state.regenerate(input))
    const retry = retryActions().at(-1)
    assert.ok(retry?.action)
    assert.equal(posts.length, 1)
    assert.deepEqual(posts[0]!.body.manual_redo, {
      intent: 'replace_unresolved', source_job_id: 'stopped-chapter-source',
    })
    assert.equal(posts[0]!.body.model, 'accepted-model')
    assert.match(posts[0]!.body.operation_id, /^[0-9a-f-]{36}$/i)

    await retry.action.onClick()
    assert.equal(posts.length, 2)
    assert.deepEqual(posts[1]!.body, posts[0]!.body,
      'adoption retries the detached body and UUID before current source/default eligibility')
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('a genuine user epoch change refuses an unknown-response Retry', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project')
  const episode = ref('EP7202')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const source = { source_job_id: 'stopped-chapter-user-edit', item_key: 'chapter:3' as const }
  const posts: any[] = []
  ;(globalThis as any).$fetch = async (_url: string, request: any) => {
    posts.push(structuredClone(request.body))
    throw new Error('response unknown')
  }

  try {
    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch })))
    const retry = retryActions().at(-1)
    assert.ok(retry?.action)
    form.model = 'model-b'
    userEpoch.value++
    await nextTick()
    await retry.action.onClick()
    assert.equal(posts.length, 1, 'a user edit cannot replay a request from the old logical scope')
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('an A to B to A user round trip cannot revive either stale response', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project')
  const episode = ref('EP7203')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const sourceA = { source_job_id: 'stopped-source-a', item_key: 'chapter:3' as const }
  const sourceB = { source_job_id: 'stopped-source-b', item_key: 'chapter:3' as const }
  const posts: any[] = []
  ;(globalThis as any).$fetch = async (_url: string, request: any) => {
    posts.push(structuredClone(request.body))
    throw new Error('response unknown')
  }

  try {
    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source: sourceA, project, episode, userEpoch })))
    const retryA = retryActions().at(-1)
    assert.ok(retryA?.action)

    form.model = 'model-b'
    userEpoch.value++
    await nextTick()
    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source: sourceB, project, episode, userEpoch })))
    const retryB = retryActions().at(-1)
    assert.ok(retryB?.action)

    form.model = 'model-a'
    userEpoch.value++
    await nextTick()
    await retryA.action.onClick()
    await retryB.action.onClick()
    assert.equal(posts.length, 2,
      'returning to identical raw values does not restore an older operation or source owner')
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('an A to B to A edit mints a new UUID for the next deliberate chapter action', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project')
  const episode = ref('EP7207')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const source = { source_job_id: 'stopped-same-source', item_key: 'chapter:3' as const }
  const posts: any[] = []
  ;(globalThis as any).$fetch = async (_url: string, request: any) => {
    posts.push(structuredClone(request.body))
    throw new Error('response unknown')
  }

  try {
    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch })))
    const staleRetry = retryActions().at(-1)
    assert.ok(staleRetry?.action)

    form.model = 'model-b'
    userEpoch.value++
    form.model = 'model-a'
    userEpoch.value++
    await nextTick()

    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch })))
    assert.equal(posts.length, 2)
    assert.notEqual(posts[1]!.operation_id, posts[0]!.operation_id,
      'a new deliberate action after user retirement must not adopt the pending old UUID')

    await staleRetry.action.onClick()
    assert.equal(posts.length, 2, 'the retired Retry remains unable to POST')
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('project or episode changes fence a late success and its finally state', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project-a')
  const episode = ref('EP7204')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const source = { source_job_id: 'stopped-late-response', item_key: 'chapter:3' as const }
  let resolvePost!: (value: unknown) => void
  const post = new Promise(resolve => { resolvePost = resolve })
  ;(globalThis as any).$fetch = async () => post

  try {
    const pending = mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch }))
    useConfirm().confirm()
    await nextTick()
    project.value = 'script-project-b'
    episode.value = 'EP9999'
    userEpoch.value++
    await nextTick()
    resolvePost({ job_id: 'old-project-job' })
    await pending
    assert.equal(mounted.state.isRegenerating('EP9999', 3), false,
      'an old target response cannot mark or clear the new project/episode action')
    assert.equal(useToast().toasts.value.some(item => item.type === 'success'), false,
      'a stale response cannot toast success over the new view')
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('a late failure from a retired project and user epoch publishes no error or Retry', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project-a')
  const episode = ref('EP7205')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const source = { source_job_id: 'stopped-late-error', item_key: 'chapter:3' as const }
  let rejectPost!: (error: unknown) => void
  let markPostStarted!: () => void
  const postStarted = new Promise<void>(resolve => { markPostStarted = resolve })
  ;(globalThis as any).$fetch = async () => new Promise((_resolve, reject) => {
    rejectPost = reject
    markPostStarted()
  })

  try {
    const pending = mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch }))
    useConfirm().confirm()
    await postStarted
    project.value = 'script-project-b'
    episode.value = 'EP9998'
    userEpoch.value++
    await nextTick()
    rejectPost(new Error('old project response failed late'))
    await pending
    assert.equal(useToast().toasts.value.some(item => item.type === 'error'), false)
    assert.equal(retryActions().length, 0)
  } finally {
    clearToasts()
    mounted.unmount()
  }
})

test('overlapping same UUID retries keep the chapter busy until the newest submit settles', async () => {
  clearToasts()
  const mounted = mountRegenerate()
  const project = ref('script-project')
  const episode = ref('EP7206')
  const userEpoch = ref(0)
  const form = reactive({ model: 'model-a', style: 'calm', words_per_chapter: 700 })
  const source = { source_job_id: 'stopped-overlap', item_key: 'chapter:3' as const }
  let first = true
  const pendingPosts: Array<{ resolve: (value: unknown) => void; reject: (error: unknown) => void }> = []
  ;(globalThis as any).$fetch = async () => {
    if (first) { first = false; throw new Error('initial response unknown') }
    return new Promise((resolve, reject) => pendingPosts.push({ resolve, reject }))
  }

  try {
    await confirmAndWait(mounted.state.regenerate(manualInput({ form, source, project, episode, userEpoch })))
    const retry = retryActions().at(-1)
    assert.ok(retry?.action)
    const older = retry.action.onClick()
    const newer = retry.action.onClick()
    await nextTick()
    assert.equal(pendingPosts.length, 2)
    assert.equal(mounted.state.isRegenerating(episode.value, 3), true)

    pendingPosts[0]!.reject(new Error('older retry failed after the newer retry started'))
    await older
    assert.equal(mounted.state.isRegenerating(episode.value, 3), true,
      'the older finally cannot clear the newest request owner')
    assert.equal(retryActions().length, 0,
      'the stale older failure cannot publish another Retry over the newer request')

    pendingPosts[1]!.resolve({ job_id: 'newest-retry-adopted', reused: true })
    await newer
    assert.equal(mounted.state.isRegenerating(episode.value, 3), false)
  } finally {
    clearToasts()
    mounted.unmount()
  }
})
