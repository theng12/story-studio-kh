/**
 * Studio Library browsable pack grid — the rules under the cards.
 *
 * Owner, 2026-10-30: "the studio library packs are all text and no images, so
 * it's hard to know which one is which. can we have it as a browse-able view
 * too?" The archive bank lists one row per VERSION, so the same pack appeared
 * twice (1.0.0 and 1.0.1) and showed no picture at all.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  buildLibraryCards,
  compareVersions,
  coverProxyPath,
  filterLibraryCards,
  libraryInstallOptions,
  libraryKindOptions,
  orderLibraryCards,
} from '../content-store/pack-browsing'
import type { ContentStoreInstalledPack, ContentStoreProduct, GatewayContentArchive } from '../composables/useContentStore'

function archive(overrides: Partial<GatewayContentArchive> & { packId: string; version: string }): GatewayContentArchive {
  return {
    archiveSha256: `sha-${overrides.packId}-${overrides.version}`,
    bytes: 1024,
    title: '',
    minAppVersion: '1.0.843',
    itemKinds: [],
    integrity: 'verified',
    ...overrides,
  }
}

function product(overrides: Partial<ContentStoreProduct> & { productId: string }): ContentStoreProduct {
  return {
    title: overrides.productId, summary: '', description: '', kind: 'visual_style',
    entitlementFamily: `family.${overrides.productId}`, owned: true, retired: false,
    compatible: true, compatibilityReason: '', free: false,
    currentRelease: { releaseId: `rel-${overrides.productId}`, packId: overrides.productId, version: '1.0.0' },
    presentation: { cover: null, hero: null, licenseLabel: null, licenseText: null, tags: [] },
    ...overrides,
  } as unknown as ContentStoreProduct
}

function installed(packId: string, version: string, overrides: Partial<ContentStoreInstalledPack> = {}): ContentStoreInstalledPack {
  return { packId, version, active: true, installState: 'installed_current', missingDependencies: [], productId: packId, title: packId, kind: 'visual_style', ...overrides }
}

describe('one card per pack, newest version only', () => {
  test('two released versions of one pack are one card, and both versions stay reachable', () => {
    const cards = buildLibraryCards({
      archives: [
        archive({ packId: 'com.storystudio.pack.style.oil', version: '1.0.0', title: 'Academic Classical Oil' }),
        archive({ packId: 'com.storystudio.pack.style.oil', version: '1.0.1', title: 'Academic Classical Oil' }),
      ],
      products: [],
      installed: [],
    })
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.newest.version, '1.0.1')
    assert.deepEqual(cards[0]!.versions.map(row => row.version), ['1.0.1', '1.0.0'])
  })

  test('an archive with no pack id is still listed, keyed by its digest', () => {
    const cards = buildLibraryCards({
      archives: [archive({ packId: '', version: '1.0.0', archiveSha256: 'a'.repeat(64) })],
      products: [],
      installed: [],
    })
    assert.equal(cards.length, 1)
    assert.equal(cards[0]!.key, `sha:${'a'.repeat(64)}`)
    assert.equal(cards[0]!.title, 'Unnamed pack')
  })

  test('versions compare numerically, not as strings', () => {
    assert.ok(compareVersions('1.0.10', '1.0.9') > 0)
    assert.ok(compareVersions('1.2.0', '1.1.9') > 0)
    assert.equal(compareVersions('2.0.0', '2.0.0'), 0)
    assert.equal(compareVersions('not-semver', '1.0.0'), 0)
  })
})

describe('install state is measured, never assumed', () => {
  const archives = [archive({ packId: 'p', version: '1.2.0' })]

  test('no installed row is not installed', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [] })
    assert.equal(card!.installState, 'not_installed')
    assert.equal(card!.installedVersion, null)
  })

  test('an older installed version offers an update, and names the version on this Mac', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [installed('p', '1.0.0')] })
    assert.equal(card!.installState, 'update_available')
    assert.equal(card!.installedVersion, '1.0.0')
  })

  test('the same installed version is current', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [installed('p', '1.2.0')] })
    assert.equal(card!.installState, 'installed_current')
  })

  test('an incomplete install is repairable, not current', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [installed('p', '1.2.0', { installState: 'incomplete' })] })
    assert.equal(card!.installState, 'incomplete')
  })

  test('installed rows with no active version report an inconsistent state, not "current"', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [installed('p', '1.2.0', { active: false })] })
    assert.equal(card!.installState, 'incomplete')
    assert.equal(card!.installedVersion, null)
  })

  test('an unresolved local read reads "checking", never "not installed"', () => {
    const [card] = buildLibraryCards({ archives, products: [], installed: [], installsResolved: false })
    assert.equal(card!.installState, 'unchecked')
    // It is not counted as installed or as missing from this Mac either way.
    assert.equal(filterLibraryCards([card!], { install: 'not_installed' }).length, 0)
    assert.equal(libraryInstallOptions([card!]).find(option => option.id === 'unchecked')?.count, 1)
  })
})

describe('covers are real or absent, never invented', () => {
  test('a pack the catalogue publishes no cover for has no cover', () => {
    const [card] = buildLibraryCards({
      archives: [archive({ packId: 'p', version: '1.0.0' })],
      products: [product({ productId: 'p', kind: 'topic_pack' })],
      installed: [],
    })
    assert.equal(card!.cover, null)
  })

  test('a published cover resolves to the Story-hosted path, not the Gateway URL', () => {
    const [card] = buildLibraryCards({
      archives: [archive({ packId: 'p', version: '1.0.0' })],
      products: [product({
        productId: 'p', kind: 'series_formula', title: 'Sleep Story',
        currentRelease: { releaseId: 'r', packId: 'p', version: '1.0.0' } as ContentStoreProduct['currentRelease'],
        presentation: { cover: { src: 'https://shelf.example.test/media/p.webp', alt: 'Moonlit cottage' }, hero: null, licenseLabel: null, licenseText: null, tags: [] },
      })],
      installed: [],
    })
    assert.deepEqual(card!.cover, { src: coverProxyPath('p', '1.0.0'), alt: 'Moonlit cottage' })
    assert.equal(card!.kindLabel, 'Series Formula')
    assert.equal(card!.title, 'Sleep Story')
  })

  test('an unknown size stays null, never a zero', () => {
    const [card] = buildLibraryCards({ archives: [archive({ packId: 'p', version: '1.0.0', bytes: null })], products: [], installed: [] })
    assert.equal(card!.sizeBytes, null)
  })
})

describe('filters and search read what the card really is', () => {
  const cards = buildLibraryCards({
    archives: [
      archive({ packId: 'formula.sleep', version: '1.0.0', title: 'Sleep Story', itemKinds: ['series-formula'] }),
      archive({ packId: 'topic.animals', version: '1.0.0', title: 'Animals', itemKinds: ['topic-pack'] }),
      archive({ packId: 'style.oil', version: '1.0.0', title: 'Oil', itemKinds: ['visual-style'] }),
    ],
    products: [
      product({ productId: 'formula.sleep', kind: 'series_formula', title: 'Sleep Story', summary: 'Gentle bedtime narratives' }),
      product({ productId: 'topic.animals', kind: 'topic_pack', title: 'Animals', summary: 'Vertebrate and invertebrate animal lives' }),
      product({ productId: 'style.oil', kind: 'visual_style', title: 'Oil', summary: 'Classical oil painting' }),
    ],
    installed: [installed('style.oil', '1.0.0')],
  })

  test('kind filter keeps only that kind', () => {
    assert.deepEqual(filterLibraryCards(cards, { kind: 'topic_pack' }).map(card => card.title), ['Animals'])
  })

  test('search matches the title, the summary and the kind name', () => {
    assert.deepEqual(filterLibraryCards(cards, { query: 'sleep' }).map(card => card.title), ['Sleep Story'])
    assert.deepEqual(filterLibraryCards(cards, { query: 'invertebrate' }).map(card => card.title), ['Animals'])
    assert.deepEqual(filterLibraryCards(cards, { query: 'visual style' }).map(card => card.title), ['Oil'])
  })

  test('install filter separates what is here from what is not', () => {
    assert.deepEqual(filterLibraryCards(cards, { install: 'installed_current' }).map(card => card.title), ['Oil'])
    assert.equal(filterLibraryCards(cards, { install: 'not_installed' }).length, 2)
    assert.equal(filterLibraryCards(cards, { install: 'update_available' }).length, 0)
    // "On this Mac" is the aggregate a person means, and it includes a pack
    // whose installed copy needs repair.
    assert.deepEqual(filterLibraryCards(cards, { install: 'on_mac' }).map(card => card.title), ['Oil'])
  })

  test('kind and install filters combine', () => {
    assert.equal(filterLibraryCards(cards, { kind: 'series_formula', install: 'installed_current' }).length, 0)
  })

  test('kind options count the packs present and never list an empty kind', () => {
    const options = libraryKindOptions(cards)
    assert.deepEqual(options.map(option => [option.id, option.count]), [
      ['all', 3], ['series_formula', 1], ['topic_pack', 1], ['visual_style', 1],
    ])
  })

  test('the repair chip only appears when a pack needs repair', () => {
    assert.deepEqual(libraryInstallOptions(cards).map(option => option.id), ['all', 'not_installed', 'update_available', 'on_mac'])
    const damaged = buildLibraryCards({
      archives: [archive({ packId: 'p', version: '1.0.0' })],
      products: [],
      installed: [installed('p', '1.0.0', { installState: 'incomplete' })],
    })
    assert.ok(libraryInstallOptions(damaged).some(option => option.id === 'incomplete'))
  })

  test('cards sort by kind then title, so a grid does not reshuffle on refresh', () => {
    const ordered = orderLibraryCards(cards)
    assert.deepEqual(ordered.map(card => card.kindLabel), ['Series Formula', 'Topic Pack', 'Visual Style'])
  })
})
