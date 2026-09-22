/**
 * A delivered `metadata_formula` product must reach the write-up, not just the
 * Store shelf.
 *
 * Ask 2 of the 2026-09-22 wire-kind parity letter. The owner's own request is
 * quoted at the top of `metadata-formula-catalogue.ts` — five built-in shapes,
 * more sold "in packs of 6 for 300 credits each" — and the runtime consumer,
 * pack schema and project pinning were already built. What was missing was the
 * WIRE kind: a delivered `metadata_formula` product could not be parsed at all.
 *
 * That kind is now on the wire (`PRODUCT_KINDS`). These tests drive the real
 * installer with a signed `metadata-formula` archive and assert the formula is
 * listable AND usable — schema validity alone would not prove the second half.
 */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, test } from 'node:test'

import JSZip from 'jszip'

import { installContentPack } from '../content-packs/installer.js'
import { createContentPackKeyring } from '../content-packs/keyring.js'
import { getContentPackRuntimePaths } from '../content-packs/runtime-paths.js'
import {
  metadataFormulaCatalogue,
  metadataFormulaPlan,
  resolveActiveMetadataFormula,
} from '../services/metadata-formula-catalogue.js'
import { buildDescriptionPrompt } from '../lib/metadata-prompt.js'
import { withMetadataFormulaShape } from '../services/metadata-formula-catalogue.js'
import { useTempDataDir } from './_helpers.js'

const PUBLISHER_ID = 'com.storystudio'
const KEY_ID = 'com.storystudio.test-metadata-formula-bridge'
const PACK_ID = 'com.storystudio.pack.metadata-formula.bridge-probe'
const PACK_VERSION = '2.0.0'
const FORMULA_ID = 'com.storystudio.metadata-formula.ledger-probe'
const ARCHITECTURE = 'A numbered ledger of claims, each with the support it rests on.'
const SECTION_INSTRUCTION = 'List what the episode establishes, one claim per line, strongest first.'

const keyPair = generateKeyPairSync('ed25519')
const policy = createContentPackKeyring([{
  keyId: KEY_ID,
  publisherId: PUBLISHER_ID,
  publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
}])

let cleanup: (() => Promise<void>) | undefined

afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The archive the Gateway would deliver for a `metadata_formula` product. */
async function buildMetadataFormulaArchive(): Promise<Uint8Array> {
  const document = Buffer.from(JSON.stringify({
    kind: 'metadata-formula',
    schema_version: 1,
    id: FORMULA_ID,
    name: 'Ledger',
    description: 'A running account of what the episode establishes.',
    architecture: ARCHITECTURE,
    description_plan: {
      max_chars: 1800,
      separator: 'rule',
      sections: [
        {
          id: 'entries',
          instruction: SECTION_INSTRUCTION,
          header: { render: true, text: 'The record' },
          target_chars: 400,
        },
        {
          id: 'closing',
          instruction: 'One sentence on what remains unsettled.',
          header: { render: false },
        },
      ],
    },
    title_plan: { mode: 'paraphrase', count: 3, max_length: 80, guidance: 'State the claim plainly.' },
    tag_plan: { count: 12, guidance: 'for this record-keeping episode' },
    tone: { constraints: ['Every claim must be one the episode supports.'] },
  }), 'utf8')
  const manifest = Buffer.from(JSON.stringify({
    pack_format: 1,
    pack_id: PACK_ID,
    publisher_id: PUBLISHER_ID,
    key_id: KEY_ID,
    version: PACK_VERSION,
    min_app_version: '1.4.216',
    lifecycle: 'active',
    entitlement: { sku: `${PACK_ID}.sku`, family: `${PACK_ID}.family` },
    bundles: [],
    items: [{ id: FORMULA_ID, kind: 'metadata-formula', schema_version: 1, path: 'content/formula.json' }],
    files: [
      { path: 'content/formula.json', sha256: sha256(document), bytes: document.byteLength, mime: 'application/json' },
    ],
  }), 'utf8')
  const zip = new JSZip()
  zip.file('manifest.json', manifest, { createFolders: false })
  zip.file('signature.ed25519', sign(null, manifest, keyPair.privateKey), { createFolders: false })
  zip.file('content/formula.json', document, { createFolders: false })
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', platform: 'UNIX' })
}

async function installDeliveredFormula(): Promise<ReturnType<typeof getContentPackRuntimePaths>> {
  const temp = await useTempDataDir()
  cleanup = temp.cleanup
  const paths = getContentPackRuntimePaths()
  const archiveBytes = await buildMetadataFormulaArchive()
  const result = await installContentPack(
    { archiveBytes, source: 'local-import', expectedArchiveSha256: sha256(archiveBytes) },
    { paths, policy },
  )
  assert.equal(result.activated, true, 'a delivered formula pack must activate')
  assert.equal(result.pack_id, PACK_ID)
  return paths
}

describe('a delivered metadata_formula product reaches the picker', () => {
  test('the installed formula lists beside the built-ins', async () => {
    const paths = await installDeliveredFormula()
    const rows = await metadataFormulaCatalogue({ paths, policy })
    const delivered = rows.find(row => row.id === FORMULA_ID)

    assert.ok(delivered, 'the delivered formula must appear in the catalogue')
    assert.equal(delivered.source, 'pack')
    assert.equal(delivered.packId, PACK_ID)
    assert.equal(delivered.architecture, ARCHITECTURE)
    assert.ok(rows.some(row => row.source === 'built-in'), 'the five free formulas must remain')
  })
})

describe('a delivered metadata_formula product reaches the write-up', () => {
  test('the delivered shape is what the description prompt is built from', async () => {
    const paths = await installDeliveredFormula()
    const entry = await resolveActiveMetadataFormula({
      requestedId: FORMULA_ID,
      config: null,
      options: { paths, policy },
    })
    assert.ok(entry, 'the customer’s chosen formula must resolve')
    assert.equal(entry!.id, FORMULA_ID)

    const plan = metadataFormulaPlan(entry!)
    assert.equal(plan.descriptionMaxChars, 1800)
    assert.equal(plan.sections.length, 2)
    assert.ok(
      plan.sections.some(section => String(section.config?.instructions || '').includes(SECTION_INSTRUCTION)),
      'the pack’s own section instruction must survive into the plan',
    )

    const prompt = buildDescriptionPrompt(
      'EP0001', 'A measured probe', 'story context', plan.sections as never,
      plan.descriptionMaxChars, withMetadataFormulaShape(null, plan, entry!.architecture),
    )
    assert.ok(prompt.includes(SECTION_INSTRUCTION),
      'the pack instruction must reach the prompt — that is what makes the pack worth buying')
    assert.ok(prompt.includes(ARCHITECTURE), 'and the shape it names must be stated')
  })

  test('a channel that picks nothing still generates exactly what it did before', async () => {
    const paths = await installDeliveredFormula()
    const entry = await resolveActiveMetadataFormula({ requestedId: undefined, config: null, options: { paths, policy } })
    assert.equal(entry, null, 'an unpicked formula changes nothing (the built-ins stay the default path)')
  })
})
