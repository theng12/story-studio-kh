import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ref } from 'vue'

const hooks: Record<string, any> = {}
const asked: any[] = []
let answer = false
const win = new EventTarget()
Object.assign(globalThis, {
  useConfirm: () => ({ ask: async (o: any) => { asked.push(o); return answer } }),
  onBeforeRouteLeave: (fn: any) => { hooks.leave = fn },
  onBeforeRouteUpdate: (fn: any) => { hooks.update = fn },
  onMounted: (fn: any) => { hooks.mounted = fn },
  onBeforeUnmount: (fn: any) => { hooks.unmount = fn },
  window: win,
})
const { useUnsavedGuard } = await import('../composables/useUnsavedGuard.js')
const route = (slug: string, episode = '') => ({ params: { slug }, query: episode ? { episode_id: episode } : {} }) as any

test('dirty edits are protected on leave, project switch, episode switch and unload', async () => {
  const dirty = ref(false)
  useUnsavedGuard(dirty, 'Scene Plan edits', { episodeSwitch: true })
  hooks.mounted()

  assert.equal(await hooks.leave(), true, 'clean page leaves without a prompt')
  assert.equal(asked.length, 0)

  dirty.value = true
  answer = false
  assert.equal(await hooks.leave(), false, 'declining keeps the user on the page')
  assert.equal(asked[0].danger, true)
  assert.equal(await hooks.update(route('b'), route('a')), false, 'project switch asks')
  assert.equal(await hooks.update(route('a', 'EP2'), route('a', 'EP1')), false, 'episode switch asks')
  assert.equal(hooks.update(route('a', 'EP1'), route('a', 'EP1')), true, 'an unrelated query change does not')
  answer = true
  assert.equal(await hooks.leave(), true, 'accepting discards')

  const unload = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(unload)
  assert.equal(unload.defaultPrevented, true, 'reload/close is blocked while dirty')
  dirty.value = false
  const clean = new Event('beforeunload', { cancelable: true })
  win.dispatchEvent(clean)
  assert.equal(clean.defaultPrevented, false)
})

test('the three manually-saved pages use the guard, and the selector honours a refused navigation', () => {
  const at = (rel: string) => readFileSync(join(import.meta.dirname, '..', rel), 'utf8')
  for (const page of ['scene-plan', 'introduction', 'sound-design']) {
    assert.match(at(`pages/projects/[slug]/${page}.vue`), /useUnsavedGuard\(dirty,/, page)
  }
  assert.match(at('components/EpisodeSelector.vue'), /isNavigationFailure\(await router\.replace[\s\S]{0,120}NavigationFailureType\.aborted/)
})
