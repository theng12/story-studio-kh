#!/usr/bin/env node
// Walks content-packs/**/pack.json + their content/*.json documents and emits a
// compact, token-efficient catalogue of every content pack item we already
// have, so a future session can compare a new style/lettering/thumbnail/topic
// idea against the existing shelf without re-reading pack files.
//
// Regenerate: npm run content-pack:index
//
// Design notes:
// - A pack_id can have several historical version snapshots kept on disk as
//   sibling directories (e.g. `ancient-humans`, `ancient-humans-v1.0.0`,
//   `ancient-humans-v1.0.2`) for immutable-build/receipt reasons. Only the
//   highest semver version per pack_id is "the shelf" going forward, so the
//   index keeps one row per item id, sourced from that highest-version
//   directory. Older snapshots are not listed.
// - A pack's items live under `<pack dir>/content/*.json` (one JSON document
//   per item, tagged with a `kind` field). A Channel Kit's items instead live
//   inline in `pack.json`'s `bundles[].components`; the bundle itself becomes
//   one `channel-kit` row.

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const contentPacksRoot = join(repoRoot, 'content-packs')
const outMd = join(repoRoot, 'docs/catalogue/content-pack-index.md')
const outJson = join(repoRoot, 'docs/catalogue/content-pack-index.json')

// Preferred group order for the markdown output. Any kind not listed here
// (e.g. a new ContentPackItemKindSchema entry) still gets its own section,
// appended after these.
const KIND_ORDER = [
  'visual-style',
  'lettering-style',
  'thumbnail-recipe',
  'series-formula',
  'metadata-formula',
  'topic-pack',
  'channel-kit',
  'subtitle-style',
  'scene-effect',
  'overlay',
]

const KIND_LABELS = {
  'visual-style': 'Visual styles',
  'lettering-style': 'Lettering styles',
  'thumbnail-recipe': 'Thumbnail recipes',
  'series-formula': 'Series formulas',
  'metadata-formula': 'Metadata formulas',
  'topic-pack': 'Topic packs',
  'channel-kit': 'Channel kits',
  'subtitle-style': 'Subtitle styles',
  'scene-effect': 'Scene effects',
  'overlay': 'Overlays',
}

async function findPackJsonFiles(dir) {
  const found = []
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...await findPackJsonFiles(full))
    } else if (entry.isFile() && entry.name === 'pack.json') {
      found.push(full)
    }
  }
  return found
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

function oneLine(text, maxChars) {
  if (!text) return '-'
  const flat = String(text).replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  return `${flat.slice(0, maxChars - 1).trimEnd()}…`
}

function axisFor(doc) {
  if (doc.category) return doc.category
  if (Array.isArray(doc.tags) && doc.tags.length) return doc.tags.join(', ')
  if (doc.axis) return doc.axis
  if (doc.formula_family) return doc.formula_family
  if (doc.architecture) return oneLine(doc.architecture, 60)
  return '-'
}

async function loadPackDirs() {
  const packJsonFiles = await findPackJsonFiles(contentPacksRoot)
  const byPackId = new Map()
  for (const packJsonPath of packJsonFiles) {
    const dir = dirname(packJsonPath)
    let manifest
    try {
      manifest = await readJson(packJsonPath)
    } catch (error) {
      console.error(`skipping unreadable pack.json: ${packJsonPath} (${error.message})`)
      continue
    }
    const packId = manifest.pack_id
    if (!packId) {
      console.error(`skipping pack.json with no pack_id: ${packJsonPath}`)
      continue
    }
    const existing = byPackId.get(packId)
    if (!existing || compareSemver(manifest.version, existing.manifest.version) > 0) {
      byPackId.set(packId, { dir, manifest })
    }
  }
  return [...byPackId.values()]
}

async function itemsInDir(dir) {
  const contentDir = join(dir, 'content')
  let entries = []
  try {
    entries = await readdir(contentDir, { withFileTypes: true })
  } catch {
    return []
  }
  const items = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = join(contentDir, entry.name)
    let doc
    try {
      doc = await readJson(path)
    } catch (error) {
      console.error(`skipping unreadable content document: ${path} (${error.message})`)
      continue
    }
    if (!doc.kind || !doc.id) {
      console.error(`skipping content document missing kind/id: ${path}`)
      continue
    }
    items.push({
      kind: doc.kind,
      id: doc.id,
      name: doc.name || doc.id,
      axis: axisFor(doc),
      description: oneLine(doc.description, 120),
    })
  }
  return items
}

function bundleItems(manifest) {
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : []
  return bundles.map((bundle) => {
    const kindsInOrder = [...new Set(bundle.components.map((component) => component.kind))]
    return {
      kind: bundle.kind || 'channel-kit',
      id: bundle.id,
      name: bundle.name || bundle.id,
      axis: kindsInOrder.join('+'),
      description: oneLine(`Bundles ${bundle.components.length} components: ${kindsInOrder.join(', ')}.`, 120),
    }
  })
}

async function buildCatalogue() {
  const packDirs = await loadPackDirs()
  const rows = []
  for (const { dir, manifest } of packDirs) {
    const collectionDir = relative(contentPacksRoot, dir)
    const items = [...await itemsInDir(dir), ...bundleItems(manifest)]
    for (const item of items) {
      rows.push({
        kind: item.kind,
        id: item.id,
        name: item.name,
        collection_dir: collectionDir,
        axis: item.axis,
        description: item.description,
        version: manifest.version,
        lifecycle: manifest.lifecycle,
      })
    }
  }
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  return rows
}

function renderMarkdown(rows) {
  const byKind = new Map()
  for (const row of rows) {
    if (!byKind.has(row.kind)) byKind.set(row.kind, [])
    byKind.get(row.kind).push(row)
  }
  const kindsPresent = [...byKind.keys()]
  const orderedKinds = [
    ...KIND_ORDER.filter((k) => byKind.has(k)),
    ...kindsPresent.filter((k) => !KIND_ORDER.includes(k)).sort(),
  ]

  const lines = []
  lines.push('# Content pack index')
  lines.push('')
  lines.push(`Regenerate: \`npm run content-pack:index\` (runs \`node scripts/content-packs/index.mjs\`)`)
  lines.push(`Generated: ${new Date().toISOString().slice(0, 10)}`)
  lines.push('')
  lines.push('One line per pack item, deduped to the highest version per `pack_id`. Format:')
  lines.push('')
  lines.push('`- <id> | <name> | <collection dir> | <category/tags or axis> | <description> | v<version> <lifecycle>`')
  lines.push('')
  const counts = orderedKinds.map((k) => `${KIND_LABELS[k] || k}: ${byKind.get(k).length}`).join(', ')
  lines.push(`Totals — ${rows.length} items. ${counts}.`)
  lines.push('')

  for (const kind of orderedKinds) {
    const label = KIND_LABELS[kind] || kind
    const kindRows = byKind.get(kind)
    lines.push(`## ${label} (${kindRows.length})`)
    lines.push('')
    for (const row of kindRows) {
      lines.push(`- ${row.id} | ${row.name} | ${row.collection_dir} | ${row.axis} | ${row.description} | v${row.version} ${row.lifecycle}`)
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd() + '\n'
}

async function main() {
  const rows = await buildCatalogue()
  await mkdir(dirname(outMd), { recursive: true })
  await writeFile(outMd, renderMarkdown(rows), 'utf8')
  await writeFile(outJson, JSON.stringify({ generated: new Date().toISOString(), count: rows.length, items: rows }, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${rows.length} items to ${relative(repoRoot, outMd)} and ${relative(repoRoot, outJson)}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
