/**
 * The owner's Content Store reached 65 packs and became unusable as a flat
 * grid: "they are just like everywhere. we can't know if it's a visual style or
 * topic pack or thumbnail recipe or series formula though." He also asked to
 * queue installs rather than wait for each one, and for a way to install
 * everything still missing from this Mac.
 */
import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import {
  filterByInstallState,
  groupProductsByKind,
  isInstalledHere,
  missingInstallReleaseIds,
  type OwnershipLookup,
} from '../content-store/library-organisation'
import { useInstallQueue } from '../composables/useInstallQueue'
import type { ContentStoreProduct } from '../composables/useContentStore'

function product(overrides: Partial<ContentStoreProduct> & { productId: string }): ContentStoreProduct {
  return {
    title: overrides.productId, summary: '', description: '', kind: 'visual_style',
    entitlementFamily: `family.${overrides.productId}`, owned: true, retired: false,
    compatible: true, compatibilityReason: '', free: false,
    currentRelease: { releaseId: `rel-${overrides.productId}`, version: '1.0.0' },
    presentation: {},
    ...overrides,
  } as unknown as ContentStoreProduct
}

const installedHere: OwnershipLookup = p => ({ installState: 'installed_current', currentReleaseId: p.currentRelease?.releaseId ?? null })
const notInstalled: OwnershipLookup = p => ({ installState: 'not_installed', currentReleaseId: p.currentRelease?.releaseId ?? null })

describe('grouping a library by what a thing actually is', () => {
  test('groups by kind in build order, formula first and Kits last', () => {
    const groups = groupProductsByKind([
      product({ productId: 'kit', kind: 'niche_bundle' }),
      product({ productId: 'style', kind: 'visual_style' }),
      product({ productId: 'formula', kind: 'series_formula' }),
      product({ productId: 'topic', kind: 'topic_pack' }),
      product({ productId: 'recipe', kind: 'thumbnail_recipe' }),
      // Ask 2, 2026-09-22 — metadata formulas became a Store kind. They sort
      // beside the other formula, before anything visual.
      product({ productId: 'write-up', kind: 'metadata_formula' }),
    ])
    assert.deepEqual(groups.map(group => group.label), [
      'Series Formula', 'Topic Pack', 'Metadata Formula', 'Visual Style', 'Thumbnail Recipe', 'Channel Kit',
    ])
    // Order is fixed rather than alphabetical or input order, so a section does
    // not move about as the library grows.
    assert.deepEqual(groups.map(group => group.products.length), [1, 1, 1, 1, 1, 1])
  })

  test('a kind with nothing in it is not shown as an empty heading', () => {
    const groups = groupProductsByKind([product({ productId: 'only', kind: 'topic_pack' })])
    assert.deepEqual(groups.map(group => group.label), ['Topic Pack'])
  })

  test('an unknown kind is still shown, never dropped', () => {
    // A pack the customer paid for must not disappear because this build does
    // not recognise its kind yet.
    const groups = groupProductsByKind([
      product({ productId: 'known', kind: 'visual_style' }),
      product({ productId: 'future', kind: 'sound_pack' as never }),
    ])
    assert.deepEqual(groups.map(group => group.label), ['Visual Style', 'Other'])
    assert.equal(groups[1]!.products[0]!.productId, 'future')
  })
})

describe('what is still missing from this Mac', () => {
  test('an owned pack that is not installed is missing', () => {
    const rows = [product({ productId: 'a' }), product({ productId: 'b' })]
    assert.deepEqual(missingInstallReleaseIds(rows, notInstalled), ['rel-a', 'rel-b'])
  })

  test('an installed pack is not missing', () => {
    assert.deepEqual(missingInstallReleaseIds([product({ productId: 'a' })], installedHere), [])
  })

  test('an older version installed still counts as missing', () => {
    // The bytes on this Mac are not the release the account owns, which is
    // exactly what "install the missing ones" is asking about.
    const stale: OwnershipLookup = () => ({ installState: 'installed_other_version', currentReleaseId: null })
    assert.deepEqual(missingInstallReleaseIds([product({ productId: 'a' })], stale), ['rel-a'])
    const upgradable: OwnershipLookup = () => ({ installState: 'update_available', currentReleaseId: null })
    assert.deepEqual(missingInstallReleaseIds([product({ productId: 'a' })], upgradable), ['rel-a'])
  })

  test('an incompatible or unavailable pack is never queued', () => {
    // Offering to install something this Story Studio cannot run would queue a
    // guaranteed failure.
    assert.deepEqual(missingInstallReleaseIds([product({ productId: 'a', compatible: false })], notInstalled), [])
    const unavailable: OwnershipLookup = () => ({ installState: 'unavailable', currentReleaseId: null })
    assert.deepEqual(missingInstallReleaseIds([product({ productId: 'a' })], unavailable), [])
  })

  test('two products sharing a release queue it once', () => {
    const shared = [
      product({ productId: 'a', currentRelease: { releaseId: 'rel-shared', version: '1.0.0' } as never }),
      product({ productId: 'b', currentRelease: { releaseId: 'rel-shared', version: '1.0.0' } as never }),
    ]
    assert.deepEqual(missingInstallReleaseIds(shared, notInstalled), ['rel-shared'])
  })
})

describe('filtering by whether it is on this Mac', () => {
  const rows = [product({ productId: 'here' }), product({ productId: 'away' })]
  const mixed: OwnershipLookup = p => ({ installState: p.productId === 'here' ? 'installed_current' : 'not_installed', currentReleaseId: null })

  test('installed, not installed, and all', () => {
    assert.deepEqual(filterByInstallState(rows, mixed, 'installed').map(p => p.productId), ['here'])
    assert.deepEqual(filterByInstallState(rows, mixed, 'not_installed').map(p => p.productId), ['away'])
    assert.deepEqual(filterByInstallState(rows, mixed, 'all').map(p => p.productId), ['here', 'away'])
  })

  test('a product GenStudio has said nothing about is not claimed as installed', () => {
    assert.equal(isInstalledHere(rows[0]!, () => null), false)
  })
})

describe('the install queue', () => {
  test('several clicks run one after another, in the order they were clicked', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const queue = useInstallQueue(async (id) => { order.push(id); if (order.length === 1) await gate })

    queue.enqueue('one'); queue.enqueue('two'); queue.enqueue('three')
    // The second and third are accepted immediately rather than refused while
    // the first is still running -- that is the whole point of the change.
    assert.equal(queue.statusOf('one'), 'installing')
    assert.equal(queue.statusOf('two'), 'queued')
    assert.equal(queue.statusOf('three'), 'queued')
    assert.equal(queue.pendingCount.value, 3)

    release()
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(order, ['one', 'two', 'three'])
    assert.equal(queue.pendingCount.value, 0)
    assert.equal(queue.statusOf('one'), 'installed')
  })

  test('one failure does not strand the rest of the batch', async () => {
    const seen: string[] = []
    const queue = useInstallQueue(async (id) => {
      seen.push(id)
      if (id === 'bad') throw new Error('install refused')
    })
    queue.enqueueAll(['good', 'bad', 'alsogood'])
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.deepEqual(seen, ['good', 'bad', 'alsogood'])
    assert.equal(queue.statusOf('bad'), 'failed')
    assert.equal(queue.statusOf('alsogood'), 'installed')
    assert.equal(queue.failedCount.value, 1)
  })

  test('clicking the same pack twice does not install it twice', async () => {
    let calls = 0
    const queue = useInstallQueue(async () => { calls += 1 })
    queue.enqueue('same'); queue.enqueue('same')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls, 1)
  })

  test('a release that failed can be enqueued again', async () => {
    let attempts = 0
    const queue = useInstallQueue(async () => { attempts += 1; if (attempts === 1) throw new Error('once') })
    queue.enqueue('retry')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(queue.statusOf('retry'), 'failed')
    queue.enqueue('retry')
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(queue.statusOf('retry'), 'installed')
    assert.equal(attempts, 2)
  })
})
