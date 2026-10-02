import assert from 'node:assert/strict'
import test from 'node:test'
import { reactive, ref } from 'vue'

;(globalThis as any).$fetch = async () => ({})
const { useVideoAssemblyIo } = await import('../composables/useVideoAssemblyIo.js')

function scanState() {
  return {
    slug: ref('proj-x'),
    episodeId: ref('EP0001'),
    visualSource: ref<'scene_plan' | 'image_pool'>('scene_plan'),
    selectedEpisode: ref<any>({ title: 'First episode' }),
    scannedAssets: ref<any>(null),
    scanning: ref(false),
    scenes: ref<any[]>([]),
    titleImage: reactive({ enabled: true, image_path: '' }),
    titleCard: reactive({ enabled: true, text: '' }),
  }
}

function stubScan(thumbnails: Array<{ path: string }>) {
  ;(globalThis as any).$fetch = async (url: string) => url.includes('/health')
    ? { boot_complete: true }
    : { scenes: [], thumbnails }
}

test('Check again keeps the title image and title text the owner already chose', async () => {
  const state = scanState()
  stubScan([{ path: '/thumb-1.png' }, { path: '/thumb-2.png' }])
  const io = useVideoAssemblyIo(state as any)

  await io.scanAssets()
  assert.equal(state.titleImage.image_path, '/thumb-1.png', 'an empty field is filled from the scan')
  assert.equal(state.titleCard.text, 'First episode')

  state.titleImage.image_path = '/thumb-2.png'
  state.titleCard.text = 'My own title'
  await io.scanAssets()
  assert.equal(state.titleImage.image_path, '/thumb-2.png')
  assert.equal(state.titleCard.text, 'My own title')
})

test('a real episode change still replaces the title image and title text', async () => {
  const state = scanState()
  stubScan([{ path: '/thumb-1.png' }])
  const io = useVideoAssemblyIo(state as any)
  await io.scanAssets()
  state.titleImage.image_path = '/chosen.png'
  state.titleCard.text = 'Chosen title'

  state.episodeId.value = 'EP0002'
  assert.equal(state.titleImage.image_path, '', 'blanked synchronously on the switch')
  assert.equal(state.titleCard.text, '')

  state.selectedEpisode.value = { title: 'Second episode' }
  stubScan([{ path: '/second-thumb.png' }])
  await io.scanAssets()
  assert.equal(state.titleImage.image_path, '/second-thumb.png')
  assert.equal(state.titleCard.text, 'Second episode')
})
