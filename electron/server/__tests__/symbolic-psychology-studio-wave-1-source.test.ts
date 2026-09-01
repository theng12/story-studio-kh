import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import sharp from 'sharp'

import { parseContentPackDocument } from '../content-packs/schemas.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const FORMULA_ROOT = path.join(ROOT, 'content-packs', 'free-starters', 'formula')
const PSYCHOLOGY_ROOT = path.join(ROOT, 'content-packs', 'psychology-editorial')
const STUDIO_ROOT = path.join(ROOT, 'content-packs', 'symbolic-psychology-studio')
const UNBLOCK_SDD_ROOT = path.join(ROOT, '.superpowers', 'sdd', '2026-08-23-symbolic-psychology-studio-unblock')
const EDITORIAL_ASSETS = [
  'editorial-psychology-symbolic-split-1.webp',
  'editorial-psychology-symbolic-split-2.webp',
  'editorial-psychology-symbolic-split-3.webp',
  'editorial-psychology-symbolic-split-5.webp',
  'pastel-surreal-psychological-collage.webp',
] as const
const EDITORIAL_HASHES = [
  'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277',
  'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb',
  '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290',
  'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492',
  '398cb595ce5c285570ce057cb81c86b73a739a5d220fc44a85faa7378b2e87ab',
] as const
const RECIPE_V1_SOURCE_HASHES = {
  'pack.json': '09800de2f8112da41eefb9dcdc76901d432643380382f4109ccd941c8323d2e5',
  'content/thumbnail-recipe.json': '74b3192de5c61d796d64f819bca3bb806a30728cdf9b49fddfd19240320a12f8',
  'assets/editorial-psychology-symbolic-split-1.webp': EDITORIAL_HASHES[0],
  'assets/editorial-psychology-symbolic-split-2.webp': EDITORIAL_HASHES[1],
  'assets/editorial-psychology-symbolic-split-3.webp': EDITORIAL_HASHES[2],
  'assets/editorial-psychology-symbolic-split-5.webp': EDITORIAL_HASHES[3],
} as const
const PASTEL_V1_SOURCE_HASHES = {
  'pack.json': '2528f1c88b65a64b86177acffaaabd031a9f671fe0351e9e60000c71dc8131a0',
  'content/visual-style.json': 'd12274ba7f5541226a8a9cdbdefd961679fbc1e90f08c7bfa4a5a75733e5751d',
  'assets/pastel-surreal-psychological-collage.webp': EDITORIAL_HASHES[4],
} as const
const HUMAN_BEHAVIOR_V1_SOURCE_HASHES = {
  'pack.json': '9a4dde3a8e889b537b19b45f006b9b981ed9e0982dc5852af705924ae7caa7be',
  'content/series-formula.json': 'bc008e06a736dda9e266c39ad4efd9af5df59103d7ac01ce0fb00d09a4961712',
} as const
const EDITORIAL_PROVENANCE_ROW_HASHES = {
  // Re-pinned 2026-08-26. These hash the ledger ROW TEXT, and the owner-identity
  // cleanse rewrote an absolute home path and a channel name inside these rows.
  // The asset bytes are unchanged and are still verified separately below, so the
  // provenance chain itself is intact -- only the wording of the record moved.
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-1.webp':
    'c92873cff96ad8ce2a74153a32e0f03eb8dc1c9b775606b406b351d74171a373',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-2.webp':
    '43dc83d998e85643dab592f63d28629d3d5b0eff5ab7705823d0f34878dc0547',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-3.webp':
    'cbe87243888b5589b49d26ee543190c332ffa1f47c952fcd4f1268929dadd1af',
  'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-5.webp':
    '2f27c35e378943726cc2258b7942bcc2fece339d22d25f273c190824fbf63ed1',
  'style/pastel-surreal-psychological-collage/assets/pastel-surreal-psychological-collage.webp':
    'a9044497df6d7130f6c354eac26327dbdf2a4c9309c1c51baa5b2a3087026779',
} as const
const NEW_EDITORIAL_PREVIEW_SHA256 = '13027e9088479b8fae570853724aebb44eff3ff2afbf53cd932577d837282bcd'
const NEW_PASTEL_PREVIEW_SHA256 = 'f0bd9dd66b09e37e1f7c542a48e6bec02697c9fcdf77ad6e2d11274d3c71f93a'
const HUMAN_BEHAVIOR = 'com.storystudio.formula.human-behavior-explained'
const IMPASTO_SHA256 = '27050a92b2b71afd9a238ccd8ac9e72497ba2dda576bd4ad05fd01e465178e07'
const OIL_ASSET = 'oil-painting-classical.webp'
const OIL_SHA256 = '721e0b45be473e1a9c868874c0e6662914f5b1ad4829748607268c520258615a'

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>
}

async function webpMetadata(file: string) {
  return sharp(file, { failOn: 'error' }).metadata()
}

test('immutable v1.0.0 Recipe and Pastel source and provenance bytes retain exact SHA-256 identities', async () => {
  const recipeRoot = path.join(PSYCHOLOGY_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split')
  const pastelRoot = path.join(PSYCHOLOGY_ROOT, 'style', 'pastel-surreal-psychological-collage')
  const ledger = await fs.readFile(path.join(PSYCHOLOGY_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  for (const [relativePath, expectedHash] of Object.entries(RECIPE_V1_SOURCE_HASHES)) {
    assert.equal(
      sha256(await fs.readFile(path.join(recipeRoot, relativePath))),
      expectedHash,
      `Recipe v1.0.0 ${relativePath} must remain byte-identical`,
    )
  }
  for (const [relativePath, expectedHash] of Object.entries(PASTEL_V1_SOURCE_HASHES)) {
    assert.equal(
      sha256(await fs.readFile(path.join(pastelRoot, relativePath))),
      expectedHash,
      `Pastel v1.0.0 ${relativePath} must remain byte-identical`,
    )
  }
  for (const [runtimePath, expectedHash] of Object.entries(EDITORIAL_PROVENANCE_ROW_HASHES)) {
    const matchingRows = ledger.split('\n').filter(line => line.includes(`\`${runtimePath}\``))
    assert.equal(matchingRows.length, 1, `${runtimePath} must have exactly one immutable provenance row`)
    assert.equal(sha256(Buffer.from(matchingRows[0]!)), expectedHash, `${runtimePath} provenance row must remain byte-identical`)
  }
})

test('Human Behavior Formula v1.0.1 changes only the receipt-authorized non-diagnostic token', async () => {
  const v100Root = path.join(FORMULA_ROOT, 'human-behavior-explained')
  const v101Root = path.join(FORMULA_ROOT, 'human-behavior-explained-v1.0.1')

  for (const [relativePath, expectedHash] of Object.entries(HUMAN_BEHAVIOR_V1_SOURCE_HASHES)) {
    assert.equal(
      sha256(await fs.readFile(path.join(v100Root, relativePath))),
      expectedHash,
      `Formula v1.0.0 ${relativePath} must remain byte-identical`,
    )
  }

  const v100Manifest = await readJson(path.join(v100Root, 'pack.json'))
  const v101Manifest = await readJson(path.join(v101Root, 'pack.json'))
  const v100 = await readJson(path.join(v100Root, 'content', 'series-formula.json'))
  const v101 = await readJson(path.join(v101Root, 'content', 'series-formula.json'))
  const v100Mood = (v100.vocabulary as { mood: string[] }).mood
  const v101Mood = (v101.vocabulary as { mood: string[] }).mood

  parseContentPackDocument('series-formula', v101)
  assert.equal(v101Manifest.version, '1.0.1')
  assert.equal(
    v101Manifest.changelog,
    'Replaces diagnostic tone vocabulary with explicitly non-diagnostic, evidence-aware language.',
  )
  assert.equal(v101Manifest.pack_id, v100Manifest.pack_id)
  assert.equal(v101Manifest.entitlement && (v101Manifest.entitlement as Record<string, unknown>).family,
    'com.storystudio.family.formula.human-behavior-explained')
  assert.equal(v101Manifest.entitlement && (v101Manifest.entitlement as Record<string, unknown>).sku,
    'com.storystudio.sku.formula.human-behavior-explained')
  assert.deepEqual(v101Manifest.dependencies, v100Manifest.dependencies)
  assert.equal(v101.id, v100.id)
  assert.equal(v100Mood.includes('diagnostic-but-warm'), true)
  assert.equal(v101Mood.includes('diagnostic-but-warm'), false)
  assert.equal(v101Mood.includes('non-diagnostic-and-warm'), true)
  assert.equal(v101Mood.length, v100Mood.length)

  const normalizedManifest = structuredClone(v101Manifest)
  normalizedManifest.version = '1.0.0'
  delete normalizedManifest.changelog
  assert.deepEqual(normalizedManifest, v100Manifest)

  const normalizedDocument = structuredClone(v101)
  const normalizedMood = (normalizedDocument.vocabulary as { mood: string[] }).mood
  normalizedMood[normalizedMood.indexOf('non-diagnostic-and-warm')] = 'diagnostic-but-warm'
  assert.deepEqual(normalizedDocument, v100)

  const nonDiagnosisSafeguards = [
    'Open with a recognizable behavior or tension, not a diagnosis or bait question.',
    'pseudo-clinical certainty',
    'Use examples without diagnosing the viewer.',
    'Avoid clinical jargon and sensational claims.',
    'never clinical jargon or diagnostic clickbait',
    'Lead with the observable behavior, not the diagnosis.',
    'never sensational, never diagnosing the viewer.',
    "diagnostic claims ('Are You a Narcissist?')",
  ]
  const serialized = JSON.stringify(v101)
  for (const safeguard of nonDiagnosisSafeguards) {
    assert.equal(serialized.includes(safeguard), true, `Formula v1.0.1 must retain safeguard: ${safeguard}`)
  }
})

test('leaf successor reservation is one receipt-bound batch with non-discoverable Recipe and Pastel scaffolds', async () => {
  const receiptRef = 'authoring:f12a9e8de181d536fe2e8367df5028460ce9e84948f43cc6978bfe5b5340bdfd'
  const request = await readJson(path.join(
    UNBLOCK_SDD_ROOT,
    'reservation-requests',
    'formula-recipe-pastel-v1.0.1.json',
  )) as {
    expected_revision: number
    coordinator: { task: string, branch: string }
    records: Array<Record<string, unknown> & { pack_id: string, version: string }>
  }
  assert.equal(request.expected_revision, 16)
  assert.deepEqual(request.coordinator, {
    task: 'symbolic-psychology-studio-unblock-leaf-successors',
    branch: 'codex/content-expansion-portfolio',
  })
  assert.deepEqual(request.records.map(record => `${record.pack_id}@${record.version}`), [
    'com.storystudio.pack.formula.human-behavior-explained@1.0.1',
    'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split@1.0.1',
    'com.storystudio.pack.style.pastel-surreal-psychological-collage@1.0.1',
  ])
  assert.equal(JSON.stringify(request).includes('component_summary'), false)

  const registry = await readJson(path.join(ROOT, 'content-packs', 'authoring-registry.json')) as {
    batches: Array<{
      revision: number
      receipt_ref: string
      request: { coordinator: { task: string }, records: Array<Record<string, unknown> & { pack_id: string }> }
    }>
  }
  const matchingBatches = registry.batches.filter(batch => (
    batch.request.coordinator.task === 'symbolic-psychology-studio-unblock-leaf-successors'
  ))
  assert.equal(matchingBatches.length, 1)
  const batch = matchingBatches[0]!
  assert.equal(batch.revision, 17)
  assert.equal(batch.receipt_ref, receiptRef)
  assert.deepEqual(batch.request, request)

  for (const record of request.records) {
    const basename = record.pack_id.replace(/^com\.storystudio\.pack\.(?:formula|thumbnail|style)\./, '')
    const identity = await readJson(path.join(
      UNBLOCK_SDD_ROOT,
      'expected-identities',
      `${basename}-v1.0.1.json`,
    ))
    assert.deepEqual(identity, record)
  }

  const scaffoldContracts = [
    {
      basename: 'editorial-psychology-symbolic-split',
      reservation: {
        pack_id: 'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split',
        version: '1.0.1',
        registry_revision: 17,
        receipt_ref: receiptRef,
        expected_identity_path: '.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/editorial-psychology-symbolic-split-v1.0.1.json',
        receipt_verified: true,
      },
      future_source_path: 'content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1',
      predecessor: {
        version: '1.0.0',
        source_path: 'content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split',
        files: [
          { path: 'pack.json', sha256: '09800de2f8112da41eefb9dcdc76901d432643380382f4109ccd941c8323d2e5' },
          { path: 'content/thumbnail-recipe.json', sha256: '74b3192de5c61d796d64f819bca3bb806a30728cdf9b49fddfd19240320a12f8' },
          { path: 'assets/editorial-psychology-symbolic-split-1.webp', sha256: 'f82c5659ca989b27af5cf789c6270b4ef40aa24ec6060f1a91e015374a52f277' },
          { path: 'assets/editorial-psychology-symbolic-split-2.webp', sha256: 'cf65e48ae0215b3ab8e4a331f91b0cc126ee8fc0dea63724836b6b0bd7a744fb' },
          { path: 'assets/editorial-psychology-symbolic-split-3.webp', sha256: '7d419bf83d807f8ce287040f51e5d620617e595f6bd09dc5ca7ee332252b6290' },
          { path: 'assets/editorial-psychology-symbolic-split-5.webp', sha256: 'b816e5ed7fb95eb16e16f95100e1e7b4840ee0f3f046e0d8eca4c766d820e492' },
        ],
        provenance_rows: [
          { runtime_asset_path: 'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-1.webp', sha256: 'd59ef8ea529691d8b249b26d9604951e5e134fc871f3471b911645a1913855d9' },
          { runtime_asset_path: 'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-2.webp', sha256: 'c2294ea7e93f02a261d53534304916a3c7693f52947490215c50cb1277d5ca9c' },
          { runtime_asset_path: 'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-3.webp', sha256: '81008d3cde7640ffb67c2b86f554282dc317db0f41de0df383b2f1ad66efe478' },
          { runtime_asset_path: 'thumbnail/editorial-psychology-symbolic-split/assets/editorial-psychology-symbolic-split-5.webp', sha256: 'bbb3dd072cc4ddc1550b0628e4bdc1dd6021a4eb3716a02871335e607c39a515' },
        ],
      },
      required_returned_evidence: [
        'owner_approval_of_exact_prompt_batch',
        'exact_quote_and_owner_quote_approval',
        'job_submission_and_generation_authority',
        'untouched_original_raster',
        'job_or_request_id',
        'exact_prompt_batch_and_sha256',
        'full_submitted_prompt_and_sha256',
        'published_receiver_provider_and_model',
        'execution_timestamp',
        'seed_if_published',
        'cost_receipt',
        'license_and_rights_basis',
        'no_reference_or_compositing_declaration',
        'original_raster_sha256',
        'original_dimensions_file_type_and_byte_size',
        'strict_decode_result',
      ],
      preview_acceptance_contract: [
        'One completely original full-frame 16:9 raster suitable for deterministic whole-image conversion to 1672x941 WebP.',
        'Exactly one fragmented porcelain mannequin head and shoulders is on the far right, in three-quarter profile at medium-long distance, facing inward.',
        'The left two-thirds remain sparse and uncluttered as the dominant title band.',
        'The complete exact headline HIDDEN MOTIVES is rendered in-image on one unbroken line with no other words, clipping, or malformed text.',
        "The result materially expands the existing gallery's subject side, camera angle, distance, and one-line hierarchy diversity.",
        'No reference or saved image, rejected preview bytes, copied composition, compositing, masking, title plate, post-render overlay, logo, watermark, or UI is permitted.',
      ],
    },
    {
      basename: 'pastel-surreal-psychological-collage',
      reservation: {
        pack_id: 'com.storystudio.pack.style.pastel-surreal-psychological-collage',
        version: '1.0.1',
        registry_revision: 17,
        receipt_ref: receiptRef,
        expected_identity_path: '.superpowers/sdd/2026-08-23-symbolic-psychology-studio-unblock/expected-identities/pastel-surreal-psychological-collage-v1.0.1.json',
        receipt_verified: true,
      },
      future_source_path: 'content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1',
      predecessor: {
        version: '1.0.0',
        source_path: 'content-packs/psychology-editorial/style/pastel-surreal-psychological-collage',
        files: [
          { path: 'pack.json', sha256: '2528f1c88b65a64b86177acffaaabd031a9f671fe0351e9e60000c71dc8131a0' },
          { path: 'content/visual-style.json', sha256: 'd12274ba7f5541226a8a9cdbdefd961679fbc1e90f08c7bfa4a5a75733e5751d' },
          { path: 'assets/pastel-surreal-psychological-collage.webp', sha256: '398cb595ce5c285570ce057cb81c86b73a739a5d220fc44a85faa7378b2e87ab' },
        ],
        provenance_rows: [
          { runtime_asset_path: 'style/pastel-surreal-psychological-collage/assets/pastel-surreal-psychological-collage.webp', sha256: '5df384239d53293a76a5c92c4465347b693b1586ce2c2a4a3f7f0ededf9be723' },
        ],
      },
      required_returned_evidence: [
        'owner_approval_of_literal_prompt_batch_and_hash',
        'exact_quote_and_owner_quote_approval',
        'job_submission_and_generation_authority',
        'untouched_original_raster',
        'job_or_request_id',
        'literal_prompt_batch_and_sha256',
        'full_submitted_prompt_and_sha256',
        'published_receiver_provider_and_model',
        'execution_timestamp',
        'seed_if_published',
        'cost_receipt',
        'license_and_rights_basis',
        'no_reference_or_compositing_declaration',
        'original_raster_sha256',
        'original_dimensions_file_type_and_byte_size',
        'strict_decode_result',
      ],
      preview_acceptance_contract: [
        'One completely original text-free full-frame 16:9 raster suitable for deterministic whole-image conversion to 1672x941 WebP.',
        'The medium is a matte mixed-media psychological collage with paper-like tactile grain, dry painterly and sculptural traces, subtle erosion, restrained blur, and clear low-saturation figure-ground separation.',
        'The palette is limited to dusty peach, mauve, lavender, pale blue, cream, charcoal, and warm gray, with ember orange only as a restrained accent.',
        'The composition contains one sparse fragmented or eroded portrait, mask, mannequin, silhouette, door, flame, sculptural human trace, or abstract emotional object.',
        'Glossy CGI, wet or heavy impasto, photoreal stock imagery, neon color, crowded scenes, typography, copied trade dress, malformed anatomy or text, logos, and watermarks are rejected.',
        'No reference or saved image, Editorial source, image edit, compositing, masking, title plate, post-render overlay, logo, watermark, or UI is permitted.',
      ],
    },
  ] as const

  for (const contract of scaffoldContracts) {
    const scaffold = await readJson(path.join(
      UNBLOCK_SDD_ROOT,
      'source-scaffolds',
      `${contract.basename}-v1.0.1.json`,
    ))
    assert.equal(scaffold.schema_version, 1)
    assert.deepEqual(scaffold.reservation, contract.reservation)
    assert.equal(scaffold.future_source_path, contract.future_source_path)
    assert.deepEqual(scaffold.predecessor, contract.predecessor)
    assert.deepEqual(scaffold.required_returned_evidence, contract.required_returned_evidence)
    assert.deepEqual(scaffold.preview_acceptance_contract, contract.preview_acceptance_contract)
    // 2026-08-28 — this used to be pinned to `false` while the preview-evidence gate was open.
    // It is now derived from the returned evidence itself, which is strictly stronger than any
    // hardcoded boolean: the flag may only be true when every required evidence item is present
    // and the preview was accepted. Inverted deliberately, not deleted.
    const evidenceName = contract.basename === 'editorial-psychology-symbolic-split'
      ? 'image-1-editorial'
      : 'image-2-pastel'
    const record = await readJson(path.join(UNBLOCK_SDD_ROOT, 'returned-evidence', `${evidenceName}.evidence.json`)) as {
      acceptance_verdict: string
      attempts_used: number
      evidence: Record<string, unknown>
    }
    for (const item of contract.required_returned_evidence) {
      assert.ok(record.evidence[item] !== undefined, `${evidenceName} must return evidence item ${item}`)
    }
    assert.equal(record.acceptance_verdict, 'ACCEPT')
    assert.ok(record.attempts_used >= 1 && record.attempts_used <= 3, 'attempts must stay within the evidenced budget')
    const batchKey = contract.required_returned_evidence.find(item => item.endsWith('prompt_batch_and_sha256'))!
    const batch = record.evidence[batchKey] as { sha256: string }
    const submitted = record.evidence.full_submitted_prompt_and_sha256 as { sha256: string, prompt: string }
    assert.equal(submitted.sha256, batch.sha256, 'the submitted prompt must hash to the owner-approved batch')
    assert.equal(sha256(Buffer.from(submitted.prompt, 'utf8')), batch.sha256, 'the recorded prompt text must reproduce that hash')
    assert.equal(scaffold.registry_transition_allowed, true)
    assert.equal(JSON.stringify(scaffold).includes('component_summary'), false)
  }

  // The two creative leaves are independently authored. The unsold coordinator is
  // withdrawn in the later legacy-closure pass, so its source cannot remain beside them.
  for (const [successorPath, expectedPackId] of [
    ['content-packs/psychology-editorial/thumbnail/editorial-psychology-symbolic-split-v1.0.1',
      'com.storystudio.pack.thumbnail.editorial-psychology-symbolic-split'],
    ['content-packs/psychology-editorial/style/pastel-surreal-psychological-collage-v1.0.1',
      'com.storystudio.pack.style.pastel-surreal-psychological-collage'],
  ] as const) {
    const manifest = await readJson(path.join(ROOT, successorPath, 'pack.json'))
    assert.equal(manifest.pack_id, expectedPackId, `${successorPath} must declare its reserved pack id`)
    assert.equal(manifest.version, '1.0.1', `${successorPath} must be the 1.0.1 successor`)
    assert.equal(manifest.publisher_id, 'com.storystudio')
    assert.ok(typeof manifest.changelog === 'string' && manifest.changelog.length > 0,
      `${successorPath} must state what changed`)
  }
  await assert.rejects(
    fs.access(path.join(STUDIO_ROOT, 'kit', 'symbolic-psychology-studio-v1.0.1')),
    { code: 'ENOENT' },
  )
})

test('v1.0.1 successors carry the approved generated previews at the family WebP standard', async () => {
  const thumbRoot = path.join(PSYCHOLOGY_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split-v1.0.1')
  const styleRoot = path.join(PSYCHOLOGY_ROOT, 'style', 'pastel-surreal-psychological-collage-v1.0.1')

  const thumbDocument = await readJson(path.join(thumbRoot, 'content', 'thumbnail-recipe.json'))
  parseContentPackDocument('thumbnail-recipe', thumbDocument)
  // The rejected preview #4 slot stays permanently vacant, so the new gallery entry is -6.
  assert.deepEqual(thumbDocument.preview_assets, [
    ...EDITORIAL_ASSETS.slice(0, 4).map(asset => `assets/${asset}`),
    'assets/editorial-psychology-symbolic-split-6.webp',
  ])
  assert.equal(
    sha256(await fs.readFile(path.join(thumbRoot, 'assets', 'editorial-psychology-symbolic-split-6.webp'))),
    NEW_EDITORIAL_PREVIEW_SHA256,
  )
  // The four retained v1.0.0 previews must ride along unchanged.
  for (const [index, asset] of EDITORIAL_ASSETS.slice(0, 4).entries()) {
    assert.equal(sha256(await fs.readFile(path.join(thumbRoot, 'assets', asset))), EDITORIAL_HASHES[index])
  }

  const styleDocument = await readJson(path.join(styleRoot, 'content', 'visual-style.json'))
  parseContentPackDocument('visual-style', styleDocument)
  assert.deepEqual(styleDocument.preview_assets, [`assets/${EDITORIAL_ASSETS[4]}`])
  const newPastel = await fs.readFile(path.join(styleRoot, 'assets', EDITORIAL_ASSETS[4]))
  assert.equal(sha256(newPastel), NEW_PASTEL_PREVIEW_SHA256)
  // The whole point of the successor: it must NOT be the rejected impasto preview.
  assert.notEqual(sha256(newPastel), EDITORIAL_HASHES[4])

  for (const asset of [
    path.join(thumbRoot, 'assets', 'editorial-psychology-symbolic-split-6.webp'),
    path.join(styleRoot, 'assets', EDITORIAL_ASSETS[4]),
  ]) {
    const metadata = await webpMetadata(asset)
    assert.deepEqual(
      { format: metadata.format, width: metadata.width, height: metadata.height },
      { format: 'webp', width: 1672, height: 941 },
    )
  }

  await assert.rejects(
    fs.access(path.join(STUDIO_ROOT, 'kit', 'symbolic-psychology-studio-v1.0.1')),
    { code: 'ENOENT' },
  )
})

test('source evidence: Editorial preview bytes match the provenance ledger', async () => {
  const recipeRoot = path.join(PSYCHOLOGY_ROOT, 'thumbnail', 'editorial-psychology-symbolic-split')
  const pastelRoot = path.join(PSYCHOLOGY_ROOT, 'style', 'pastel-surreal-psychological-collage')
  const ledger = await fs.readFile(path.join(PSYCHOLOGY_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  const recipe = await readJson(path.join(recipeRoot, 'content', 'thumbnail-recipe.json'))
  const pastel = await readJson(path.join(pastelRoot, 'content', 'visual-style.json'))

  parseContentPackDocument('thumbnail-recipe', recipe)
  parseContentPackDocument('visual-style', pastel)
  assert.deepEqual(recipe.preview_assets, EDITORIAL_ASSETS.slice(0, 4).map(asset => `assets/${asset}`))
  assert.deepEqual(pastel.preview_assets, [`assets/${EDITORIAL_ASSETS[4]}`])

  for (const [index, asset] of EDITORIAL_ASSETS.entries()) {
    const root = index < 4 ? recipeRoot : pastelRoot
    const bytes = await fs.readFile(path.join(root, 'assets', asset))
    assert.equal(sha256(bytes), EDITORIAL_HASHES[index], `${asset} must retain its reviewed source byte`)
    const ledgerEntry = ledger.split('\n').find(line => line.includes(asset))
    assert.ok(ledgerEntry, `${asset} must remain in the Editorial provenance ledger`)
    assert.match(ledgerEntry, new RegExp(EDITORIAL_HASHES[index]), `${asset} must retain its paired provenance hash`)
  }
})

test('source evidence: Impasto is a Human Behavior-only decodable WebP', async () => {
  const root = path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration', 'style', 'impasto-psychological-animals')
  const document = await readJson(path.join(root, 'content', 'visual-style.json'))
  const asset = path.join(root, 'assets', 'impasto-psychological-animals.webp')
  const ledger = await fs.readFile(path.join(ROOT, 'content-packs', 'legacy-thumbnail-restoration', 'PREVIEW-PROVENANCE.md'), 'utf8')

  parseContentPackDocument('visual-style', document)
  assert.deepEqual(document.compatible_formula_ids, [HUMAN_BEHAVIOR])
  assert.equal(sha256(await fs.readFile(asset)), IMPASTO_SHA256)
  const ledgerEntry = ledger.split('\n').find(line => line.includes('impasto-psychological-animals.webp'))
  assert.ok(ledgerEntry, 'Impasto must remain in its preview provenance ledger')
  assert.match(ledgerEntry, new RegExp(IMPASTO_SHA256), 'Impasto provenance must retain its exact preview hash')
  const metadata = await webpMetadata(asset)
  assert.deepEqual(
    { format: metadata.format, width: metadata.width, height: metadata.height },
    { format: 'webp', width: 1672, height: 941 },
  )
})

test('Oil source: Store packaging keeps a qualified asset and safe runtime document', async () => {
  const root = path.join(STUDIO_ROOT, 'style', 'oil-painting-classical')
  const document = await readJson(path.join(root, 'content', 'visual-style.json'))
  const asset = path.join(root, 'assets', OIL_ASSET)

  parseContentPackDocument('visual-style', document)
  assert.match(String(document.style_bible), /oil painting/i)
  assert.ok(String(document.negative_prompt).length > 0)
  assert.deepEqual(document.compatible_formula_ids, [HUMAN_BEHAVIOR])
  assert.deepEqual(document.preview_assets, [`assets/${OIL_ASSET}`])
  assert.equal(sha256(await fs.readFile(asset)), OIL_SHA256)
  const metadata = await webpMetadata(asset)
  assert.deepEqual(
    { format: metadata.format, width: metadata.width, height: metadata.height },
    { format: 'webp', width: 1672, height: 941 },
  )
  assert.doesNotMatch(
    JSON.stringify(document),
    /episode|provider|model|price|discount|GenStudio|(?:\/Users\/|[A-Za-z]:[\\/])/i,
  )
})

test('Gothic evidence: the blocked proposal remains source-free until all five evidence gaps close', async () => {
  const gothicRoot = path.join(STUDIO_ROOT, 'style', 'gothic-charcoal-animal-editorial')
  const ledger = await fs.readFile(path.join(STUDIO_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')

  await assert.rejects(fs.access(gothicRoot), { code: 'ENOENT' })
  const gothicSection = ledger.match(/## Gothic Charcoal Animal Editorial[\s\S]*?(?=\n## |$)/i)?.[0]
  assert.ok(gothicSection, 'the provenance ledger must disclose the Gothic qualification block')
  assert.match(gothicSection, /status:\s*blocked/i)
  for (const missing of [
    'original preview bytes',
    'source/rightsholder provenance',
    'rights/license basis',
    'transformation record',
    'independent visual review',
  ]) assert.match(gothicSection, new RegExp(missing, 'i'))
})
