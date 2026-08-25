import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import sharp from 'sharp'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const PACK_ROOT = path.join(ROOT, 'content-packs', 'thumbnail-recipe-expansion-ten')
const RECEIPT = 'authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378'
const RIGHTS_BASIS = 'OpenAI output terms basis; owner responsible for use; non-exclusive/similarity caveat applies'
const NO_REFERENCE_ATTESTATION = 'Generated as a completely original asset with no reference images, masking, or compositing inputs.'
const REVIEW_REFERENCES = [
  'chatgpt-final-diversity-review.md',
  'chatgpt-wave-a-independent-review.md',
  'chatgpt-wave-b-independent-review.md',
  'chatgpt-wave-c-independent-review.md',
]
const CONVERSION = {
  tool: 'sharp',
  operation: 'whole-image PNG to WebP only',
  resize: { width: 1672, height: 941, fit: 'fill', kernel: 'lanczos3' },
  webp: { lossless: true, effort: 6 },
  prohibited: [
    'crop', 'mask', 'overlay', 'title replacement', 'inpainting', 'region edit', 'compositing', 'creative repair',
  ],
}
const EXPECTED_PACK_IDS = [
  'com.storystudio.pack.thumbnail.before-after-proof-panel',
  'com.storystudio.pack.thumbnail.two-option-criteria-split',
  'com.storystudio.pack.thumbnail.reaction-evidence-inset',
  'com.storystudio.pack.thumbnail.cutaway-exploded-object',
  'com.storystudio.pack.thumbnail.hero-payoff-companion',
  'com.storystudio.pack.thumbnail.iconic-result-closeup',
  'com.storystudio.pack.thumbnail.scale-journey',
  'com.storystudio.pack.thumbnail.numbered-lineup',
  'com.storystudio.pack.thumbnail.macro-mystery-detail',
  'com.storystudio.pack.thumbnail.hands-on-pov-moment',
]
const RECIPE_NAMES: Record<string, string> = {
  'before-after-proof-panel': 'Before/After Proof Panel',
  'two-option-criteria-split': 'Two-Option Criteria Split',
  'reaction-evidence-inset': 'Reaction Evidence Inset',
  'cutaway-exploded-object': 'Cutaway Exploded Object',
  'hero-payoff-companion': 'Hero Payoff Companion',
  'iconic-result-closeup': 'Iconic Result Close-Up',
  'scale-journey': 'Scale Journey',
  'numbered-lineup': 'Numbered Lineup',
  'macro-mystery-detail': 'Macro Mystery Detail',
  'hands-on-pov-moment': 'Hands-On POV Moment',
}

const ACCEPTED = [
  ['before-after-proof-panel-01', 'before-after-proof-panel', 1, 'FROM SEED TO SPROUT', '3d3c9ae8012bd4ead1b39263affb0812d51f2440bbe95914da05ed8cd26c97dc', 1454390, '28cf0c657abe429d2bb893b1276d673b6c682e9962894c5d69772f1acef31185', 'afddc196f4b7c0ed60d8a0d15cf73fd75a1bfb26ae1f87b6b340910c7ca11b9e'],
  ['before-after-proof-panel-02', 'before-after-proof-panel', 2, 'A DULL ROOM\nBECOMES CALM', '8bbf609fe1f9197fb828bb4a907ff4eaf49e0ac814a9e367fa59a57b16bfa25a', 1328912, '180c55e74dd66d76b880cd9a5b5a1f963c97060b51ed91cf0edcd0ee09efd226', 'baf7cdc1b3c85c711ae59bceb2289a6908bc4a22d4d2fe69b3374c06af4a797d'],
  ['before-after-proof-panel-03', 'before-after-proof-panel', 3, 'FROM ROUGH\nTO READY\nTO USE', '45200e51c5d2ae56f0ea2533c86604748238ee78317013d17acf4adeffc48710', 1527708, '94e8792ebea5577505a8fcbafbdef427004d48e69891d3363eb0a207a08f8574', '0b50392a28e76b86e774724ef24aee3ca3206ea1db606adc572b4da62f3dd808'],
  ['two-option-criteria-split-01', 'two-option-criteria-split', 1, 'PAPER OR DIGITAL?', '843922cfcc8af23640fb13b1377aaef4cd20f9ffd21957c638984483b7503c88', 1673998, '9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07', '6a19caeaa8fd436338d12c778f68ef2bdcbb8a39036a66616b3b7252949087eb'],
  ['two-option-criteria-split-02', 'two-option-criteria-split', 2, 'QUIET SPACE\nOR BUSY SPACE?', '0973d72df3972b9b83a708c2652d9e6bc82a661f045218b84b3d14e8f66dcdc7', 1518140, 'a1bec8992db1196a3b5b6d583b1e1aef21c4b00803c9c52078bbc2e163e4d19a', '0c8f80e5d5a223fefc632d3121dcbf3fe9318316d836ec8bb229b7f0050ade36'],
  ['two-option-criteria-split-03', 'two-option-criteria-split', 3, 'LIGHT OR\nDARK FOR\nFOCUS?', 'b4ca3d8aa3e27eaa0ac9dbfe51f363d5accf6a7af0a318f2f883e9ceb4f279bc', 1208114, 'a943dc0be132d832e90c7ee86c24b8e0c93a72d35c2b5d479daec4ac35fdb5e3', '3ddf39266374f4f8812855502b3e7802533ba9ac6a0ce0ea2e40fa19bda8fecf'],
  ['reaction-evidence-inset-01', 'reaction-evidence-inset', 1, "THAT'S THE CLUE", 'c753af88415b5ff76875dfca653c7abba0a40e7abfdf5ee768a53b73a52955a2', 1548674, '0c98c5a4ea46a8480c7051e50ce7725830832a2c8e715e161fb58805673b3beb', 'd08d27f31131e43886deeef8015c4859a0c4989d1ff4bf70fae87aadc691f83f'],
  ['reaction-evidence-inset-02', 'reaction-evidence-inset', 2, 'THE TINY DETAIL\nCHANGES EVERYTHING', '5a9e3f9242329ec2422cf2ff4c96331805689157cba04caa9732318c52501a55', 1409264, 'def3c974fdd9daa6b8281d041c8d95e12525f92a1730e1c5d1b8044223429a8d', '4a4b4aa3491ae65b872662603a5dcb4d6c9ee93bcf8f2ec2aa8b1b88a02f5ee0'],
  ['reaction-evidence-inset-03', 'reaction-evidence-inset', 3, 'ONE SMALL\nSIGN TELLS\nTHE STORY', 'd37b5687c12583d30eb446bd4e621fb01bee286ee488cce205bd8bb8633870ef', 2131478, 'b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8', '05143b4461bb8550602cd8901f559616e1ff5c6b2c958ea2b7b75fb8b60ecb01'],
  ['cutaway-exploded-object-01', 'cutaway-exploded-object', 1, 'INSIDE A SEED', 'c3ce800a9858c4248bb70c0fa83450f3e0afa32ef9175d504ed1c2f84aca2a15', 1441708, 'ed5c34f069a58483d59d9d14b31bd58cd4d3bb53c6422fa4b326ec16d1b7f728', '26db7ee6136be4d3211abf7736b1b6eab019a991645cd46062ae5c96ac872b66'],
  ['cutaway-exploded-object-02', 'cutaway-exploded-object', 2, 'HOW A THERMOS\nKEEPS HEAT', '7f6039e524471a188e44506d65f2cd1ff8dc8dc8230435bb2416524aa4937705', 1439994, '7f6e89379c02397062bd86871b6b0d739bcd6bb11ac05563846ae9e75f6fdcf5', 'a4d361eb62a84391e76ff13ce233ce8637495e5fb5933749e96360cd872e2f35'],
  ['cutaway-exploded-object-03', 'cutaway-exploded-object', 3, 'THE LAYERS\nTHAT MAKE\nA ROOF WORK', 'd906f47b11b4d97ef3a320d2b430aaa384380f9dfb59a6ec4ad891c02ed91acc', 1478404, 'f7363e63f841a87dc6539d9a722a7237f28fe019530c8feae48070afa24caf3f', '9b6220f11f7b9b90b7046636fee97cfc1acdd73ffb27a939fdb291d61e4a06fc'],
  ['hero-payoff-companion-01', 'hero-payoff-companion', 1, 'THE FIRST HARVEST', '1d051308f1b7ce553f0c4ebddc4a3e850352d19c0d0acfd97d3f7958c41c430a', 1616678, '32061c1c2370fa15e48bfdccf4c98862d61b34eb6295455123cca7073244b99d', '81ef046118600471009a5f2eeb16e2fe2eb2df7fe3516ca354243b052e40e5eb'],
  ['hero-payoff-companion-02', 'hero-payoff-companion', 2, 'A BETTER WAY\nTO ORGANIZE', '0d52d8c01a687965766b732ecda324341c9dd76019b3f1b289cdc5461071c57b', 1380408, '0217ee0ddde2879c87e6fa7d60f9578c089a061b14adee2f61b9dc53e2e131d9', 'edf2db1001bd3bd8e89490aaa5ff8e0851b0286e8e02ad3dc71e9497036127fb'],
  ['hero-payoff-companion-03', 'hero-payoff-companion', 3, 'THE PLAN\nFINALLY BECOMES\nREAL', 'bf1e1e805ba5b9bf8240f8d6b365a035620a0edf6a869bb4952f23f236b1e4d3', 1574720, '12ec6a8e45ef0acf120f7e28662853d765c4f01974d5e4855dbffae09d2722a3', 'bfbf83b72634a74b7e79a1b9764516ae2abea5ffb9798db81445dd7c76850c1d'],
  ['iconic-result-closeup-01', 'iconic-result-closeup', 1, 'PERFECTLY PROOFED', 'f2d72d26cfb386301ae74673e44497ca30ca89103c773e164ceefcca22236576', 1801744, 'c0ae4932e4b66909829ee9d41745425f1b06c6f0fe5d372e3436b11a86736974', '031713b92bfa73b5937b15028607c23292ba5f284539df2fa559c678c73ca299'],
  ['iconic-result-closeup-02', 'iconic-result-closeup', 2, 'THE FINISHED\nGARDEN BED', 'a639fa00693c45a06043df9a0a2cbe0cfd96fd7a4e0eda7e5865119c9a8c6a86', 1993524, '8f38437b19b595082a7d8f479615e2e3af7975ae3690b2e2f1570fdeedb5babb', '65746a7949941087e8c243b38bec5d360dc183a4babd4cfddb88df32ecde0959'],
  ['iconic-result-closeup-03', 'iconic-result-closeup', 3, 'SMALL SPACE\nBIG CALM\nRESULT', 'e8b1bd981ca9744ac108eb93f1a43c2ad4135e65d6b9174e75f51f3e435c4ca6', 1343932, '970c5dd76116e6f68634de9aca7ff63dac4af9b411dff96c2f9916af266e7e90', '7a5e8ff866057f261b7f71a76ab2298d10018e44e2c0e95420d694b738fafdd0'],
  ['scale-journey-01', 'scale-journey', 1, 'FROM DOT TO FOREST', '7d9086cefe9f7fce2ddb9a4e1d6a8c39b94e4b7086c6075d04d357cbe8c20deb', 1820716, '6948eb7ece83bec59406886b52c5f24f79d2aa0f2cd72ba7257372fa99043872', 'c2b49f6330caa439c68d8d81688e3736bd60d9a917d5f76b82575658d0441bb5'],
  ['scale-journey-02', 'scale-journey', 2, 'TINY STEPS\nADD UP', '59b22f0e39725ee6e08bf9f865ceb46f1bbddcbd1c85c22d41b9a3396cc612e5', 1482468, '4c62b241147a00df11aa2113774d82f408e1abb7cc129c6d3db54ceb50d56f4a', '379bf4a33b1d29f1a15ede95f4259a4bd8241c4c463aa1e9b6b4da0de6d553e6'],
  ['scale-journey-03', 'scale-journey', 3, 'SEE THE\nWHOLE SCALE\nAT ONCE', 'cdffb91a058b4a3570da92c444d36c35444774ae2e89a2211dc8d19d491e60d7', 1405508, 'cecce979f25df3f5c65fc05dc2be89b6e0ac74a8a265ba291e3371408a5be0c2', '09a92925e9f08d9a04fb3b3359860ddc82127bb48afb39656817bde95f96d5a6'],
  ['numbered-lineup-01', 'numbered-lineup', 1, '5 KINDS OF CLOUDS', '5695fada263f543f2dec229adb5a89e79412398c968882da2ccb995acd400c5a', 1459370, '948d1cbbf54885e41ab644a51a631657b53c946d732ca18e824939c215737d01', '3c61d78f01da405636698974c7713df3e7a73a8e22506eb8a2baa3f4ba5241b2'],
  ['numbered-lineup-02', 'numbered-lineup', 2, '3 TOOLS\nFOR CLEAN CUTS', '07b3b1f969d36bc555a1b41e881d5c48a1c8525ed35765dc6b21417d4ea209d2', 2262186, '0f68466c8a42cb12858c731511be99c4ff726227ddee47c7a6ec566df64dfb29', '282c5ff0a3d6046c0f0c89f01ad633476ded2cf891214a8e96182d2abc56c4de'],
  ['numbered-lineup-03', 'numbered-lineup', 3, 'FOUR WAYS\nTO START\nA COMPOST PILE', '1c481e52f1c39432f20926100e098bb8aad0497d6f0a8c6e56fd85ddb99f6bdc', 1672988, '986fdaf39fb3d07190df11fdb0e8f8482a308b6c09bd7e261362460607ce3b9d', '45e52a06b4b8880f30e06ee077298d73f9720dbe4d575383f01f90d5d97629fb'],
  ['macro-mystery-detail-01', 'macro-mystery-detail', 1, 'WHAT IS THIS?', 'e1113000e914850b44ac482baa8b90a9f759a3054d612d1eb0e863664a7d96fa', 1511698, '44a59d9fd7380f3fcf34d7455785f608e1289ad6168c3b69da93342469723dd1', 'b34c6872228e24b27ededb6969c81fdbbdb847ff2422d48f7a34e6109b5e774f'],
  ['macro-mystery-detail-02', 'macro-mystery-detail', 2, 'LOOK CLOSER\nAT THIS LEAF', 'da16f97615dcc545e45348f7573842ce0e706799aaeb66db35c3c1bf9f13b69f', 1897020, '33d68a3ddcbeb4e3fe4b9877d9704536107102d8ff7e486b1f6eada8f11ec067', '7e6560b51b2ff5fe8a3d2eb11bc7bfb49d7eb671c54241c7e0fa74574a8dd55b'],
  ['macro-mystery-detail-03', 'macro-mystery-detail', 3, "THIS ISN'T\nA LANDSCAPE\nIT'S BREAD", '7e7ca9d146bc60361cc2425b5cc0eb6abd3ea52cd8f70dc4fa535c991c86da6e', 2184276, '7fd46109544f1cba6c61173789ce915d14cde6bd41d6a0cc306baefea7a0bf51', '411f17be75916006c28c8f9b694f72b31c14232a25d252a96419cdd665eeb350'],
  ['hands-on-pov-moment-01', 'hands-on-pov-moment', 1, 'PLANT IT RIGHT', 'de2974dd88ea35458309ec25fb01413040d1f7c4919a7b89406f450382a8f454', 1446666, 'a0b163a21a56dc630329b5bd837b84f66c5fd8a70d86cfbff77f3cf8816c4590', '41be5fc39608d79e14732abbe5e986b4f8db1e48bfb1c0a60faa6ab14e3a86df'],
  ['hands-on-pov-moment-02', 'hands-on-pov-moment', 2, 'MAKE THE FIRST\nCLEAN CUT', 'ac208662b418dcfa9213d64545dd8117aa80829d0359aeab5baf9c57ed2de17b', 1499292, '1e31ec8a480003e228f5b721290c045fc4601d4f8af2c729bbab7d1f2e38562b', '0eafa4e9da86d8c021ad01547cfa006d5a0b9103672eee25344aefb3d800fcc7'],
  ['hands-on-pov-moment-03', 'hands-on-pov-moment', 3, 'TURN A\nCORNER INTO\nA READING NOOK', '9d5872336d64a3bbb4e80fce1d828412fb68cf9dfae3322682b90ebad5e24891', 1401886, 'e95c6f9f5fd44756a86fe9387649009cb13bb4a6c09a4d2a442605fa24dbd115', '57d1a5180345383f3db166bd93b432d3afc4298948f64fb0e7618649fee9fd55'],
] as const

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('the ten receipt-authorized preview sets keep all thirty accepted source-byte identities', async () => {
  assert.equal(ACCEPTED.length, 30)
  assert.equal(new Set(ACCEPTED.map(([id]) => id)).size, 30)
  for (const [id, slug, ordinal, title, expectedHash, expectedBytes] of ACCEPTED) {
    const asset = `${slug}-${ordinal}.webp`
    const assetPath = path.join(PACK_ROOT, 'thumbnail', slug, 'assets', asset)
    const bytes = await fs.readFile(assetPath)
    assert.equal(bytes.byteLength, expectedBytes, `${id} byte count`)
    assert.equal(sha256(bytes), expectedHash, `${id} byte identity`)
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata()
    assert.deepEqual({ format: metadata.format, width: metadata.width, height: metadata.height }, {
      format: 'webp', width: 1672, height: 941,
    })
    assert.equal(title.split('\n').length, ordinal, `${id} exact title line count`)
  }
})

test('the returned-evidence ledger and durable provenance pin all accepted ChatGPT route facts', async () => {
  const registry = JSON.parse(await fs.readFile(path.join(ROOT, 'content-packs', 'authoring-registry.json'), 'utf8')) as {
    batches: Array<{ revision: number, receipt_ref: string, request: { records: Array<{ pack_id: string, status: string }> } }>
  }
  const reservation = registry.batches.find(batch => batch.revision === 23)
  assert.ok(reservation)
  assert.equal(reservation.receipt_ref, RECEIPT)
  assert.equal(reservation.request.records.length, 10)
  assert.deepEqual(reservation.request.records.map(record => record.pack_id), EXPECTED_PACK_IDS)
  assert.equal(reservation.request.records.every(record => record.status === 'reserved'), true)
  const sdd = path.join(ROOT, '.superpowers', 'sdd', '2026-08-24-thumbnail-recipe-expansion-ten')
  const evidence = JSON.parse(await fs.readFile(path.join(sdd, 'returned-evidence.json'), 'utf8')) as {
    accepted: Array<Record<string, any>>
    blocked: unknown[]
    summary: Record<string, unknown>
  }
  assert.equal(evidence.accepted.length, 30)
  assert.deepEqual(evidence.blocked, [])
  assert.deepEqual(evidence.summary, {
    accepted_assets: 30,
    blocked_assets: 0,
    eligible_recipe_sets: 10,
    blocked_recipe_sets: 0,
    independent_review_eligibility: '30/30 PASS',
    current_replacement_hashes: [
      '9b2e49ace8bbd84fc055cc96a138e6057df40b10b935d31ae9cc51fb5fd92b07',
      'b37490d2edd19e55b0ddb5a758541d71cf6b84298ba993009bd7fe2cd515dce8',
    ],
  })
  const provenance = await fs.readFile(path.join(PACK_ROOT, 'PREVIEW-PROVENANCE.md'), 'utf8')
  assert.match(provenance, /OpenAI Terms of Use/i)
  assert.match(provenance, /C2PA/i)
  assert.match(provenance, /not independently establish accuracy, ownership, or context/i)
  for (const [id, slug, ordinal, title, hash, bytes, originalHash, promptHash] of ACCEPTED) {
    const accepted = evidence.accepted.find(row => row.draft_job_id === id)
    assert.ok(accepted, `${id} must be in the fail-closed accepted ledger`)
    const source = await fs.readFile(path.join(ROOT, accepted.original_path))
    const sourceSelection = JSON.parse(await fs.readFile(path.join(path.dirname(path.join(ROOT, accepted.original_path)), 'selection.json'), 'utf8')) as Record<string, any>
    const sourceMetadata = await sharp(source, { failOn: 'error' }).metadata()
    assert.equal(accepted.status, 'accepted')
    assert.equal(accepted.pack_id, `com.storystudio.pack.thumbnail.${slug}`)
    assert.equal(accepted.target_source_asset, `content-packs/thumbnail-recipe-expansion-ten/thumbnail/${slug}/assets/${slug}-${ordinal}.webp`)
    assert.equal(accepted.original_path, `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/chatgpt-originals/${id}/selected.png`)
    assert.equal(accepted.tool_provenance, 'built-in ChatGPT image generation')
    assert.deepEqual(accepted.backend_provider, { value: 'unavailable', reason: 'not exposed by the built-in tool; never claim gpt-image-2' })
    assert.deepEqual(accepted.backend_model, { value: 'unavailable', reason: 'not exposed by the built-in tool; never claim gpt-image-2' })
    assert.deepEqual(accepted.fleet_worker, { value: 'not applicable', reason: 'this Mac never registered or executed as a fleet worker' })
    assert.deepEqual(accepted.provider_job_request_id, { value: 'unavailable', reason: 'not exposed by the built-in tool; local draft_job_id and prompt_sha256 are the correlation keys' })
    assert.deepEqual(accepted.seed, { value: 'unavailable', reason: 'not exposed by the built-in tool' })
    assert.deepEqual(accepted.cost_receipt, { value: 'not applicable', reason: 'no Studio Hub credits were charged and no external paid API/CLI call was made' })
    assert.equal(accepted.generated_timestamp, sourceSelection.generated_timestamp_exposed)
    assert.deepEqual(accepted.reference_images, [])
    assert.equal(accepted.no_reference_no_compositing_attestation, sourceSelection.originality_no_reference_declaration ?? NO_REFERENCE_ATTESTATION)
    assert.equal(source.toString('latin1').includes('c2pa'), true)
    assert.equal(source.toString('latin1').includes('OpenAI'), true)
    assert.equal(accepted.c2pa_openai_string_check, 'PASS: untouched PNG contains C2PA and OpenAI strings')
    assert.deepEqual(accepted.rights_sources, [
      {
        url: 'https://openai.com/policies/terms-of-use/',
        accessed: '2026-08-24',
        limitation: 'Output may not be unique and the user remains responsible for use and appropriateness.',
      },
      {
        url: 'https://help.openai.com/en/articles/8912793',
        accessed: '2026-08-24',
        limitation: 'C2PA and SynthID indicate OpenAI-tool origin but do not independently establish accuracy, ownership, or context.',
      },
    ])
    assert.equal(accepted.converted_sha256, hash)
    assert.equal(accepted.converted_bytes, bytes)
    assert.equal(accepted.converted_format, 'webp')
    assert.deepEqual(accepted.converted_dimensions, { width: 1672, height: 941 })
    assert.equal(accepted.converted_decode, 'PASS: Sharp failOn error decoded WebP')
    assert.equal(accepted.original_sha256, originalHash)
    assert.equal(accepted.original_sha256, sha256(source))
    assert.equal(accepted.original_bytes, source.byteLength)
    assert.equal(accepted.original_format, 'png')
    assert.deepEqual(accepted.original_dimensions, { width: sourceMetadata.width, height: sourceMetadata.height })
    assert.equal(accepted.original_decode, 'PASS: Sharp failOn error decoded PNG')
    assert.equal(sourceMetadata.format, 'png')
    assert.equal(accepted.prompt_sha256, promptHash)
    assert.equal(accepted.prompt_sha256, sourceSelection.prompt_sha256)
    assert.equal(accepted.exact_title_transcription, title)
    assert.equal(accepted.exact_title_transcription, sourceSelection.exact_title_transcription)
    assert.equal(accepted.headline_line_count, ordinal)
    assert.equal(accepted.headline_line_count_verdict, sourceSelection.headline_line_count_verdict)
    assert.equal(accepted.recipe_invariant_verdict, sourceSelection.recipe_invariant_verdict)
    assert.deepEqual(accepted.conversion, { ...CONVERSION, paired_output_byte_identity: 'PASS' })
    assert.deepEqual(accepted.review_references, REVIEW_REFERENCES)
    assert.equal(accepted.prompt_hash_validation.status, 'PASS')
    assert.equal(accepted.rights_basis, RIGHTS_BASIS)
    assert.equal(accepted.receipt_ref, RECEIPT)
    assert.match(provenance, new RegExp(`${slug}-${ordinal}\\.webp`))
    assert.match(provenance, new RegExp(hash))
    assert.match(provenance, new RegExp(originalHash))
    assert.match(provenance, new RegExp(promptHash))
  }
})

for (const slug of [...new Set(ACCEPTED.map(([, slug]) => slug))]) {
  test(`${RECIPE_NAMES[slug]} remains reserved until its receipt-authorized pack and content manifests are authored`, async () => {
    const sourceRoot = path.join(PACK_ROOT, 'thumbnail', slug)
    await fs.access(path.join(sourceRoot, 'pack.json'))
    await fs.access(path.join(sourceRoot, 'content', 'thumbnail-recipe.json'))
  })
}
