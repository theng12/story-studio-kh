import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'
import { isVerifiedLiveCapacity } from '../utils/job-presentation.js'
import { createVisibleInterval } from '../composables/useVisibleInterval.js'

const page = readFileSync(new URL('../pages/projects/[slug]/jobs.vue', import.meta.url), 'utf8')
const source = page.slice(page.indexOf('const now = ref(Date.now())'), page.indexOf('// Post-bulk banner:'))

function runtime(getImpl?: (url: string) => Promise<unknown>) {
  let mounted!: () => void
  let unmounted!: () => void
  const intervals = new Map<number, { fn: () => void; ms: number }>()
  const listeners = new Map<string, () => void>()
  const document = {
    visibilityState: 'visible',
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string, fn: () => void) => {
      if (listeners.get(name) === fn) listeners.delete(name)
    },
  }
  const calls: string[] = []
  let nextId = 0
  let clock = Date.now()
  const deps = {
    Date: { now: () => clock },
    ref: (value: unknown) => ({ value }), computed: (fn: () => unknown) => ({ get value() { return fn() } }),
    useNetworkStatus: () => ({ refresh: async () => {} }),
    get: async (url: string) => {
      calls.push(url)
      return getImpl ? getImpl(url) : { paused: false, stats: { queued: 0, running: 0 } }
    },
    post: async () => ({}), success: () => {}, showError: () => {},
    genStudioModels: { refresh: async () => {} }, isUniversal: { value: false }, universalQueue: { stop() {} },
    isVerifiedLiveCapacity, document,
    createVisibleInterval: (tick: () => void, ms: number, resume?: () => void) => createVisibleInterval(tick, ms, resume, {
      document, setInterval: (fn, delay) => deps.setInterval(fn, delay), clearInterval: (id) => deps.clearInterval(id),
    }),
    onMounted: (fn: () => void) => { mounted = fn },
    onUnmounted: (fn: () => void) => { unmounted = fn },
    setInterval: (fn: () => void, ms: number) => { intervals.set(++nextId, { fn, ms }); return nextId },
    clearInterval: (id: number) => intervals.delete(id),
  }
  const js = ts.transpileModule(`${source}\nreturn { refreshGenStudioCapacity, pauseQueue, resumeQueue, freshQueueAdmission, genStudioAdmission }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  // eslint-disable-next-line no-new-func
  const actions = new Function(...Object.keys(deps), js)(...Object.values(deps))
  return {
    ...actions, calls, intervals, listeners, document,
    mount: () => mounted(), unmount: () => unmounted(),
    async tick(ms: number) {
      for (let t = 1000; t <= ms; t += 1000) {
        clock += 1000
        for (const item of intervals.values()) if (t % item.ms === 0) item.fn()
        await flush()
      }
    },
  }
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve() }
const admissionCount = (r: ReturnType<typeof runtime>) => r.calls.filter(url => url.endsWith('/admission')).length

test('Jobs polls advisory capacity four times per minute and retains fast local queue status', async () => {
  const r = runtime()
  r.mount(); await flush(); await r.tick(60_000)
  assert.equal(admissionCount(r), 5, 'initial read plus four refreshes, instead of thirteen')
  assert.equal(r.calls.filter((url: string) => url.endsWith('/queue/status')).length, 13)
  r.unmount()
  assert.equal(r.intervals.size, 0)
  assert.equal(r.listeners.size, 0)
})

test('hidden Jobs windows stop advisory polling and refresh immediately on return', async () => {
  const r = runtime()
  r.mount(); await flush()
  r.document.visibilityState = 'hidden'
  await r.tick(60_000)
  assert.equal(admissionCount(r), 1)
  r.document.visibilityState = 'visible'
  r.listeners.get('visibilitychange')?.(); await flush()
  assert.equal(admissionCount(r), 2)
  r.unmount()
})

test('slow capacity reads are shared across timers and visible-window refresh', async () => {
  let resolve!: (value: unknown) => void
  const pending = new Promise(resolvePromise => { resolve = resolvePromise })
  const r = runtime(async url => url.endsWith('/admission') ? pending : { paused: false })
  r.mount(); await r.tick(60_000)
  r.listeners.get('visibilitychange')?.()
  assert.equal(admissionCount(r), 1)
  resolve({}); await flush(); await r.tick(15_000)
  assert.equal(admissionCount(r), 2)
  r.unmount()
})

test('explicit queue actions refresh capacity immediately without extending snapshot validity', async () => {
  const r = runtime()
  r.mount(); await flush()
  await r.pauseQueue(); await flush()
  await r.resumeQueue(); await flush()
  assert.equal(admissionCount(r), 3)
  const now = Date.now()
  const snapshot = { capacity_verified: true, limitSource: 'account-overview', refreshed_at: new Date(now).toISOString() }
  assert.equal(isVerifiedLiveCapacity(snapshot, now + 30_001), false)
  r.unmount()
})


test('local submission warnings expire even when the old snapshot is retained after refresh failure', async () => {
  let fail = false
  const r = runtime(async url => {
    if (url.endsWith('/admission')) {
      if (fail) throw new Error('offline')
      return { submissions_blocked: true, local_waiting: 3 }
    }
    return { paused: false }
  })
  r.mount(); await flush()
  assert.equal(r.freshQueueAdmission.value, true)
  fail = true
  await r.tick(31_000)
  assert.equal(r.genStudioAdmission.value.submissions_blocked, true, 'last-known snapshot retained')
  assert.equal(r.freshQueueAdmission.value, false, 'expired local facts are not presented as current')
  assert.match(page, /v-if="freshQueueAdmission && genStudioAdmission\?\.submissions_blocked"/)
  assert.match(page, /v-if="freshQueueAdmission && genStudioAdmission\?\.local_waiting"/)
  r.unmount()
})
