/**
 * Owner report: "the install all button doesn't show status" — clicking
 * "Install all missing (13)" on the Content Store's Owned tab gave no
 * feedback at all. `ContentLibraryView.vue` emitted `install-many` and
 * disabled itself only on `networkUnavailable`, even though the cards next
 * to it already render `:busy` / `:queue-status` from the same install
 * queue. This mounts the real component against the real `useInstallQueue`
 * composable so the test drives the actual wiring, not a re-description of
 * it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import { createApp, defineComponent, h, nextTick, ref, type Component } from 'vue'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'
import { transform } from 'esbuild'
import { useInstallQueue } from '../composables/useInstallQueue'
import type { ContentStoreAccount, ContentStoreProduct } from '../composables/useContentStore'

async function loadContentLibraryView(): Promise<Component> {
  const filename = fileURLToPath(new URL('../components/content-store/ContentLibraryView.vue', import.meta.url))
  const source = readFileSync(filename, 'utf8')
  const { descriptor } = parse(source, { filename })
  const script = compileScript(descriptor, { id: 'content-library-view-install-all' })
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: 'content-library-view-install-all',
    compilerOptions: { bindingMetadata: script.bindings },
  })
  const vueUrl = await import.meta.resolve('vue')
  // The component's only non-type import is real (filter/group helpers), so
  // it has to resolve to something importable from a data: URL module — a
  // bare "~/..." specifier cannot. Point it at the real file instead of
  // stubbing the logic under test.
  const libraryOrgUrl = await import.meta.resolve('../content-store/library-organisation.js')
  const support = `
    import { h } from ${JSON.stringify(vueUrl)}
    const ContentProductCard = { props: ['product'], render() { return h('article', { class: 'stub-card' }, this.product.title) } }
  `
  const code = `${support}\n${script.content
    .replace(/import ContentProductCard from '.+?'\n/, '')
    .replace('export default', 'const __sfc__ =')}\n${template.code}\n__sfc__.render = render\nexport default __sfc__`
  const transformed = await transform(code, { loader: 'ts', format: 'esm' })
  const finalCode = transformed.code
    .replaceAll('"vue"', JSON.stringify(vueUrl))
    .replaceAll('"~/content-store/library-organisation"', JSON.stringify(libraryOrgUrl))
  const componentUrl = `data:text/javascript;base64,${Buffer.from(finalCode).toString('base64')}`
  return (await import(componentUrl)).default
}

async function mount(component: Component) {
  document.body.innerHTML = ''
  const host = document.body.appendChild(document.createElement('div'))
  const app = createApp(component)
  app.mount(host)
  await nextTick()
  return { host, unmount: () => app.unmount() }
}

function product(id: string): ContentStoreProduct {
  return {
    productId: id, entitlementFamily: `family.${id}`, kind: 'topic_pack', title: `Product ${id}`,
    summary: '', description: '', publisherId: 'Story Studio', creditPrice: 300, free: false,
    owned: true, retired: false, successorProductId: null, compatible: true, compatibilityReason: null,
    currentRelease: {
      releaseId: `rel-${id}`, packId: `pack-${id}`, version: '1.0.0', archiveSha256: 'a'.repeat(64),
      archiveBytes: 10, archiveAvailable: true, minStoryVersion: '1.0.0', changelog: '', componentSummary: {},
    },
    bundleComponents: [], ownedComponentCreditValue: 0, showcaseVideos: [], presentation: {}, discount: null,
  } as unknown as ContentStoreProduct
}

function ownedRow(id: string, installState: string) {
  return {
    entitlementFamily: `family.${id}`, productId: id, title: `Product ${id}`, kind: 'topic_pack',
    grantedAt: '2026-08-01T00:00:00Z', purchaseId: `cpur_${id}`,
    currentRelease: { releaseId: `rel-${id}`, packId: `pack-${id}`, version: '1.0.0' },
    showcaseVideos: [], recalledReleaseVersions: [], receiptVerification: 'verified',
    downloadAvailable: true, installState, installedVersion: null, missingDependencies: [],
  } as unknown as ContentStoreAccount['owned'][number]
}

function accountWith(rows: Array<ReturnType<typeof ownedRow>>): ContentStoreAccount {
  return { contentAccountId: 'acct_test', availableCredits: 0, contentSpendableCredits: 0, owned: rows } as unknown as ContentStoreAccount
}

describe('the Install all missing button gives feedback', () => {
  test('disables and shows live progress while its batch installs, then re-enables with a shrunk count and a plain failure note', async () => {
    const ContentLibraryView = await loadContentLibraryView()
    const products = [product('a'), product('b'), product('c')]
    const accountRef = ref<ContentStoreAccount>(accountWith([
      ownedRow('a', 'not_installed'), ownedRow('b', 'not_installed'), ownedRow('c', 'not_installed'),
    ]))
    const emitted: string[][] = []
    const gates = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
    const queue = useInstallQueue(releaseId => new Promise<void>((resolve, reject) => {
      gates.set(releaseId, { resolve, reject })
    }))

    const Wrapper = defineComponent({
      setup() {
        return () => h(ContentLibraryView, {
          headingId: 'owned-heading', title: 'Owned', products, account: accountRef.value,
          emptyTitle: 'none', emptyDescription: 'none', busyProductId: '', busyReleaseId: '',
          showInstallAll: true, queueStatus: queue.statusOf,
          onInstallMany: (ids: string[]) => { emitted.push(ids); queue.enqueueAll(ids) },
        })
      },
    })
    const rendered = await mount(Wrapper)
    const button = () => rendered.host.querySelector<HTMLButtonElement>('button.install-all')!
    const settle = () => new Promise(resolve => setTimeout(resolve, 0))

    // Today's code (before this fix) has no busy state at all: the button
    // never disables and never says anything beyond the static count, which
    // is the exact bug reported — this assertion block is what fails against it.
    assert.equal(button().textContent, 'Install all missing (3)')
    assert.equal(button().disabled, false)

    button().click()
    await nextTick()
    assert.deepEqual(emitted, [['rel-a', 'rel-b', 'rel-c']], 'the button must still hand the whole batch to the queue')
    assert.equal(button().disabled, true, 'the button must disable itself while its own batch is running')
    assert.match(button().textContent || '', /Installing 0 of 3…/)

    // rel-a succeeds — the account is refreshed the way applyOverview does
    // after a real install, so the missing count can shrink honestly.
    gates.get('rel-a')!.resolve()
    accountRef.value = accountWith([
      ownedRow('a', 'installed_current'), ownedRow('b', 'not_installed'), ownedRow('c', 'not_installed'),
    ])
    await settle(); await nextTick(); await nextTick()
    assert.equal(button().disabled, true)
    assert.match(button().textContent || '', /Installing 1 of 3…/)

    // rel-b fails — the queue keeps going rather than stranding rel-c.
    gates.get('rel-b')!.reject(new Error('install refused'))
    await settle(); await nextTick(); await nextTick()
    assert.equal(button().disabled, true)
    assert.match(button().textContent || '', /Installing 2 of 3…/)

    // rel-c succeeds and the batch is done.
    gates.get('rel-c')!.resolve()
    accountRef.value = accountWith([
      ownedRow('a', 'installed_current'), ownedRow('b', 'not_installed'), ownedRow('c', 'installed_current'),
    ])
    await settle(); await nextTick(); await nextTick()

    assert.equal(button().disabled, false, 'the button re-enables once its batch is done')
    assert.equal(button().textContent, 'Install all missing (1)', 'the recomputed missing count shrank to the one that failed')
    assert.match(
      rendered.host.textContent || '',
      /1 install failed\. Open the pack and try again\./,
      'a failure must be stated plainly, not silently dropped',
    )

    const liveRegion = rendered.host.querySelector('.install-all-group')
    assert.equal(liveRegion?.getAttribute('role'), 'status')
    assert.equal(liveRegion?.getAttribute('aria-live'), 'polite')

    // Dismissing the finished-installs strip clears the queue's results back to idle. The button
    // used to read that as "0 of 3 done, still running" and stay disabled until the tab changed.
    queue.clearFinished()
    await nextTick(); await nextTick()
    assert.equal(button().disabled, false, 'Dismiss must not lock the button')
    assert.equal(button().textContent, 'Install all missing (1)')

    rendered.unmount()
  })
})
