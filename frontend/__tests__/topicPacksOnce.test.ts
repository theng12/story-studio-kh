import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { useTopicPacks } from '../composables/useTopicPacks.js'

// S9: the 8 MB Topic Pack list is fetched once per session (slim view), not on every mount.
test('useTopicPacks fetches the slim list once; later mounts reuse it and refresh() re-reads', async () => {
  const originalFetch = (globalThis as any).$fetch
  const urls: string[] = []
  ;(globalThis as any).$fetch = async (url: string) => { urls.push(url); return { topic_packs: [{ id: 'a', name: 'A' }] } }
  const settle = async () => { for (let i = 0; i < 5; i++) { await nextTick(); await new Promise(resolve => setTimeout(resolve, 0)) } }
  try {
    let api!: ReturnType<typeof useTopicPacks>
    const Probe = defineComponent({ setup() { api = useTopicPacks(); return () => h('div') } })
    for (let mount = 0; mount < 3; mount++) {
      const app = createApp(Probe)
      app.mount(document.createElement('div'))
      await settle()
      app.unmount()
    }
    assert.equal(urls.length, 1, 'three mounts, one request')
    assert.ok(urls[0]!.endsWith('/topic-packs?view=list'))
    await api.refresh()
    assert.equal(urls.length, 2, 'refresh() still re-reads')
    assert.equal(api.topicPacks.value[0]?.id, 'a')
  } finally {
    ;(globalThis as any).$fetch = originalFetch
  }
})
